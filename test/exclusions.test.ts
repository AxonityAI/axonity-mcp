import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerAll } from "../src/index.js";

/**
 * Security guard: no registered tool may target a deny-listed route family.
 *
 * The connector must never publish directly, decide an approval, touch secrets,
 * mint tokens, or reach the deploy/config surface — those are human-gated or
 * out of scope by design. This drives the REAL registration (`registerAll`) with
 * a recording client, invokes every handler with permissive args, and asserts
 * none of the paths that reach the client match a forbidden pattern. A new tool
 * that crosses the line fails the build.
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

// A path is forbidden if it hits a route family the connector must never use.
// Note: request_publish_* posts to `/publish-approvals` (creating an approval),
// which is ALLOWED — only the direct publish/approve/secret/etc. routes are not.
const FORBIDDEN: [string, RegExp][] = [
  ["direct publish/unpublish", /\/(publish|unpublish)$/],
  ["approve/reject an approval", /\/publish-approvals\/[^/]+\/(approve|reject)$/],
  // The bulk decision routes exist for the human review UI. Requesting in bulk
  // is fine (/publish-approvals/bulk); DECIDING in bulk is not ours to do.
  ["bulk approve/reject", /\/publish-approvals\/bulk-(approve|reject)$/],
  ["direct version publish", /\/versions\/(publish|unpublish)(\/|$)/],
  ["secrets", /\/secrets(\/|$)/],
  ["service tokens", /\/service-tokens(\/|$)/],
  ["deployment", /\/deployment(\/|$)/],
  ["config / migration surface", /\/config\//],
  ["arbitrary connector execution", /\/tools\/execute-connector$/],
];

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

    const violations = calls.filter((c) =>
      FORBIDDEN.some(([, re]) => re.test(c.path)),
    );
    expect(violations, JSON.stringify(violations, null, 2)).toHaveLength(0);
  });

  it("the guard actually catches a forbidden path (poison check)", () => {
    const bad = "/api/v1/tools/execute-connector";
    expect(FORBIDDEN.some(([, re]) => re.test(bad))).toBe(true);
    const good = "/api/v1/tools/abc/execute-connector"; // stored connector — allowed
    expect(FORBIDDEN.some(([, re]) => re.test(good))).toBe(false);
    const approvalCreate = "/api/v1/publish-approvals"; // request_publish_* — allowed
    expect(FORBIDDEN.some(([, re]) => re.test(approvalCreate))).toBe(false);
  });
});
