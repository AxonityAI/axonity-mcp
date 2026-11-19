/**
 * Prompt-element placement — where a prompt snippet actually takes effect.
 *
 * A snippet (the `prompt_snippet` entity) is a LIBRARY item: creating it does
 * nothing on its own. It only shapes a run once it is PLACED into a method step's
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
import { defineTool } from "./aliases.js";
import { detachResult, guard, jsonResult } from "./result.js";

/** The two prompt channels a snippet can be placed in. */
const TARGET = z
  .enum(["system", "user"])
  .describe(
    "Which prompt channel to place the snippet in: 'system' (instructions the " +
      "model is steered by) or 'user' (content presented as the user turn).",
  );

/** The old spelling of a step id and a method id, which an old tool name still takes. */
const FORMER_STEP_ID = {
  flowStepId: z.string().describe("The method step's id (this tool's old spelling)."),
};
const FORMER_METHOD_ID = {
  flowId: z.string().describe("The method's id (this tool's old spelling)."),
};
const toStepId = ({ flowStepId, ...rest }: Record<string, unknown>) => ({
  ...rest,
  methodStepId: flowStepId,
});

export function registerPromptPlacementTools(
  server: McpServer,
  client: AxonityClient,
): void {
  defineTool(
    server,
    "list_method_step_prompts",
    "List the prompt snippets attached to a method step — its `system` and `user` " +
      "prompt stacks, each entry with its link id and display order. This is how " +
      "you see a step's current prompt composition before changing it. Excludes " +
      "wildcard snippets (see list_wildcard_prompts). Read-only.",
    { methodStepId: z.string().describe("The method step's id.") },
    async ({ methodStepId }: { methodStepId: string }) =>
      guard(async () =>
        jsonResult(await client.get(`/api/v1/method-steps/${methodStepId}/prompts`)),
      ),
    {
      name: "list_flow_step_prompts",
      shape: FORMER_STEP_ID,
      adapt: toStepId,
    },
  );

  defineTool(
    server,
    "attach_prompt_snippet_to_method_step",
    "Place a library prompt snippet into a method step's prompt stack. Choose the " +
      "channel (`target`: system/user) and its order in that channel. This is " +
      "what makes a snippet actually shape the step's prompt — creating the " +
      "snippet alone does nothing. Returns the created link (with its linkId) so " +
      "you can reorder or detach it later.",
    {
      methodStepId: z.string().describe("The method step's id."),
      snippetId: z.string().describe("The prompt snippet's id (a UUID)."),
      target: TARGET,
      displayOrder: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Position within the chosen channel (0 = first). Defaults to 0."),
    },
    async ({
      methodStepId,
      snippetId,
      target,
      displayOrder,
    }: {
      methodStepId: string;
      snippetId: string;
      target: "system" | "user";
      displayOrder?: number;
    }) =>
      guard(async () =>
        jsonResult(
          await client.post(`/api/v1/method-steps/${methodStepId}/prompts`, {
            snippetId,
            target,
            ...(displayOrder === undefined ? {} : { displayOrder }),
          }),
        ),
      ),
    {
      name: "attach_prompt_snippet_to_flow_step",
      shape: {
        ...FORMER_STEP_ID,
        snippetId: z.string().describe("The prompt snippet's id (a UUID)."),
        target: TARGET,
        displayOrder: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Position within the chosen channel (0 = first). Defaults to 0."),
      },
      adapt: toStepId,
    },
  );

  defineTool(
    server,
    "update_method_step_prompt",
    "Change an existing method-step prompt attachment: move it between the system " +
      "and user channel, and/or change its display order. Identify it by its " +
      "linkId (from list_method_step_prompts or the attach response), NOT the " +
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
    async ({
      linkId,
      target,
      displayOrder,
    }: {
      linkId: string;
      target?: "system" | "user";
      displayOrder?: number;
    }) =>
      guard(async () => {
        const body: Record<string, unknown> = {};
        if (target !== undefined) body.target = target;
        if (displayOrder !== undefined) body.displayOrder = displayOrder;
        return jsonResult(
          await client.patch(`/api/v1/method-step-prompts/${linkId}`, body),
        );
      }),
    { name: "update_flow_step_prompt" },
  );

  defineTool(
    server,
    "reorder_method_step_prompts",
    "Set the full ordering of a method step's prompt snippets in one call. Pass the " +
      "snippet ids in the order you want them; the backend replaces the step's " +
      "ordering with this list. Read the step first (list_method_step_prompts) so " +
      "you include every snippet — omitting one is a reorder, not a safe no-op.",
    {
      methodStepId: z.string().describe("The method step's id."),
      snippetIds: z
        .array(z.string())
        .min(1)
        .max(512)
        .describe("Snippet ids (UUIDs) in the desired order."),
    },
    async ({ methodStepId, snippetIds }: { methodStepId: string; snippetIds: string[] }) =>
      guard(async () =>
        jsonResult(
          await client.put(`/api/v1/method-steps/${methodStepId}/prompts/order`, {
            snippetIds,
          }),
        ),
      ),
    {
      name: "reorder_flow_step_prompts",
      shape: {
        ...FORMER_STEP_ID,
        snippetIds: z
          .array(z.string())
          .min(1)
          .max(512)
          .describe("Snippet ids (UUIDs) in the desired order."),
      },
      adapt: toStepId,
    },
  );

  defineTool(
    server,
    "detach_prompt_snippet_from_method_step",
    "Remove a prompt snippet from a method step's stack. This only unlinks it — the " +
      "snippet itself is not deleted and stays available to place elsewhere. " +
      "Identify the link by its linkId (from list_method_step_prompts). This route " +
      "answers 204 with no body, so the result confirms the call was accepted and " +
      "nothing more — read the stack back with list_method_step_prompts to see what " +
      "is actually attached.",
    { linkId: z.string().describe("The attachment's link id (not the snippet id).") },
    async ({ linkId }: { linkId: string }) =>
      guard(async () =>
        detachResult(await client.del(`/api/v1/method-step-prompts/${linkId}`), {
          readBack: "list_method_step_prompts",
          request: { linkId },
        }),
      ),
    { name: "detach_prompt_snippet_from_flow_step" },
  );

  server.tool(
    "read_workflow_prompt_stacks",
    "Resolve a workflow to the method steps under its agent steps and each step's " +
      "prompt stack in one read: per step you get its methodStepId, its name " +
      "(spelled `flowStepName` in the answer), and its system/user prompt " +
      "snippets (with link ids and order). Only agent steps with an explicit " +
      "methodId are listed; one without is left out. This is how you discover the " +
      "methodStepIds you need before placing prompts, and how you see a " +
      "workflow's whole prompt composition. Read-only.",
    { workflowId: z.string().describe("The workflow's id.") },
    async ({ workflowId }) =>
      guard(async () =>
        jsonResult(
          await client.get(`/api/v1/workflows/${workflowId}/prompt-stacks`),
        ),
      ),
  );

  defineTool(
    server,
    "read_method_prompt_stacks",
    "The method-scoped counterpart of read_workflow_prompt_stacks: resolve a method " +
      "to its steps and their system/user prompt stacks (methodStepId, the step's " +
      "name as `flowStepName`, link ids, order), plus the tenant's wildcard " +
      "prompts. Read-only.",
    { methodId: z.string().describe("The method's id.") },
    async ({ methodId }: { methodId: string }) =>
      guard(async () =>
        jsonResult(await client.get(`/api/v1/methods/${methodId}/prompt-stacks`)),
      ),
    {
      name: "read_flow_prompt_stacks",
      shape: FORMER_METHOD_ID,
      adapt: ({ flowId }) => ({ methodId: flowId }),
    },
  );

  server.tool(
    "list_wildcard_prompts",
    "List the tenant's wildcard prompt snippets — those that apply to EVERY method " +
      "step (they sit at the top of each step's prompt stack). Use this for " +
      "cross-cutting instructions that should hold everywhere, rather than " +
      "attaching the same snippet to every step by hand. Read-only.",
    {},
    async () =>
      guard(async () => jsonResult(await client.get("/api/v1/wildcard-prompts"))),
  );
}
