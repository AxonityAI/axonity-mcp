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
 * that is only unpublished is published by it). The same is true of the one
 * warning Flow can prove belongs to the release: a changed agent that owns a
 * warned step is one of the release's members.
 */

import type { AxonityClient } from "../client.js";
import { seg } from "../ids.js";

interface ValidationIssue {
  code?: string;
  message?: string;
  severity?: string;
  stepIds?: string[];
}

type WorkflowDocument = {
  orchestratorAgentId?: unknown;
  steps?: { all?: unknown[] };
};

function isReleaseMemberAgentWarning(issue: ValidationIssue, document: WorkflowDocument): boolean {
  if (issue.code !== "agent_has_unpublished_changes" || !issue.stepIds?.length) return false;

  const steps = document.steps?.all;
  if (!Array.isArray(steps)) return false;
  const warnedSteps = new Set(issue.stepIds);
  return steps.some((step) => {
    if (!step || typeof step !== "object") return false;
    const item = step as { id?: unknown; contract?: { owners?: unknown } };
    if (typeof item.id !== "string" || !warnedSteps.has(item.id)) return false;
    const hasAgentOwner = Array.isArray(item.contract?.owners) && item.contract.owners.some((owner) =>
      !!owner && typeof owner === "object" &&
      (owner as { type?: unknown; id?: unknown }).type === "agent" &&
      typeof (owner as { id?: unknown }).id === "string",
    );
    return hasAgentOwner || typeof document.orchestratorAgentId === "string";
  });
}

export async function refuseWhileWorkflowWarns(
  client: AxonityClient,
  workflowId: string,
  options: { release?: boolean } = {},
): Promise<void> {
  const verdict = (await client.post(`/api/v1/workflows/${seg(workflowId)}/validate`)) as {
    issues?: ValidationIssue[];
  } | null;
  const warnings = (verdict?.issues ?? []).filter((i) => i?.severity === "warning");
  if (warnings.length === 0) return;

  if (!options.release) throwForWarnings(workflowId, warnings);

  // Flow's stored-workflow validation deliberately only names the warned step,
  // not the member id. The draft is authoritative for that step's agent owner
  // (or its orchestrator fallback), and both are in a workflow release
  // closure. Do not suppress a warning unless that relation is explicit; an
  // unreadable or changed shape must remain a gate rather than becoming a
  // guessed exception.
  const workflow = (await client.get(`/api/v1/workflows/${seg(workflowId)}`)) as {
    document?: WorkflowDocument;
  } | null;
  const blocking = warnings.filter(
    (warning) => !isReleaseMemberAgentWarning(warning, workflow?.document ?? {}),
  );
  if (blocking.length === 0) return;

  throwForWarnings(workflowId, blocking);
}

function throwForWarnings(workflowId: string, warnings: ValidationIssue[]): never {
  const lines = warnings.map((w) => `- ${w.code ?? "warning"}: ${w.message ?? ""}`);
  throw new Error(
    `Workflow ${workflowId} still has ${warnings.length} warning(s), so it is ` +
      "not put in the approval queue. Fix each one — change the design, not " +
      "the reviewer's patience — then request again. validate_workflow with " +
      "this workflowId shows them with their step ids.\n" +
      lines.join("\n"),
  );
}
