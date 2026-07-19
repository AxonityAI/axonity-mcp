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

## Drafts, not live
- \`create_*\` and \`update_*\` produce a DRAFT. The live runtime is unaffected
  until a human publishes it in Axonity. You cannot publish directly.
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
- The backend validates fields; a 422 error tells you exactly which field is wrong.

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
