/**
 * Requests for administration changes a token may only PROPOSE (token-approval
 * design, category 2). A route of that kind answers a token with 202 and one
 * request; a person decides it in Axonity (Approvals → Admin requests). These
 * two tools are how an agent finds out what became of it — the counterpart of
 * `list_publish_approvals` / `get_publish_approval`.
 *
 * Approving and rejecting have no tool and never will: "a token never
 * approves". The routes are closed in the route table and in the deny list.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";
import { pathId, seg } from "../ids.js";

const WHAT_A_REQUEST_SAYS =
  "Each request carries `summary` (what it would do, in words), `status` " +
  "(`pending`, `approved`, `rejected` or `expired`), `statusReason` (why it was " +
  "rejected or expired), `result` (what the action returned once approved; null " +
  "before) and `check`: re-run WHEN YOU READ, so it is what approving would do " +
  "NOW — `{outcome, reason}` with `outcome` `ok` (would succeed), `changed` " +
  "(something moved since the request) or `expired`. A blocker you saw earlier " +
  "may be gone, and `ok` means ok now. " +
  "Approving and rejecting are a person's act in Axonity; no tool can do them, " +
  "and `canDecide` is false through a token.";

const VIEW = z
  .enum(["mine", "all"])
  .optional()
  .describe(
    "`mine` (the backend's default): the requests you sent through one of your own " +
      "tokens. `all`: every request of the workspace — administrators only, anyone " +
      "else gets a 403.",
  );

export function registerActionApprovalTools(server: McpServer, client: AxonityClient): void {
  server.tool(
    "list_action_approvals",
    "List the requests for administration changes (a mailbox, a member, a role, an " +
      "audience, the executors of an application…) that a token proposed and a person " +
      "decides — how you find out whether a call that answered `NOT DONE YET` was " +
      "approved. Newest first. Optionally filter by `status`. The answer is one page " +
      "{items, nextCursor, pageSize, hasMore}: while `hasMore` is true pass `nextCursor` " +
      "back as `cursor`; never build a cursor. " +
      WHAT_A_REQUEST_SAYS,
    {
      status: z
        .enum(["pending", "approved", "rejected", "expired"])
        .optional()
        .describe("Filter by status. Omit for all."),
      view: VIEW,
      limit: z.number().int().min(1).optional().describe("Page size. The backend chooses when omitted."),
      cursor: z
        .string()
        .optional()
        .describe("Opaque continuation cursor — the previous answer's nextCursor. Omit for the first page."),
    },
    async ({ status, view, limit, cursor }) =>
      guard(async () =>
        jsonResult(await client.get("/api/v1/action-approvals", { status, view, limit, cursor })),
      ),
  );

  server.tool(
    "get_action_approval",
    "Read one request for an administration change by id — poll it after a call " +
      "answered `NOT DONE YET` instead of repeating the call. You can open your own " +
      "request; an administrator can open any. " +
      WHAT_A_REQUEST_SAYS,
    {
      approvalId: pathId.describe(
        "The approval's id, from the `NOT DONE YET` answer or list_action_approvals.",
      ),
    },
    async ({ approvalId }) =>
      guard(async () => jsonResult(await client.get(`/api/v1/action-approvals/${seg(approvalId)}`))),
  );
}
