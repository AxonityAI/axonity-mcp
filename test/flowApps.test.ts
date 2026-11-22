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
