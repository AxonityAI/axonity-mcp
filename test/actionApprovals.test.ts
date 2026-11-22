import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AxonityClient } from "../src/client.js";
import { collectCalledRoutes } from "../src/contract.js";
import { TOKEN_ROUTE_CLASSES } from "../src/generated/tokenRouteClasses.js";
import { buildServer, registerAll } from "../src/index.js";
import { forbids } from "./denyList.js";

/**
 * Requests for the actions a token may only PROPOSE (token-approval design,
 * category 2): the backend answers 202 with an approval, a person decides in
 * Axonity, and this connector says "not done yet" in words an agent cannot
 * read as success. Everything runs through the real MCP layer and, where the
 * status code matters, the real client against a faked `fetch`.
 */

const CONFIG = { apiUrl: "https://api.test", token: "axs_secret" };
const APPROVAL_ID = "5b0f6f0e-3a43-4d1e-9a7e-0c6a1f6a9c11";

const accepted = {
  status: "pending_approval",
  message: "Asked, not done.",
  approval: {
    id: APPROVAL_ID,
    status: "pending",
    action: "module_settings.patch",
    summary: "Mail: add mailbox support@axonity.test",
    check: { outcome: "ok", reason: null },
  },
};

function fetchReturning(status: number, body: unknown) {
  return vi.fn(async () =>
    ({
      ok: status < 400,
      status,
      text: async () => JSON.stringify(body),
    }) as unknown as Response,
  );
}

async function connected(client: unknown) {
  const server = buildServer(client as AxonityClient);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const probe = new Client({ name: "probe", version: "0.0.0" });
  await probe.connect(clientSide);
  return probe;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

afterEach(() => vi.restoreAllMocks());

const settingsCall = {
  name: "update_module_settings",
  arguments: {
    id: "mail",
    changes: [
      { key: "mailboxes", operation: "set", value: [{ address: "x" }], expectedRevision: null },
    ],
  },
};

describe("a 202 from a route a token may only propose", () => {
  it("update_module_settings says NOT DONE YET, names the approval and forbids a retry", async () => {
    vi.stubGlobal("fetch", fetchReturning(202, accepted));
    const probe = await connected(new AxonityClient(CONFIG));

    const result = await probe.callTool(settingsCall);
    const said = text(result);

    expect(said).toMatch(/^NOT DONE YET/);
    expect(said).toContain("Approvals → Admin requests");
    expect(said).toContain(APPROVAL_ID);
    expect(said).toContain("get_action_approval");
    expect(said).toMatch(/Do not retry/);
    expect(said).toContain("a second identical request returns the same approval");
    expect(said).toContain("Mail: add mailbox support@axonity.test");
  });

  it("is not read as success: the answer carries no `status: ok`-looking JSON of its own", async () => {
    vi.stubGlobal("fetch", fetchReturning(202, accepted));
    const probe = await connected(new AxonityClient(CONFIG));
    const said = text(await probe.callTool(settingsCall));
    expect(() => JSON.parse(said)).toThrow();
  });

  it("any other tool that reaches such a route says the same (one shared wording)", async () => {
    vi.stubGlobal("fetch", fetchReturning(202, accepted));
    const probe = await connected(new AxonityClient(CONFIG));
    const said = text(
      await probe.callTool({
        name: "set_application_executors",
        arguments: { id: "app-1", executorIds: ["ex-1"] },
      }),
    );
    expect(said).toMatch(/^NOT DONE YET/);
    expect(said).toContain(APPROVAL_ID);
  });

  it("an ordinary 200 body is untouched", async () => {
    const page = { moduleId: "mail", fields: [] };
    vi.stubGlobal("fetch", fetchReturning(200, page));
    const probe = await connected(new AxonityClient(CONFIG));
    expect(JSON.parse(text(await probe.callTool(settingsCall)))).toEqual(page);
  });
});

describe("a 422 that names the field", () => {
  it("shows mailboxes[0].address and the reason, so the agent can repair it", async () => {
    vi.stubGlobal(
      "fetch",
      fetchReturning(422, {
        error: "validation_error",
        code: "validation_error",
        retryable: false,
        message: "The mailbox address is not an address.",
        detail: ["The mailbox address is not an address."],
        fieldErrors: [
          { loc: ["mailboxes", 0, "address"], msg: "The mailbox address is not an address." },
        ],
      }),
    );
    const probe = await connected(new AxonityClient(CONFIG));
    const result = await probe.callTool(settingsCall);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toContain("mailboxes[0].address: The mailbox address is not an address.");
  });

  it("keeps working for a bare FastAPI 422 without fieldErrors", async () => {
    vi.stubGlobal(
      "fetch",
      fetchReturning(422, {
        code: "validation_error",
        message: "Request validation failed",
        detail: [{ loc: ["body", "changes"], msg: "Field required", type: "missing" }],
      }),
    );
    const probe = await connected(new AxonityClient(CONFIG));
    expect(text(await probe.callTool(settingsCall))).toContain("body.changes: Field required");
  });
});

describe("list_action_approvals and get_action_approval", () => {
  const item = {
    id: APPROVAL_ID,
    status: "pending",
    statusReason: null,
    summary: "Mail: add mailbox",
    result: null,
    check: { outcome: "changed", reason: "the mailbox list moved since the request" },
  };

  it("list sends the filters the backend takes (status, view, limit, cursor) and returns status and check", async () => {
    const backend = {
      get: vi.fn(async () => ({ items: [item], pageSize: 1, hasMore: false, nextCursor: null })),
      post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(),
    };
    const probe = await connected(backend);
    const said = text(
      await probe.callTool({
        name: "list_action_approvals",
        arguments: { status: "pending", view: "all", limit: 5, cursor: "c1" },
      }),
    );
    expect(backend.get).toHaveBeenCalledWith("/api/v1/action-approvals", {
      status: "pending", view: "all", limit: 5, cursor: "c1",
    });
    const body = JSON.parse(said);
    expect(body.items[0].status).toBe("pending");
    expect(body.items[0].check.outcome).toBe("changed");
  });

  it("get reads one approval by id and shows status, check and result", async () => {
    const backend = {
      // The real backend fills `check` only while pending: null once decided.
      get: vi.fn(async () => ({ ...item, status: "approved", result: { applied: true }, check: null })),
      post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(),
    };
    const probe = await connected(backend);
    const body = JSON.parse(
      text(await probe.callTool({ name: "get_action_approval", arguments: { approvalId: APPROVAL_ID } })),
    );
    expect(backend.get).toHaveBeenCalledWith(`/api/v1/action-approvals/${APPROVAL_ID}`);
    expect(body).toMatchObject({ status: "approved", result: { applied: true } });
    expect(body.check).toBeNull();
  });

  it("says check is live only while pending and null once decided", async () => {
    const probe = await connected({ get: vi.fn() });
    const tools = (await probe.listTools()).tools;
    for (const name of ["list_action_approvals", "get_action_approval"]) {
      const d = tools.find((t) => t.name === name)!.description!;
      expect(d, name).toMatch(/while the request is `pending`/);
      expect(d, name).toMatch(/`check` is null/);
    }
  });

  it("their descriptions name fields that exist on the pinned response schema", async () => {
    const snapshot = JSON.parse(
      readFileSync(fileURLToPath(new URL("./fixtures/openapi.snapshot.json", import.meta.url)), "utf8"),
    ) as { components: { schemas: Record<string, { properties: Record<string, unknown> }> } };
    const fields = Object.keys(snapshot.components.schemas.ActionApprovalItem.properties);
    const probe = await connected({ get: vi.fn() });
    const tools = (await probe.listTools()).tools;
    for (const name of ["list_action_approvals", "get_action_approval"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      for (const field of ["summary", "status", "statusReason", "result", "check"]) {
        expect(fields).toContain(field);
        expect(tool!.description).toContain(field);
      }
    }
  });
});

describe("no tool approves or rejects", () => {
  it("both decision routes are closed in the route table, with the reason", () => {
    for (const verb of ["approve", "reject"]) {
      expect(TOKEN_ROUTE_CLASSES[`POST /api/v1/action-approvals/{approval_id}/${verb}`]).toEqual({
        class: "dicht",
        why: "a token never approves",
      });
    }
  });

  it("the client refuses the call even if a tool tried", () => {
    expect(forbids("POST", `/api/v1/action-approvals/${APPROVAL_ID}/approve`)).toBe(true);
    expect(forbids("POST", `/api/v1/action-approvals/${APPROVAL_ID}/reject`)).toBe(true);
    expect(forbids("GET", `/api/v1/action-approvals/${APPROVAL_ID}`)).toBe(false);
  });

  it("no registered tool calls a decision route (every tool, every probe variant)", async () => {
    const calls = await collectCalledRoutes((server, client) => registerAll(server as never, client));
    const decisions = calls.filter((c) => /\/action-approvals\/[^/]+\/(approve|reject)$/.test(c.path));
    expect(decisions).toEqual([]);
    expect(calls.some((c) => c.path.startsWith("/api/v1/action-approvals"))).toBe(true);
  });
});
