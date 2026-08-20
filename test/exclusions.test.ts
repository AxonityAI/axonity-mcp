import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { PROBE_ARGS as ARGS } from "../src/contract.js";
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
  // A RELEASE decision is the same act one level up, and the rule above cannot
  // see it: its `[^/]+` matches ONE segment, while the release route carries
  // two (`/publish-approvals/release/{id}/approve`). Worth its own rule
  // precisely because it is the biggest decision on the surface — approving a
  // release publishes a whole workflow closure at once (axonity-flow#799).
  {
    label: "approve/reject a release",
    path: /\/publish-approvals\/release\/[^/]+\/(approve|reject)$/,
  },
  // The bulk decision routes exist for the human review UI. Requesting in bulk
  // is fine (/publish-approvals/bulk); DECIDING in bulk is not ours to do.
  { label: "bulk approve/reject", path: /\/publish-approvals\/bulk-(approve|reject)$/ },
  { label: "direct version publish", path: /\/versions\/(publish|unpublish)(\/|$)/ },
  // Writing secret material is a human act — the backend refuses it from a
  // service token too (`forbid_service_token_for_secrets`). Reading the
  // catalogue is not: no route there returns a value. See axonity-mcp#39.
  { label: "secret writes", path: /\/secrets(\/|$)/, methods: WRITE_METHODS },
  // A plan waiting on human review. #45 M9(2) asked for a DECISION on the four
  // run-write routes rather than leaving them an omission, and this is the one
  // that lands on the same line as the publish queue: the step exists because a
  // person was asked to look at the agent's plan before it runs. An agent
  // approving it removes the review it was created to get — and it would often
  // be approving its OWN plan. Supplying input a run asked for is a different
  // act, which is why `answer_run_question` and `send_run_message` ARE here.
  { label: "decide a plan approval", path: /\/steps\/[^/]+\/plan-approval$/ },
  // Re-dispatching a stuck run is `require_admin` on the backend, and a service
  // token is deliberately `role="member"` — so this is not a boundary we are
  // choosing, it is one that cannot be crossed. Recorded rather than left to be
  // rediscovered as a 403 by whoever wonders why there is no tool for it.
  { label: "restart a run (admin-only)", path: /\/runs\/[^/]+\/restart$/ },
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

    // A release: proposing one is ours, deciding it is not. Both spellings are
    // planted here because the single-segment rule above silently misses the
    // release paths, and a boundary rule nobody has seen bite is not a rule.
    expect(forbids("POST", "/api/v1/publish-approvals/release")).toBe(false);
    expect(forbids("GET", "/api/v1/publish-approvals/release/r-1")).toBe(false);
    expect(forbids("POST", "/api/v1/publish-approvals/release/r-1/approve")).toBe(true);
    expect(forbids("POST", "/api/v1/publish-approvals/release/r-1/reject")).toBe(true);
  });

  it("a run can be answered but not decided or restarted (poison check)", () => {
    // Unparking a run by giving it the input it asked for is ours.
    expect(forbids("POST", "/api/v1/runs/r-1/steps/s-1/answer")).toBe(false);
    expect(forbids("POST", "/api/v1/runs/r-1/message")).toBe(false);
    // Deciding a plan a human was asked to review is not.
    expect(forbids("POST", "/api/v1/runs/r-1/steps/s-1/plan-approval")).toBe(true);
    // Neither is re-dispatching a run — `require_admin`, and a service token is
    // always role="member".
    expect(forbids("POST", "/api/v1/runs/r-1/restart")).toBe(true);
    // The restart rule must not swallow the RESTORE routes it looks like.
    expect(forbids("POST", "/api/v1/workflows/w-1/restore")).toBe(false);
    expect(forbids("POST", "/api/v1/skills/s-1/versions/v-1/restore-deleted")).toBe(
      false,
    );
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
