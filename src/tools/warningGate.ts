/**
 * No workflow goes to a human for publishing while it still has warnings.
 *
 * A warning the author has learned to scroll past is a warning nobody reads,
 * and the wall of "harmless" ones is exactly where the real one hides. So the
 * three ways this connector can put a workflow in the approval queue —
 * request_publish_release, request_publish_workflow and a workflow entry of
 * request_publish_bulk — first validate the STORED workflow against the
 * catalog and refuse while any issue is a warning.
 *
 * Errors are not refused here: the server's own readiness already names them
 * as blockers, and some resolve by the very release being requested (a tool
 * that is only unpublished is published by it). A warning has no such path —
 * nothing the approval does makes it go away.
 */

import type { AxonityClient } from "../client.js";

interface ValidationIssue {
  code?: string;
  message?: string;
  severity?: string;
}

export async function refuseWhileWorkflowWarns(
  client: AxonityClient,
  workflowId: string,
): Promise<void> {
  const verdict = (await client.post(`/api/v1/workflows/${workflowId}/validate`)) as {
    issues?: ValidationIssue[];
  } | null;
  const warnings = (verdict?.issues ?? []).filter((i) => i?.severity === "warning");
  if (warnings.length === 0) return;

  const lines = warnings.map((w) => `- ${w.code ?? "warning"}: ${w.message ?? ""}`);
  throw new Error(
    `Workflow ${workflowId} still has ${warnings.length} warning(s), so it is ` +
      "not put in the approval queue. Fix each one — change the design, not " +
      "the reviewer's patience — then request again. validate_workflow with " +
      "this workflowId shows them with their step ids.\n" +
      lines.join("\n"),
  );
}
