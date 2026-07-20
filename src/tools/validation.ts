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
    "Check a workflow document for structural and schema problems. Returns " +
      "`launchable` plus an `issues` list (each with code, message, severity, " +
      "stepIds, edgeIds). STATELESS: it validates the document you pass, does " +
      "not read or write the stored workflow, and does NOT verify that " +
      "referenced agents or tools exist. Call it after apply_workflow_mutations " +
      "and before request_publish_workflow.",
    {
      document: z
        .record(z.unknown())
        .describe("The workflow document to validate (as returned by read_workflow)."),
    },
    async ({ document }) =>
      guard(async () =>
        jsonResult(await client.post("/api/v1/workflows/validate", { document })),
      ),
  );

  server.tool(
    "analyze_workflow_reachable_outputs",
    "List the outputs a given step can read — i.e. what upstream steps make " +
      "available to it. Use it to bind a step's inputs to real upstream outputs " +
      "instead of guessing field names. Stateless.",
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
      "message, severity, functionName). Stateless.",
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
      "Stateless — it does not save anything.",
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
      "are human-only actions in Axonity; no tool can do them.",
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
      "than re-fetching the whole list.",
    { approvalId: z.string().describe("The approval's id, from request_publish_* or list_publish_approvals.") },
    async ({ approvalId }) =>
      guard(async () =>
        jsonResult(await client.get(`/api/v1/publish-approvals/${approvalId}`)),
      ),
  );
}

export function registerExecutionTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "execute_tool",
    "Run tool code directly, without saving it — the way to test a tool you're " +
      "authoring before create_tool/update_tool. Returns stdout/stderr, the " +
      "result, and a typed errorType (timeout/memory/import/runtime/validation) " +
      "on failure. Pass toolId to run against an already-saved tool's context.",
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
