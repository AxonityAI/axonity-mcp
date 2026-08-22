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
 *
 * READING A RUN NEED NOT COST THE WHOLE RUN (axonity-mcp#57). `read_run`
 * returns the document; `read_run_outline` returns its table of contents, whose
 * size follows the run's SHAPE rather than its content because it carries no
 * bodies. The two reads that serve those bodies on open — `read_run_value` and
 * `read_run_invocation_messages` — are the only reason the outline can stay
 * small, so they belong with it rather than as conveniences.
 *
 * A RUN THAT ASKS A QUESTION CAN BE ANSWERED (#45 M9). `axonity_conventions`
 * tells an agent to `start_workflow_run` to test a workflow end to end. A run
 * that reaches an `ask_user` step parks there and waits — so, without a way to
 * answer, the guide prescribed a loop the connector could not finish. The two
 * tools that unpark a run supply the INPUT it is waiting for, which is not the
 * same act as deciding a review:
 *   - `answer_run_question` / `send_run_message` are here.
 *   - `POST /runs/{id}/steps/{id}/plan-approval` is NOT, and
 *     `POST /runs/{id}/restart` cannot be. Both are recorded, with the reason,
 *     in `test/exclusions.test.ts` — as a decision rather than an omission.
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
      "follow it with read_run / read_run_trace / read_run_cost. " +
      "\n\nA workflow can have MORE THAN ONE start (a button and a schedule, " +
      "say), and each start declares its own fields. Read " +
      "read_workflow_trigger_parameters first, then name the one you mean with " +
      "triggerId and build triggerInput from THAT start's parameters — a " +
      "triggerId that does not exist is a 422 listing the ones that do, never a " +
      "quiet fallback to a different start. " +
      "\n\nA run may PARK on a step that asks a question instead of finishing. " +
      "read_run_waiting_on says what it is parked on; answer_run_question and " +
      "send_run_message are how it moves again.",
    {
      workflowId: z.string().describe("The workflow's id."),
      triggerId: z
        .string()
        .optional()
        .describe(
          "Which start to fire, from read_workflow_trigger_parameters' " +
            "`triggers[].id`. Omit and the workflow's FIRST trigger is used — " +
            "the historical behaviour, and an arbitrary choice on a workflow " +
            "with several starts, so name one whenever more than one exists.",
        ),
      triggerInput: z
        .record(z.unknown())
        .optional()
        .describe(
          "Input payload for the start you are firing, keyed by each " +
            "parameter's `name`. Omit for none. Do NOT send a parameter marked " +
            "`pinned` — the author owns that value and it is overwritten on " +
            "every run regardless of what you send.",
        ),
      manualPhases: z
        .boolean()
        .optional()
        .describe("Run with manual phase gating. Defaults to false."),
    },
    async ({ workflowId, triggerId, triggerInput, manualPhases }) =>
      guard(async () =>
        jsonResult(
          await client.post(`/api/v1/workflows/${workflowId}/runs`, {
            ...(triggerId ? { triggerId } : {}),
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
      "\n\nTHE RESPONSE IS ONE PAGE, NOT THE FULL LIST: " +
      "{ items, nextCursor, pageSize, hasMore }. Default page size is 20, max " +
      "200. While hasMore is true you have NOT seen every run — pass the " +
      "response's nextCursor back as cursor to get the next page, and repeat " +
      "until nextCursor is null. Counting or concluding anything (\"how many " +
      "failed?\") from a single page with hasMore: true gives a confidently " +
      "wrong answer. " +
      "\n\nRuns arrive at ~78/min during a fan-out, which is why the position " +
      "is a cursor and not an offset: an offset window under that rate skips " +
      "and repeats rows between pages. Never build a cursor — echo back the " +
      "one you were given. " +
      "\n\nUnlike list_workflow_runs, this route does list per-item FOR EACH " +
      "runs alongside their launches.",
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
          "Page size. Defaults to 20, silently clamped to 200 — asking for " +
            "more does not fail, it just returns 200.",
        ),
      cursor: z
        .string()
        .optional()
        .describe(
          "Opaque continuation cursor from the previous response's nextCursor. " +
            "Omit for the first page. Do not parse or construct one.",
        ),
    },
    async ({ status, createdAfter, createdBefore, includeArchived, limit, cursor }) =>
      guard(async () =>
        jsonResult(
          await client.get("/api/v1/runs", {
            status,
            created_after: createdAfter,
            created_before: createdBefore,
            include_archived: includeArchived,
            limit,
            cursor,
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
      "a number of runs." +
      "\n\nFilter with status BEFORE paging, not after: the filter is applied " +
      "in the query, so \"which launches failed?\" is one page rather than a " +
      "walk through every page keeping the failures. A status this backend " +
      "does not know is a 422 naming the ones it does — this connector " +
      "deliberately keeps no copy of that list.",
    {
      workflowId: z.string().describe("The workflow's id."),
      status: z
        .array(z.string())
        .optional()
        .describe(
          'Restrict to these launch statuses, e.g. ["failed", "cancelled"]. ' +
            "Several are a union. Omit for every status.",
        ),
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
    async ({ workflowId, status, archivedOnly, limit, cursor }) =>
      guard(async () =>
        // The page envelope is forwarded WHOLE. Unwrapping to items would drop
        // hasMore/nextCursor and recreate, one layer up, exactly the silent
        // truncation this tool exists to make visible (#37).
        jsonResult(
          await client.get(`/api/v1/workflows/${workflowId}/runs`, {
            // This route reads a REPEATED key (?status=a&status=b); the
            // tenant-wide `list_runs` reads one comma-separated string. A real
            // backend difference, so each tool sends what its route declares.
            status,
            archived_only: archivedOnly,
            limit,
            cursor,
          }),
        ),
      ),
  );

  server.tool(
    "read_run",
    "Read one run: status, per-step state, trigger input, agent invocations, " +
      "and validator verdicts. The verdicts are the closest thing to evaluator " +
      "findings — there is no separate findings endpoint. " +
      "\n\nThe WORKFLOW SNAPSHOT is omitted by default. It is the immutable " +
      "copy of the document the run executed, and it measured 23,809 of 29,414 " +
      "bytes — 81% — of one real response, none of which says anything about " +
      "how the run went. An oversized response turns a call that SUCCEEDED into " +
      "an error, which is the same trap apply_workflow_mutations avoids by not " +
      "forwarding a document either. Pass includeSnapshot: true when you " +
      "actually need to see what the run executed (e.g. it behaved unlike the " +
      "current draft and you want to know which document it ran).",
    {
      runId: z.string().describe("The run's id."),
      includeSnapshot: z
        .boolean()
        .optional()
        .describe(
          "Include `workflowSnapshot`, the document this run executed. " +
            "Defaults to FALSE here — the backend's own default is true, and " +
            "this tool overrides it because the snapshot is typically most of " +
            "the response and never the answer to a question about the run.",
        ),
    },
    async ({ runId, includeSnapshot }) =>
      guard(async () =>
        jsonResult(
          await client.get(`/api/v1/runs/${runId}`, {
            includeSnapshot: includeSnapshot === true,
          }),
        ),
      ),
  );

  server.tool(
    "list_todo_steps",
    "The steps across the TENANT that are waiting on a human — every parked " +
      "run, whatever it is parked on. This is the list you read to answer 'is " +
      "anything stuck on me?' without knowing which run to look at. " +
      "\n\nTHE RESPONSE IS ONE PAGE, NOT THE FULL LIST: " +
      "{ items, nextCursor, pageSize, hasMore }. While hasMore is true you have " +
      "NOT seen every waiting step — pass the response's nextCursor back as " +
      "cursor and repeat until nextCursor is null. " +
      "\n\nNote what the page bounds: the cursor walks the waiting RUNS, and " +
      "one run can carry several waiting steps, so `items` may be LONGER than " +
      "pageSize. That is not a bug and not an overflow — pageSize bounds what " +
      "was read, not what came back. A fan-out can park thousands of items on " +
      "one manual step at once, which is why this list is paged at all. " +
      "\n\nread_run_waiting_on answers the same question for a run you already " +
      "have in your hand.",
    {
      limit: z
        .number()
        .int()
        .optional()
        .describe("Page size, over the waiting runs. Omit for the route's default."),
      cursor: z
        .string()
        .optional()
        .describe(
          "Opaque continuation cursor from the previous response's nextCursor. " +
            "Omit for the first page. Do not parse or construct one.",
        ),
    },
    async ({ limit, cursor }) =>
      guard(async () => jsonResult(await client.get("/api/v1/runs/todo", { limit, cursor }))),
  );

  server.tool(
    "list_run_session_memory",
    "List the files an agent wrote to SESSION MEMORY during a run — title, " +
      "kind, tags, size and timestamp for each. Bodies are not included; fetch " +
      "one with read_run_session_memory_file. " +
      "\n\nThis is what an agent left itself between steps, and it is often the " +
      "answer to 'why did it decide that?' when the trace shows the decision " +
      "but not what it was reading. " +
      "\n\nAn empty list is an answer: this run wrote nothing to session memory.",
    { runId: z.string().describe("The run's id.") },
    async ({ runId }) =>
      guard(async () =>
        jsonResult(await client.get(`/api/v1/runs/${runId}/session-memory`)),
      ),
  );

  server.tool(
    "read_run_session_memory_file",
    "Read ONE session-memory file's text, by the id from " +
      "list_run_session_memory. The listing carries metadata and this carries " +
      "the body — up to 200 files per run, so fetching all of them to read one " +
      "is the mistake the split exists to prevent. " +
      "\n\nThe file id is scoped to THIS run's session folder: one borrowed " +
      "from another run is a 404, not someone else's file.",
    {
      runId: z.string().describe("The run's id."),
      fileId: z.string().describe("The file's id, from list_run_session_memory."),
    },
    async ({ runId, fileId }) =>
      guard(async () =>
        jsonResult(await client.get(`/api/v1/runs/${runId}/session-memory/${fileId}`)),
      ),
  );

  server.tool(
    "read_run_outline",
    "A run's TABLE OF CONTENTS — everything that happened, at the depth it " +
      "happened: the run, its steps, and the items a fan-out step handed out. " +
      "Flat rows with parent pointers; nest them yourself. " +
      "\n\nREAD THIS FIRST when you want to know the shape of a run. It carries " +
      "no bodies, so its size follows the run's SHAPE rather than its content — " +
      "a launch over four thousand items costs about what one over four costs, " +
      "where read_run pays for the whole document. Then fetch only what you " +
      "actually want to look at: read_run_value for a step value, " +
      "read_run_invocation_messages for one agent's transcript. " +
      "\n\n`itemCap` bounds how many items are LISTED per fan-out step. The rest " +
      "are counted in that step's `counts.truncated` and live on the paged " +
      "item-results surface — nothing is dropped in silence.",
    {
      runId: z.string().describe("The run's id."),
      itemCap: z
        .number()
        .int()
        .optional()
        .describe(
          "Max items listed per fan-out step. Anything beyond it is counted in " +
            "`counts.truncated`, not hidden.",
        ),
    },
    async ({ runId, itemCap }) =>
      guard(async () =>
        jsonResult(
          await client.get(`/api/v1/runs/${runId}/outline`, { item_cap: itemCap }),
        ),
      ),
  );

  server.tool(
    "read_run_value",
    "Fetch ONE large step value by its digest — the body behind a marker in " +
      "read_run's `stepStates`. A run detail carries handles rather than " +
      "megabytes; this is how you open one of them, when you have decided you " +
      "need it. " +
      "\n\nThe digest is scoped to THIS run: one you saw in another run is not " +
      "readable here, and asking gives a 404 rather than someone else's value.",
    {
      runId: z.string().describe("The run's id."),
      digest: z
        .string()
        .describe("The value's digest, from the marker in read_run's `stepStates`."),
    },
    async ({ runId, digest }) =>
      guard(async () =>
        jsonResult(await client.get(`/api/v1/runs/${runId}/values/${digest}`)),
      ),
  );

  server.tool(
    "read_run_invocation_messages",
    "Read ONE agent invocation's transcript — the conversation behind a row in " +
      "read_run's `agentInvocations`, which lists each invocation with its " +
      "metadata and a `messageCount` but not its messages. " +
      "\n\nThis is the read for 'what did this agent actually say?'. Fetch the " +
      "one invocation you are asking about: a run's transcripts together are " +
      "routinely larger than everything else in it combined.",
    {
      runId: z.string().describe("The run's id."),
      invocationId: z
        .string()
        .describe("The invocation's id, from read_run's `agentInvocations`."),
    },
    async ({ runId, invocationId }) =>
      guard(async () =>
        jsonResult(
          await client.get(`/api/v1/runs/${runId}/invocations/${invocationId}/messages`),
        ),
      ),
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

  // ---- Why a run is parked, and what it did ------------------------------

  server.tool(
    "read_run_waiting_on",
    "Why a run is PARKED. A run in `waiting` or `input_required` is not stuck " +
      "and not slow — it is holding for something, and this lists every pending " +
      "wake-task targeting it: a question asked of a person, a timer, a callback " +
      "that has not arrived. Read this before concluding a test run failed. " +
      "\n\nAn EMPTY list is a real answer, not an error: the run may have every " +
      "wake already resolved and be about to resume. " +
      "\n\nWhen the answer is a question, answer_run_question is what unparks it.",
    {
      runId: z.string().describe("The run's id."),
      limit: z.number().int().optional().describe("How many to return. Default 50."),
    },
    async ({ runId, limit }) =>
      guard(async () =>
        jsonResult(await client.get(`/api/v1/runs/${runId}/waiting-on`, { limit })),
      ),
  );

  server.tool(
    "list_run_items",
    "One page of the ITEM RESULTS inside a launch — the rows a FOR EACH " +
      "produced. This is what list_workflow_runs does NOT show: a launch over " +
      "4,415 people is one entry there and 4,415 rows here. Each row's `id` is " +
      "a real run you can read_run for that one item's detail. " +
      "\n\nTHE RESPONSE IS ONE PAGE: { items, nextCursor, pageSize, hasMore }, " +
      "20 by default and max 200. Follow nextCursor until it is null. " +
      "\n\nFILTER WITH `outcome`, DO NOT FILTER THE PAGE. It is applied in the " +
      "database: on a 4,415-item launch the twelve failures are scattered " +
      "through the middle, so keeping the failed rows out of page one shows you " +
      "none and reads as \"no failures\". For the totals alone use " +
      "read_run_items_summary — it is one call instead of a walk.",
    {
      runId: z.string().describe("The launch's run id."),
      outcome: z
        .enum(["all", "failed", "skipped"])
        .optional()
        .describe(
          'Which items to return. "failed" covers items that never produced a ' +
            'result; "skipped" covers items a gate deliberately declined. ' +
            'Defaults to "all".',
        ),
      limit: z.number().int().optional().describe("Page size. Default 20, max 200."),
      cursor: z
        .string()
        .optional()
        .describe(
          "Opaque continuation cursor from the previous response's nextCursor. " +
            "Omit for the first page. Do not parse or construct one.",
        ),
    },
    async ({ runId, outcome, limit, cursor }) =>
      guard(async () =>
        jsonResult(
          await client.get(`/api/v1/runs/${runId}/items`, { outcome, limit, cursor }),
        ),
      ),
  );

  server.tool(
    "read_run_items_summary",
    "The roll-up over a launch's items — \"4,415 processed · 12 failed\" — in " +
      "ONE call, with no paging. Ask this before list_run_items: it answers " +
      "\"did anything fail?\" outright, where counting a page answers it wrongly. " +
      "A launch that never fanned out reports zeroes.",
    { runId: z.string().describe("The launch's run id.") },
    async ({ runId }) =>
      guard(async () =>
        jsonResult(await client.get(`/api/v1/runs/${runId}/items/summary`)),
      ),
  );

  server.tool(
    "list_run_tasks",
    "Every task and child run descending from this run: for-each iterations " +
      "still queued, delegated agent tasks, callback wake-tasks, and the " +
      "iterations already promoted to runs of their own. Use it to see what a " +
      "run set in motion beyond its own steps — a run can look idle while its " +
      "children are doing all the work.",
    {
      runId: z.string().describe("The run's id."),
      limit: z.number().int().optional().describe("How many to return. Default 200."),
    },
    async ({ runId, limit }) =>
      guard(async () =>
        jsonResult(await client.get(`/api/v1/runs/${runId}/tasks`, { limit })),
      ),
  );

  server.tool(
    "read_run_for_each_progress",
    "Per-state counts for ONE fan-out batch on a run: total, pending, " +
      "inProgress, succeeded, failed, deadLetter. This is how you watch a FOR " +
      "EACH step advance while it is still running, instead of re-reading the " +
      "whole run. Get the batchId from list_run_tasks or the step's state in " +
      "read_run.",
    {
      runId: z.string().describe("The run's id."),
      batchId: z.string().describe("The FOR EACH batch's id."),
    },
    async ({ runId, batchId }) =>
      guard(async () =>
        jsonResult(
          await client.get(`/api/v1/runs/${runId}/for-each/${batchId}/progress`),
        ),
      ),
  );

  // ---- Unparking a run ---------------------------------------------------

  server.tool(
    "answer_run_question",
    "Answer an `ask_user` step a run is parked on, so the run resumes. This is " +
      "what makes \"start a run and see what it does\" finishable: without it a " +
      "workflow that asks anything waits forever and a test never returns a " +
      "verdict. Find the parked step with read_run_waiting_on or read_run. " +
      "\n\nThe answer is recorded as the ANSWER A PERSON WOULD HAVE GIVEN and " +
      "the run proceeds on it. On a run a human is depending on, that is their " +
      "decision to make, not yours — answer your own test runs, and ask before " +
      "answering someone else's. Returns the run's updated detail.",
    {
      runId: z.string().describe("The run's id."),
      stepId: z.string().describe("The suspended step's id, from read_run_waiting_on."),
      answer: z.string().describe("The answer text the step is waiting for."),
    },
    async ({ runId, stepId, answer }) =>
      guard(async () =>
        jsonResult(
          await client.post(`/api/v1/runs/${runId}/steps/${stepId}/answer`, { answer }),
        ),
      ),
  );

  server.tool(
    "send_run_message",
    "Send a user turn to a CONVERSATION run that is waiting on one. The server " +
      "resolves which step is parked, so unlike answer_run_question this takes " +
      "no stepId. Same caution: the turn is recorded as a person's, so use it " +
      "on runs you started. Returns the run's updated detail.",
    {
      runId: z.string().describe("The conversation run's id."),
      message: z.string().min(1).describe("The user turn to submit."),
    },
    async ({ runId, message }) =>
      guard(async () =>
        jsonResult(await client.post(`/api/v1/runs/${runId}/message`, { message })),
      ),
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
