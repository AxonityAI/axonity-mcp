import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { buildServer } from "../src/index.js";
import { forbids } from "./denyList.js";

/**
 * R4 of agent-first: the approval queue is read PER PERSON, and every request
 * says where it came from and whether the reader may decide it.
 *
 * What changed in the backend (axonity-flow `af-r4-navigatie`):
 *   - `GET /publish-approvals` and `GET /publish-approvals/release` take `view`
 *     (`mine` by default, `all` for administrators), and answer only what the
 *     caller may see;
 *   - the three item shapes carry `origin`, `requestedByName`, `canDecide`, `canReject` and
 *     `version`;
 *   - a run row carries `ownerAgentId` and `currentStepName`.
 *
 * Zod drops a parameter it does not know without a word, so the `view` tests go
 * through the REAL MCP layer (the connector's own server, an in-memory
 * transport and an SDK client) and check what reaches the backend client. The
 * words a tool says are held to the pinned OpenAPI snapshot: a field a
 * description names must be a field of the response schema, and an enum value it
 * names must be one of the schema's.
 */

type Json = Record<string, unknown>;

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/openapi.snapshot.json", import.meta.url)),
    "utf8",
  ),
) as {
  paths: Record<string, Record<string, { description?: string; parameters?: Json[] }>>;
  components: { schemas: Record<string, { properties?: Record<string, Json> }> };
};

async function connected() {
  const backend = {
    get: vi.fn(async (_path: string, _query?: unknown) => ({}) as unknown),
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

const LISTS = [
  ["list_publish_approvals", "/api/v1/publish-approvals"],
  ["list_publish_releases", "/api/v1/publish-approvals/release"],
] as const;

const ITEMS = ["PublishApprovalItem", "ReleaseApprovalSummary", "ReleaseApprovalItem"] as const;

describe("`view` on the two approval lists (A2)", () => {
  it.each(LISTS)("%s sends `view` to the backend when it is given", async (tool, path) => {
    const { client, backend } = await connected();
    await client.callTool({ name: tool, arguments: { view: "all" } });
    expect(backend.get).toHaveBeenCalledTimes(1);
    const [calledPath, query] = backend.get.mock.calls[0] as [string, Json];
    expect(calledPath).toBe(path);
    expect(query.view).toBe("all");
  });

  it.each(LISTS)("%s leaves `view` out when it is not given, so the backend's default (mine) applies", async (tool) => {
    const { client, backend } = await connected();
    await client.callTool({ name: tool, arguments: {} });
    const [, query] = backend.get.mock.calls[0] as [string, Json];
    expect(query.view).toBeUndefined();
  });

  it.each(LISTS)("%s refuses a `view` the backend does not know, and sends nothing", async (tool) => {
    const { client, backend } = await connected();
    let refused = "";
    try {
      const result = await client.callTool({ name: tool, arguments: { view: "everyone" } });
      expect((result as { isError?: boolean }).isError).toBe(true);
      refused = text(result);
    } catch (error) {
      refused = (error as Error).message;
    }
    expect(refused).toMatch(/view/);
    expect(backend.get).not.toHaveBeenCalled();
  });

  it.each(LISTS)("%s takes the same values for `view` as its route, and no default of its own", async (tool, path) => {
    const { tools } = await connected();
    const parameter = (snapshot.paths[path].get.parameters ?? []).find((p) => p.name === "view") as
      | { schema: { enum: string[]; default: string } }
      | undefined;
    expect(parameter, `${path} has no \`view\` in the pinned snapshot`).toBeDefined();
    expect(parameter!.schema.enum).toEqual(["mine", "all"]);
    expect(parameter!.schema.default).toBe("mine");

    const property = (tools.get(tool)!.inputSchema.properties as Record<string, Json>).view;
    expect(property.enum).toEqual(parameter!.schema.enum);
    // The default lives in the backend, once: a second one here would be a copy.
    expect(property.default).toBeUndefined();
  });

  it.each(LISTS)("%s says whose requests `mine` and `all` show, and who may ask for `all`", async (tool) => {
    const { tools } = await connected();
    const description = tools.get(tool)!.description ?? "";
    expect(description).toMatch(/`view`/);
    expect(description).toMatch(/`mine`/);
    expect(description).toMatch(/`all`/);
    expect(description).toMatch(/administrators?/);
    expect(description).toMatch(/403/);
    expect(description).toMatch(/service token/);
  });

  it("neither list describes itself as the whole tenant's queue any more", async () => {
    const { tools } = await connected();
    for (const [tool] of LISTS) {
      expect(tools.get(tool)!.description ?? "", tool).not.toMatch(/this tenant's/i);
    }
  });
});

describe("what a request says about itself (A2, A5a, A5b, H3b)", () => {
  it.each(ITEMS)("%s carries origin, requestedByName, canDecide, canReject and version in the pinned snapshot", (name) => {
    const properties = snapshot.components.schemas[name]?.properties ?? {};
    for (const field of ["origin", "requestedByName", "canDecide", "canReject", "version"]) {
      expect(properties[field], `${name}.${field}`).toBeDefined();
    }
    expect(properties.origin.enum).toEqual(["mcp", "agent", "screen"]);
  });

  it.each([
    "list_publish_approvals",
    "get_publish_approval",
    "list_publish_releases",
    "get_publish_release",
  ])("%s names the five fields and the three origins", async (tool) => {
    const { tools } = await connected();
    const description = tools.get(tool)!.description ?? "";
    for (const field of ["origin", "requestedByName", "canDecide", "canReject", "version"]) {
      expect(description, `${tool} never names \`${field}\``).toContain(`\`${field}\``);
    }
    for (const origin of ["mcp", "agent", "screen"]) {
      expect(description, `${tool} never names the origin ${origin}`).toContain(`\`${origin}\``);
    }
  });

  it.each([
    "list_publish_approvals",
    "get_publish_approval",
    "list_publish_releases",
    "get_publish_release",
  ])("%s says a token never decides, so `canDecide` is false through one", async (tool) => {
    const { tools } = await connected();
    expect(tools.get(tool)!.description ?? "").toMatch(/token never/i);
  });

  it.each([
    "list_publish_approvals",
    "get_publish_approval",
    "list_publish_releases",
    "get_publish_release",
  ])("%s separates approval authority, rejection authority and pending status", async (tool) => {
    const { tools } = await connected();
    const description = tools.get(tool)!.description ?? "";
    expect(description).toContain("`canDecide` is your authority to approve");
    expect(description).toContain("`canReject` is your authority to reject");
    expect(description).toContain("`status` must be `pending`");
    expect(description).not.toContain("whether approving it would succeed");
  });

  it("the release list dates its saved version and points to the detail for the current pending version", async () => {
    const { tools } = await connected();
    const description = tools.get("list_publish_releases")!.description ?? "";
    expect(description).toContain("`version` comes from the saved verdict as of `readinessAsOf`");
    expect(description).toContain("get_publish_release for the current version of a pending release");
    expect(description).not.toContain("publishes as of now");
  });

  it.each(["list_publish_approvals", "get_publish_approval", "get_publish_release"])(
    "%s still describes the current pending version",
    async (tool) => {
      const { tools } = await connected();
      const description = tools.get(tool)!.description ?? "";
      expect(description).toContain("publishes as of now");
      expect(description).not.toContain("`version` comes from the saved verdict");
    },
  );

  it("hands the new fields to the agent unchanged (the answer is forwarded whole)", async () => {
    const { client, backend } = await connected();
    const item = {
      id: "a-1",
      origin: "agent",
      requestedByName: "Agent Smith",
      canDecide: false,
      canReject: false,
      status: "pending",
      version: 4,
    };
    backend.get.mockResolvedValueOnce({ approvals: [item], total: 1, hasMore: false });
    const result = await client.callTool({ name: "list_publish_approvals", arguments: {} });
    expect(JSON.parse(text(result)).approvals[0]).toEqual(item);
  });

  it.each([
    ["get_publish_approval", "/api/v1/publish-approvals/{approval_id}"],
    ["get_publish_release", "/api/v1/publish-approvals/release/{release_id}"],
  ])("%s says someone else's request is a 404, as its route does", async (tool, path) => {
    expect(snapshot.paths[path].get.description ?? "").toMatch(/someone else's is 404/);
    const { tools } = await connected();
    expect(tools.get(tool)!.description ?? "").toMatch(/404/);
  });
});

describe("a run row says whose it is and what it is on (H1)", () => {
  it("RunSummary carries ownerAgentId and currentStepName, both nullable, in the pinned snapshot", () => {
    const properties = snapshot.components.schemas.RunSummary?.properties ?? {};
    for (const field of ["ownerAgentId", "currentStepName"]) {
      expect(properties[field], `RunSummary.${field}`).toBeDefined();
      const types = ((properties[field].anyOf as { type: string }[]) ?? []).map((t) => t.type);
      expect(types.sort(), field).toEqual(["null", "string"]);
    }
  });

  it.each(["list_runs", "list_workflow_runs"])("%s names both fields", async (tool) => {
    const { tools } = await connected();
    const description = tools.get(tool)!.description ?? "";
    expect(description).toContain("`ownerAgentId`");
    expect(description).toContain("`currentStepName`");
  });
});

describe("the two routes R4 added are decided (A3, A8)", () => {
  it("GET /knowledge/oversight/waiting is the badge of the oversight work lists, which a token does not read", () => {
    expect(snapshot.paths["/api/v1/knowledge/oversight/waiting"]?.get).toBeDefined();
    expect(forbids("GET", "/api/v1/knowledge/oversight/waiting")).toBe(true);
  });

  it("GET /library/summary is in the pinned snapshot", () => {
    expect(snapshot.paths["/api/v1/library/summary"]?.get).toBeDefined();
  });
});
