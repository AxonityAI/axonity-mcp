/**
 * Finding the workflows a sub-process step may call.
 *
 * Workflows can call each other (axonity-flow#898). Both halves of that live in
 * the workflow DOCUMENT and are therefore already authorable over this
 * connector: `add_trigger` with `typeId: "subprocess-invocation"` declares the
 * callee's signature — in that one call, `parameters` included, since
 * axonity-flow#961 S3 — and `add_step` with `type: "subprocess"` makes the
 * call. What an agent could not do was find out WHICH workflow to call — the
 * same gap the secret catalogue closed (#39): the platform can express the
 * wiring, the agent cannot find the id.
 *
 * `GET /workflows/callable` answers it, and answers the harder half too: a
 * workflow that CANNOT be called is listed with the reason rather than filtered
 * out. An author hunting for a workflow that is right there is a support
 * question; "here it is, and here is what to fix" is a two-second answer.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

export function registerSubworkflowTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "list_callable_workflows",
    "List the workflows a sub-process step may call, each with its INTERFACE: " +
      "`parameters` (what to bind the calling step's inputs to, matched by name) " +
      "and `outcomes` (the callee's end steps and the fields each carries — " +
      "which end was reached is itself part of the answer). A workflow that " +
      "cannot be called is listed too, with `callable: false` and a " +
      "`blockedReason` — usually that it has never been published, or has no " +
      "`subprocess-invocation` trigger. " +
      "\n\nCall this BEFORE authoring a sub-process step. `validate_workflow` " +
      "does check the target now — a missing one, a self-call, a target that is " +
      "deleted, unpublished or not callable each have their own issue code — " +
      "but it can only tell you AFTERWARDS that the workflow you picked was " +
      "wrong. This is how you pick, and how you read the interface you are " +
      "about to bind the calling step's inputs to.",
    {
      exclude: z
        .string()
        .optional()
        .describe(
          "The workflow you are editing. A workflow cannot call itself — every " +
            "run would spawn a child that reaches the same step again — so pass " +
            "its id to keep it out of the list.",
        ),
    },
    async ({ exclude }) =>
      guard(async () =>
        jsonResult(
          await client.get(
            "/api/v1/workflows/callable",
            exclude ? { exclude } : undefined,
          ),
        ),
      ),
  );
}
