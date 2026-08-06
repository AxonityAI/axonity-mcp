/**
 * Run observability — how an agent evaluates what it built.
 *
 * There is no "findings" endpoint and no evaluator entity. Evaluation means
 * reading runs: the run detail carries `validatorVerdicts` and
 * `agentInvocations`, and the trace carries the step-by-step tool calls. Those
 * are the evidence an agent reasons over.
 *
 * Runs are also the only thing in the product with a real archive state —
 * entities have soft-delete, runs have archive/unarchive.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

const CONFIRM = z
  .literal(true)
  .describe("Must be true. Destructive and irreversible — ask your human first.");

export function registerRunTools(server: McpServer, client: AxonityClient): void {
  server.tool(
    "start_workflow_run",
    "Start a real run of a workflow — the way to TEST a workflow you just " +
      "authored. This EXECUTES: it runs the PUBLISHED workflow against live " +
      "infrastructure (models, connectors), so it can incur cost and cause real " +
      "side effects. It does not run your unpublished draft. After starting, " +
      "follow it with read_run / read_run_trace / read_run_cost. Optionally pass " +
      "triggerInput to feed the workflow's trigger.",
    {
      workflowId: z.string().describe("The workflow's id."),
      triggerInput: z
        .record(z.unknown())
        .optional()
        .describe("Input payload for the workflow's trigger. Omit for none."),
      manualPhases: z
        .boolean()
        .optional()
        .describe("Run with manual phase gating. Defaults to false."),
    },
    async ({ workflowId, triggerInput, manualPhases }) =>
      guard(async () =>
        jsonResult(
          await client.post(`/api/v1/workflows/${workflowId}/runs`, {
            ...(triggerInput ? { triggerInput } : {}),
            ...(manualPhases === undefined ? {} : { manualPhases }),
          }),
        ),
      ),
  );

  server.tool(
    "cancel_run",
    "Cancel an in-flight run. Stops further steps; already-completed steps and " +
      "their side effects are not undone.",
    { runId: z.string().describe("The run's id.") },
    async ({ runId }) =>
      guard(async () => jsonResult(await client.post(`/api/v1/runs/${runId}/cancel`))),
  );

  server.tool(
    "delete_run",
    "Delete ONE run. IRREVERSIBLE — the run and its trace and cost history go " +
      "with it. Prefer archive_run unless a human has asked for deletion. For " +
      "many at once use bulk_delete_runs.",
    {
      runId: z.string().describe("The run's id."),
      confirm: CONFIRM,
    },
    async ({ runId }) =>
      guard(async () => {
        await client.del(`/api/v1/runs/${runId}`);
        return jsonResult({ deleted: true, runId });
      }),
  );

  server.tool(
    "list_runs",
    "List workflow runs across the tenant, newest first. Archived runs are " +
      "excluded unless includeArchived is true. To list runs of ONE workflow, " +
      "use list_workflow_runs instead — this route has no workflow filter." +
      "\n\nTHIS ONE IS NOT PAGED THE SAME WAY: it answers with a BARE ARRAY, " +
      "no envelope, no total and no cursor. You get at most limit rows (default " +
      "50, and a larger value is silently clamped to 200), so a result whose " +
      "length equals the limit you asked for is the signal that MORE MAY EXIST " +
      "— nothing in the response says so. Walk it with offset until you get a " +
      "short page. Unlike list_workflow_runs, this route does list per-item " +
      "FOR EACH runs alongside their launches.",
    {
      status: z
        .string()
        .optional()
        .describe(
          'Comma-separated statuses, e.g. "running,failed". Omit for all.',
        ),
      createdAfter: z.string().optional().describe("ISO date lower bound."),
      createdBefore: z.string().optional().describe("ISO date upper bound."),
      includeArchived: z.boolean().optional().describe("Defaults to false."),
      limit: z
        .number()
        .int()
        .optional()
        .describe(
          "Rows to return. Defaults to 50, silently clamped to 200 — asking " +
            "for more does not fail, it just returns 200.",
        ),
      offset: z
        .number()
        .int()
        .optional()
        .describe(
          "Rows to skip. Defaults to 0. Advance it by the page size to walk " +
            "the whole list; stop when a page comes back short.",
        ),
    },
    async ({ status, createdAfter, createdBefore, includeArchived, limit, offset }) =>
      guard(async () =>
        jsonResult(
          await client.get("/api/v1/runs", {
            status,
            created_after: createdAfter,
            created_before: createdBefore,
            include_archived: includeArchived,
            limit,
            offset,
          }),
        ),
      ),
  );

  server.tool(
    "list_workflow_runs",
    "List one workflow's LAUNCHES, newest first. Note this route takes " +
      "archivedOnly (show ONLY archived launches), which is not the same as " +
      "list_runs' includeArchived." +
      "\n\nTHE RESPONSE IS ONE PAGE, NOT THE FULL LIST: " +
      "{ items, nextCursor, pageSize, hasMore }. Default page size is 20, max " +
      "200. While hasMore is true you have NOT seen every launch — pass the " +
      "response's nextCursor back as cursor to get the next page, and repeat " +
      "until nextCursor is null. Counting or concluding anything (\"how many " +
      "failed?\") from a single page with hasMore: true gives a confidently " +
      "wrong answer." +
      "\n\nA LAUNCH IS NOT A RUN. A launch is what a person or a schedule " +
      "started. The per-item runs a FOR EACH creates live INSIDE their launch " +
      "and never appear here, so a launch over 4,415 people is exactly ONE " +
      "entry — not 4,415. That entry carries forEachProgress " +
      "({ total, pending, inProgress, succeeded, failed, … }), which is where " +
      "per-item counts come from. Do not read the number of items on a page as " +
      "a number of runs.",
    {
      workflowId: z.string().describe("The workflow's id."),
      archivedOnly: z
        .boolean()
        .optional()
        .describe("True to list only archived launches. Defaults to false."),
      limit: z
        .number()
        .int()
        .optional()
        .describe(
          "Page size. Defaults to 20, capped at 200 — a larger value is " +
            "clamped, not rejected.",
        ),
      cursor: z
        .string()
        .optional()
        .describe(
          "Opaque continuation token: pass back the previous response's " +
            "nextCursor verbatim. Omit for the first page. It marks a POSITION, " +
            "not an offset, so it stays correct while new runs are being " +
            "inserted. A token you built or edited yourself is a 400.",
        ),
    },
    async ({ workflowId, archivedOnly, limit, cursor }) =>
      guard(async () =>
        // The page envelope is forwarded WHOLE. Unwrapping to items would drop
        // hasMore/nextCursor and recreate, one layer up, exactly the silent
        // truncation this tool exists to make visible (#37).
        jsonResult(
          await client.get(`/api/v1/workflows/${workflowId}/runs`, {
            archived_only: archivedOnly,
            limit,
            cursor,
          }),
        ),
      ),
  );

  server.tool(
    "read_run",
    "Read one run in full: status, per-step state, the workflow snapshot it " +
      "ran against, trigger input, agent invocations, and validator verdicts. " +
      "The verdicts are the closest thing to evaluator findings — there is no " +
      "separate findings endpoint.",
    { runId: z.string().describe("The run's id.") },
    async ({ runId }) =>
      guard(async () => jsonResult(await client.get(`/api/v1/runs/${runId}`))),
  );

  server.tool(
    "read_run_trace",
    "Read a run's chronological tool-call trace — each entry has the step, the " +
      "tool, its arguments, its output, and any error. This is what you read to " +
      "work out WHY a run behaved as it did.",
    { runId: z.string().describe("The run's id.") },
    async ({ runId }) =>
      guard(async () => jsonResult(await client.get(`/api/v1/runs/${runId}/trace`))),
  );

  server.tool(
    "read_run_cost",
    "Read a run's token and cost breakdown, per agent and model.",
    { runId: z.string().describe("The run's id.") },
    async ({ runId }) =>
      guard(async () => jsonResult(await client.get(`/api/v1/runs/${runId}/cost`))),
  );

  server.tool(
    "read_runs_summary",
    "Counts of runs by state across the tenant (running, waiting, completed, " +
      "failed, expired, total).",
    {},
    async () => guard(async () => jsonResult(await client.get("/api/v1/runs/summary"))),
  );

  server.tool(
    "archive_run",
    "Archive a run — hides it from the default run list without deleting it. " +
      "Reversible with unarchive_run.",
    { runId: z.string().describe("The run's id.") },
    async ({ runId }) =>
      guard(async () => jsonResult(await client.post(`/api/v1/runs/${runId}/archive`))),
  );

  server.tool(
    "unarchive_run",
    "Restore an archived run to the default run list.",
    { runId: z.string().describe("The run's id.") },
    async ({ runId }) =>
      guard(async () => jsonResult(await client.post(`/api/v1/runs/${runId}/unarchive`))),
  );

  server.tool(
    "bulk_archive_runs",
    "Archive up to 500 runs at once. Reversible — archived runs can be " +
      "unarchived individually. Returns counts of succeeded and failed.",
    {
      runIds: z.array(z.string()).min(1).max(500).describe("The run ids to archive."),
    },
    async ({ runIds }) =>
      guard(async () =>
        jsonResult(await client.post("/api/v1/runs/bulk/archive", { runIds })),
      ),
  );

  server.tool(
    "bulk_delete_runs",
    "Delete up to 500 runs at once. IRREVERSIBLE — unlike archiving, deleted " +
      "runs do not come back, and their traces and cost history go with them. " +
      "Prefer bulk_archive_runs unless a human has explicitly asked for deletion. " +
      "Returns counts of succeeded and failed; a partial failure is possible.",
    {
      runIds: z.array(z.string()).min(1).max(500).describe("The run ids to delete."),
      confirm: CONFIRM,
    },
    async ({ runIds }) =>
      guard(async () =>
        jsonResult(await client.post("/api/v1/runs/bulk/delete", { runIds })),
      ),
  );
}
