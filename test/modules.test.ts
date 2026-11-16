import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AxonityClient } from "../src/client.js";
import { collectCalledRoutes } from "../src/contract.js";
import { errorForStatus } from "../src/errors.js";
import { TOKEN_ROUTE_CLASSES } from "../src/generated/tokenRouteClasses.js";
import { buildServer, registerAll, registerHosted } from "../src/index.js";
import {
  RUN_ACTIONS,
  forPersonalTokens,
  recordTools,
  routesPerTool,
} from "../src/routeClasses.js";
import { CONVENTIONS } from "../src/tools/conventions.js";
import { FORBIDDEN, forbids } from "./denyList.js";

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


// Prepared against the whole real R1 app export. Execution is pending the
// coordinator's resource gate; this is not evidence of a passing contract.
const moduleSnapshot = JSON.parse(readFileSync(
  new URL("./fixtures/openapi.snapshot.json", import.meta.url), "utf8",
));
describe("the real R1 backend module contract", () => {
  it("declares all four generic routes and the Page envelope", () => {
    const paths = moduleSnapshot.paths;
    expect(paths["/api/v1/modules"].get.responses["200"].content["application/json"].schema.$ref)
      .toBe("#/components/schemas/Page_ModuleResponse_");
    expect(paths["/api/v1/modules/{module_id}/settings/schema"].get).toBeDefined();
    expect(paths["/api/v1/modules/{module_id}/settings"].get).toBeDefined();
    expect(paths["/api/v1/modules/{module_id}/settings"].patch).toBeDefined();
  });

  it("pins strict changes, explicit value and nullable required revision to the backend", () => {
    const schemas = moduleSnapshot.components.schemas;
    for (const name of ["SetSetting", "InheritSetting", "FollowDeploySetting"]) {
      expect(schemas[name].additionalProperties).toBe(false);
      expect(schemas[name].required).toContain("expectedRevision");
      expect(schemas[name].properties.expectedRevision.anyOf).toContainEqual({ type: "null" });
    }
    expect(schemas.SetSetting.required).toContain("value");
    expect(schemas.SetSetting.properties.locked.type).toBe("boolean");
    for (const name of ["InheritSetting", "FollowDeploySetting"]) {
      expect(schemas[name].properties).not.toHaveProperty("value");
      expect(schemas[name].properties).not.toHaveProperty("locked");
    }
  });

  it("describes the actual response item fields, including nested source records", () => {
    const { tool } = registered();
    const requiredFields = (schema: string) => moduleSnapshot.components.schemas[schema].required as string[];
    for (const key of requiredFields("ModuleResponse")) {
      expect(tool("list_modules").description, key).toContain(key);
    }
    expect(tool("list_modules").description).toContain("emergencyStopped");
    for (const key of requiredFields("ModuleSettingsSchemaResponse")) {
      expect(tool("read_module_settings_schema").description, key).toContain(key);
    }
    for (const key of requiredFields("HttpSettingField")) {
      expect(tool("read_module_settings_schema").description, key).toContain(key);
    }
    for (const name of ["read_module_settings", "update_module_settings"]) {
      for (const key of requiredFields("ModuleSettingResponse")) expect(tool(name).description, key).toContain(key);
      for (const key of Object.keys(moduleSnapshot.components.schemas.SettingSource.properties)) {
        expect(tool(name).description, `source.${key}`).toContain(key);
      }
    }
  });

  // The enumeration above checks the REQUIRED keys only, so a field the backend
  // added with a default (`humanOnly`, `group`, `choiceLabels`: Mail, R2.2)
  // went unnamed. Every property the schema declares is named.
  it("names every property a setting field and a nested value field can carry", () => {
    const { tool } = registered();
    const schemas = moduleSnapshot.components.schemas;
    const text = tool("read_module_settings_schema").description;
    for (const key of Object.keys(schemas.HttpSettingField.properties)) {
      expect(text, `HttpSettingField.${key}`).toContain(key);
    }
    const nested = text.split("fields and item describe nested")[1] ?? "";
    for (const key of Object.keys(schemas.HttpSettingValueField.properties)) {
      expect(nested, `HttpSettingValueField.${key}`).toContain(key);
    }
  });
});


describe("personal module settings boundary", () => {
  it.each([
    ["GET", "/api/v1/me/settings/sample"],
    ["PATCH", "/api/v1/me/settings/sample"],
    ["GET", "/api/v1/modules/sample/settings/resolved"],
  ])("forbids the human-only operation %s %s", (method, path) => {
    expect(forbids(method, path)).toBe(true);
  });

  it("covers exactly the three human-only operations in the actual snapshot", () => {
    const rules = FORBIDDEN.filter((rule) => rule.label.startsWith("personal module settings"));
    const operations = Object.entries(moduleSnapshot.paths).flatMap(([path, item]) =>
      Object.keys(item as object).filter((method) => rules.some((rule) =>
        rule.path.test(path) && rule.methods?.includes(method.toUpperCase()),
      )).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(operations.sort()).toEqual([
      "GET /api/v1/me/settings/{module_id}",
      "GET /api/v1/modules/{module_id}/settings/resolved",
      "PATCH /api/v1/me/settings/{module_id}",
    ]);
  });

  it.each([
    ["GET", "/api/v1/modules"],
    ["GET", "/api/v1/modules/sample/settings/schema"],
    ["GET", "/api/v1/modules/sample/settings"],
    ["PATCH", "/api/v1/modules/sample/settings"],
    ["POST", "/api/v1/me/settings/sample"],
    ["PUT", "/api/v1/me/settings/sample"],
    ["DELETE", "/api/v1/me/settings/sample"],
    ["PATCH", "/api/v1/modules/sample/settings/resolved"],
    ["GET", "/api/v1/modules/sample/settings/resolved-extra"],
    ["GET", "/api/v1/me/settings/sample/extra"],
  ])("does not broaden the boundary to %s %s", (method, path) => {
    expect(forbids(method, path)).toBe(false);
  });
});


// B84 (axonity-flow#1826): a personal token of an administrator writes workspace
// settings with its person's rights; a service token needs the author scope;
// installation, role and personal settings stay with a person in the browser.
describe("who may write module settings, and where the tools stop", () => {
  const write = () => registered().tool("update_module_settings").description;

  it("names both token kinds that may write the workspace level", () => {
    expect(write()).toMatch(/service token with the author scope/i);
    expect(write()).toMatch(/personal token/i);
    expect(write()).toMatch(/owner is an administrator/i);
    expect(write()).toMatch(/with that person's rights/i);
  });

  it("says installation, role and personal settings are never written through a token", () => {
    expect(write()).toMatch(/installation, role and personal settings/i);
    expect(write()).toMatch(/person in Axonity/i);
  });

  it("the conventions repeat both token kinds, without a second rule set", () => {
    const section = CONVENTIONS.split("## Modules and settings")[1].split("\n## ")[0];
    expect(section).toMatch(/personal token/i);
    expect(section).toMatch(/author scope/i);
  });

  async function hostedDescriptions() {
    const tools = recordTools(registerHosted, {} as AxonityClient);
    const routes = await routesPerTool(registerHosted);
    return new Map(
      forPersonalTokens(tools, routes, TOKEN_ROUTE_CLASSES).map((t) => [t.name, t.description]),
    );
  }

  it("the hosted wording never calls the three reads closed to a personal token", async () => {
    const hosted = await hostedDescriptions();
    for (const name of ["list_modules", "read_module_settings_schema", "read_module_settings"]) {
      expect(hosted.get(name), name).not.toMatch(/^WITH A PERSONAL TOKEN|^NOT AVAILABLE/);
    }
  });

  it.each([
    "GET /api/v1/me/settings/{module_id}",
    "PATCH /api/v1/me/settings/{module_id}",
    "GET /api/v1/modules/{module_id}/settings/resolved",
    "GET /modules/{module_id}/settings",
    "PATCH /modules/{module_id}/settings",
    "PUT /api/v1/platform/modules/{module_id}/emergency-stop",
  ])("the backend's table keeps %s closed to every token (personal, installation)", (key) => {
    expect(TOKEN_ROUTE_CLASSES[key]?.class, key).toBe("dicht");
  });

  // B84: the backend's table lets a personal token write the workspace level as an
  // administrator who left "Run actions" on (class actie_beheerder). The hosted
  // wording is derived from that row, so it says exactly those two conditions.
  it("B84: the backend's table opens the workspace write to a personal token of an administrator", async () => {
    expect(TOKEN_ROUTE_CLASSES["PATCH /api/v1/modules/{module_id}/settings"]?.class).toBe("actie_beheerder");
    const text = (await hostedDescriptions()).get("update_module_settings") ?? "";
    expect(text).not.toMatch(/^NOT AVAILABLE/);
    expect(text).toMatch(/^WITH A PERSONAL TOKEN this needs /);
    expect(text).toContain(`'${RUN_ACTIONS}' switched on`);
    expect(text).toContain("an administrator role in this workspace");
  });

  it("the written description names the Run actions choice a personal token also needs", () => {
    expect(write()).toMatch(/Run actions/);
  });

  // `human_only` (Mail's mailboxes, R2.2): no token of any kind writes such a
  // setting, a personal one of an administrator included, so the sentence that
  // says an administrator's token may write "including admin-classified
  // fields" cannot stand alone. Sources: `domain/module_settings.py`
  // `may_write_setting` (a machine principal with `human_only` is refused before
  // any role is looked at) and `modules/manifest_schema.py` (`human_only`).
  it("says a setting marked humanOnly is written by a person only, whatever the token", () => {
    expect(write()).toMatch(/humanOnly/);
    expect(write()).toMatch(/person in Axonity/i);
    expect(write()).toMatch(/no token/i);
    expect(registered().tool("read_module_settings_schema").description).toMatch(
      /humanOnly[^.]*(person|human)/i,
    );
  });
});
