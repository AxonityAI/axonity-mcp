/**
 * The `axonity_conventions` guidance tool.
 *
 * An external agent needs the same authoring rules the internal Builder team
 * carries, or its drafts will be low quality. This is a static conventions
 * reference for the MLP; a single-sourced `discover_<entity>_operations` tool
 * backed by the platform's own discovery contract is a planned refinement
 * (epic #652 C4 — "prefer a thin backend read endpoint").
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const CONVENTIONS = `# Authoring conventions for Axonity entities

Read this before creating or updating anything.

## What this connector is for
- AUTHORING: composing an entity from intent — drafting a workflow, an agent, a
  tool, and wiring them together. That is what these tools are good at.
- NOT bulk migration. Do not use this to move many entities verbatim from
  somewhere else; Axonity's config import/export moves bytes without a model in
  the path. Content can be subtly altered in transit through an agent, which is
  exactly what you cannot afford in a fidelity migration.

## The authoring loop
1. \`read_*\` the entity (and \`read_*_published\` if you need to see what is live).
2. Edit the DRAFT: \`update_*\`, or \`apply_workflow_mutations\` for workflow structure.
3. \`validate_workflow\` / \`validate_tool_code\` and fix what they report.
4. Re-read and check the result matches your intent (see "After you write, verify").
5. \`request_publish_*\` — this only QUEUES a human approval.
6. \`list_publish_approvals\` to see whether it was approved or rejected.
7. If something went wrong: \`list_*_versions\` then \`restore_*_version\` to roll the
   draft back.

## Drafts, not live
- \`create_*\` and \`update_*\` produce a DRAFT. The live runtime is unaffected
  until a human publishes it in Axonity. You cannot publish directly — the
  backend refuses a direct publish from a service token with a 403, so there is
  no tool for it and no way around it.
- A read-only token can only read: any write returns 403. If you see that, ask
  your human for a write-scoped token rather than retrying.
- \`request_publish_*\` does NOT publish — it creates a pending approval a human
  approves in Axonity. Use it when a draft is ready; then tell the user to
  approve it in their Axonity approvals inbox.

## Optimistic locking (always read-then-write)
- Before \`update_*\`, call \`read_*\` and use the \`version\` you get as
  \`expectedVersion\`. If the update returns a 409 conflict, someone else changed
  it — read again and re-apply your change onto the new version.

## Field shape
- All fields are camelCase JSON (e.g. \`capabilityTier\`, not \`capability_tier\`).
- \`update_*\` is a partial change for agents/tools and a partial patch for
  workflows: send only the fields you are changing.
- The backend validates fields; a 422 error names the offending field and why
  (e.g. \`body.capabilityTier: Input should be 'standard' or 'advanced'\`). Fix
  that field and retry — do not guess at the whole shape.

## After you write, verify
- A 200 means the request was accepted, NOT that it did what you meant. Re-read
  the entity after a mutation and diff it against your intent — unknown fields
  can be dropped silently, and a partial update only changes what you sent.

## Per entity
- **workflow**: \`create_workflow\` makes a stub (name, description). Build its
  steps/edges with \`apply_workflow_mutations\` (a list of mutation commands) —
  the workflow document is edited through commands, never by replacing it wholesale.
- **agent**: fields include name, avatar, capabilityTier, creativityTier,
  learningMode, permissions, delegationTargetIds, toolIds, systemToolIds, status.
- **tool**: fields include name, description, type
  ("function" | "connector" | "validator" | "evaluator"), inputSchema,
  outputSchema, implementation, authConfig, status. For a connector, set
  \`type: "connector"\`; NEVER put real credentials in authConfig — use
  placeholders and let a human fill secrets in the Axonity tool editor.

## Structural workflow edits
- \`apply_workflow_mutations\` takes a LIST of commands and applies them in order,
  threading the version for you — pass the version you read, not one per command.
- It is NOT transactional. If command N fails, the ones before it stay applied;
  the error tells you how many landed and which index failed. Re-read and resume
  from that index rather than replaying the whole list.

## Triggers
- A published workflow still does nothing until it has a trigger. Add one with
  \`create_cron_schedule\`, \`create_webhook_trigger\`, or
  \`create_conditional_trigger\`.
- Trigger deletes are HARD deletes — no restore. Webhook tokens are shown once
  at create/rotate and are never retrievable; hand them straight to your human
  and never store one in an entity field.

## Evaluating what you built
- There is no findings endpoint and no evaluator entity. To judge a run, read it:
  \`read_run\` (its \`validatorVerdicts\` and \`agentInvocations\`) and
  \`read_run_trace\` (the step-by-step tool calls).
- Runs are the only thing with a real archive state — \`archive_run\` is
  reversible, \`bulk_delete_runs\` is not.

## Secrets
- Never handle a real credential. A connector's \`authConfig\` takes placeholders
  only ("{{ MY_SECRET }}" or ""); a human fills the real value in Axonity. This
  is enforced — a write carrying something that looks like a real secret is
  rejected before it leaves this connector.

## Tenant
- Your token fixes the tenant. You cannot act across tenants; never send a
  tenant id in a body.
`;

export function registerConventions(server: McpServer): void {
  server.tool(
    "axonity_conventions",
    "Read the authoring conventions (drafts vs live, optimistic locking, field " +
      "shapes per entity). Call this before creating or updating entities.",
    {},
    async () => ({ content: [{ type: "text" as const, text: CONVENTIONS }] }),
  );
}
