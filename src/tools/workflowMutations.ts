/**
 * `apply_workflow_mutations` — structural edits to a workflow document.
 *
 * A workflow's steps and edges are edited through mutation COMMANDS (the same
 * backend-authoritative model the Studio uses), never by replacing the whole
 * document. The backend applies and validates the commands and returns the new
 * authoritative document + version.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { AxonityApiError } from "../errors.js";

export function registerWorkflowMutations(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "apply_workflow_mutations",
    "Apply structural mutation commands to a workflow draft (add/remove steps, " +
      "connect edges, set conditions). Read the workflow first for its version. " +
      "Returns the new authoritative document + version. On a 409 conflict, " +
      "re-read and retry.",
    {
      id: z.string().describe("The workflow's id."),
      expectedVersion: z
        .number()
        .int()
        .describe("The version you last read — rejected with 409 if stale."),
      mutations: z
        .array(z.record(z.unknown()))
        .describe(
          "A list of mutation commands, each a JSON object with a command name " +
            "and its arguments (camelCase).",
        ),
    },
    async ({ id, expectedVersion, mutations }) => {
      try {
        const data = await client.post(`/api/v1/workflows/${id}/mutations`, {
          expectedVersion,
          mutations,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        const message =
          err instanceof AxonityApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    },
  );
}
