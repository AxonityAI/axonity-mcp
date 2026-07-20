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
3. \`validate_workflow\` / \`validate_tool_code\` and fix what they report;
   \`execute_tool\` / \`execute_stored_connector\` to actually run it before trusting it.
4. Re-read and check the result matches your intent (see "After you write, verify").
5. \`request_publish_*\` — this only QUEUES a human approval.
6. \`list_publish_approvals\` / \`get_publish_approval\` to see whether it was
   approved or rejected.
7. If something went wrong:
   - Bad edit, entity still exists → \`list_*_versions\` then \`restore_*_version\`
     to roll the draft back to an earlier version.
   - Never published, want a clean slate → \`discard_*_draft\` resets the draft to
     the last published state (fails if it was never published — there's nothing
     to fall back to).
   - Deleted by mistake → \`restore_*\` (see "Delete is recoverable" below).

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
  \`expectedVersion\` — in the request BODY. If the update returns a 409
  conflict, someone else changed it — read again and re-apply your change onto
  the new version.
- \`delete_*\` also takes \`expectedVersion\`, but as an argument on the tool call
  only — the connector maps it to whatever query-parameter spelling that
  entity's route actually expects (it differs per entity on the wire; you never
  need to know which).
- \`restore_*\` and \`restore_deleted_*_version\` take NO version at all — a
  restore must never lose to a stale-version guard.

## Errors: branch on the failure, not the words
- Every error names what went wrong as plainly as the backend allows. For a 409
  specifically, two different problems share that status code and need
  different responses:
  - **Version conflict** — you had a stale read. Re-read, re-apply, retry.
  - **Reference conflict** — the entity is referenced by something published or
    live. Retrying will never help. Detach the reference or unpublish the
    referencing entity first.
  The error message tells you which one you hit — read it, don't assume 409
  always means "retry."
- A 403 on any write means the token is read-only, or (for a direct publish
  attempt, which no tool makes) that publishing must go through
  \`request_publish_*\`. Either way: stop, don't retry, tell your human.
- A 401 means the service token is dead — missing, wrong, expired, or revoked.
  **The backend deliberately returns the identical message for all four
  causes** so it doesn't leak which applies; you have no way to tell them
  apart and no way to check a token's remaining lifetime in advance (every
  token now expires — 7, 15, 30, 60 or 90 days, chosen when it was minted;
  there is no "never"). On any 401: stop, do not retry, and tell your human
  plainly that the configured token is no longer valid and a new one must be
  minted from Axonity → Settings → API tokens. Do not guess or imply the cause.

## Field shape
- All fields are camelCase JSON (e.g. \`capabilityTier\`, not \`capability_tier\`).
- \`update_*\` is a partial change for agents/tools and a partial patch for
  workflows: send only the fields you are changing.
- The backend validates fields; a 422 error names the offending field and why
  (e.g. \`body.capabilityTier: Input should be 'standard' or 'advanced'\`). Fix
  that field and retry — do not guess at the whole shape.
- \`agent.tags\` is not cosmetic: it drives which policies apply to the agent at
  runtime. An untagged agent looks correct everywhere in the UI and silently
  skips policies scoped to those tags. If you create or update an agent that
  should be governed by a policy, check its tags match what the policy expects.

## After you write, verify
- A 200 means the request was accepted, NOT that it did what you meant. Re-read
  the entity after a mutation and diff it against your intent — unknown fields
  can be dropped silently, and a partial update only changes what you sent.

## Delete is recoverable — but not everything is
- \`delete_*\` soft-deletes: the entity disappears from \`list_*\` but is not gone.
  \`restore_*\` brings it back; \`list_deleted_*\` shows what's waiting. This
  applies uniformly to workflow, agent, tool, skill, policy, reference_doc,
  persona, output_schema, prompt_snippet, and flow.
- The same applies one level down, to version HISTORY:
  \`delete_*_version\` removes one entry from history (the current draft and
  published version are protected and can't be targeted this way);
  \`list_deleted_*_versions\` / \`restore_deleted_*_version\` undo it. Deleted
  version numbers stay reserved rather than reused, so gaps in the numbering
  are normal, not a sign of corruption.
- \`restore_*\` can itself 409 if a live entity now holds the same name/slot —
  the error names the conflicting one.
- There is no "archive" state for these ten entities — delete + restore IS the
  lifecycle. Runs are the one exception with a true archive/unarchive (see below).

## Per entity
- **workflow**: \`create_workflow\` makes a stub (name, description). Build its
  steps/edges with \`apply_workflow_mutations\` (a list of mutation commands) —
  the workflow document is edited through commands, never by replacing it wholesale.
- **agent**: fields include name, avatar, capabilityTier, creativityTier,
  learningMode, permissions, delegationTargetIds, toolIds, systemToolIds, tags,
  status. \`list_system_tools\` shows what can go in \`systemToolIds\` — there is
  no separate grant/revoke tool, you set it via \`update_agent\`.
- **tool**: fields include name, description, type
  ("function" | "connector" | "validator" | "evaluator"), inputSchema,
  outputSchema, implementation, authConfig, status. For a connector, set
  \`type: "connector"\`; NEVER put real credentials in authConfig — use
  placeholders and let a human fill secrets in the Axonity tool editor. Test it
  with \`execute_tool\` (runs code you supply) or \`execute_stored_connector\`
  (runs an already-saved connector using its real, server-side-decrypted
  secret — you never see the secret, only the result).
- **persona**: an agent's character — 1:1 with an agent. Created only through
  its agent (\`create_agent_persona\`); once created it's a normal entity
  (\`list_personas\`, \`read_persona\`, \`update_persona\`, delete/restore/versions).
- **prompt_snippet**: reusable prompt fragments. A normal entity in every
  respect now (\`read_prompt_snippet\`, \`discard_prompt_snippet_draft\`,
  everything else). Only wire-level oddity: \`list_deleted_prompt_snippets\`
  is implemented as \`?deleted=true\` on the list route rather than a
  dedicated collection — you won't notice from the tool's shape.
- **output_schema**: a reusable output contract, fully version-controlled and
  publishable like the other memory entities. A tool's \`outputValidators\` (or
  an agent's \`permissions.expected_output_schema_id\`) references one by id —
  create it before you need to point something at it.
- **flow**: a reusable workflow fragment. No versions, no publish — a flow is
  live the moment you save it. \`clone_flow\` forks one (including a
  framework-provided flow, which is otherwise read-only to your tenant) into a
  tenant-owned copy you can then edit freely.

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
