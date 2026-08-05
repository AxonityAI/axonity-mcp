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
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, { properties?: Record<string, { enum?: string[] }> }> };
};

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

    const ARGS: Record<string, unknown> = {
      id: "x", workflowId: "x", agentId: "x", toolId: "x", runId: "x", approvalId: "x",
      flowId: "x", snippetId: "x", flowStepId: "x", linkId: "x", webhookId: "x",
      scheduleId: "x", triggerId: "x", versionId: "x", version: 1, majorVersion: 1,
      expectedVersion: 1, displayOrder: 0, name: "x", cronExpr: "0 0 * * *",
      conditionText: "x", repeatIntervalMinutes: 5, target: "system", confirm: true,
      document: {}, fields: {}, mutations: [{ type: "add_step", payload: {} }],
      snippetIds: ["a"], runIds: ["a"], workflows: [{ id: "x", expectedVersion: 1 }],
      functions: [{ name: "f", code: "def f(): pass" }], code: "x",
      requests: [{ entityType: "tool", entityId: "x" }],
    };

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
   * The gap that let axonity-flow#802 ship: apply_workflow_mutations names every
   * valid command type in its description, the backend's boundary enum was
   * hand-maintained and three narrower, and no test compared the two. So the
   * tool advertised add_decision_condition, attach_output_schema and
   * detach_output_schema while the route answered 422 for all three.
   *
   * #808 derives the enum from the handler registry on the backend side. This is
   * the other half: the description and the schema are compared directly, so
   * neither a type we stop advertising nor one the backend drops can pass
   * unnoticed. Parsed from the live description rather than a second hand-kept
   * list here — a copy would drift exactly the way the original did.
   */
  it("every mutation type the tool advertises exists in the schema, and vice versa", () => {
    const descriptions = new Map<string, string>();
    const server = {
      tool: (name: string, description: string) => descriptions.set(name, description),
    };
    registerAll(server as never, {} as unknown as AxonityClient);

    const description = descriptions.get("apply_workflow_mutations");
    expect(description, "apply_workflow_mutations is not registered").toBeDefined();

    const advertised = description!
      .match(/Valid types: ([^.]+)\./)?.[1]
      .split(",")
      .map((t) => t.replace(/\s+/g, ""))
      .filter(Boolean);
    expect(advertised, "could not parse the 'Valid types:' list").toBeDefined();

    const schemaTypes =
      snapshot.components.schemas.WorkflowMutationRequest?.properties?.type?.enum;
    expect(schemaTypes, "WorkflowMutationRequest.type has no enum").toBeDefined();

    expect([...advertised!].sort()).toEqual([...schemaTypes!].sort());
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
