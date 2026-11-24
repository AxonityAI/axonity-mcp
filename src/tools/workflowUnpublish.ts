/**
 * `unpublish_workflow` — take a published workflow off the air (axonity-flow#2626).
 *
 * `archive_workflow` refuses a published workflow ("Unpublish it first"), and until #2626 no
 * token could unpublish: an agent could clean up nothing it had published. The backend's
 * `POST /api/v1/workflows/{id}/unpublish` now answers a token with a REQUEST (`202`,
 * `ActionApprovalAccepted`, action `workflows.unpublish`) that a person approves on Approvals ›
 * Admin requests; nothing changes until then. A person at a screen unpublishes at once
 * (`UnpublishResponse`). The tool says which of the two happened.
 *
 * What the backend refuses, said before the call: a workflow that is not published (404), and
 * one with a start still switched on (409, naming each schedule, webhook or conditional start);
 * a token whose owner is not an administrator, and a read-only service token (403).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { pathId, seg } from "../ids.js";
import { guard, jsonResult } from "./result.js";

/** Where a person decides a token's request for an administrator action. */
export const ADMIN_REQUESTS_PAGE = "/digitaltwin/approvals/admin";

const NEXT_DONE =
  "The workflow is a draft now: archive_workflow can archive it.";
const NEXT_WAITING =
  "Nothing has changed yet. Once a person approves, the workflow is a draft and " +
  "archive_workflow can archive it; until then archive_workflow still refuses it.";

interface ApprovalAccepted {
  status?: string;
  message?: string;
  approval?: { id?: string; status?: string; summary?: string };
}

interface UnpublishDone {
  previousMajorVersion?: number | null;
  draftMajorVersion?: number | null;
  draftVersionName?: string | null;
}

/** The backend's answer, said as one of two outcomes. */
export function unpublishOutcome(
  workflowId: string,
  answer: unknown,
  link: (path: string) => string,
): Record<string, unknown> {
  const accepted = (answer ?? {}) as ApprovalAccepted;
  if (accepted.approval) {
    return {
      outcome: "waiting_for_approval",
      workflowId,
      approvalId: accepted.approval.id,
      approvalStatus: accepted.approval.status,
      summary: accepted.approval.summary,
      link: link(ADMIN_REQUESTS_PAGE),
      message: accepted.message,
      next: NEXT_WAITING,
    };
  }
  const done = (answer ?? {}) as UnpublishDone;
  return {
    outcome: "unpublished",
    workflowId,
    draftMajorVersion: done.draftMajorVersion ?? null,
    draftVersionName: done.draftVersionName ?? null,
    next: NEXT_DONE,
  };
}

export function registerWorkflowUnpublishTool(server: McpServer, client: AxonityClient): void {
  server.tool(
    "unpublish_workflow",
    "Take a published workflow off the air, so it no longer runs and becomes a draft again. " +
      "Through this connector it is a REQUEST: it answers `outcome: waiting_for_approval` with " +
      "the request (`approvalId`, `summary`) and a `link` to Approvals › Admin requests, where " +
      "a person approves; nothing changes until then, and asking again returns the same " +
      "request. Should the platform do it at once, the answer is `outcome: unpublished`. " +
      "Afterwards archive_workflow can archive it (it refuses a published workflow). " +
      "Refused while the workflow still has an active trigger — a schedule, webhook or " +
      "conditional start that is switched on; the refusal names each one by name and id: " +
      "switch them off first. Refused too for a workflow that is not published, and when the " +
      "token's owner is not an administrator.",
    {
      id: pathId.describe("The workflow's id."),
      reason: z
        .string()
        .max(1000)
        .optional()
        .describe(
          "Why it is taken off the air, for the person who approves; stored on the audit " +
            "event of the unpublication.",
        ),
    },
    async ({ id, reason }) =>
      guard(async () => {
        const answer = await client.post(
          `/api/v1/workflows/${seg(id)}/unpublish`,
          reason ? { reason } : {},
        );
        return jsonResult(unpublishOutcome(id, answer, (path) => client.appUrl(path)));
      }),
  );
}
