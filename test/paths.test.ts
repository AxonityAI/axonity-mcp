import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AxonityClient } from "../src/client.js";
import { pathId, seg } from "../src/ids.js";
import { registerAll } from "../src/index.js";

/**
 * An id is ONE path segment. Whatever an agent passes as an id — copied from a
 * run's output, a table row, a document — must not be able to step out of
 * that segment and make a tool call a different route than the one the person
 * approved. Two layers hold that: every id is encoded into its segment
 * (`seg`), and the client refuses any path that would still resolve somewhere
 * else, or that the connector's own deny-list forbids.
 */

const CONFIG = { apiUrl: "https://api.test", token: "axs_secret" };

function okFetch() {
  return vi.fn(async () =>
    ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }) as unknown as Response,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the client refuses a path that leaves its route", () => {
  const bad = [
    "/api/v1/runs/../publish-approvals/a1/approve",
    "/api/v1/runs/%2e%2e/publish-approvals/a1/approve",
    "/api/v1/runs/%2E%2E/x",
    "/api/v1/runs/./x",
    "/api/v1/runs/a?/cancel",
    "/api/v1/runs/a#/cancel",
    "/api/v1/runs//cancel",
    "/api/v1/runs/a\\..\\b",
    "/api/v1/runs/a b",
  ];
  for (const path of bad) {
    it(`refuses ${JSON.stringify(path)} without calling the API`, async () => {
      const fetchMock = okFetch();
      vi.stubGlobal("fetch", fetchMock);
      await expect(new AxonityClient(CONFIG).post(path)).rejects.toThrow(/path/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("refuses a route the connector's deny-list forbids, at run time", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const client = new AxonityClient(CONFIG);
    await expect(client.post("/api/v1/runs/r1/steps/s1/plan-approval")).rejects.toThrow(
      /not allowed/i,
    );
    await expect(client.post("/api/v1/publish-approvals/a1/approve")).rejects.toThrow(
      /not allowed/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still sends an ordinary path, with an encoded segment and a query", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    await new AxonityClient(CONFIG).get(`/api/v1/runs/${seg("a b?c")}`, { limit: 2 });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.test/api/v1/runs/a%20b%3Fc?limit=2");
  });
});

describe("one id schema and one encoder", () => {
  it("pathId refuses an empty id and a dot segment", () => {
    for (const value of ["", ".", ".."]) expect(pathId.safeParse(value).success, value).toBe(false);
    expect(pathId.safeParse("3f2a-uuid").success).toBe(true);
  });

  it("seg encodes and refuses what encoding cannot make safe", () => {
    expect(seg("a/b?c#d")).toBe("a%2Fb%3Fc%23d");
    expect(seg("%2e%2e")).toBe("%252e%252e");
    expect(seg(3)).toBe("3");
    for (const value of ["", ".", ".."]) expect(() => seg(value), value).toThrow();
  });
});

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean }>;

function surface() {
  const handlers = new Map<string, Handler>();
  const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
  const server = {
    tool: (name: string, _d: string, ...rest: unknown[]) => {
      handlers.set(name, rest[rest.length - 1] as Handler);
      if (rest.length >= 2) schemas.set(name, rest[rest.length - 2] as Record<string, z.ZodTypeAny>);
    },
    prompt: () => undefined,
    resource: () => undefined,
    registerPrompt: () => undefined,
    registerResource: () => undefined,
  };
  const client = new AxonityClient(CONFIG);
  registerAll(server as never, client);
  return { handlers, schemas };
}

/** One tool per family, with the argument that is the id. */
const FAMILIES: { tool: string; idArg: string; args: Record<string, unknown> }[] = [
  { tool: "read_workflow", idArg: "id", args: {} },
  { tool: "update_skill", idArg: "id", args: { expectedVersion: 1, fields: { name: "x" } } },
  { tool: "cancel_run", idArg: "runId", args: { confirm: "CONFIRM" } },
  { tool: "delete_run", idArg: "runId", args: { confirm: "CONFIRM" } },
  { tool: "read_secret", idArg: "secretId", args: {} },
  { tool: "list_workflow_versions", idArg: "id", args: {} },
  { tool: "list_cron_schedules", idArg: "workflowId", args: {} },
  { tool: "list_toolbox_agents", idArg: "toolboxId", args: {} },
  { tool: "read_fact", idArg: "id", args: {} },
  { tool: "list_application_knowledge", idArg: "id", args: {} },
  { tool: "list_data_table_rows", idArg: "tableId", args: {} },
  { tool: "update_connector", idArg: "id", args: { expectedVersion: 1, fields: { name: "x" } } },
  { tool: "read_module_settings_schema", idArg: "id", args: {} },
];

describe("no tool can be pointed at another route through its id", () => {
  const { handlers } = surface();

  it("knows every family it tests", () => {
    for (const f of FAMILIES) expect(handlers.has(f.tool), f.tool).toBe(true);
  });

  for (const f of FAMILIES) {
    for (const hostile of ["..", "%2e%2e", "", "x/../../publish-approvals/a1/approve"]) {
      it(`${f.tool} refuses or contains ${JSON.stringify(hostile)}`, async () => {
        const fetchMock = okFetch();
        vi.stubGlobal("fetch", fetchMock);
        await handlers.get(f.tool)!({ ...f.args, [f.idArg]: hostile });
        for (const [url] of fetchMock.mock.calls as unknown as [string][]) {
          // The hostile text may still be IN the path, but only inside one
          // encoded segment: no segment of its own is a dot step or the
          // route it tried to reach.
          const segments = new URL(url).pathname.split("/");
          expect(segments).not.toContain("publish-approvals");
          expect(segments).not.toContain("..");
          expect(segments).not.toContain(".");
          expect(segments).toContain(encodeURIComponent(hostile));
        }
        if (hostile === ".." || hostile === "") expect(fetchMock).not.toHaveBeenCalled();
      });
    }
    for (const hostile of ["a?b", "a#b"]) {
      it(`${f.tool} keeps ${JSON.stringify(hostile)} inside its segment`, async () => {
        const fetchMock = okFetch();
        vi.stubGlobal("fetch", fetchMock);
        await handlers.get(f.tool)!({ ...f.args, [f.idArg]: hostile });
        expect(fetchMock).toHaveBeenCalled();
        for (const [url] of fetchMock.mock.calls as unknown as [string][]) {
          const parsed = new URL(url);
          expect(parsed.hash).toBe("");
          expect(parsed.pathname.split("/")).toContain(encodeURIComponent(hostile));
        }
      });
    }
  }
});

describe("every id argument uses the shared schema", () => {
  const { schemas } = surface();

  it("an id argument refuses an empty id and a dot segment", () => {
    const loose: string[] = [];
    for (const [tool, shape] of schemas) {
      for (const [key, schema] of Object.entries(shape ?? {})) {
        if (!(key === "id" || /[a-z]Id$/.test(key))) continue;
        if (!(schema instanceof z.ZodType)) continue;
        if (!schema.safeParse("abc").success) continue; // not a string id
        if (schema.safeParse("").success || schema.safeParse("..").success) loose.push(`${tool}.${key}`);
      }
    }
    expect(loose).toEqual([]);
  });
});

describe("fields cannot overwrite the fixed fields", () => {
  it("update_connector keeps its own version and type", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { handlers } = surface();
    await handlers.get("update_connector")!({
      id: "t1",
      expectedVersion: 4,
      fields: { expectedVersion: 99, type: "function", name: "x" },
    });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ expectedVersion: 4, type: "connector", name: "x" });
  });

  it("create_connector keeps its own type", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { handlers } = surface();
    await handlers.get("create_connector")!({ fields: { type: "function", name: "x" } });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string).type).toBe("connector");
  });

  it("update_<entity> keeps the version it was given", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { handlers } = surface();
    await handlers.get("update_skill")!({ id: "s1", expectedVersion: 4, fields: { expectedVersion: 99 } });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string).expectedVersion).toBe(4);
  });
});
