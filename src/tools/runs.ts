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
 *   - `answer_run_question` / `send_run_message` are here, and since #59 so is
 *     `complete_run_step` — one route over two acts. Choosing a DECISION step's
 *     branch is routing; completing a MANUAL step asserts that human work
 *     happened, which the platform then treats as fact. The tool says so and
 *     takes a `confirm`, because leaving it out left the guide prescribing an
 *     end-to-end test that hits a wall at the first manual step — the same
 *     defect `answer_run_question` was added to fix.
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
      "say). Read read_workflow_trigger_parameters first, then name the one you " +
      "mean with triggerId and build triggerInput from the process's `inputs` " +
      "PLUS whatever that start declares on top in its own `parameters` — a " +
      "triggerId that does not exist is a 422 listing the ones that do, never a " +
      "quiet fallback to a different start. " +
      "\n\nA run may PARK on a step that asks a question instead of finishing. " +
      "list_todo_steps lists the step it waits on (each item carries its runId " +
      "and stepId); answer_run_question and send_run_message are how it moves " +
      "again. " +
      "\n\nA chat with the Dashboard Analyst is not a workflow run: start one " +
      "with start_conversation.",
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
      "excluded unless includeArchived is true, and the platform's own work " +
      "(labelled `isPlatform`) unless includePlatform is true. To list runs of ONE workflow, " +
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
      "\n\nLike list_workflow_runs, the per-item runs of a FOR EACH are NOT here: " +
      "a launch over 4,415 items is ONE row. The item results live inside their " +
      "launch — list_run_items for the rows, read_run_for_each_progress for the " +
      "counts. " +
      "\n\nCONVERSATIONS ARE NOT HERE. A chat about a dashboard with the " +
      "Dashboard Analyst is a run of kind `conversation`; this tool asks the " +
      "route for workflow runs only. list_conversations lists the chats — " +
      "across dashboards on this same route (kind=conversation, with the same " +
      "status and date filters), or for one dashboard.",
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
      includePlatform: z
        .boolean()
        .optional()
        .describe(
          "Also the platform's own work (Maintain knowledge, Learn from a run), " +
            "each row labelled `isPlatform`. Defaults to false: left out, those " +
            "runs are not in the list.",
        ),
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
    async ({ status, createdAfter, createdBefore, includeArchived, includePlatform, limit, cursor }) =>
      guard(async () =>
        jsonResult(
          await client.get("/api/v1/runs", {
            status,
            created_after: createdAfter,
            created_before: createdBefore,
            include_archived: includeArchived,
            include_platform: includePlatform,
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
      "current draft and you want to know which document it ran)." +
      "\n\nA CONVERSATION (`kind: conversation`, e.g. a chat with the Dashboard " +
      "Analyst from list_conversations or start_conversation) reads here too. " +
      "`status` says whether the analyst is still working on the last turn or " +
      "is waiting for the next one; `triggerInput` holds the dashboard " +
      "(`dashboardId`), the opening question (`message`) and the tile asked " +
      "about (`focus`). The answer itself and the tools the analyst called are " +
      "in the transcript: take the orchestrator row from `agentInvocations` " +
      "and read it with read_run_invocation_messages. read_run_trace is not " +
      "where a conversation's tool calls are.",
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
    "The steps across the TENANT that are waiting on a person — one item per " +
      "step. This is the list you read to answer 'is anything stuck on me?' " +
      "without knowing which run to look at. " +
      "\n\nWHAT IS AN ITEM: a step of a run that is `waiting` or " +
      "`input_required`, not archived and not a conversation, that waits for " +
      "one of four things (`todoType`): `ask_user` — an agent asked a question " +
      "that is not answered; `plan_approval` — a plan waits for a decision; " +
      "`manual_step` or `decision` — the step type says a person does it. NOT " +
      "items: a debug pause (`phase_control`) or any other step without one of " +
      "those reasons, and a question already answered whose run has not " +
      "resumed yet (the answer is on its way). A conversation waits for its " +
      "person in the chat, not here. " +
      "\n\nWHOSE IT IS: each item belongs to one agent or to none (`agentId`). " +
      "A question or a plan belongs to the agent that asked (the agent of the " +
      "step's latest orchestrator call; with none on record, the workflow's " +
      "owner). A manual step or a decision belongs to the workflow's owner " +
      "(none when the workflow has no live owner or is deleted). None for the " +
      "budget question the platform itself asked under the old budget rule " +
      "(marked `budget_pause` in the question's state), and for every step of " +
      "a run the run history hides (a hidden platform workflow). Pass " +
      "`agentId` for that agent's items only — the items its \"Needs you\" " +
      "counts; an agent of another workspace has none. Without it the list " +
      "shows every item, those on no agent included. " +
      "\n\nEach item also carries `askedAt` (when the agent asked; null for an " +
      "item that is not a question) and `groupKey`: equal for literally equal " +
      "questions — same workflow, same step, question text equal character " +
      "for character — so they can be shown once. Each is still answered on " +
      "its own run. Null for an item without a question. " +
      "\n\nTHE RESPONSE IS ONE PAGE, NOT THE FULL LIST: " +
      "{ items, nextCursor, pageSize, hasMore }. While hasMore is true you have " +
      "NOT seen every waiting step — pass the response's nextCursor back as " +
      "cursor and repeat until nextCursor is null. " +
      "\n\nNote what the page bounds: the cursor walks the waiting RUNS, and " +
      "one run can carry several waiting steps, so `items` may be LONGER than " +
      "pageSize. That is not a bug and not an overflow — pageSize bounds what " +
      "was read, not what came back. A fan-out can park thousands of items on " +
      "one manual step at once, which is why this list is paged at all. Without " +
      "agentId a run read may hold no item, so a page can also be shorter than " +
      "pageSize, even empty, while hasMore is true; with agentId only the runs " +
      "holding an item of that agent are walked. " +
      "\n\nread_run_waiting_on is a different read: the pending wake-tasks of " +
      "one run you already have (a timer; an answer, a chat message or a " +
      "callback's result on its way). An open question has no wake-task.",
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
      agentId: z
        .string()
        .optional()
        .describe(
          "An agent's id (a UUID): only the items that belong to that agent. " +
            "Omit for every item in the tenant.",
        ),
    },
    async ({ limit, cursor, agentId }) =>
      guard(async () =>
        jsonResult(await client.get("/api/v1/runs/todo", { limit, cursor, agentId })),
      ),
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
      "are counted in that step's `counts.truncated` and are NOT lost: " +
      "read_run_outline_items carries on from where the outline stopped, and " +
      "read_run_item_results reads the item RESULTS. Nothing is dropped in " +
      "silence.",
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
    "read_run_outline_items",
    "The items ONE fan-out step handed out, beyond what read_run_outline " +
      "listed. Read-only. " +
      "\n\nThe outline stays bounded — it lists `itemCap` items per fan-out " +
      "step and counts the rest — so a step that says \"121 not listed\" is a " +
      "dead end for a reader who came looking for item 40. This is the way " +
      "onward. It returns the SAME node shape the outline does (the item and " +
      "the steps beneath it), in the same order. " +
      "\n\nWALKED BY OFFSET, NOT A CURSOR, and that is safe here for a reason " +
      "the run lists cannot claim: a fan-out\u2019s items are fixed once it has " +
      "handed them out, so the ordering does not shift under you. Start at the " +
      "number the outline stopped at (its `itemCap`), then follow the " +
      "response\u2019s `nextOffset` while `hasMore` is true. " +
      "\n\nOne step at a time: `stepId` is required, because \"the rest of the " +
      "run\" is what read_run_outline already answered.",
    {
      runId: z.string().describe("The run's id."),
      stepId: z
        .string()
        .describe(
          "The fan-out step whose items to continue listing — the step's id " +
            "from the outline, not an item's.",
        ),
      offset: z
        .number()
        .int()
        .optional()
        .describe(
          "Where to carry on. Pass the outline's `itemCap` for the first " +
            "stretch, then the response's `nextOffset` for each one after it. " +
            "Defaults to 0, which repeats what the outline already showed.",
        ),
      limit: z
        .number()
        .int()
        .optional()
        .describe("How many items this stretch carries. Max 100."),
    },
    async ({ runId, stepId, offset, limit }) =>
      guard(async () =>
        jsonResult(
          await client.get(`/api/v1/runs/${runId}/outline/items`, {
            step_id: stepId,
            offset,
            limit,
          }),
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
      "routinely larger than everything else in it combined. " +
      "\n\nFOR A CONVERSATION this is where the conversation IS: every user " +
      "turn, every answer the agent wrote, and every tool call with its " +
      "arguments and result. For a chat with the Dashboard Analyst that means " +
      "the numbers it read (`read_measure` — which measure, filters and " +
      "period) and the charts it showed (`show_visual` — the tile it put on " +
      "screen), so you can check an answer against the figures it was given.",
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
      "work out WHY a run behaved as it did. " +
      "\n\nNot for a CONVERSATION: a chat's tool calls live in its transcript " +
      "(read_run_invocation_messages), and this trace is typically empty for one.",
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
      "wake-task targeting it: a timer, or an answer, a chat message or a " +
      "callback's result on its way (a callback row appears only once the work " +
      "behind it has finished). Read this before concluding a test run failed. " +
      "\n\nA step that waits on a PERSON — an open question, a plan, a manual or " +
      "a decision step — has NO wake-task and is not here: a question's wake-task " +
      "is planted only once someone answers it. Those steps are on " +
      "list_todo_steps (with their runId and stepId), and in read_run as a step " +
      "whose status is `waiting_for_input` and whose `waitReason` says why. " +
      "\n\nA run waiting on a FOR EACH batch, or on a callback whose work is " +
      "still running, has no wake-task here either: the batch waits as a marker " +
      "on its step (watch it with read_run_for_each_progress), and the running " +
      "work is a task in list_run_tasks. " +
      "\n\nAn EMPTY list is a real answer, not an error: the run may have every " +
      "wake already resolved and be about to resume, or it waits on something " +
      "with no wake-task — a person, a FOR EACH batch, a callback still running.",
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
      "verdict. Find the parked step with list_todo_steps or read_run. " +
      "\n\nThe answer is recorded as the ANSWER A PERSON WOULD HAVE GIVEN and " +
      "the run proceeds on it. On a run a human is depending on, that is their " +
      "decision to make, not yours — answer your own test runs, and ask before " +
      "answering someone else's. Returns the run's updated detail.",
    {
      runId: z.string().describe("The run's id."),
      stepId: z.string().describe("The suspended step's id, from list_todo_steps or read_run."),
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
    "complete_run_step",
    "Complete a MANUAL or DECISION step a run is parked on, so the run " +
      "resumes. Along with answer_run_question, this is what makes \"start a " +
      "run and see what it does\" finishable — a workflow with a manual step " +
      "otherwise waits forever and a test never returns a verdict. " +
      "\n\nONE ROUTE, TWO VERY DIFFERENT ACTS. Know which you are doing: " +
      "\n- On a DECISION step you are CHOOSING A BRANCH. Pass `selectedBranch`. " +
      "That is a routing choice, the same kind of act as answering a question. " +
      "\n- On a MANUAL step you are ASSERTING THAT HUMAN WORK HAPPENED. The " +
      "platform then treats that as fact and everything downstream proceeds on " +
      "it. Only do this when a person has told you the work is done, or on a " +
      "test run of your own where nothing real depended on the step. Never to " +
      "get a stuck run moving. " +
      "\n\nFind the parked step with list_todo_steps or read_run. Returns the run's " +
      "updated detail. Deciding a PLAN APPROVAL is a different thing again and " +
      "is deliberately not available here — that step exists to get a human's " +
      "review, and an agent approving it would often be approving its own plan.",
    {
      runId: z.string().describe("The run's id."),
      stepId: z.string().describe("The parked step's id, from list_todo_steps or read_run."),
      selectedBranch: z
        .string()
        .optional()
        .describe("For a DECISION step: which branch to take."),
      output: z
        .record(z.unknown())
        .optional()
        .describe("For a MANUAL step: the result the step should carry forward."),
      structuredOutputs: z
        .record(z.unknown())
        .optional()
        .describe("Values for the step's declared output schema, when it has one."),
      confirm: z
        .literal(true)
        .describe(
          "Must be true. Acknowledges that on a manual step you are asserting " +
            "human work was done.",
        ),
    },
    async ({ runId, stepId, selectedBranch, output, structuredOutputs }) =>
      guard(async () =>
        jsonResult(
          await client.post(`/api/v1/runs/${runId}/steps/${stepId}/complete`, {
            ...(selectedBranch !== undefined ? { selectedBranch } : {}),
            ...(output !== undefined ? { output } : {}),
            ...(structuredOutputs !== undefined ? { structuredOutputs } : {}),
          }),
        ),
      ),
  );

  server.tool(
    "send_run_message",
    "Send a user turn to a CONVERSATION run that is waiting on one. The server " +
      "resolves which step is parked, so unlike answer_run_question this takes " +
      "no stepId. Same caution: the turn is recorded as a person's, so use it " +
      "on runs you started. Returns the run's updated detail. " +
      "\n\nThis is the FOLLOW-UP QUESTION in a chat with the Dashboard Analyst " +
      "(start one with start_conversation). Two refusals come from the backend " +
      "and are passed on as they are: a 422 \"not awaiting a message right now\" " +
      "while the analyst is still answering the previous turn — read_run until " +
      "its status says it is waiting, then send — and a 404 on a dashboard " +
      "conversation someone else opened, because a dashboard chat belongs to " +
      "the person who opened it. Needs a token with the `operate` scope.",
    {
      runId: z.string().describe("The conversation run's id."),
      message: z.string().min(1).describe("The user turn to submit."),
    },
    async ({ runId, message }) =>
      guard(async () =>
        jsonResult(await client.post(`/api/v1/runs/${runId}/message`, { message })),
      ),
  );

  // ---- Conversations with the Dashboard Analyst --------------------------
  //
  // A chat about a dashboard is a run of kind `conversation` with no workflow;
  // list_runs asks for kind=workflow only. Two backend routes list these chats
  // and neither does everything, so list_conversations picks one per call:
  //   - GET /conversations?dashboardId= — one dashboard, with status,
  //     createdAfter/createdBefore and q (axonity-flow#2331); no archive filter.
  //   - GET /runs?kind=conversation — every dashboard the person can see, with
  //     status, created_after/created_before and include_archived; no text filter.
  // What one route has and the other has not (includeArchived with a
  // dashboard, q without one) is a local refusal rather than a quiet drop.
  // Both routes return
  // only the token holder's own dashboard chats; the Builder chat never
  // appears (test/denyList.ts says why it stays out).

  server.tool(
    "list_conversations",
    "List conversations with the Dashboard Analyst, newest first. Use it to " +
      "find a chat to review; read it with read_run and " +
      "read_run_invocation_messages. Find a dashboard's id with " +
      "list_dashboards. " +
      "\n\nTWO WAYS TO ASK, because the backend has two lists and neither " +
      "does both: " +
      "\n- With `dashboardId`: the chats about that one dashboard — the history " +
      "its chat window shows — filtered by `status`, `createdAfter`/`createdBefore` " +
      "and `q` (text in the opening question) before the page is cut " +
      "(axonity-flow#2331). Archived chats are left out. A value this list " +
      "cannot read is a 422 with the reason. " +
      "\n- Without `dashboardId`: the chats about EVERY dashboard the person can " +
      "still see, filtered by `status`, `createdAfter`/`createdBefore` and " +
      "`includeArchived` in the database before the page is cut — so \"which " +
      "chats failed last week?\" is one page, not a walk. " +
      "\nWhat one list has and the other has not is refused here rather than " +
      "half-applied: `includeArchived` with `dashboardId`, and `q` without it. " +
      "The two lists read a bare `createdBefore` date differently; see that " +
      "argument. " +
      "\n\nWHAT CANNOT BE FILTERED AT ALL: who opened the chat. Both lists " +
      "return only the chats opened by the person this connector's token " +
      "belongs to (who minted it) — a colleague's chat in the app is never " +
      "listed. " +
      "\n\nEach row: `id` (the run id), `question` (the opening question, null " +
      "when the chat was opened without one), `dashboardId`, `status`, " +
      "`createdAt`/`startedAt`/`completedAt`, `createdByName`. The tile a " +
      "question was about is not in the row; it is `triggerInput.focus` in " +
      "read_run. " +
      "\n\nTHE RESPONSE IS ONE PAGE, NOT THE FULL LIST: " +
      "{ items, nextCursor, pageSize, hasMore }. Default page size is 20, max " +
      "200. While hasMore is true you have NOT seen every conversation — pass " +
      "the response's nextCursor back as cursor, with the SAME other " +
      "arguments, and repeat until nextCursor is null. " +
      "\n\nRefusals come from the backend unchanged: 404 for a dashboard that " +
      "does not exist or is not shared with that person; 403 with the module's " +
      "own sentence when the `insights` module is switched off here.",
    {
      dashboardId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Only the chats about this dashboard, from list_dashboards. Cannot be " +
            "combined with includeArchived.",
        ),
      status: z
        .string()
        .optional()
        .describe(
          'Comma-separated run statuses, e.g. "idle" or "running,failed". ' +
            "A conversation's own statuses: `idle` = answered, waiting for the " +
            "next question (NOT `completed`: an answered chat never reaches it); " +
            "`running` = the analyst is working on a turn; `failed`; " +
            "`completed` only once a chat was ended. Without dashboardId an " +
            "unknown status is not refused — it just matches nothing, so an " +
            "empty page may mean a misspelt status; with dashboardId it is a " +
            "422. Omit for all.",
        ),
      createdAfter: z
        .string()
        .optional()
        .describe(
          "ISO date or datetime lower bound on when the chat started (a bare " +
            "date is midnight at its start, so that day is included), e.g. " +
            '"2026-11-01". Without dashboardId, a value the backend cannot ' +
            "parse is IGNORED, not refused — the list then comes back unfiltered " +
            "by it, so send a plain ISO date. With dashboardId it is a 422, and " +
            "a date-time without an offset is read as UTC.",
        ),
      createdBefore: z
        .string()
        .optional()
        .describe(
          "ISO date or datetime upper bound, inclusive of that MOMENT. The two " +
            "lists read a bare date differently. Without dashboardId a bare " +
            'date means midnight at its start, so "2026-11-03" EXCLUDES the ' +
            'chats of 3 November itself: for "up to and including 3 November" ' +
            'send "2026-11-04" or "2026-11-03T23:59:59"; an unparseable value is ' +
            "silently ignored. With dashboardId a bare date means the END of that " +
            "day, so createdAfter = createdBefore = one date is that day's chats; " +
            "an unparseable value is a 422. A date-time is exact on both.",
        ),
      q: z
        .string()
        .optional()
        .describe(
          "With dashboardId only: the chats whose opening question contains this " +
            "text, ignoring case and the spaces around it. Taken literally: % and " +
            "_ match themselves.",
        ),
      includeArchived: z
        .boolean()
        .optional()
        .describe("Include archived chats. Defaults to false. Without dashboardId only."),
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
    async ({ dashboardId, status, createdAfter, createdBefore, q, includeArchived, limit, cursor }) =>
      guard(async () => {
        // The page envelope is forwarded WHOLE on both routes, as list_runs
        // does (#37).
        if (dashboardId !== undefined) {
          if (includeArchived !== undefined) {
            throw new Error(
              "list_conversations: includeArchived cannot be combined with " +
                "dashboardId — the backend's per-dashboard list leaves archived " +
                "chats out and has no such filter. Leave dashboardId out to " +
                "include them, and keep the rows whose dashboardId matches.",
            );
          }
          return jsonResult(
            await client.get("/api/v1/conversations", {
              dashboardId,
              status,
              createdAfter,
              createdBefore,
              q,
              limit,
              cursor,
            }),
          );
        }
        if (q !== undefined) {
          throw new Error(
            "list_conversations: `q` needs dashboardId — only the per-dashboard " +
              "list filters on the question's text. Without a dashboard, read " +
              "`question` on every row across all pages.",
          );
        }
        return jsonResult(
          await client.get("/api/v1/runs", {
            kind: "conversation",
            status,
            created_after: createdAfter,
            created_before: createdBefore,
            include_archived: includeArchived,
            limit,
            cursor,
          }),
        );
      }),
  );

  server.tool(
    "start_conversation",
    "Open a NEW conversation with the Dashboard Analyst about one dashboard, " +
      "with an opening question — the same request the dashboard's chat window " +
      "sends. This is how you TEST the analyst: one conversation per question, " +
      "then send_run_message for a follow-up in the same chat. " +
      "\n\nThis EXECUTES: the analyst runs on live models and reads the " +
      "tenant's real figures, so it costs tokens. It does not change the " +
      "dashboard: a chart the analyst shows is placed only by a person in the " +
      "app. " +
      "\n\nThe reply is not in the response. It returns the conversation run " +
      "at its start; the analyst answers in the background. read_run shows " +
      "the status (still working, or waiting for the next turn); the answer " +
      "and the tools it called (`read_measure`, `show_visual`, with their " +
      "arguments) are in the transcript — the orchestrator row of " +
      "`agentInvocations`, read with read_run_invocation_messages. " +
      "\n\nTHE CHAT IS OPENED AS A PERSON: the one this connector's token " +
      "belongs to. The analyst reads with that person's access, and the chat " +
      "appears in THEIR history on that dashboard in the app. Only that person " +
      "can continue it — in the app, or through any token they minted. " +
      "\n\nRefusals come from the backend unchanged: 404 when the dashboard " +
      "does not exist or is not shared with that person, or when the Dashboard " +
      "Analyst is not available in this workspace; 403 with the module's own " +
      "sentence when the `insights` module is switched off here; 403 for a " +
      "token that may not start one — \"This service token lacks the " +
      "'author' scope\" (it has other write scopes, e.g. only `operate`) or " +
      "\"This service token is read-only\"; 422 for an oversized focus.",
    {
      dashboardId: z
        .string()
        .min(1)
        .describe("The dashboard the question is about, from list_dashboards."),
      message: z
        .string()
        .min(1)
        .describe("The opening question, as a person would type it in the chat."),
      focus: z
        .record(z.unknown())
        .optional()
        .describe(
          "The tile the question is about, as the dashboard sends it when " +
            "someone presses \"Ask about this\" on a tile: " +
            "{ title, type, config, period } — the tile's title, its type and " +
            "its `config` as read_dashboard returns them, and its period " +
            "(the tile's own `config.period`, or the dashboard's: a preset " +
            "name, or `period: null` with `start` and `end` dates). The " +
            "analyst reads it as \"this number\". Omit it for a question about " +
            "the dashboard as a whole, as the chat window does when opened " +
            "without a tile. The chat also sends two other shapes, when a person " +
            "asks the analyst to MAKE a tile rather than explain one: " +
            "{ purpose: \"new_tile\", section } (\"Add tile\" by asking, with the " +
            "section's title) and { purpose: \"change_tile\", title, type, " +
            "config, period } (\"Change by asking\" on an existing tile). At " +
            "most 16 KB as JSON.",
        ),
    },
    async ({ dashboardId, message, focus }) =>
      guard(async () =>
        jsonResult(
          // Exactly the body the dashboard chat sends (frontend
          // conversationService.start): no workflow, the question, the
          // dashboard and its focus. The dashboardId is what makes it the
          // Analyst rather than the Builder team.
          await client.post("/api/v1/conversations", {
            targetWorkflowId: null,
            message,
            dashboardId,
            focus: focus ?? null,
          }),
        ),
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
