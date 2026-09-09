/**
 * What a workflow is MADE OF, and how to make one part of it its own
 * (axonity-flow#1369 / #1371).
 *
 * The connector could already answer the reverse question. `list_workflows_using`
 * says which workflows reference an entity — read it before you change something
 * shared. Nothing answered the forward one: given this workflow, what does it
 * depend on? The guide's own "Reproducing a setup" section tells an agent to
 * work it out by hand — read the steps, follow each to its agent, follow that to
 * its tools, follow those to the tables behind them, and remember the lot. That
 * is a walk with no natural end and one an agent gets partly wrong.
 *
 * It is not the same question with the arrow reversed, either. The reverse
 * reader looks at workflow DOCUMENTS. This one composes two hops: which entities
 * the document names, and then what each agent actually receives and each tool
 * actually reaches — because "what is attached" and "what the agent gets" have
 * different answers, and only the second one explains a run.
 *
 * Every row carries WHY it is there. An entity reached twice is one dependency
 * with two reasons, and "in these two steps" is something an author can act on
 * where a bare "used" is not.
 *
 * `duplicate_workflow_component` is the other half, and it exists because
 * sharing is the default: an agent used by three processes is ONE agent, so
 * editing it from inside one of them changes the two nobody opened. The copy
 * belongs to this workflow, the original is not touched, and every other
 * workflow stays on the original.
 *
 * That is not the "recreate, never copy ids" rule breaking. That rule is about
 * carrying an id ACROSS TENANTS, where it points at nothing or at the wrong
 * thing. This is one tenant, and the backend rewrites the references itself.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

export function registerComponentTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "list_workflow_components",
    "Everything this workflow is made of, in ONE call: the agents and flows " +
      "that run its steps, the workflows it calls, the tools those agents " +
      "reach, the tables behind those tools, and the knowledge attached to " +
      "them. Read-only. " +
      "\n\nUSE THIS BEFORE REPRODUCING OR AUDITING A SETUP. The alternative is " +
      "walking the document step by step and following each entity outward by " +
      "hand, which is where a recreated workflow quietly loses a tool nobody " +
      "noticed was attached. " +
      "\n\nEach row carries `section` (agents / called / tools / tables / " +
      "knowledge), `kind`, `entityId`, `name`, and `sources` — the steps that " +
      "are the REASON it is here. One entity reached twice is one row with two " +
      "sources, not two rows. " +
      "\n\nREAD `publicationState`: it says whether the RUNTIME can see this " +
      "component at all. `live` is published and unchanged; `edited` is " +
      "published with newer changes the runtime has NOT got; `not_published` " +
      "has never gone live and reaches nobody; `missing` was deleted out from " +
      "under the workflow while still referenced; `not_versioned` is a kind " +
      "with no publish lifecycle. A workflow whose components are `edited` or " +
      "`not_published` runs on something other than what you just read. " +
      "\n\n`reach` counts the workflows in the tenant that name this component " +
      "directly, INCLUDING this one — so 1 means it is yours alone and 3 means " +
      "changing it changes two other processes. That is the number to look at " +
      "before you edit something, and duplicate_workflow_component is the way " +
      "out when it is higher than you want. " +
      "\n\nAn unknown workflow id is a 404, not an empty list: a workflow that " +
      "names nothing and a workflow that does not exist are different answers.",
    { workflowId: z.string().describe("The workflow's id.") },
    async ({ workflowId }) =>
      guard(async () =>
        jsonResult(
          await client.get(`/api/v1/workflows/${workflowId}/components`),
        ),
      ),
  );

  server.tool(
    "duplicate_workflow_component",
    "Copy a SHARED component and point THIS workflow at the copy — the way to " +
      "make one process's agent its own without disturbing the processes that " +
      "share it. The original is not modified and every other workflow stays " +
      "on it. " +
      "\n\nWHY YOU WOULD: list_workflow_components gives each row a `reach`. " +
      "When that is greater than 1, editing the component edits processes you " +
      "did not open. Duplicating first turns an edit that reaches three " +
      "processes into one that reaches this one. " +
      "\n\nTHE ANSWER IS THE WHOLE DOCUMENT, NOT A PATCH: { newEntityId, name, " +
      "version, document }. The repoint rewrites EVERY site the component was " +
      "named in, so a caller that applied only part of the answer would keep a " +
      "stale reference on the sites it did not hear about. Take the document " +
      "and the version as your new baseline. " +
      "\n\nAGENTS ONLY today — `kind` accepts nothing else, and the backend " +
      "refuses anything else rather than half-doing it.",
    {
      workflowId: z.string().describe("The workflow that should get its own copy."),
      kind: z
        .literal("agent")
        .describe(
          "What is being duplicated. Only `agent` is supported; the route " +
            "declares it as a constant, not as an open vocabulary.",
        ),
      entityId: z
        .string()
        .min(1)
        .max(200)
        .describe("The shared component's id, from list_workflow_components."),
    },
    async ({ workflowId, kind, entityId }) =>
      guard(async () =>
        jsonResult(
          await client.post(
            `/api/v1/workflows/${workflowId}/components/duplicate`,
            { kind, entityId },
          ),
        ),
      ),
  );
}
