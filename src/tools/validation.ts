/**
 * Validation and inspection verbs — check work before requesting publish.
 *
 * All four routes are stateless: they take a document or a code fragment and
 * return a verdict without touching stored state. That makes them safe to call
 * as often as the agent likes, and they are the cheapest way to close the
 * authoring loop (draft → validate → fix → request_publish).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

export function registerValidationTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "validate_workflow",
    "Check a workflow for problems. Returns `launchable`, `catalogChecked`, and an " +
      "`issues` list (each with code, message, severity, stepIds, edgeIds). " +
      "\n\nPass EXACTLY ONE of workflowId or document — they answer different " +
      "questions:" +
      "\n- workflowId → validates the STORED workflow against this tenant's " +
      "catalog. This is the real 'can this run?': it confirms the agents, tools " +
      "and flows the steps reference actually exist. Answers catalogChecked: true." +
      "\n- document → validates the document you pass, STATELESSLY. No database, " +
      "so read-only service tokens can call it, but with no catalog the " +
      "cross-entity checks cannot run: `launchable` here means 'structurally " +
      "sound', NOT 'this will run'. Answers catalogChecked: false. Use it for a " +
      "draft you have not saved, or for fast feedback while editing." +
      "\n\nA green verdict is what a reader remembers, so check `catalogChecked` " +
      "before telling anyone a workflow is ready. Call this after " +
      "apply_workflow_mutations and before request_publish_workflow.",
    {
      workflowId: z
        .string()
        .optional()
        .describe(
          "Validate this STORED workflow against the tenant catalog. Omit if you " +
            "are passing a document.",
        ),
      document: z
        .record(z.unknown())
        .optional()
        .describe(
          "Validate this document statelessly (as returned by read_workflow). " +
            "Omit if you are passing a workflowId.",
        ),
    },
    async ({ workflowId, document }) =>
      guard(async () => {
        // Refuse the ambiguous call rather than silently preferring one: the two
        // routes answer different questions, and guessing would hand back a
        // verdict for something the caller did not ask about.
        if ((workflowId === undefined) === (document === undefined)) {
          throw new Error(
            "Pass exactly one of workflowId or document. workflowId validates the " +
              "stored workflow against the tenant catalog (the 'can this run?' " +
              "answer); document validates an unsaved document structurally.",
          );
        }

        return jsonResult(
          workflowId === undefined
            ? await client.post("/api/v1/workflows/validate", { document })
            : await client.post(`/api/v1/workflows/${workflowId}/validate`),
        );
      }),
  );

  server.tool(
    "analyze_workflow_reachable_outputs",
    "List the outputs a given step can read — i.e. what upstream steps make " +
      "available to it. Use it to bind a step's inputs to real upstream outputs " +
      "instead of guessing field names. Stateless, and safe for read-only service tokens.",
    {
      document: z.record(z.unknown()).describe("The workflow document."),
      stepId: z.string().describe("The step whose reachable inputs you want."),
    },
    async ({ document, stepId }) =>
      guard(async () =>
        jsonResult(
          await client.post("/api/v1/workflows/reachable-outputs", { document, stepId }),
        ),
      ),
  );

  server.tool(
    "validate_tool_code",
    "Check Python tool code for syntax errors and banned patterns before " +
      "saving it on a tool. Returns `valid` plus `errors` (line, column, " +
      "message, severity, functionName). Stateless and safe for read-only service " +
      "tokens.",
    {
      imports: z
        .string()
        .optional()
        .describe("The import block, as one string. Defaults to empty."),
      functions: z
        .array(
          z.object({
            name: z.string().describe("Function name."),
            code: z.string().describe("Full function source."),
          }),
        )
        .describe("The functions to check (max 20)."),
      classes: z
        .array(
          z.object({
            name: z.string().describe("Class name."),
            code: z.string().describe("Full class source."),
          }),
        )
        .optional()
        .describe("Optional classes to check (max 20)."),
    },
    async ({ imports, functions, classes }) =>
      guard(async () =>
        jsonResult(
          await client.post("/api/v1/tools/validate-code", {
            imports: imports ?? "",
            functions,
            ...(classes ? { classes } : {}),
          }),
        ),
      ),
  );

  server.tool(
    "format_tool_code",
    "Format Python tool code with Black and return the formatted source. " +
      "Stateless and safe for read-only service tokens — it does not save anything.",
    { code: z.string().describe("The Python source to format.") },
    async ({ code }) =>
      guard(async () =>
        jsonResult(await client.post("/api/v1/tools/format-code", { code })),
      ),
  );
}

export function registerApprovalTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "list_publish_approvals",
    "List this tenant's publish approvals and their status — how you find out " +
      "whether a request_publish_* was approved or rejected. Optionally filter " +
      "by status, and page through with limit/offset. Approving and rejecting " +
      "are human-only actions in Axonity; no tool can do them. " +
      "\n\nReadiness is recomputed WHEN YOU READ, not frozen at request time: " +
      "`readiness` is the verdict right now, `readinessAtRequest` is what the " +
      "requester saw, and `readinessChanged` says whether it moved. So a blocker " +
      "you saw an hour ago may already be resolved — and 'ready' means ready now.",
    {
      status: z
        .enum(["pending", "approved", "rejected"])
        .optional()
        .describe("Filter by status. Omit for all."),
      limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
      offset: z.number().int().min(0).optional().describe("Default 0."),
    },
    async ({ status, limit, offset }) =>
      guard(async () =>
        jsonResult(await client.get("/api/v1/publish-approvals", { status, limit, offset })),
      ),
  );

  server.tool(
    "get_publish_approval",
    "Read one publish approval by id — lets you poll a specific request rather " +
      "than re-fetching the whole list. Its `readiness` is recomputed on this " +
      "read, so it reflects the entity as it stands NOW; `readinessAtRequest` " +
      "keeps what the requester saw and `readinessChanged` flags a difference. " +
      "This is how you check whether a blocker (for a tool, typically " +
      "`dry_run_required`) has since been cleared.",
    { approvalId: z.string().describe("The approval's id, from request_publish_* or list_publish_approvals.") },
    async ({ approvalId }) =>
      guard(async () =>
        jsonResult(await client.get(`/api/v1/publish-approvals/${approvalId}`)),
      ),
  );

  server.tool(
    "request_publish_bulk",
    "Request publication of MANY entities in one call — the same human approval " +
      "queue as request_publish_*, one entry per entity, up to 200. Taking a " +
      "whole tenant live means hundreds of individual requests otherwise, which " +
      "turns the human review it exists for into clicking through. This does NOT " +
      "publish and does NOT approve: a human still decides, in Axonity. " +
      "\n\nNOT TRANSACTIONAL: each entry carries its own outcome and one failure " +
      "does not undo the entries before it. The response is " +
      "`{ results: [{ id, success, status, error }], succeededCount, " +
      "failedCount }`. Read the per-entry results — retrying the whole list " +
      "because failedCount is non-zero double-requests everything that worked.",
    {
      requests: z
        .array(
          z.object({
            entityType: z
              .enum([
                "workflow",
                "agent",
                "tool",
                "skill",
                "policy",
                "reference_doc",
                "persona",
                "output_schema",
                "prompt_snippet",
                "flow",
                "company",
              ])
              .describe("What kind of entity this entry publishes."),
            entityId: z
              .string()
              .optional()
              .describe(
                "The entity's id. Omit ONLY for company, which is a singleton " +
                  "the server resolves from your tenant.",
              ),
            changeSummary: z
              .string()
              .optional()
              .describe("A short note for the approver on what changed and why."),
          }),
        )
        .min(1)
        .max(200)
        .describe("One entry per entity to propose for publishing."),
    },
    async ({ requests }) =>
      guard(async () =>
        jsonResult(await client.post("/api/v1/publish-approvals/bulk", { requests })),
      ),
  );

  // Deliberately absent: bulk approve and bulk reject. Those routes exist on the
  // backend for the human review UI. Deciding an approval is a human action in
  // Axonity and no tool of this connector may take it — the same boundary
  // list_publish_approvals states, and test/exclusions.test.ts enforces.
}

export function registerExecutionTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "execute_tool",
    "Run tool code directly, WITHOUT saving it — the way to test a tool you are " +
      "authoring, before create_tool/update_tool. Returns stdout/stderr, the " +
      "result, and a typed errorType (timeout/memory/import/runtime/validation) " +
      "on failure. Pass toolId to run against an already-saved tool's context. " +
      "\n\nThis does NOT satisfy the publish gate, however cleanly it runs. It " +
      "executes the functions YOU supply, which need not be the tool's stored " +
      "code, so a pass here proves nothing about what would actually ship. To " +
      "clear the `dry_run_required` blocker on a SAVED tool, use `dry_run_tool` — " +
      "that runs the tool's own stored implementation and is the only run that " +
      "counts.",
    {
      imports: z.string().optional().describe("The import block. Defaults to empty."),
      functions: z
        .array(z.object({ name: z.string(), code: z.string() }))
        .describe("The functions to run (max 20)."),
      classes: z
        .array(z.object({ name: z.string(), code: z.string() }))
        .optional()
        .describe("Optional classes (max 20)."),
      inputParams: z
        .record(z.unknown())
        .optional()
        .describe("Parameters passed into the entry-point function."),
      timeout: z.number().int().min(1).max(120).optional().describe("Seconds. Default 30."),
      toolId: z.string().optional().describe("An existing tool id to run in context of."),
    },
    async ({ imports, functions, classes, inputParams, timeout, toolId }) =>
      guard(async () =>
        jsonResult(
          await client.post("/api/v1/tools/execute", {
            imports: imports ?? "",
            functions,
            ...(classes ? { classes } : {}),
            ...(inputParams ? { inputParams } : {}),
            ...(timeout ? { timeout } : {}),
            ...(toolId ? { toolId } : {}),
          }),
        ),
      ),
  );

  server.tool(
    "dry_run_tool",
    "Prove a SAVED tool by running its OWN stored code in the sandbox. This is " +
      "the run that satisfies the publish gate: a clean pass stamps the tool's " +
      "current version and clears the `dry_run_required` blocker, so " +
      "request_publish_tool can succeed. Nothing about the code is supplied by " +
      "you — only sample input — which is exactly why it counts and why " +
      "execute_tool does not.\n" +
      "Editing the tool afterwards bumps its version and invalidates the proof, " +
      "so dry-run again after your last edit, not before it.\n" +
      "Expect a refusal for tools that have no code to prove: 403 for a " +
      "platform-shipped (locked) tool, 422 for a connector, a builtin-backed " +
      "validator, or a tool with an empty implementation.",
    {
      toolId: z.string().describe("The saved tool's id."),
      inputParams: z
        .record(z.unknown())
        .optional()
        .describe(
          "Sample arguments for the tool's entry-point function. Omit for none — " +
            "but give it realistic input: a run that never reaches the real work " +
            "still stamps the version.",
        ),
    },
    async ({ toolId, inputParams }) =>
      guard(async () =>
        jsonResult(
          await client.post(`/api/v1/tools/${toolId}/dry-run`, {
            inputParams: inputParams ?? {},
          }),
        ),
      ),
  );

  server.tool(
    "execute_stored_connector",
    "Test-run an ALREADY-SAVED connector by its tool id — the backend loads its " +
      "stored authConfig and decrypts the real secret server-side; nothing " +
      "credential-shaped ever passes through this tool or through you. Takes " +
      "only input parameters, nothing else — there is no way to point this at a " +
      "URL or auth config of your choosing (that admin-only, body-supplied form " +
      "exists on the backend precisely so a client like this one can never reach " +
      "it, since it would otherwise let a caller exfiltrate a decrypted secret).",
    {
      toolId: z.string().describe("The connector's tool id — must already be saved."),
      inputParams: z
        .record(z.unknown())
        .optional()
        .describe("Parameters for the connector call."),
    },
    async ({ toolId, inputParams }) =>
      guard(async () =>
        jsonResult(
          await client.post(`/api/v1/tools/${toolId}/execute-connector`, {
            ...(inputParams ? { inputParams } : {}),
          }),
        ),
      ),
  );
}
