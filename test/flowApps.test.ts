import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AxonityClient } from "../src/client.js";
import { registerAll } from "../src/index.js";

type Result = { isError?: boolean; content: { text: string }[] };
type Tool = {
  description: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<Result>;
};

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
    expect(tools.has(name), `registered Flow-App tool: ${name}`).toBe(true);
    return tools.get(name)!;
  }
  async function call(name: string, args: Record<string, unknown>) {
    const current = tool(name);
    return current.handler(z.object(current.schema).parse(args));
  }
  return { client, tool, call };
}

const body = (result: Result) => JSON.parse(result.content[0].text);

describe("Flow-App authoring tools", () => {
  it("validates a candidate manifest through the canonical backend route", async () => {
    const result = { valid: false, errors: [{ path: "bundle.ref", message: "does not name this bundle" }] };
    const manifest = {
      schema: "flow-app/v1", slug: "intake-desk", name: "Intake desk", surface: "v1",
      builtBy: "Jane Builder", navigation: { label: "Intake" },
      bundle: { sha256: "a".repeat(64), sourceTree: "b".repeat(40), ref: "wrong" },
    };
    const { call, client, tool } = registered(result);

    expect(body(await call("validate_flow_app_manifest", { manifest }))).toEqual(result);
    expect(client.post).toHaveBeenCalledExactlyOnceWith("/api/v1/apps/manifest/validate", { manifest });
    expect(tool("validate_flow_app_manifest").description).toMatch(/before.*pull request/i);
    expect(tool("validate_flow_app_manifest").description).toMatch(/canonical/i);
  });

  it("reads one page of statuses only for apps visible to the token holder", async () => {
    const page = {
      items: [{ slug: "intake-desk", label: "Intake", hasUserSettings: true }],
      nextCursor: "opaque/+?=", pageSize: 20, hasMore: true,
    };
    const { call, client, tool } = registered(page);

    expect(body(await call("list_flow_app_status", { limit: 20, cursor: "opaque/+?=雪" }))).toEqual(page);
    expect(client.get).toHaveBeenCalledExactlyOnceWith("/api/v1/apps/status", {
      limit: 20, cursor: "opaque/+?=雪",
    });
    expect(tool("list_flow_app_status").description).toMatch(/visible/i);
  });

  it("does not invent a page limit and exposes no authority selector", async () => {
    const { call, client, tool } = registered({ items: [], nextCursor: null });

    await call("list_flow_app_status", {});
    expect(client.get).toHaveBeenCalledWith("/api/v1/apps/status", { limit: undefined, cursor: undefined });
    expect(Object.keys(tool("validate_flow_app_manifest").schema)).toEqual(["manifest"]);
    expect(Object.keys(tool("list_flow_app_status").schema).sort()).toEqual(["cursor", "limit"]);
  });
});

describe("Flow-App entry tools: every value comes from the Flow routes", () => {
  const starter = (n: number) => ({
    buildVersion: `build-${n}`, surface: "v1", kitVersion: `7.${n}.0`,
    contractHash: String(n).repeat(64).slice(0, 64),
    downloadUrl: `https://flow.example.test/api/v1/apps/starter/download/t${n}`,
    expiresAt: "2030-01-01T00:00:00Z",
  });

  it("get_flow_app_starter hands on whatever /apps/starter answers, and a changed answer comes through", async () => {
    for (const n of [1, 2]) {
      const { call, client } = registered(starter(n));
      expect(body(await call("get_flow_app_starter", {}))).toEqual(starter(n));
      expect(client.get).toHaveBeenCalledExactlyOnceWith("/api/v1/apps/starter");
    }
  });

  it("get_flow_app_starter takes no argument and states no version of its own", () => {
    const { tool } = registered();
    expect(Object.keys(tool("get_flow_app_starter").schema)).toEqual([]);
    expect(tool("get_flow_app_starter").description).toMatch(/before writing any file/i);
    // No version number or hash is written into any entry tool: the route owns them.
    for (const name of ["get_flow_app_starter", "get_flow_app_authoring_contract", "check_flow_app_manifest"]) {
      expect(tool(name).description, name).not.toMatch(/\b\d+\.\d+\.\d+\b|[0-9a-f]{40}/);
    }
  });

  it("get_flow_app_authoring_contract hands on /apps/authoring unchanged", async () => {
    const answer = { surface: { surface: "v1", operations: [] }, manifestSchema: { title: "x" }, results: {}, contractHash: "h" };
    const { call, client } = registered(answer);
    expect(body(await call("get_flow_app_authoring_contract", {}))).toEqual(answer);
    expect(client.get).toHaveBeenCalledExactlyOnceWith("/api/v1/apps/authoring");
  });

  it("check_flow_app_manifest posts the manifest to the workspace check and returns its verdict", async () => {
    const verdict = { valid: false, problems: [{ code: "table_not_published", message: "Data table 'notes' is not published." }] };
    const manifest = { schema: "flow-app/v1", slug: "notes", grants: { tables: [{ table: "notes", read: true }] } };
    const { call, client, tool } = registered(verdict);
    expect(body(await call("check_flow_app_manifest", { manifest }))).toEqual(verdict);
    expect(client.post).toHaveBeenCalledExactlyOnceWith("/api/v1/apps/manifest/check", { manifest });
    expect(Object.keys(tool("check_flow_app_manifest").schema)).toEqual(["manifest"]);
  });

  it("a failing route is an error result, not a made-up answer", async () => {
    const { client, call } = registered();
    client.get.mockRejectedValueOnce(new Error("503 The starter package is not part of this build"));
    const result = await call("get_flow_app_starter", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not part of this build/);
  });

  it("none of the entry tools reaches /config/ or /deployment, and none fetches the archive itself", async () => {
    const { forbids } = await import("./denyList.js");
    const paths: { method: string; path: string }[] = [];
    const rec = (method: string) => vi.fn(async (path: string) => { paths.push({ method, path }); return {}; });
    const client = { get: rec("GET"), post: rec("POST"), put: rec("PUT"), patch: rec("PATCH"), del: rec("DELETE") };
    const tools = new Map<string, Tool>();
    registerAll({
      tool: (n: string, d: string, s: z.ZodRawShape, h: Tool["handler"]) => tools.set(n, { description: d, schema: s, handler: h }),
    } as never, client as unknown as AxonityClient);
    for (const name of ["get_flow_app_starter", "get_flow_app_authoring_contract", "check_flow_app_manifest"]) {
      await tools.get(name)!.handler({ manifest: {} });
    }
    expect(paths.map((p) => `${p.method} ${p.path}`).sort()).toEqual([
      "GET /api/v1/apps/authoring", "GET /api/v1/apps/starter", "POST /api/v1/apps/manifest/check",
    ]);
    for (const p of paths) expect(forbids(p.method, p.path), `${p.method} ${p.path}`).toBe(false);
    // The deny list itself still refuses the families, and the one-time archive.
    expect(forbids("GET", "/api/v1/config/environments/sync/apps")).toBe(true);
    expect(forbids("POST", "/api/v1/deployment/commit")).toBe(true);
    expect(forbids("GET", "/api/v1/apps/starter/download/abc")).toBe(true);
  });
});
