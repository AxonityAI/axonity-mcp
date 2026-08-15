import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerAll } from "../src/index.js";

/**
 * Security guard: no registered tool may target a deny-listed route family.
 *
 * The connector must never publish directly, decide an approval, write secrets,
 * mint tokens, or reach the deploy/config surface — those are human-gated or
 * out of scope by design. This drives the REAL registration (`registerAll`) with
 * a recording client, invokes every handler with permissive args, and asserts
 * none of the calls that reach the client match a forbidden pattern. A new tool
 * that crosses the line fails the build.
 *
 * Most entries are method-blind: a path this connector must not touch, it must
 * not touch with any verb. Secrets are the exception, and the reason the guard
 * records a METHOD at all — reading the catalogue is safe by construction (no
 * secrets route returns a value) and is how an agent finds the id a connector's
 * `authConfig.secretId` points at, while writing secret material stays a human
 * act. Blocking the reads too was over-broad, not safe: it is what left an agent
 * asking a human to copy an id out of the UI.
 */

interface Recorded {
  method: string;
  path: string;
}

function recordingClient(calls: Recorded[]) {
  const rec = (method: string) =>
    vi.fn(async (path: string) => {
      calls.push({ method, path });
      return { ok: true };
    });
  return { get: rec("GET"), post: rec("POST"), put: rec("PUT"), patch: rec("PATCH"), del: rec("DELETE") };
}

/** Permissive args so most handlers reach the client regardless of their shape. */
const ARGS: Record<string, unknown> = {
  id: "x",
  workflowId: "x",
  agentId: "x",
  toolId: "x",
  runId: "x",
  approvalId: "x",
  flowId: "x",
  snippetId: "x",
  flowStepId: "x",
  linkId: "x",
  webhookId: "x",
  scheduleId: "x",
  triggerId: "x",
  secretId: "x",
  versionId: "x",
  version: 1,
  majorVersion: 1,
  expectedVersion: 1,
  displayOrder: 0,
  name: "x",
  cronExpr: "0 0 * * *",
  conditionText: "x",
  repeatIntervalMinutes: 5,
  target: "system",
  confirm: true,
  document: {},
  fields: {},
  mutations: [{ type: "add_step", payload: {} }],
  snippetIds: ["a"],
  runIds: ["a"],
  workflows: [{ id: "x", expectedVersion: 1 }],
  functions: [{ name: "f", code: "def f(): pass" }],
  code: "x",
  requests: [{ entityType: "tool", entityId: "x" }],
};

/**
 * A call is forbidden if it hits a route family the connector must never use.
 * A rule with no `methods` forbids every verb.
 *
 * Note: request_publish_* posts to `/publish-approvals` (creating an approval),
 * which is ALLOWED — only the direct publish/approve/secret-write/etc. routes
 * are not.
 */
interface Rule {
  label: string;
  path: RegExp;
  /** Verbs this rule forbids. Omitted means all of them. */
  methods?: string[];
}

const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

const FORBIDDEN: Rule[] = [
  { label: "direct publish/unpublish", path: /\/(publish|unpublish)$/ },
  {
    label: "approve/reject an approval",
    path: /\/publish-approvals\/[^/]+\/(approve|reject)$/,
  },
  // The bulk decision routes exist for the human review UI. Requesting in bulk
  // is fine (/publish-approvals/bulk); DECIDING in bulk is not ours to do.
  { label: "bulk approve/reject", path: /\/publish-approvals\/bulk-(approve|reject)$/ },
  { label: "direct version publish", path: /\/versions\/(publish|unpublish)(\/|$)/ },
  // Writing secret material is a human act — the backend refuses it from a
  // service token too (`forbid_service_token_for_secrets`). Reading the
  // catalogue is not: no route there returns a value. See axonity-mcp#39.
  { label: "secret writes", path: /\/secrets(\/|$)/, methods: WRITE_METHODS },
  { label: "service tokens", path: /\/service-tokens(\/|$)/ },
  { label: "deployment", path: /\/deployment(\/|$)/ },
  // `/config/secrets` lives behind this rule and stays closed to every verb —
  // it is the deploy-time surface, not the tenant's secret catalogue.
  { label: "config / migration surface", path: /\/config\// },
  { label: "arbitrary connector execution", path: /\/tools\/execute-connector$/ },
];

function forbids(method: string, path: string): boolean {
  return FORBIDDEN.some(
    (rule) => rule.path.test(path) && (rule.methods ?? [method]).includes(method),
  );
}

describe("registered surface stays inside its authority boundary", () => {
  it("no tool targets a deny-listed route family", async () => {
    const calls: Recorded[] = [];
    const client = recordingClient(calls);
    const handlers = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      tool: (name: string, _d: string, _s: unknown, h: (a: never) => Promise<unknown>) =>
        handlers.set(name, h as (a: Record<string, unknown>) => Promise<unknown>),
    };

    registerAll(server as never, client as unknown as AxonityClient);
    expect(handlers.size).toBeGreaterThan(100); // the full surface registered

    for (const handler of handlers.values()) {
      try {
        await handler(ARGS);
      } catch {
        /* arg-shape mismatch is fine — we only care about paths that DID fire */
      }
    }

    const violations = calls.filter((c) => forbids(c.method, c.path));
    expect(violations, JSON.stringify(violations, null, 2)).toHaveLength(0);
  });

  it("the guard actually catches a forbidden path (poison check)", () => {
    expect(forbids("POST", "/api/v1/tools/execute-connector")).toBe(true);
    // A stored connector's own execute route — allowed.
    expect(forbids("POST", "/api/v1/tools/abc/execute-connector")).toBe(false);
    // request_publish_* creates an approval — allowed.
    expect(forbids("POST", "/api/v1/publish-approvals")).toBe(false);
  });

  it("secrets are readable and unwritable, by method", () => {
    expect(forbids("GET", "/api/v1/secrets")).toBe(false);
    expect(forbids("GET", "/api/v1/secrets/abc")).toBe(false);

    for (const method of WRITE_METHODS) {
      expect(forbids(method, "/api/v1/secrets"), method).toBe(true);
      expect(forbids(method, "/api/v1/secrets/abc"), method).toBe(true);
    }

    // The deploy-time secret surface stays closed to reads as well.
    expect(forbids("GET", "/api/v1/config/secrets")).toBe(true);
  });
});
