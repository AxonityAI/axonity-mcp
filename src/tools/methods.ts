/**
 * What is specific to a method, beyond the generic entity family.
 *
 * The family (`list_methods`, `update_method`, the versions, publish, archive…)
 * comes from the registrar, and the placement of prompts on a method's steps is
 * `promptPlacement.ts`. What a method has that no other kind does is *Used by*:
 * which agents run it and through which workflows (`GET /methods/{id}/used-by`,
 * `MethodUsageResponse` in `schemas/workflow.py`).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

export function registerMethodTools(server: McpServer, client: AxonityClient): void {
  server.tool(
    "read_method_used_by",
    "Who runs a method — read it before you change, delete or archive one: " +
      "{ agents: [{ id, name }], workflows: [{ id, name, state, steps }] }. " +
      "`agents` are the agents that run it: for each workflow step that runs the " +
      "method, the step's own owner, else the workflow's owner, name-ordered. " +
      "`workflows` are the workflows in use (not deleted, not archived) whose " +
      "steps run it, once per document that names it: `state` is `published` " +
      "(live now, and it blocks delete_method and archive_method) or `draft` " +
      "(still being built, and it does not); `steps` are the author's own names " +
      "for the steps. For the platform's default method — the one a step runs " +
      "when it names none — it is the agent steps that name no method. Read-only.",
    { id: z.string().describe("The method's id.") },
    async ({ id }) =>
      guard(async () => jsonResult(await client.get(`/api/v1/methods/${id}/used-by`))),
  );
}
