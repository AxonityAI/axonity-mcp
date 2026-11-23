import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { buildServer } from "../src/index.js";

/**
 * platform-onderhoud, blok a (axonity-flow #2608): the publish queue held 1,499
 * requests and reading it whole timed out. `GET /publish-approvals` now pages on
 * a keyset cursor (`nextCursor`, sent back as `cursor`) and narrows by `status`,
 * `origin`, `entityType` and `agentId`; `GET /publish-approvals/summary` counts
 * per status, source, kind and agent without loading a row. `offset` still works.
 *
 * Zod drops a parameter it does not know without a word, so these go through the
 * REAL MCP layer and check what reaches the backend client. The names and enum
 * values are held to the pinned OpenAPI snapshot.
 */

type Json = Record<string, unknown>;

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/openapi.snapshot.json", import.meta.url)),
    "utf8",
  ),
) as {
  paths: Record<string, Record<string, { parameters?: Json[] }>>;
  components: { schemas: Record<string, { properties?: Record<string, Json> }> };
};

async function connected(answer: unknown = {}) {
  const backend = {
    get: vi.fn(async (_path: string, _query?: unknown) => answer),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    del: vi.fn(async () => ({})),
  };
  const server = buildServer(backend as unknown as AxonityClient);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "probe", version: "0.0.0" });
  await client.connect(clientSide);
  const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
  return { client, backend, tools };
}

const text = (result: unknown): string =>
  (result as { content: { text?: string }[] }).content.map((c) => c.text ?? "").join("\n");

const LIST = "/api/v1/publish-approvals";
const SUMMARY = "/api/v1/publish-approvals/summary";
const AGENT = "5f0c1e8a-2b7d-4c3e-9a10-6d2f4b8e1c55";

/** The enum of a query parameter in the pinned snapshot (`anyOf` with null). */
function routeEnum(path: string, name: string): string[] {
  const parameter = (snapshot.paths[path].get.parameters ?? []).find((p) => p.name === name) as
    | { schema: { enum?: string[]; anyOf?: { enum?: string[] }[] } }
    | undefined;
  expect(parameter, `${path} has no \`${name}\` in the pinned snapshot`).toBeDefined();
  const values = parameter!.schema.enum ?? parameter!.schema.anyOf?.find((s) => s.enum)?.enum;
  expect(values, `${path} \`${name}\` has no enum`).toBeDefined();
  return values!;
}

const routeParams = (path: string): string[] =>
  (snapshot.paths[path].get.parameters ?? []).map((p) => p.name as string);

describe("list_publish_approvals reads the queue a page at a time", () => {
  it("sends the cursor and the four filters under the route's own names", async () => {
    const { client, backend } = await connected();
    await client.callTool({
      name: "list_publish_approvals",
      arguments: {
        cursor: "c-2",
        status: "pending",
        origin: "agent",
        entityType: "workflow",
        agentId: AGENT,
        limit: 50,
      },
    });
    const [path, query] = backend.get.mock.calls[0] as [string, Json];
    expect(path).toBe(LIST);
    expect(query).toMatchObject({
      cursor: "c-2",
      status: "pending",
      origin: "agent",
      entityType: "workflow",
      agentId: AGENT,
      limit: 50,
    });
    for (const name of Object.keys(query).filter((k) => query[k] !== undefined)) {
      expect(routeParams(LIST), `\`${name}\` is not a parameter of ${LIST}`).toContain(name);
    }
  });

  it("without the new parameters it sends what it always sent", async () => {
    const { client, backend } = await connected();
    await client.callTool({
      name: "list_publish_approvals",
      arguments: { status: "approved", limit: 20, offset: 40 },
    });
    const [, query] = backend.get.mock.calls[0] as [string, Json];
    const sent = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined));
    expect(sent).toEqual({ status: "approved", limit: 20, offset: 40 });
  });

  it("hands back the next cursor with the page, untouched", async () => {
    const page = { approvals: [{ id: "a-1" }], total: 1499, hasMore: true, nextCursor: "c-3" };
    const { client } = await connected(page);
    const result = await client.callTool({ name: "list_publish_approvals", arguments: {} });
    expect(JSON.parse(text(result))).toEqual(page);
    const answer = Object.keys(
      snapshot.components.schemas.PublishApprovalListResponse.properties ?? {},
    );
    expect(answer).toEqual(expect.arrayContaining(["approvals", "total", "hasMore", "nextCursor"]));
  });

  it("takes the same values for `origin` and `entityType` as its route", async () => {
    const { tools } = await connected();
    const props = tools.get("list_publish_approvals")!.inputSchema.properties as Record<string, Json>;
    expect(props.origin.enum).toEqual(routeEnum(LIST, "origin"));
    expect(props.entityType.enum).toEqual(routeEnum(LIST, "entityType"));
  });

  it("refuses an origin the backend does not know, and sends nothing", async () => {
    const { client, backend } = await connected();
    let refused = "";
    try {
      const result = await client.callTool({
        name: "list_publish_approvals",
        arguments: { origin: "email" },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      refused = text(result);
    } catch (error) {
      refused = (error as Error).message;
    }
    expect(refused).toMatch(/origin/);
    expect(backend.get).not.toHaveBeenCalled();
  });

  it("tells an agent to page by nextCursor, to narrow first, and not to read it all", async () => {
    const { tools } = await connected();
    const description = tools.get("list_publish_approvals")!.description ?? "";
    expect(description).toMatch(/`nextCursor`/);
    expect(description).toMatch(/`cursor`/);
    expect(description).toMatch(/publish_approvals_summary/);
    expect(description).toMatch(/not .*(whole|all|every)/i);
  });
});

describe("publish_approvals_summary counts the queue without reading it", () => {
  it("reads GET /publish-approvals/summary with the same filters", async () => {
    const { client, backend } = await connected();
    await client.callTool({
      name: "publish_approvals_summary",
      arguments: { status: "pending", origin: "mcp", entityType: "tool", agentId: AGENT, view: "all" },
    });
    const [path, query] = backend.get.mock.calls[0] as [string, Json];
    expect(path).toBe(SUMMARY);
    expect(query).toEqual({
      status: "pending",
      origin: "mcp",
      entityType: "tool",
      agentId: AGENT,
      view: "all",
    });
    for (const name of Object.keys(query)) expect(routeParams(SUMMARY)).toContain(name);
  });

  it("takes no paging: a summary is one answer", async () => {
    const { tools } = await connected();
    const props = Object.keys(tools.get("publish_approvals_summary")!.inputSchema.properties ?? {});
    expect(props.sort()).toEqual(["agentId", "entityType", "origin", "status", "view"]);
    const routeProps = routeParams(SUMMARY);
    for (const p of props) expect(routeProps).toContain(p);
  });

  it("takes the same values for `origin` and `entityType` as its route", async () => {
    const { tools } = await connected();
    const props = tools.get("publish_approvals_summary")!.inputSchema.properties as Record<string, Json>;
    expect(props.origin.enum).toEqual(routeEnum(SUMMARY, "origin"));
    expect(props.entityType.enum).toEqual(routeEnum(SUMMARY, "entityType"));
  });

  it("names the fields of the answer that the route answers", async () => {
    const { tools } = await connected();
    const description = tools.get("publish_approvals_summary")!.description ?? "";
    const fields = Object.keys(snapshot.components.schemas.PublishApprovalSummary.properties ?? {});
    for (const field of ["total", "byStatus", "byOrigin", "byKind", "byAgent"]) {
      expect(fields).toContain(field);
      expect(description).toContain(`\`${field}\``);
    }
  });
});
