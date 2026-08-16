import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerAll } from "../src/index.js";

/**
 * Drift guard (axonity-mcp#17, contract from axonity-flow#722, Option 1).
 *
 * The backend's OpenAPI schema is the single source of truth for the authoring
 * surface. This test pins the MCP to a vendored snapshot of it and fails if:
 *   1. any route path+method a tool calls no longer exists in the schema
 *      (a renamed/removed/retyped backend route), or
 *   2. an enum the operability guide documents diverges from the schema.
 *
 * Regenerate the snapshot from axonity-flow with:
 *   python backend/scripts/dump_openapi.py -o <this-repo>/test/fixtures/openapi.snapshot.json
 * (deterministic, no DB needed — see docs/MCP-AUTHORING-CONTRACT.md there).
 */

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/openapi.snapshot.json", import.meta.url)),
    "utf8",
  ),
) as {
  paths: Record<string, Record<string, PathOperation>>;
  components: { schemas: Record<string, { properties?: Record<string, { enum?: string[] }> }> };
};

interface PathOperation {
  parameters?: { name: string; in?: string }[];
  responses?: Record<
    string,
    { content?: { "application/json"?: { schema?: { $ref?: string } } } }
  >;
}

/** Split a path into segments, dropping any query string. */
function segs(path: string): string[] {
  return path.split("?")[0].replace(/^\/+|\/+$/g, "").split("/");
}

/** OpenAPI templates for a given method, pre-split, cached. */
const templatesByMethod = new Map<string, string[][]>();
for (const [tmpl, ops] of Object.entries(snapshot.paths)) {
  for (const method of Object.keys(ops)) {
    const m = method.toUpperCase();
    if (!templatesByMethod.has(m)) templatesByMethod.set(m, []);
    templatesByMethod.get(m)!.push(segs(tmpl));
  }
}

/** Does a concrete path match an OpenAPI template for this method? */
function schemaHas(method: string, path: string): boolean {
  const parts = segs(path);
  const templates = templatesByMethod.get(method.toUpperCase()) ?? [];
  return templates.some(
    (t) =>
      t.length === parts.length &&
      t.every((seg, i) => (seg.startsWith("{") && seg.endsWith("}")) || seg === parts[i]),
  );
}

/**
 * One filled-in argument per name any tool takes, so a blind sweep reaches as
 * much of the route surface as possible. A handler that rejects these is simply
 * skipped — only the routes that actually fired are asserted on.
 */
const ARGS: Record<string, unknown> = {
  id: "x", workflowId: "x", agentId: "x", toolId: "x", runId: "x", approvalId: "x",
  flowId: "x", snippetId: "x", flowStepId: "x", linkId: "x", webhookId: "x",
  scheduleId: "x", triggerId: "x", secretId: "x", versionId: "x", version: 1, majorVersion: 1,
  expectedVersion: 1, displayOrder: 0, name: "x", cronExpr: "0 0 * * *",
  conditionText: "x", repeatIntervalMinutes: 5, target: "system", confirm: true,
  document: {}, fields: {}, mutations: [{ type: "add_step", payload: {} }],
  snippetIds: ["a"], runIds: ["a"], workflows: [{ id: "x", expectedVersion: 1 }],
  functions: [{ name: "f", code: "def f(): pass" }], code: "x",
  requests: [{ entityType: "tool", entityId: "x" }],
};

describe("MCP route surface conforms to the backend OpenAPI snapshot", () => {
  it("every route a tool calls exists in the schema (path + method)", async () => {
    const calls: { method: string; path: string }[] = [];
    const rec = (method: string) =>
      vi.fn(async (path: string) => {
        calls.push({ method, path });
        return { ok: true };
      });
    const client = { get: rec("GET"), post: rec("POST"), put: rec("PUT"), patch: rec("PATCH"), del: rec("DELETE") };
    const handlers = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      tool: (name: string, _d: string, _s: unknown, h: (a: never) => Promise<unknown>) =>
        handlers.set(name, h as (a: Record<string, unknown>) => Promise<unknown>),
    };
    registerAll(server as never, client as unknown as AxonityClient);

    for (const handler of handlers.values()) {
      try {
        await handler(ARGS);
      } catch {
        /* arg-shape mismatch is fine — only paths that fired are checked */
      }
    }

    const unknown = calls.filter((c) => !schemaHas(c.method, c.path));
    expect(unknown, `routes not found in OpenAPI:\n${JSON.stringify(unknown, null, 2)}`).toEqual(
      [],
    );
    // Sanity: the harness actually exercised a broad surface.
    expect(calls.length).toBeGreaterThan(80);
  });

  it("documented enums match the schema", () => {
    const enumOf = (model: string, prop: string): string[] | undefined =>
      snapshot.components.schemas[model]?.properties?.[prop]?.enum;

    expect(enumOf("CreateAgentRequest", "capabilityTier")).toEqual([
      "economy",
      "standard",
      "smart",
      "reasoning",
    ]);
    expect(enumOf("CreateAgentRequest", "creativityTier")).toEqual(["low", "medium", "high"]);
    expect(enumOf("CreateAgentRequest", "learningMode")).toEqual(["none", "adaptive", "strict"]);
    expect(enumOf("CreateToolRequest", "type")).toEqual([
      "function",
      "connector",
      "validator",
      "evaluator",
    ]);
    expect(enumOf("AttachSnippetRequest", "target")).toEqual(["system", "user"]);
  });

  /**
   * The gap that let axonity-flow#802 ship: apply_workflow_mutations named every
   * valid command type in its description, the backend's boundary enum was
   * hand-maintained and three narrower, and no test compared the two. So the
   * tool advertised add_decision_condition, attach_output_schema and
   * detach_output_schema while the route answered 422 for all three.
   *
   * That was guarded by pinning the prose to the schema enum. It is now closed
   * one level down instead: the connector states no vocabulary at all and reads
   * `GET /workflows/operations` (#8, axonity-flow#802 B4). A list you do not keep
   * cannot drift, so the pin has nothing left to compare — and this test guards
   * the property that replaced it. Re-introducing a hand-kept list would
   * silently re-open #32, so the absence is asserted rather than assumed.
   */
  it("the connector states no mutation vocabulary of its own", () => {
    const descriptions = new Map<string, string>();
    const server = {
      tool: (name: string, description: string) => descriptions.set(name, description),
    };
    registerAll(server as never, {} as unknown as AxonityClient);

    const description = descriptions.get("apply_workflow_mutations");
    expect(description, "apply_workflow_mutations is not registered").toBeDefined();
    expect(description).toContain("get_workflow_authoring_spec");
    expect(description, "a hand-kept type list is back — see #32").not.toMatch(
      /Valid types:/,
    );

    // Naming a command to state its BEHAVIOUR is guidance the schemas do not
    // carry ("add_step builds a complete step in one call") and must stay. What
    // must not come back is an ENUMERATION — commands strung together by commas,
    // which is a claim about what exists and the exact thing that went stale.
    // So the guard is on the shape, not on a count of mentions.
    const schemaTypes =
      snapshot.components.schemas.WorkflowMutationRequest?.properties?.type?.enum ?? [];
    expect(schemaTypes.length, "the enum vanished — check the snapshot").toBeGreaterThan(
      10,
    );

    const alternation = schemaTypes.join("|");
    const enumeration = new RegExp(`(${alternation})(,\\s*(${alternation})){2,}`);

    // The guard bites: this is the shape the old description had.
    expect(
      "Valid types: update_workflow, add_trigger, add_step, add_edge.".match(enumeration),
    ).not.toBeNull();

    for (const [name, text] of descriptions) {
      const found = text.match(enumeration)?.[0];
      expect(
        found,
        `${name} lists the mutation vocabulary ("${found}") — read it from ` +
          "get_workflow_authoring_spec instead (#32)",
      ).toBeUndefined();
    }
  });

  /**
   * axonity-flow#811/#816 — no paged route may be consumed as if it were a list.
   *
   * #822 converted `GET /workflows/{id}/runs` to the `Page` envelope and #816
   * is bringing the same treatment to the remaining list endpoints, one at a
   * time. Each conversion is invisible to a pass-through tool: nothing crashes,
   * the tool just starts answering with page 1 of N and no way to say so (#37).
   *
   * So the guard is on the SNAPSHOT, not on a list we maintain: whenever a
   * route the MCP calls starts returning a `Page_*`, the tool that calls it
   * must expose a cursor. A converted endpoint we have not caught up with
   * fails here, at snapshot-refresh time, instead of in a tenant.
   */
  it("every paged route the MCP calls is called by a cursor-aware tool", async () => {
    // Which routes each tool touches, recorded per tool rather than in bulk.
    const perTool = new Map<string, { method: string; path: string }[]>();
    const descriptions = new Map<string, string>();
    const schemas = new Map<string, Record<string, unknown>>();
    let current = "";

    const rec = (method: string) =>
      vi.fn(async (path: string) => {
        perTool.get(current)?.push({ method, path });
        return { ok: true };
      });
    const client = { get: rec("GET"), post: rec("POST"), put: rec("PUT"), patch: rec("PATCH"), del: rec("DELETE") };
    const handlers = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      tool: (name: string, d: string, s: Record<string, unknown>, h: (a: never) => Promise<unknown>) => {
        handlers.set(name, h as (a: Record<string, unknown>) => Promise<unknown>);
        descriptions.set(name, d);
        schemas.set(name, s);
      },
    };
    registerAll(server as never, client as unknown as AxonityClient);

    for (const [name, handler] of handlers) {
      current = name;
      perTool.set(name, []);
      try {
        await handler(ARGS);
      } catch {
        /* arg-shape mismatch is fine — only the routes that fired are checked */
      }
    }

    /** The OpenAPI operation for a concrete path, if the snapshot has one. */
    const operationFor = (method: string, path: string): PathOperation | undefined => {
      const parts = segs(path);
      for (const [tmpl, ops] of Object.entries(snapshot.paths)) {
        const t = segs(tmpl);
        const matches =
          t.length === parts.length &&
          t.every((seg, i) => (seg.startsWith("{") && seg.endsWith("}")) || seg === parts[i]);
        if (matches && ops[method.toLowerCase()]) return ops[method.toLowerCase()];
      }
      return undefined;
    };

    const offenders: string[] = [];
    let pagedRoutesSeen = 0;

    for (const [name, calls] of perTool) {
      for (const { method, path } of calls) {
        const op = operationFor(method, path);
        const ref = op?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref ?? "";
        if (!ref.includes("/Page_")) continue;
        pagedRoutesSeen++;

        // The route is paged. The tool must let a caller ask for the next page
        // AND tell them there is one.
        const takesCursor = "cursor" in (schemas.get(name) ?? {});
        const saysSo = /nextCursor/.test(descriptions.get(name) ?? "");
        if (!takesCursor || !saysSo) {
          offenders.push(
            `${name} calls paged ${method} ${path} (${ref.split("/").pop()}) but ` +
              `${!takesCursor ? "takes no cursor argument" : "never mentions nextCursor"}`,
          );
        }
      }
    }

    expect(offenders, offenders.join("\n")).toEqual([]);
    // The sweep must actually have reached a paged route, or this passes vacuously.
    expect(pagedRoutesSeen).toBeGreaterThan(0);
  });

  it("both validation routes resolve (the harness cannot reach them)", () => {
    // validate_workflow takes EXACTLY ONE of workflowId/document, and the shared
    // ARGS fixture supplies both — so the handler rejects the call and neither
    // route fires in the sweep above. Assert them directly rather than let two
    // routes quietly drop out of the drift guard.
    expect(schemaHas("POST", "/api/v1/workflows/validate")).toBe(true);
    expect(schemaHas("POST", "/api/v1/workflows/wf-1/validate")).toBe(true);
  });

  it("the matcher is sound (rejects a made-up route, accepts a real one)", () => {
    expect(schemaHas("GET", "/api/v1/agents/x/skills-v2")).toBe(true);
    expect(schemaHas("POST", "/api/v1/publish-approvals")).toBe(true);
    expect(schemaHas("GET", "/api/v1/does-not-exist")).toBe(false);
    expect(schemaHas("DELETE", "/api/v1/agents")).toBe(false); // no such method on collection
  });
});
