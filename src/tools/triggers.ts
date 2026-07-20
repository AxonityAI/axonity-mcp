/**
 * Trigger management — what makes a published workflow actually run.
 *
 * Three trigger kinds, all member-accessible despite living in `*_admin.py` on
 * the backend. Note the asymmetry the routes impose: creating and listing are
 * workflow-scoped, while rotate/update/delete address the trigger directly.
 *
 * Trigger deletes are HARD deletes — the row is removed, not soft-deleted, and
 * there is no restore. Hence the `confirm` guard on each.
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
    "create_cron_schedule",
    "Schedule a workflow to run on a cron expression.",
    {
      workflowId: z.string().describe("The workflow's id."),
      triggerId: z
        .string()
        .describe("The id of the trigger node in the workflow document."),
      cronExpr: z
        .string()
        .describe('The cron expression, e.g. "0 9 * * 1-5" for weekdays at 09:00.'),
      timezone: z
        .string()
        .optional()
        .describe('IANA timezone, e.g. "Europe/Brussels". Defaults to UTC.'),
      enabled: z.boolean().optional().describe("Defaults to true."),
    },
    async ({ workflowId, triggerId, cronExpr, timezone, enabled }) =>
      guard(async () =>
        jsonResult(
          await client.post(`/api/v1/workflows/${workflowId}/cron-schedules`, {
            triggerId,
            cronExpr,
            ...(timezone ? { timezone } : {}),
            ...(enabled === undefined ? {} : { enabled }),
          }),
        ),
      ),
  );

  server.tool(
    "delete_cron_schedule",
    "Delete a cron schedule. HARD delete — the row is removed and cannot be " +
      "restored. The workflow stops running on this schedule immediately.",
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

  server.tool(
    "list_conditional_triggers",
    "List a workflow's conditional triggers — an agent evaluates a condition " +
      "on an interval and starts the workflow when it holds.",
    { workflowId: z.string().describe("The workflow's id.") },
    async ({ workflowId }) =>
      guard(async () =>
        jsonResult(
          await client.get(`/api/v1/workflows/${workflowId}/conditional-triggers`),
        ),
      ),
  );

  server.tool(
    "create_conditional_trigger",
    "Create a conditional trigger on a workflow: an agent checks `conditionText` " +
      "every `repeatIntervalMinutes` and fires the workflow when it is met.",
    {
      workflowId: z.string().describe("The workflow's id."),
      triggerId: z
        .string()
        .describe("The id of the trigger node in the workflow document."),
      agentId: z.string().describe("The agent that evaluates the condition."),
      conditionText: z
        .string()
        .min(1)
        .max(2000)
        .describe("The condition, in plain language."),
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
    "Change a conditional trigger's condition, interval, agent, or enabled flag. " +
      "Send only what you are changing.",
    {
      triggerId: z.string().describe("The conditional trigger's id."),
      conditionText: z.string().min(1).max(2000).optional(),
      repeatIntervalMinutes: z.number().int().min(5).max(10080).optional(),
      agentId: z.string().optional(),
      enabled: z.boolean().optional(),
    },
    async ({ triggerId, ...fields }) =>
      guard(async () => {
        const body = Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v !== undefined),
        );
        return jsonResult(
          await client.patch(`/api/v1/conditional-triggers/${triggerId}`, body),
        );
      }),
  );

  server.tool(
    "delete_conditional_trigger",
    "Delete a conditional trigger. HARD delete — the row is removed and cannot " +
      "be restored.",
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
