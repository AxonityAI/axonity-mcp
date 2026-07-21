/**
 * `apply_workflow_mutations` — structural edits to a workflow document.
 *
 * A workflow's steps and edges are edited through mutation COMMANDS (the same
 * backend-authoritative model the Studio uses), never by replacing the whole
 * document. The backend applies and validates the commands and returns the new
 * authoritative document + version.
 *
 * The backend route applies exactly ONE mutation per call — `POST
 * /workflows/{id}/mutations` takes `{ type, payload, expectedVersion }` and there
 * is no batch route. This tool keeps a batch-shaped signature (an agent thinks in
 * whole edits, not round-trips) and sequences the calls itself, threading the
 * version returned by call N into call N+1.
 *
 * Because the sequence is not a transaction, a failure at index k leaves the
 * mutations before it applied. The error says how many landed and which one
 * failed so the caller can re-read and resume rather than blindly retry — a
 * retry from the top would re-apply the successful prefix.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { AxonityApiError } from "../errors.js";
import { guard, jsonResult } from "./result.js";

/** The response shape of a single mutation call. */
interface MutationResponse {
  version: number;
  document?: unknown;
  launchable?: boolean;
  validationIssues?: unknown[];
}

/**
 * Split one command into the `{ type, payload }` pair the backend expects.
 *
 * Accepts both the explicit form (`{ type, payload: {...} }`) and the flat form
 * (`{ type, ...args }`), because an agent writing these by hand produces either
 * and the difference is not meaningful to it.
 */
export function toMutationBody(
  mutation: Record<string, unknown>,
  index: number,
): { type: string; payload: Record<string, unknown> } {
  const { type, payload, ...rest } = mutation;

  if (typeof type !== "string" || type.length === 0) {
    throw new Error(
      `mutations[${index}] is missing a \`type\` (e.g. "add_step", "add_edge").`,
    );
  }

  if (payload !== undefined) {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error(`mutations[${index}].payload must be a JSON object.`);
    }
    return { type, payload: payload as Record<string, unknown> };
  }

  return { type, payload: rest };
}

/** Compose the error for a mutation that failed part-way through a sequence. */
function sequenceError(
  index: number,
  total: number,
  type: string,
  version: number,
  cause: unknown,
): Error {
  const reason =
    cause instanceof AxonityApiError || cause instanceof Error
      ? cause.message
      : String(cause);
  const applied = index;
  const summary = JSON.stringify(
    { appliedCount: applied, failedIndex: index, failedType: type, currentVersion: version },
    null,
    2,
  );
  return new Error(
    `Mutation ${index + 1} of ${total} (\`${type}\`) failed: ${reason}\n\n` +
      `${applied} of ${total} mutations were already applied and were NOT rolled back — ` +
      `this sequence is not a transaction. Do not retry the whole list: re-read the ` +
      `workflow, confirm which edits landed, and resume from index ${index}.\n\n` +
      summary,
  );
}

export function registerWorkflowMutations(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "apply_workflow_mutations",
    "Apply structural mutation commands to a workflow draft (add/remove steps, " +
      "connect edges, set conditions). Read the workflow first for its version. " +
      "Commands are applied IN ORDER, one backend call each, with the version " +
      "threaded automatically — pass the version you read, not one per command. " +
      "Returns the new authoritative document, version, and validation state. " +
      "Not transactional: if command N fails, commands before it stay applied and " +
      "the error reports how many landed. On a 409 conflict, re-read and retry. " +
      'Each command is `{ "type": "add_step", "payload": { … } }`; the flat form ' +
      '`{ "type": "add_step", … }` is accepted too. Valid types: update_workflow, ' +
      "add_trigger, update_trigger, remove_trigger, update_trigger_operator, " +
      "group_triggers, ungroup_triggers, move_trigger, add_step, add_loop, " +
      "update_step, remove_step, move_step, add_edge, update_edge, remove_edge, " +
      "convert_to_loop, setup_loop_decision, advanced_edit.",
    {
      id: z.string().describe("The workflow's id."),
      expectedVersion: z
        .number()
        .int()
        .describe(
          "The version you last read. Only the FIRST command uses it; later " +
            "commands use the version returned by the previous one.",
        ),
      mutations: z
        .array(z.record(z.unknown()))
        .min(1)
        .describe(
          "Mutation commands to apply in order, each a JSON object with a " +
            "`type` and its arguments (camelCase), either nested under " +
            "`payload` or inline.",
        ),
  },
  async ({ id, expectedVersion, mutations }) =>
      guard(async () => {
        // Reject the whole batch on a malformed command before applying any of
        // it — a shape error is the agent's mistake, not a partial failure.
        const bodies = mutations.map((m, i) => toMutationBody(m, i));

        let version = expectedVersion;
        let last: MutationResponse | undefined;

        for (const [index, body] of bodies.entries()) {
          try {
            last = await client.post<MutationResponse>(
              `/api/v1/workflows/${id}/mutations`,
              { type: body.type, payload: body.payload, expectedVersion: version },
            );
          } catch (cause) {
            throw sequenceError(index, bodies.length, body.type, version, cause);
          }
          version = last.version;
        }

        return jsonResult({ ...last, appliedCount: bodies.length });
      }),
  );

  server.tool(
    "replace_workflow_document",
    "Replace the ENTIRE workflow document in one atomic call. Read the workflow first to " +
      "get the current version, then call this again only after rereading on a stale " +
      "`409`.\n" +
      "Unlike `apply_workflow_mutations`, this is a single PUT request and treats the " +
      "payload as the complete editable document.",
    {
      id: z.string().describe("The workflow's id."),
      expectedVersion: z
        .number()
        .int()
        .describe("The version you read before replacing the document."),
      document: z
        .record(z.unknown())
        .describe("The complete workflow document object to persist."),
    },
    async ({ id, expectedVersion, document }) =>
      guard(async () =>
        jsonResult(
          await client.put(`/api/v1/workflows/${id}`, {
            expectedVersion,
            document,
          }),
        ),
      ),
  );
}
