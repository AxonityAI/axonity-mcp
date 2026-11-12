import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AxonityClient } from "../src/client.js";
import { collectCalledRoutes } from "../src/contract.js";
import { errorForStatus } from "../src/errors.js";
import { buildServer, registerAll } from "../src/index.js";
import { CONVENTIONS } from "../src/tools/conventions.js";

// These tests prove the connector's wire contract, not backend authorization,
// revision locking, atomicity or the existence of R1 routes in a deployed API.
const NAMES = [
  "list_modules", "read_module_settings_schema", "read_module_settings", "update_module_settings",
];
type Result = { isError?: boolean; content: { text: string }[] };
type Tool = {
  description: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<Result>;
};
const revision = "884a2b99-b02b-468b-a658-a2b44a813150";
const changes = [
  { key: "language", operation: "set", value: "en", expectedRevision: revision, locked: true },
  { key: "topics", operation: "set", value: ["sales", "operations"], expectedRevision: null, locked: false },
  { key: "assignment", operation: "set", value: null, expectedRevision: null },
  { key: "day", operation: "inherit", expectedRevision: revision },
  { key: "timezone", operation: "follow_deploy", expectedRevision: null },
];

function backend(response: unknown = {}) {
  return {
    get: vi.fn(async () => response), post: vi.fn(async () => response),
    put: vi.fn(async () => response), patch: vi.fn(async () => response),
    del: vi.fn(async () => response),
  };
}
function registered(response: unknown = {}) {
  const client = backend(response);
  const tools = new Map<string, Tool>();
  registerAll({
    tool: (name: string, description: string, schema: z.ZodRawShape, handler: Tool["handler"]) =>
      tools.set(name, { description, schema, handler }),
  } as never, client as unknown as AxonityClient);
  function tool(name: string) {
    expect(tools.has(name), `registered module tool: ${name}`).toBe(true);
    return tools.get(name)!;
  }
  async function call(name: string, args: Record<string, unknown>) {
    const t = tool(name);
    return t.handler(z.object(t.schema).parse(args));
  }
  return { tools, tool, client, call };
}
const body = (r: Result) => JSON.parse(r.content[0].text);

describe("generic module discovery and workspace settings", () => {
  it("registers exactly four generic module tools and no per-module or personal tools", () => {
    expect([...registered().tools.keys()].filter((n) => /module/.test(n)).sort()).toEqual([...NAMES].sort());
  });

  it("forwards both paging arguments and preserves every Page field", async () => {
    const page = { items: [{ id: "insights", enabled: true }], nextCursor: "next/+?=", pageSize: 37, hasMore: true, extra: "preserved" };
    const { call, client, tool } = registered(page);
    expect(body(await call("list_modules", { limit: 37, cursor: "opaque/+?=雪" }))).toEqual(page);
    expect(client.get).toHaveBeenCalledWith("/api/v1/modules", { limit: 37, cursor: "opaque/+?=雪" });
    expect(tool("list_modules").description).toMatch(/nextCursor/);
  });

  it("allows the backend's default paging without inventing a limit", async () => {
    const { call, client } = registered({ items: [], nextCursor: null });
    await call("list_modules", {});
    expect(client.get).toHaveBeenCalledWith("/api/v1/modules", { limit: undefined, cursor: undefined });
  });

  it.each([
    ["read_module_settings_schema", "/settings/schema", undefined],
    ["read_module_settings", "/settings", { level: "workspace" }],
  ])("%s encodes the module id and preserves the server response", async (name, suffix, query) => {
    const response = { moduleId: "plugin/a ?#雪", fields: [{ key: "custom", value: null }], extra: "preserved" };
    const { call, client } = registered(response);
    expect(body(await call(name, { id: response.moduleId }))).toEqual(response);
    const path = `/api/v1/modules/${encodeURIComponent(response.moduleId)}${suffix}`;
    if (query) expect(client.get).toHaveBeenCalledWith(path, query);
    else expect(client.get).toHaveBeenCalledWith(path);
  });

  it("sends one PATCH with every change field and the fixed workspace query", async () => {
    const response = { moduleId: "a/b", level: "workspace", subjectId: null, fields: [] };
    const { call, client } = registered(response);
    expect(body(await call("update_module_settings", { id: "a/b", changes }))).toEqual(response);
    expect(client.patch).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/modules/a%2Fb/settings", { changes }, { level: "workspace" },
    );
  });

  it.each([false, 0, "", null, [], {}, { nested: [false, null, { custom: "kept" }] }])(
    "preserves an explicitly supplied JSON value %j", async (value) => {
      const { call, client } = registered();
      const item = { key: "custom", operation: "set", value, expectedRevision: null };
      await call("update_module_settings", { id: "custom", changes: [item] });
      expect(client.patch.mock.calls[0]).toEqual([
        "/api/v1/modules/custom/settings", { changes: [item] }, { level: "workspace" },
      ]);
    },
  );

  it("adds no client quota on module ids, keys, page size or change count", async () => {
    const { call, client } = registered();
    await call("list_modules", { limit: 10001 });
    const large = Array.from({ length: 1001 }, (_, i) => ({
      key: `${i}${"k".repeat(1001)}`, operation: "set", value: i, expectedRevision: null,
    }));
    await call("update_module_settings", { id: "m".repeat(1001), changes: large });
    expect(client.patch).toHaveBeenCalledOnce();
  });

  it.each(NAMES)("%s exposes no caller authority or context selector", (name) => {
    const keys = Object.keys(registered().tool(name).schema).sort();
    expect(keys).toEqual(name === "list_modules" ? ["cursor", "limit"] :
      name === "update_module_settings" ? ["changes", "id"] : ["id"]);
  });

  it.each([403, 404, 409, 422, 500])("surfaces backend failure %i without reporting success or retrying", async (status) => {
    const { call, client } = registered();
    client.patch.mockRejectedValueOnce(errorForStatus(status, { detail: "Backend refusal" }));
    expect((await call("update_module_settings", { id: "insights", changes })).isError).toBe(true);
    expect(client.patch).toHaveBeenCalledOnce();
  });

  it("includes all four routes in the existing blind contract replay", async () => {
    const calls = await collectCalledRoutes(registerAll);
    for (const [method, path] of [
      ["GET", "/api/v1/modules"], ["GET", "/api/v1/modules/x/settings/schema"],
      ["GET", "/api/v1/modules/x/settings"], ["PATCH", "/api/v1/modules/x/settings"],
    ]) expect(calls).toContainEqual({ method, path });
  });
});

const invalid = [
  { key: "day", operation: "set", expectedRevision: null },
  { key: "day", operation: "set", value: undefined, expectedRevision: null },
  { key: "day", operation: "set", value: null },
  { key: "day", operation: "inherit" },
  { key: "day", operation: "follow_deploy" },
  { key: "day", operation: "set", value: "monday", expectedRevision: 1 },
  { key: "day", operation: "inherit", value: null, expectedRevision: null },
  { key: "day", operation: "inherit", locked: false, expectedRevision: null },
  { key: "day", operation: "follow_deploy", value: "monday", expectedRevision: null },
  { key: "day", operation: "follow_deploy", locked: true, expectedRevision: null },
  { key: "day", operation: "set", value: "monday", locked: "true", expectedRevision: null },
  { key: "day", operation: "reset", expectedRevision: null },
  ...["set", "inherit", "follow_deploy"].flatMap((operation) =>
    ["via", "actor", "level", "subject", "subjectId", "unexpected"].map((field) => ({
      key: "day", operation, ...(operation === "set" ? { value: "monday" } : {}),
      expectedRevision: null, [field]: "spoofed",
    })),
  ),
];

describe("module change validation", () => {
  it.each(invalid)("refuses invalid change %# before any request", async (change) => {
    const { call, client, tool } = registered();
    tool("update_module_settings");
    await expect(call("update_module_settings", { id: "insights", changes: [change] })).rejects.toThrow();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it.each([".", ".."])('refuses dot-segment module id "%s" before URL normalization can change the route', async (id) => {
    const { call, client, tool } = registered();
    tool("update_module_settings");
    await expect(call("update_module_settings", { id, changes })).rejects.toThrow();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("the real MCP transport preserves valid changes and refuses unknown union fields", async () => {
    const api = backend({ fields: [] });
    const server = buildServer(api as unknown as AxonityClient);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "module-test", version: "0.0.0" });
    try {
      await server.connect(serverSide);
      await client.connect(clientSide);
      const listed = (await client.listTools()).tools;
      expect(listed.map((t) => t.name)).toContain("update_module_settings");
      const schema = listed.find((t) => t.name === "update_module_settings")!.inputSchema;
      expect(Object.keys(schema.properties!).sort()).toEqual(["changes", "id"]);
      const success = await client.callTool({ name: "update_module_settings", arguments: {
        id: "a/b", changes, level: "installation", subjectId: "another-user", via: "release", actor: "admin",
      } });
      expect(success.isError).not.toBe(true);
      expect(api.patch).toHaveBeenCalledExactlyOnceWith(
        "/api/v1/modules/a%2Fb/settings", { changes }, { level: "workspace" },
      );
      for (const change of invalid.filter((c) => !("value" in c && c.value === undefined))) {
        const result = await client.callTool({ name: "update_module_settings", arguments: {
          id: "insights", changes: [change],
        } });
        expect(result.isError, JSON.stringify(change)).toBe(true);
      }
      expect(api.patch).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await server.close();
    }
  });
});


describe("module authoring guidance", () => {
  it("makes the generic workspace tools discoverable and keeps field rules in the live schema", () => {
    const section = CONVENTIONS.split("## Modules and settings")[1]?.split("\n## ")[0];
    expect(section).toBeDefined();
    for (const name of NAMES) expect(section).toContain(name);
    expect(section).toMatch(/workspace/i);
    expect(section).toMatch(/schema/i);
    expect(section).toMatch(/immediate/i);
    expect(section).toMatch(/no publication/i);
  });
});
