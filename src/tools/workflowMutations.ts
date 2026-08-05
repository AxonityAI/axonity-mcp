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

/** A required literal — an agent cannot satisfy it by filling in a default. */
const CONFIRM = z
  .literal(true)
  .describe("Must be true. Acknowledges you understand this is destructive.");

/** The response shape of a single mutation call. */
interface MutationResponse {
  version: number;
  document?: unknown;
  launchable?: boolean;
  validationIssues?: unknown[];
  /**
   * What the platform changed on its own in this call: the end-step edges it
   * wired, and the bound inputs whose contract it re-derived. Ids and names
   * only, by design, so it rides safely on the summary — and it is the whole
   * point of forwarding it: an author who found edges they never asked for
   * previously had to diff the entire document to see them.
   */
  systemAdjustments?: {
    addedEdges?: unknown[];
    removedEdges?: unknown[];
    rederivedInputs?: unknown[];
  };
}

/** True when the platform reported doing something of its own accord. */
function hasAdjustments(a: MutationResponse["systemAdjustments"]): boolean {
  if (!a) return false;
  return Boolean(
    a.addedEdges?.length || a.removedEdges?.length || a.rederivedInputs?.length,
  );
}

/**
 * Why the document is not forwarded by default (#21).
 *
 * The backend answers every mutation with the WHOLE document. A real workflow
 * runs past 100k characters, which overflows the client's response limit — so a
 * change that SUCCEEDED came back as an error. Believing that error and retrying
 * applies the change twice (with `add_step`, a duplicate step). It also made the
 * deliberate non-transactional semantics far worse than they need to be: an
 * unreadable failure on a partially-applied sequence.
 *
 * So the client projects the response down to what a caller acts on, and hands
 * over the document only when asked. Two caps keep even the summary bounded:
 * `validationIssues` is caller-controlled in size, and an API error message can
 * carry the server's body (see `withDetail` in errors.ts) — which is another way
 * a document can reach the response.
 */
const MAX_VALIDATION_ISSUES = 25;
const MAX_REASON_CHARS = 1500;

/** Shorten a string, saying so rather than truncating silently. */
function cap(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [truncated ${text.length - limit} of ${text.length} characters]`;
}

/** Count array members at a path in the document, when it looks as expected. */
function countAt(document: unknown, key: "all" | "edges"): number | undefined {
  const steps = (document as { steps?: Record<string, unknown> } | undefined)?.steps;
  const value = steps?.[key];
  return Array.isArray(value) ? value.length : undefined;
}

/**
 * Project a mutation response into the compact summary a caller acts on:
 * the new version, what landed, the launchable verdict, validation issues, and
 * cheap orientation counts taken from the document before it is dropped.
 */
export function summarizeMutation(
  response: MutationResponse,
  appliedCount: number,
  returnDocument: boolean,
): Record<string, unknown> {
  const issues = Array.isArray(response.validationIssues) ? response.validationIssues : [];
  const kept = issues.slice(0, MAX_VALIDATION_ISSUES);
  const stepCount = countAt(response.document, "all");
  const edgeCount = countAt(response.document, "edges");

  return {
    version: response.version,
    appliedCount,
    ...(response.launchable === undefined ? {} : { launchable: response.launchable }),
    ...(stepCount === undefined ? {} : { stepCount }),
    ...(edgeCount === undefined ? {} : { edgeCount }),
    // Only when something actually happened — an empty object on every response
    // trains a reader to skip the field.
    ...(hasAdjustments(response.systemAdjustments)
      ? { systemAdjustments: response.systemAdjustments }
      : {}),
    validationIssues: kept,
    ...(issues.length > kept.length
      ? {
          validationIssuesTruncated: issues.length - kept.length,
          validationIssuesTotal: issues.length,
        }
      : {}),
    // Absent by default — say where it is rather than leaving the caller guessing.
    ...(returnDocument
      ? { document: response.document }
      : { documentOmitted: "Summary only. Pass returnDocument: true, or call read_workflow." }),
  };
}

/*
 * The document metadata story on `PUT /workflows/{id}`, post axonity-flow#805.
 *
 * There used to be a local pre-flight warning here. `WorkflowDocumentSchema`
 * carried the default `extra="ignore"` and the route re-serialised the parsed
 * model, so `name`, `description`, `stageId`, `capabilityId`, `valueStreamId`
 * and `onFailure` were discarded before the service saw them — and the call
 * still answered 200. A use case was signed off carrying the description of the
 * PREVIOUS implementation. We could not make those keys stick, so we said so.
 *
 * #808 put `extra="allow"` on the schema and the silence is gone. The six keys
 * now split in two, and the server states both outcomes itself:
 *   - `name` / `description` PERSIST — the service syncs them from the document
 *     onto their authoritative columns. An omitted key leaves the stored value
 *     alone; an explicit "" clears it.
 *   - `stageId` / `capabilityId` / `valueStreamId` / `onFailure` are PATCH-only.
 *     Changing one is refused with a 422 naming the field; round-tripping it
 *     unchanged passes, which is what a read-edit-write caller does.
 *
 * So the warning is deleted rather than reworded. It would now fire on every
 * honest round trip (every read overlays name and description into the
 * document) to repeat something the server already enforces — and its central
 * claim, "the change did not land", became false for the two keys callers
 * actually change. A thin client does not restate a contract the server tells
 * the truth about; see `docs/` and the conformance snapshot for that contract.
 */

/** The `returnDocument` opt-in, shared by both document-returning tools. */
const RETURN_DOCUMENT = z
  .boolean()
  .optional()
  .describe(
    "Include the full workflow document in the response. Defaults to false — a " +
      "real document can exceed the response limit and turn a successful call " +
      "into an error. Prefer read_workflow when you need it.",
  );

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
  // An AxonityApiError message can carry the server's response body, and that
  // body is often the whole document — the very thing this tool refuses to
  // forward. Cap it so a mid-sequence failure stays readable (#21).
  const reason = cap(
    cause instanceof AxonityApiError || cause instanceof Error
      ? cause.message
      : String(cause),
    MAX_REASON_CHARS,
  );
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
      "\n\nRESPONSE IS A SUMMARY, not the document: version, appliedCount, " +
      "launchable, validationIssues, stepCount, edgeCount. A real workflow " +
      "document can exceed the response limit, which would turn a call that " +
      "SUCCEEDED into an error you must not retry. Pass returnDocument: true, or " +
      "call read_workflow, when you need the document itself. " +
      "\n\nNot transactional: if command N fails, commands before it stay applied " +
      "and the error reports how many landed and which index failed — resume from " +
      "there, do NOT replay the list. On a 409 conflict, re-read and retry. " +
      '\n\nEach command is `{ "type": "add_step", "payload": { … } }`; the flat ' +
      'form `{ "type": "add_step", … }` is accepted too. Valid types: ' +
      "update_workflow, add_trigger, update_trigger, remove_trigger, " +
      "update_trigger_operator, group_triggers, ungroup_triggers, move_trigger, " +
      "add_step, add_loop, update_step, remove_step, move_step, add_edge, " +
      "update_edge, remove_edge, add_decision_condition, convert_to_loop, " +
      "setup_loop_decision, advanced_edit, attach_output_schema, " +
      "detach_output_schema." +
      "\n\nPAYLOAD CONTRACT:" +
      "\n- add_step builds a COMPLETE step in ONE call: { name, position: " +
      "{after|before: <stepId>, …} } are required, and id, type, typeId, config, " +
      "contract, inputs, outputs and edgeType are all accepted alongside them. No " +
      "follow-up update_step is needed merely to fill the step in." +
      "\n- add_edge accepts the document's own from/to as well as " +
      "fromStepId/toStepId, and HONOURS an id you supply rather than replacing it, " +
      "so ids stay diffable against an environment you are reproducing." +
      "\n- Payloads are STRICT: an unknown or misspelled key is a 422 that names " +
      "it, never a silent drop. Read the error instead of assuming a value landed." +
      "\n\nTWO INVARIANTS RUN AFTER EVERY EDIT, and the response reports what they " +
      "did in `systemAdjustments` (addedEdges / removedEdges / rederivedInputs):" +
      "\n- Every step is guaranteed to reach the END point; the platform wires that " +
      "edge itself. An edge you did not ask for is this, and it is listed." +
      "\n- A bound input's contract, its description included, is DERIVED from the " +
      "output it reads and cannot be authored on its own. Set the text on the " +
      "PRODUCING step's output; a downstream description changing by itself is this " +
      "rule at work, and the inputs it re-derived are listed.",
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
      returnDocument: RETURN_DOCUMENT,
  },
  async ({ id, expectedVersion, mutations, returnDocument }) =>
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

        return jsonResult(
          summarizeMutation(
            last ?? { version },
            bodies.length,
            returnDocument === true,
          ),
        );
      }),
  );

  server.tool(
    "replace_workflow_document",
    "Replace the ENTIRE workflow document in one atomic call. Read the workflow " +
      "first to get the current version, then call this again only after rereading " +
      "on a stale `409`. Unlike `apply_workflow_mutations`, this is a single PUT " +
      "and treats the payload as the complete editable document — prefer the " +
      "mutation commands, which the backend validates and normalises per edit. " +
      "\n\nThe response is the same SUMMARY (version, launchable, " +
      "validationIssues, stepCount, edgeCount), not the stored document; pass " +
      "returnDocument: true or call read_workflow for that." +
      "\n\nDOCUMENT METADATA: name and description in the document ARE stored — " +
      "they sync onto the workflow's own columns, an omitted key leaves the " +
      "stored value alone, and an explicit \"\" clears it. stageId, " +
      "capabilityId, valueStreamId and onFailure are PATCH-only: changing one " +
      "here is REFUSED with a 422 naming the field, while round-tripping it " +
      "unchanged passes. So read, edit, write is safe, and re-linking a " +
      "workflow is a separate call.",
    {
      id: z.string().describe("The workflow's id."),
      expectedVersion: z
        .number()
        .int()
        .describe("The version you read before replacing the document."),
      document: z
        .record(z.unknown())
        .describe("The complete workflow document object to persist."),
      returnDocument: RETURN_DOCUMENT,
    },
    async ({ id, expectedVersion, document, returnDocument }) =>
      guard(async () => {
        const response = await client.put<MutationResponse>(
          `/api/v1/workflows/${id}`,
          { expectedVersion, document },
        );
        // One document written, so appliedCount is 1 — the same shape as a
        // single-command sequence, which is what a caller compares against.
        return jsonResult(summarizeMutation(response, 1, returnDocument === true));
      }),
  );

  server.tool(
    "read_workflow_trigger_parameters",
    "Read the input parameters a workflow's triggers expect — what a caller must " +
      "supply to start it. Use this before authoring a webhook/cron/conditional " +
      "trigger, or before start_workflow_run, so the trigger input matches. Read-only.",
    { workflowId: z.string().describe("The workflow's id.") },
    async ({ workflowId }) =>
      guard(async () =>
        jsonResult(
          await client.get(`/api/v1/workflows/${workflowId}/trigger-parameters`),
        ),
      ),
  );

  server.tool(
    "bulk_delete_workflows",
    "Soft-delete several workflows at once (each recoverable with " +
      "restore_workflow, like single delete_workflow). Each target needs its own " +
      "current version for optimistic locking — read each first. Returns a " +
      "per-workflow success/error result; a partial failure is possible.",
    {
      workflows: z
        .array(
          z.object({
            id: z.string().describe("The workflow's id."),
            expectedVersion: z
              .number()
              .int()
              .describe("That workflow's last-read version — 409 if stale."),
          }),
        )
        .min(1)
        .describe("The workflows to delete, each with its expectedVersion."),
      confirm: CONFIRM,
    },
    async ({ workflows }) =>
      guard(async () =>
        jsonResult(await client.post("/api/v1/workflows/bulk-delete", { workflows })),
      ),
  );
}
