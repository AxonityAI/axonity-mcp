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
    "list_runs",
    "List workflow runs across the tenant, newest first. Archived runs are " +
      "excluded unless includeArchived is true. To list runs of ONE workflow, " +
      "use list_workflow_runs instead — this route has no workflow filter.",
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
      limit: z.number().int().optional().describe("Default 50, capped at 200."),
      offset: z.number().int().optional().describe("Default 0."),
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
    "List the runs of one workflow. Note this route takes archivedOnly (show " +
      "ONLY archived runs), which is not the same as list_runs' includeArchived.",
    {
      workflowId: z.string().describe("The workflow's id."),
      archivedOnly: z
        .boolean()
        .optional()
        .describe("True to list only archived runs. Defaults to false."),
    },
    async ({ workflowId, archivedOnly }) =>
      guard(async () =>
        jsonResult(
          await client.get(`/api/v1/workflows/${workflowId}/runs`, {
            archived_only: archivedOnly,
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
