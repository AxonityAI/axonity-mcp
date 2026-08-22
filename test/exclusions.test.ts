import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { PROBE_ARGS as ARGS } from "../src/contract.js";
import { registerAll } from "../src/index.js";
import { WRITE_METHODS, forbids } from "./denyList.js";

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

  /**
   * Four run routes that need no judgement — only writing down. Each was an
   * omission until now, which reads identically to "we have not got to it yet"
   * and sends the next reader to rediscover a 403 or an empty list.
   */
  it("the run routes that CANNOT be ours are recorded, not merely absent", () => {
    // Admin-gated on the backend; a service token is always role="member".
    expect(forbids("POST", "/api/v1/runs/bulk/stop")).toBe(true);
    expect(forbids("GET", "/api/v1/runs/storage")).toBe(true);
    // The member path to stopping a run is not missing — it is cancel_run.
    expect(forbids("POST", "/api/v1/runs/r-1/cancel")).toBe(false);

    // Authenticated by an email/WhatsApp adapter's own credential plus the
    // reply secret from the outbound message — not a service-token caller.
    expect(forbids("POST", "/api/v1/runs/r-1/channel-reply")).toBe(true);
    // Supplying a turn from HERE is a different act, and stays ours.
    expect(forbids("POST", "/api/v1/runs/r-1/message")).toBe(false);

    // A retired placeholder that always answers `[]`.
    expect(forbids("GET", "/api/v1/runs/r-1/workflow-memory")).toBe(true);
    // Session memory is real and readable — the rule must not swallow it.
    expect(forbids("GET", "/api/v1/runs/r-1/session-memory")).toBe(false);
    expect(forbids("GET", "/api/v1/runs/r-1/session-memory/f-1")).toBe(false);
  });

  /**
   * The #59 rules, each with the near-miss it must NOT swallow. Three of these
   * split a family by METHOD rather than by path, which is the shape most
   * likely to go quietly wrong: a rule that widens from "writes" to "the whole
   * family" takes working tools with it and nothing else would notice, because
   * the operation stays *decided* either way.
   */
  it("the #59 boundaries cut where they are meant to (poison check)", () => {
    // Templates: readable, not creatable (create is admin-only).
    expect(forbids("GET", "/api/v1/templates")).toBe(false);
    expect(forbids("GET", "/api/v1/templates/t-1")).toBe(false);
    expect(forbids("GET", "/api/v1/workflow-templates")).toBe(false);
    expect(forbids("POST", "/api/v1/templates")).toBe(true);
    // Instantiating a COMPANY from a template is a company write, not a
    // template write — it must stay on the allowed side.
    expect(forbids("POST", "/api/v1/company/from-template")).toBe(false);

    // Tenant settings: read the effective values, never write them.
    expect(forbids("GET", "/api/v1/tenant-settings/model-tier-map")).toBe(false);
    expect(forbids("GET", "/api/v1/tenant-settings/concurrency-status")).toBe(false);
    expect(forbids("PATCH", "/api/v1/tenant-settings/model-tier-map")).toBe(true);
    // And the whole-tenant bundle stays shut in both directions.
    expect(forbids("GET", "/api/v1/tenant/export")).toBe(true);
    expect(forbids("POST", "/api/v1/tenant/import")).toBe(true);

    // The task queue is readable and unactionable.
    expect(forbids("GET", "/api/v1/task-queue")).toBe(false);
    expect(forbids("GET", "/api/v1/task-queue/t-1")).toBe(false);
    expect(forbids("GET", "/api/v1/task-queue/export")).toBe(false);
    expect(forbids("POST", "/api/v1/task-queue/purge")).toBe(true);
    expect(forbids("POST", "/api/v1/task-queue/t-1/replay")).toBe(true);
    // The queues screen's own reads are a different family and stay open.
    expect(forbids("GET", "/api/v1/queues/overview")).toBe(false);
    expect(forbids("GET", "/api/v1/queues/runs")).toBe(false);

    // Someone's notifications are theirs, in both directions.
    expect(forbids("GET", "/api/v1/notifications")).toBe(true);
    expect(forbids("POST", "/api/v1/notifications/n-1/read")).toBe(true);

    // Firing a webhook by its token is out; the trigger ROWS stay ours, and the
    // rule is anchored so the three trigger families are not caught by it.
    expect(forbids("POST", "/api/v1/triggers/tok-1")).toBe(true);
    expect(forbids("GET", "/api/v1/workflows/w-1/webhook-triggers")).toBe(false);
    expect(forbids("POST", "/api/v1/webhook-triggers/wh-1/rotate")).toBe(false);
    expect(forbids("PATCH", "/api/v1/conditional-triggers/ct-1")).toBe(false);
    expect(forbids("POST", "/api/v1/cron-schedules/cs-1/run-now")).toBe(false);

    // The Builder chat surface, and the run tools that must survive beside it.
    expect(forbids("GET", "/api/v1/conversations")).toBe(true);
    expect(forbids("GET", "/api/v1/folders/f-1/files")).toBe(true);
    expect(forbids("POST", "/api/v1/runs/r-1/end-conversation")).toBe(true);
    expect(forbids("POST", "/api/v1/runs/r-1/message")).toBe(false);
    expect(forbids("GET", "/api/v1/runs/r-1/session-memory/f-1")).toBe(false);

    // Scheduler plumbing is closed; reading why a run is parked is not.
    expect(forbids("POST", "/api/v1/admin/wake-tasks")).toBe(true);
    expect(forbids("GET", "/api/v1/runs/r-1/waiting-on")).toBe(false);
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
