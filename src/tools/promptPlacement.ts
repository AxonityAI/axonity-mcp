/**
 * Prompt-element placement — where a prompt snippet actually takes effect.
 *
 * A snippet (the `prompt_snippet` entity) is a LIBRARY item: creating it does
 * nothing on its own. It only shapes a run once it is PLACED into a flow step's
 * prompt stack — in the `system` or `user` channel, at a chosen order — or made
 * a tenant-wide "wildcard" that sits at the top of every step's stack.
 *
 * These tools wrap the placement routes in the backend's `prompt_snippets.py`.
 * The snippet CRUD itself is the generic `*_prompt_snippet` entity family; this
 * module is only the linking layer that the generic registrar can't express.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

/** The two prompt channels a snippet can be placed in. */
const TARGET = z
  .enum(["system", "user"])
  .describe(
    "Which prompt channel to place the snippet in: 'system' (instructions the " +
      "model is steered by) or 'user' (content presented as the user turn).",
  );

export function registerPromptPlacementTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "list_flow_step_prompts",
    "List the prompt snippets attached to a flow step — its `system` and `user` " +
      "prompt stacks, each entry with its link id and display order. This is how " +
      "you see a step's current prompt composition before changing it. Excludes " +
      "wildcard snippets (see list_wildcard_prompts). Read-only.",
    { flowStepId: z.string().describe("The flow step's id.") },
    async ({ flowStepId }) =>
      guard(async () =>
        jsonResult(await client.get(`/api/v1/flow-steps/${flowStepId}/prompts`)),
      ),
  );

  server.tool(
    "attach_prompt_snippet_to_flow_step",
    "Place a library prompt snippet into a flow step's prompt stack. Choose the " +
      "channel (`target`: system/user) and its order in that channel. This is " +
      "what makes a snippet actually shape the step's prompt — creating the " +
      "snippet alone does nothing. Returns the created link (with its linkId) so " +
      "you can reorder or detach it later.",
    {
      flowStepId: z.string().describe("The flow step's id."),
      snippetId: z.string().describe("The prompt snippet's id (a UUID)."),
      target: TARGET,
      displayOrder: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Position within the chosen channel (0 = first). Defaults to 0."),
    },
    async ({ flowStepId, snippetId, target, displayOrder }) =>
      guard(async () =>
        jsonResult(
          await client.post(`/api/v1/flow-steps/${flowStepId}/prompts`, {
            snippetId,
            target,
            ...(displayOrder === undefined ? {} : { displayOrder }),
          }),
        ),
      ),
  );

  server.tool(
    "update_flow_step_prompt",
    "Change an existing flow-step prompt attachment: move it between the system " +
      "and user channel, and/or change its display order. Identify it by its " +
      "linkId (from list_flow_step_prompts or the attach response), NOT the " +
      "snippet id. Send only what you are changing.",
    {
      linkId: z.string().describe("The attachment's link id (not the snippet id)."),
      target: z
        .enum(["system", "user"])
        .optional()
        .describe("New channel. Omit to leave it unchanged."),
      displayOrder: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("New position in its channel. Omit to leave it unchanged."),
    },
    async ({ linkId, target, displayOrder }) =>
      guard(async () => {
        const body: Record<string, unknown> = {};
        if (target !== undefined) body.target = target;
        if (displayOrder !== undefined) body.displayOrder = displayOrder;
        return jsonResult(
          await client.patch(`/api/v1/flow-step-prompts/${linkId}`, body),
        );
      }),
  );

  server.tool(
    "reorder_flow_step_prompts",
    "Set the full ordering of a flow step's prompt snippets in one call. Pass the " +
      "snippet ids in the order you want them; the backend replaces the step's " +
      "ordering with this list. Read the step first (list_flow_step_prompts) so " +
      "you include every snippet — omitting one is a reorder, not a safe no-op.",
    {
      flowStepId: z.string().describe("The flow step's id."),
      snippetIds: z
        .array(z.string())
        .min(1)
        .max(512)
        .describe("Snippet ids (UUIDs) in the desired order."),
    },
    async ({ flowStepId, snippetIds }) =>
      guard(async () =>
        jsonResult(
          await client.put(`/api/v1/flow-steps/${flowStepId}/prompts/order`, {
            snippetIds,
          }),
        ),
      ),
  );

  server.tool(
    "detach_prompt_snippet_from_flow_step",
    "Remove a prompt snippet from a flow step's stack. This only unlinks it — the " +
      "snippet itself is not deleted and stays available to place elsewhere. " +
      "Identify the link by its linkId (from list_flow_step_prompts).",
    { linkId: z.string().describe("The attachment's link id (not the snippet id).") },
    async ({ linkId }) =>
      guard(async () => {
        await client.del(`/api/v1/flow-step-prompts/${linkId}`);
        return jsonResult({ detached: true, linkId });
      }),
  );

  server.tool(
    "read_workflow_prompt_stacks",
    "Resolve a workflow to its flow steps and each step's prompt stack in one " +
      "read: per step you get its flowStepId, name, and its system/user prompt " +
      "snippets (with link ids and order). This is how you discover the " +
      "flowStepIds you need before placing prompts, and how you see a workflow's " +
      "whole prompt composition. Read-only.",
    { workflowId: z.string().describe("The workflow's id.") },
    async ({ workflowId }) =>
      guard(async () =>
        jsonResult(
          await client.get(`/api/v1/workflows/${workflowId}/prompt-stacks`),
        ),
      ),
  );

  server.tool(
    "read_flow_prompt_stacks",
    "The flow-scoped counterpart of read_workflow_prompt_stacks: resolve a flow " +
      "to its steps and their system/user prompt stacks (flowStepId, link ids, " +
      "order). Read-only.",
    { flowId: z.string().describe("The flow's id.") },
    async ({ flowId }) =>
      guard(async () =>
        jsonResult(await client.get(`/api/v1/flows/${flowId}/prompt-stacks`)),
      ),
  );

  server.tool(
    "list_wildcard_prompts",
    "List the tenant's wildcard prompt snippets — those that apply to EVERY flow " +
      "step (they sit at the top of each step's prompt stack). Use this for " +
      "cross-cutting instructions that should hold everywhere, rather than " +
      "attaching the same snippet to every step by hand. Read-only.",
    {},
    async () =>
      guard(async () => jsonResult(await client.get("/api/v1/wildcard-prompts"))),
  );
}
