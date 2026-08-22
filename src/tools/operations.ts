/**
 * What this deploy is, who is in it, and what it is busy with (axonity-mcp#59).
 *
 * Read-only, all of it. These are the questions an agent asks ABOUT the system
 * rather than about a thing it is authoring, and every one of them was
 * previously answered by asking a human to look at a screen.
 *
 * Three earn their place on their own:
 *
 *   - `read_deploy_contract` — the connector already reads `GET /contract` once
 *     at startup (#48) to decide whether the backend has the routes it needs.
 *     An agent could not ask the same question mid-task. "Does this deploy have
 *     X?" is the question this whole repository keeps turning out to be about.
 *   - `list_users` — an `ownerId` is a field on half the memory entities, and
 *     the only way to get one was to have a human copy it out of the UI. That
 *     is exactly the gap `list_secrets` closed for `secretId` (#39).
 *   - `list_audit_events` — it takes `actorKind=service_token`, so an agent can
 *     read back WHAT IT ITSELF DID, narrowed to one credential. Nothing else on
 *     the surface offers that.
 *
 * The WRITES on these families are deliberately absent and recorded in
 * `test/exclusions.test.ts`: purging, replaying, dismissing and releasing queue
 * work are operator acts on the workspace, and notifications are addressed to a
 * person — marking one read is speaking as them.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

/** Filters `GET /task-queue` and its export share, spelled as the routes take them. */
const TASK_FILTERS = {
  state: z.string().optional().describe("Task state to filter on. Omit for all."),
  owner: z.string().optional().describe("Owner id to filter on."),
  workflow: z.string().optional().describe("Workflow id to filter on."),
  batch: z.string().optional().describe("Batch id to filter on."),
  includeDismissed: z
    .boolean()
    .optional()
    .describe("Include dismissed tasks. Defaults to false."),
};

export function registerOperationsTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "read_deploy_contract",
    "What THIS Axonity deploy speaks: its build version, environment, the " +
      "routes it actually mounts, and a hash over them. " +
      "\n\nRead it when a call fails in a way that smells like the backend is " +
      "older or newer than you expect, or before you rely on something recent. " +
      "It is derived from the running app, so it cannot drift from what is " +
      "really there — unlike any list a connector keeps. " +
      "\n\nTenant-agnostic: it describes the deploy, not your data.",
    {},
    async () => guard(async () => jsonResult(await client.get("/api/v1/contract"))),
  );

  server.tool(
    "list_users",
    "List the users in your tenant (alphabetically). This is where an " +
      "`ownerId` comes from — the field on a policy, reference doc or prompt " +
      "snippet that says whose it is. Look it up here rather than asking a " +
      "human to copy one out of the UI. Read-only; this connector cannot " +
      "create, change or remove a user.",
    {},
    async () => guard(async () => jsonResult(await client.get("/api/v1/users"))),
  );

  server.tool(
    "list_audit_events",
    "The tenant's audit trail, newest first — who changed what, and when. " +
      "\n\nPASS actorKind: \"service_token\" TO SEE WHAT EXTERNAL AGENTS DID, " +
      "and serviceTokenId to narrow that to one credential. That is how you " +
      "read back your OWN footprint: what this connector changed in a session, " +
      "without reconstructing it from memory. " +
      "\n\nTHE RESPONSE IS ONE PAGE, NOT THE FULL TRAIL: " +
      "{ items, nextCursor, pageSize, hasMore }. While hasMore is true you have " +
      "not seen every event — pass the response's nextCursor back as cursor and " +
      "repeat until nextCursor is null. Never build a cursor; echo back the one " +
      "you were given.",
    {
      actorKind: z
        .string()
        .optional()
        .describe(
          'Who acted, e.g. "service_token" for external agents. Omit for everyone.',
        ),
      serviceTokenId: z
        .string()
        .optional()
        .describe("Narrow to one credential's actions."),
      entityType: z.string().optional().describe("Only events about this entity type."),
      limit: z.number().int().optional().describe("Page size."),
      cursor: z
        .string()
        .optional()
        .describe(
          "Opaque continuation cursor from the previous response's nextCursor. " +
            "Omit for the first page.",
        ),
    },
    async ({ actorKind, serviceTokenId, entityType, limit, cursor }) =>
      guard(async () =>
        jsonResult(
          await client.get("/api/v1/audit-events", {
            actorKind,
            serviceTokenId,
            entityType,
            limit,
            cursor,
          }),
        ),
      ),
  );

  server.tool(
    "read_queue_overview",
    "The health header for this tenant's queues: how much work is waiting, how " +
      "old the oldest item is, and whether dispatch is alive. One call rather " +
      "than three. " +
      "\n\nRead it when a run you started is not moving — the answer is usually " +
      "here rather than in the run. Note the `dispatch` block's numbers are " +
      "administrator-only and may come back withheld for this token; the rest " +
      "is tenant-scoped and yours.",
    {},
    async () => guard(async () => jsonResult(await client.get("/api/v1/queues/overview"))),
  );

  server.tool(
    "list_in_flight_runs",
    "The tenant's runs that are still going, OLDEST FIRST — the opposite order " +
      "to list_runs, because the oldest in-flight run is the one that is stuck. " +
      "\n\nEvery non-terminal run, EXCEPT archived runs, per-item `for_each` " +
      "sub-runs and Builder conversation runs. So this is 'what is the system " +
      "working on', not 'every row that exists' — for that, list_runs.",
    {
      status: z
        .array(z.string())
        .optional()
        .describe('Statuses to include, e.g. ["running", "waiting"]. Omit for all.'),
      workflow: z.string().optional().describe("Only runs of this workflow."),
      limit: z.number().int().optional().describe("Defaults to 25, max 100."),
      offset: z.number().int().optional().describe("Defaults to 0."),
    },
    async ({ status, workflow, limit, offset }) =>
      guard(async () =>
        jsonResult(
          await client.get("/api/v1/queues/runs", { status, workflow, limit, offset }),
        ),
      ),
  );

  server.tool(
    "read_task_queue_summary",
    "Per-state counts of the tenant's background task queue — the cheap read " +
      "that says whether anything is piling up. Start here; reach for " +
      "list_task_queue only once a count looks wrong.",
    {},
    async () =>
      guard(async () =>
        jsonResult(await client.get("/api/v1/task-queue/dashboard-summary")),
      ),
  );

  server.tool(
    "list_task_queue",
    "The tenant's background task queue, filtered. This is where a failed " +
      "delivery, a dead-lettered wake-up or a stalled batch shows up — the " +
      "layer beneath a run, which read_run cannot see. " +
      "\n\nDismissed tasks are hidden unless includeDismissed is true. " +
      "\n\nThis connector can READ the queue but not act on it: purging, " +
      "replaying, dismissing and releasing are operator acts on the workspace " +
      "and are recorded as out of scope in test/exclusions.test.ts. Report what " +
      "you find to your human rather than looking for another way in.",
    {
      ...TASK_FILTERS,
      limit: z.number().int().optional().describe("Page size."),
      offset: z.number().int().optional().describe("Offset into the list."),
    },
    async ({ state, owner, workflow, batch, includeDismissed, limit, offset }) =>
      guard(async () =>
        jsonResult(
          await client.get("/api/v1/task-queue", {
            state,
            owner,
            workflow,
            batch,
            include_dismissed: includeDismissed,
            limit,
            offset,
          }),
        ),
      ),
  );

  server.tool(
    "read_task_queue_item",
    "One background task in full — its state, its payload and why it is where " +
      "it is. The detail behind a row from list_task_queue.",
    { taskId: z.string().describe("The task's id, from list_task_queue.") },
    async ({ taskId }) =>
      guard(async () => jsonResult(await client.get(`/api/v1/task-queue/${taskId}`))),
  );

  server.tool(
    "export_task_queue",
    "The same rows list_task_queue returns, as one JSON export, for when you " +
      "want to reason over a whole filtered set at once rather than page " +
      "through it. " +
      "\n\nIt is CAPPED at the backend's export limit and does not paginate: a " +
      "filter that matches more rows than the cap returns the cap, and there is " +
      "no continuation. Narrow with the filters instead of hoping — a truncated " +
      "export looks exactly like a complete one.",
    TASK_FILTERS,
    async ({ state, owner, workflow, batch, includeDismissed }) =>
      guard(async () =>
        jsonResult(
          await client.get("/api/v1/task-queue/export", {
            state,
            owner,
            workflow,
            batch,
            include_dismissed: includeDismissed,
          }),
        ),
      ),
  );

  // ---- Tenant settings, read-only ---------------------------------------

  server.tool(
    "read_model_tier_map",
    "What this tenant's capability tiers actually RESOLVE TO — which model " +
      "backs `economy`, `standard`, `smart` and `reasoning`. " +
      "\n\nRead it before you set an agent's `capabilityTier`: the tier is the " +
      "field you write, but the model is what you are choosing, and the mapping " +
      "is per-tenant with a global fallback. Writing the map is an operator act " +
      "and is not available here.",
    {},
    async () =>
      guard(async () =>
        jsonResult(await client.get("/api/v1/tenant-settings/model-tier-map")),
      ),
  );

  server.tool(
    "read_concurrency_status",
    "How many runs are going right now against this tenant's cap — the live " +
      "answer to 'is my run queued because the tenant is full?'. Read this " +
      "before concluding a workflow is broken.",
    {},
    async () =>
      guard(async () =>
        jsonResult(await client.get("/api/v1/tenant-settings/concurrency-status")),
      ),
  );

  server.tool(
    "read_concurrent_run_cap",
    "The tenant's effective ceiling on runs going at once. The cap alone; " +
      "read_concurrency_status pairs it with what is actually running. Changing " +
      "it is an operator act and is not available here.",
    {},
    async () =>
      guard(async () =>
        jsonResult(await client.get("/api/v1/tenant-settings/concurrent-run-cap")),
      ),
  );

  server.tool(
    "read_for_each_rate",
    "The tenant's default ceiling on how many FOR EACH items may start per " +
      "minute. This is why a fan-out over thousands of rows paces itself rather " +
      "than stalling — read it before you call a slow batch a bug. Changing it " +
      "is an operator act and is not available here.",
    {},
    async () =>
      guard(async () =>
        jsonResult(await client.get("/api/v1/tenant-settings/for-each-rate")),
      ),
  );
}
