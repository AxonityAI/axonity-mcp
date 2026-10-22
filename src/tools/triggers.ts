/**
 * Trigger management — what makes a published workflow actually run.
 *
 * Three trigger kinds, all member-accessible despite living in `*_admin.py` on
 * the backend. Note the asymmetry the routes impose: creating and listing are
 * workflow-scoped, while rotate/update/delete address the trigger directly.
 *
 * Trigger deletes are HARD deletes — the row is removed, not soft-deleted, and
 * there is no restore. Hence the `confirm` guard on each.
 *
 * A SCHEDULE IS A CLAIM, AND IT IS NOW CHECKABLE (axonity-mcp#57). "Every
 * weekday at 07:00" used to be something an author could only test by coming
 * back tomorrow, and the thing most likely to be wrong is not the timing but
 * whether it starts anything at all. Three routes close that:
 * `run_cron_schedule_now` fires one without moving `nextFireAt`,
 * `set_cron_schedule_enabled` pauses one without throwing its rules away, and
 * `reconcile_cron_schedules` answers "is what I am reading what runs tonight?".
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

/** A required literal — an agent cannot satisfy it by filling in a default. */
const CONFIRM = z
  .literal(true)
  .describe("Must be true. Destructive and irreversible — ask your human first.");

export function registerTriggerTools(
  server: McpServer,
  client: AxonityClient,
): void {
  // ---- Webhook triggers -------------------------------------------------

  server.tool(
    "list_webhook_triggers",
    "List a workflow's webhook triggers. Secrets are never returned — a " +
      "trigger's token is shown only once, when it is created or rotated.",
    { workflowId: z.string().describe("The workflow's id.") },
    async ({ workflowId }) =>
      guard(async () =>
        jsonResult(await client.get(`/api/v1/workflows/${workflowId}/webhook-triggers`)),
      ),
  );

  server.tool(
    "create_webhook_trigger",
    "Create a webhook trigger on a workflow. Returns the trigger AND its " +
      "plaintext token — shown ONCE and never retrievable again. Hand the token " +
      "to your human immediately; do not store it in an entity field.",
    {
      workflowId: z.string().describe("The workflow's id."),
      triggerId: z
        .string()
        .describe("The id of the trigger node in the workflow document."),
      expectedInputSchema: z
        .record(z.unknown())
        .optional()
        .describe("JSON schema the incoming payload must match. Defaults to {}."),
    },
    async ({ workflowId, triggerId, expectedInputSchema }) =>
      guard(async () =>
        jsonResult(
          await client.post(`/api/v1/workflows/${workflowId}/webhook-triggers`, {
            triggerId,
            ...(expectedInputSchema ? { expectedInputSchema } : {}),
          }),
        ),
      ),
  );

  server.tool(
    "rotate_webhook_trigger",
    "Rotate a webhook trigger's token. Returns the new plaintext token ONCE. " +
      "The old token keeps working for a short grace period so callers can be " +
      "migrated.",
    {
      webhookId: z.string().describe("The webhook trigger's id."),
      confirm: CONFIRM,
    },
    async ({ webhookId }) =>
      guard(async () =>
        jsonResult(await client.post(`/api/v1/webhook-triggers/${webhookId}/rotate`)),
      ),
  );

  server.tool(
    "delete_webhook_trigger",
    "Delete a webhook trigger. HARD delete — the row is removed and cannot be " +
      "restored, and any caller using its token starts failing immediately.",
    {
      webhookId: z.string().describe("The webhook trigger's id."),
      confirm: CONFIRM,
    },
    async ({ webhookId }) =>
      guard(async () => {
        await client.del(`/api/v1/webhook-triggers/${webhookId}`);
        return jsonResult({ deleted: true, webhookId });
      }),
  );

  // ---- Cron schedules ---------------------------------------------------

  server.tool(
    "list_cron_schedules",
    "List a workflow's cron schedules, with their next and last fire times.",
    { workflowId: z.string().describe("The workflow's id.") },
    async ({ workflowId }) =>
      guard(async () =>
        jsonResult(await client.get(`/api/v1/workflows/${workflowId}/cron-schedules`)),
      ),
  );

  server.tool(
    "list_all_cron_schedules",
    "Every cron schedule in the TENANT, with the workflow each one fires — the " +
      "answer to 'what runs tonight?'. list_cron_schedules answers the same " +
      "question for one workflow; this one needs no id and is what you read " +
      "when you do not already know which workflow to suspect.",
    {},
    async () =>
      guard(async () => jsonResult(await client.get("/api/v1/cron-schedules"))),
  );

  server.tool(
    "create_cron_schedule",
    "Schedule a published workflow to run on a timetable. " +
      "\n\nThe TRIGGER must exist in the workflow's PUBLISHED document — the " +
      "schedule table stores a copy of the rules and publishing keeps that copy " +
      "true, so a trigger id no canvas has shown is refused rather than stored. " +
      "Read read_workflow_trigger_parameters or the published document for the " +
      "id. " +
      "\n\nGive it EITHER `cronExpr` OR `rules`. `rules` is the richer form and " +
      "the one a person reads back: call get_workflow_authoring_spec for " +
      "`scheduleRuleKinds`, which lists every shape this deploy accepts with a " +
      "working example of each. Do not invent a shape — the list is generated " +
      "from the parser that validates it. A malformed expression or an unknown " +
      "timezone is a 422.",
    {
      workflowId: z.string().describe("The workflow's id."),
      triggerId: z
        .string()
        .describe(
          "The id of the trigger node in the workflow's PUBLISHED document. An " +
            "id that is not there is refused.",
        ),
      cronExpr: z
        .string()
        .optional()
        .describe(
          'A cron expression, e.g. "0 9 * * 1-5" for weekdays at 09:00. Use ' +
            "`rules` instead for anything you want a person to be able to read.",
        ),
      rules: z
        .array(z.record(z.unknown()))
        .optional()
        .describe(
          "The schedule as rule objects. Shapes come from " +
            "get_workflow_authoring_spec → `scheduleRuleKinds`, each with an " +
            "example that is round-tripped through the parser on every read.",
        ),
      timezone: z
        .string()
        .optional()
        .describe('IANA timezone, e.g. "Europe/Brussels". Defaults to UTC.'),
      enabled: z.boolean().optional().describe("Defaults to true."),
    },
    async ({ workflowId, triggerId, cronExpr, rules, timezone, enabled }) =>
      guard(async () =>
        jsonResult(
          await client.post(`/api/v1/workflows/${workflowId}/cron-schedules`, {
            triggerId,
            ...(cronExpr !== undefined ? { cronExpr } : {}),
            ...(rules !== undefined ? { rules } : {}),
            ...(timezone ? { timezone } : {}),
            ...(enabled === undefined ? {} : { enabled }),
          }),
        ),
      ),
  );

  server.tool(
    "set_cron_schedule_enabled",
    "Arm or disarm a cron schedule. THIS IS HOW YOU PAUSE ONE — it keeps the " +
      "rules the author wrote, so 'stop this for a week' stays distinguishable " +
      "from 'we do not do this any more'. Reach for delete_cron_schedule only " +
      "when the schedule is genuinely finished.",
    {
      scheduleId: z.string().describe("The cron schedule's id."),
      enabled: z
        .boolean()
        .describe("true arms the schedule, false pauses it without losing it."),
    },
    async ({ scheduleId, enabled }) =>
      guard(async () =>
        jsonResult(await client.patch(`/api/v1/cron-schedules/${scheduleId}`, { enabled })),
      ),
  );

  server.tool(
    "run_cron_schedule_now",
    "Fire a cron schedule once, right now — the way to TEST one without waiting " +
      "for its next time. This EXECUTES the workflow against live " +
      "infrastructure, with the same cost and side effects as any real run. " +
      "\n\n`nextFireAt` is deliberately NOT moved: testing a schedule must not " +
      "consume the run it was going to make. " +
      "\n\nIt returns as soon as the run is queued, not when it finishes — " +
      "follow it with list_runs or read_run_outline.",
    { scheduleId: z.string().describe("The cron schedule's id.") },
    async ({ scheduleId }) =>
      guard(async () =>
        jsonResult(await client.post(`/api/v1/cron-schedules/${scheduleId}/run-now`)),
      ),
  );

  server.tool(
    "reconcile_cron_schedules",
    "Check the tenant's schedule table against the PUBLISHED workflows and " +
      "repair it — the answer to 'is what I am reading actually what runs " +
      "tonight?'. Schedules follow their workflow's lifecycle now, so this is " +
      "for rows written before that held, and for confirming there are none. " +
      "\n\nIt REPORTS rather than tidying silently, and it never arms a " +
      "schedule someone switched off. Safe to run when you are unsure.",
    {},
    async () =>
      guard(async () => jsonResult(await client.post("/api/v1/cron-schedules/reconcile"))),
  );

  server.tool(
    "delete_cron_schedule",
    "Delete a cron schedule. HARD delete — the row is removed, the rules go " +
      "with it, and there is no restore. " +
      "\n\nTO PAUSE ONE, USE set_cron_schedule_enabled INSTEAD. Deleting is not " +
      "how you stop a schedule for a while: it destroys the timetable an author " +
      "wrote and leaves nothing saying it ever existed.",
    {
      scheduleId: z.string().describe("The cron schedule's id."),
      confirm: CONFIRM,
    },
    async ({ scheduleId }) =>
      guard(async () => {
        await client.del(`/api/v1/cron-schedules/${scheduleId}`);
        return jsonResult({ deleted: true, scheduleId });
      }),
  );

  // ---- Conditional triggers ---------------------------------------------

  /**
   * A conditional start is AUTHORED IN THE WORKFLOW DOCUMENT, and the row these
   * tools address is a copy the platform writes at publish (axonity-mcp#95).
   *
   * The trigger element (`typeId: "conditional-poll"`) carries everything on
   * its `config`: `conditionText`, `repeatIntervalMinutes`, `checkKind` and the
   * kind's settings. Publishing the workflow syncs that onto the
   * `conditional_triggers` row (`services/conditional_trigger_sync.py`):
   * creates it, updates it, and deletes the rows whose element is gone. A
   * deploy does the same, arriving switched off.
   *
   * The check is refused HERE by the platform
   * (`conditional_trigger_service._refuse_check_fields`): "A conditional
   * start's check is set on the start in the workflow, and takes effect when
   * the workflow is published." Writing it on the row would look like it
   * worked until the next publish wrote the document's check back over it. So
   * these tools no longer take `checkKind`/`checkConfig` — this connector used
   * to advertise them (#66), and every call that used them was a 422.
   *
   * `create_conditional_trigger` also sends `workflowId` in the BODY. The
   * route overrides it with the path, but `ConditionalTriggerIn` declares it
   * required, and without it every create was a 422 "body.workflowId: Field
   * required".
   */
  const AUTHORED_IN_THE_DOCUMENT =
    "\n\nTHE NORMAL PATH IS THE WORKFLOW, NOT THIS TOOL. A conditional start is " +
    "a trigger element (`typeId: \"conditional-poll\"`) in the workflow " +
    "document, written with `apply_workflow_mutations` (`add_trigger` / " +
    "`update_trigger`), with `conditionText`, `repeatIntervalMinutes` and its " +
    "CHECK (`checkKind` plus the kind's settings) on the element's `config`. " +
    "Its `id` must be a UUID, or the platform cannot make a row for it. " +
    "PUBLISHING the workflow creates or updates the row from the document and " +
    "removes rows whose element is gone; a value written on the row is " +
    "overwritten by the next publish. The check CANNOT be set on the row at " +
    "all — the platform refuses it, because a check written here would be " +
    "silently replaced by the document's at the next publish.";

  server.tool(
    "list_conditional_triggers",
    "List a workflow's conditional triggers — the rows the runtime reads, one " +
      "per conditional start in the PUBLISHED document. " +
      "\n\nREAD `checkKind` ON EACH ROW: `null` means the start has no check " +
      "and every beat becomes a run, whether or not there was work. " +
      "`checkConfig` is the check's settings as copied from the document. To " +
      "change either, edit the trigger element's `config` in the workflow and " +
      "publish — not create_/update_conditional_trigger." +
      AUTHORED_IN_THE_DOCUMENT,
    { workflowId: z.string().describe("The workflow's id.") },
    async ({ workflowId }) =>
      guard(async () =>
        jsonResult(
          await client.get(`/api/v1/workflows/${workflowId}/conditional-triggers`),
        ),
      ),
  );

  server.tool(
    "list_tenant_conditional_triggers",
    "Every conditional start in the TENANT, not one workflow's — the answer to " +
      "\"what is scheduled to run here at all\", which list_conditional_triggers " +
      "cannot give you without walking every workflow. Read-only. " +
      "\n\nEach row names the workflow it starts, so a tenant-wide list is " +
      "readable, and DISABLED triggers are included on purpose: a schedule " +
      "somebody switched off is the one you go looking for to switch back on. " +
      "\n\nREAD `pendingTasks`. It should be 1. More than one means the " +
      "schedule FORKED and the workflow is starting several times an interval " +
      "— a fault that otherwise shows up only as a surprising number of runs. " +
      "`nextScheduledFor` says when the next beat is due, and " +
      "`schedulePausedAt` is set when the whole workflow's schedule is paused, " +
      "which makes a trigger that looks enabled do nothing. " +
      "\n\nRicher rows than list_conditional_triggers, which answers with the " +
      "trigger records themselves — use that one when you are editing a " +
      "specific workflow's starts.",
    {},
    async () =>
      guard(async () =>
        jsonResult(await client.get("/api/v1/conditional-triggers")),
      ),
  );

  server.tool(
    "create_conditional_trigger",
    "Create the runtime row of a conditional start by hand. RARELY WHAT YOU " +
      "WANT: publishing the workflow creates this row from the trigger element " +
      "in the document, and the next publish overwrites what you set here. A " +
      "row for a workflow that is not published yet is created switched OFF; " +
      "publishing arms it. Takes NO check — set `checkKind` and its settings " +
      "on the trigger element's `config` in the workflow instead." +
      AUTHORED_IN_THE_DOCUMENT,
    {
      workflowId: z.string().describe("The workflow's id."),
      triggerId: z
        .string()
        .describe(
          "The id of the trigger element in the workflow document — a UUID.",
        ),
      agentId: z
        .string()
        .describe(
          "The agent this start belongs to. Not what decides whether the beat " +
            "fires — the check on the trigger element does.",
        ),
      conditionText: z
        .string()
        .min(1)
        .max(2000)
        .describe(
          "The condition, in plain language: what a person would say this " +
            "start is waiting for.",
        ),
      repeatIntervalMinutes: z
        .number()
        .int()
        .min(5)
        .max(10080)
        .describe("How often to re-check, in minutes (5 to 10080)."),
      enabled: z.boolean().optional().describe("Defaults to true."),
    },
    async ({ workflowId, triggerId, agentId, conditionText, repeatIntervalMinutes, enabled }) =>
      guard(async () =>
        jsonResult(
          await client.post(`/api/v1/workflows/${workflowId}/conditional-triggers`, {
            // Required by the platform's body schema (ConditionalTriggerIn);
            // the route then overrides it with the path.
            workflowId,
            triggerId,
            agentId,
            conditionText,
            repeatIntervalMinutes,
            ...(enabled === undefined ? {} : { enabled }),
          }),
        ),
      ),
  );

  server.tool(
    "update_conditional_trigger",
    "Change a conditional trigger's row: its enabled flag, condition, interval " +
      "or agent. Send only what you are changing. " +
      "\n\nUSE IT TO SWITCH A START OFF OR ON (`enabled`) — and know that " +
      "publishing the workflow switches its starts back ON. The other fields " +
      "are copied from the workflow document at every publish, so a change " +
      "here lasts only until the next one — change them on the trigger " +
      "element instead. The CHECK cannot be changed here at all: the platform refuses " +
      "it." +
      AUTHORED_IN_THE_DOCUMENT,
    {
      triggerId: z.string().describe("The conditional trigger's id."),
      conditionText: z.string().min(1).max(2000).optional(),
      repeatIntervalMinutes: z.number().int().min(5).max(10080).optional(),
      agentId: z.string().optional(),
      enabled: z.boolean().optional(),
    },
    async ({ triggerId, conditionText, repeatIntervalMinutes, agentId, enabled }) =>
      guard(async () => {
        // Named, not spread: a check field must never reach the row, whatever
        // a caller sends — the platform refuses it there.
        const body = Object.fromEntries(
          Object.entries({ conditionText, repeatIntervalMinutes, agentId, enabled }).filter(
            ([, v]) => v !== undefined,
          ),
        );
        return jsonResult(
          await client.patch(`/api/v1/conditional-triggers/${triggerId}`, body),
        );
      }),
  );

  server.tool(
    "delete_conditional_trigger",
    "Delete a conditional trigger. HARD delete — the row is removed and cannot " +
      "be restored. While the trigger element is still in the workflow " +
      "document, the next publish creates the row again: to remove a start " +
      "for good, remove the element (`remove_trigger`) and publish — that " +
      "deletes the row too.",
    {
      triggerId: z.string().describe("The conditional trigger's id."),
      confirm: CONFIRM,
    },
    async ({ triggerId }) =>
      guard(async () => {
        await client.del(`/api/v1/conditional-triggers/${triggerId}`);
        return jsonResult({ deleted: true, triggerId });
      }),
  );
}
