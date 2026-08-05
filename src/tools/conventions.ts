/**
 * The `axonity_conventions` guidance tool.
 *
 * An external agent needs the same authoring rules the internal Builder team
 * carries, or its drafts will be low quality. This is agent-facing GUIDANCE:
 * build order, "complete when…" bars, wiring, and the prompt-placement / Memory
 * V2 model — the parts a schema can't express.
 *
 * The hard facts it references (field names, enum values, required-ness) are NOT
 * a second source of truth: the backend OpenAPI schema is authoritative
 * (axonity-flow#722, Option 1). `test/conformance.test.ts` pins the routes here
 * and the enums quoted below to a vendored snapshot of that schema, so a drift
 * between this prose and the backend fails CI rather than misleading an agent.
 * Keep enum lists in this doc in step with what that test asserts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const CONVENTIONS = `# Authoring conventions for Axonity entities

Read this before creating or updating anything.

## What this connector is for
- AUTHORING: composing an entity from intent — drafting a tool, an agent, a
  workflow, and wiring them together so the result is CORRECT and COMPLETE
  (every required field set, every reference pointing at something real).
- REPRODUCING a setup is just authoring it again, from scratch. To recreate an
  agent/workflow/tool, CREATE NEW entities and wire them by their NEW ids —
  never reuse an id you read. There is no "migration" and no "import an id":
  this connector only ever acts in the ONE tenant its token points at (see
  Tenant), and ids are tenant-local, so an id from anywhere else points at
  nothing (or the wrong thing) here. Read the source for its SHAPE and intent —
  names, field values, which tools an agent uses, which agents a workflow's
  steps run — then build fresh and capture the ids the create calls return.
  Recreating into a DIFFERENT tenant means running that build while the
  connector is configured with THAT tenant's token — a separate session. See
  "Reproducing a setup" below.

## The authoring loop
1. \`read_*\` the entity (and \`read_*_published\` if you need to see what is live).
2. Edit the DRAFT: \`update_*\`, or workflow-edit tools for workflow structure.
3. Validate before publish: \`validate_workflow\` / \`analyze_workflow_reachable_outputs\` / 
   \`validate_tool_code\` / \`format_tool_code\`. These four are stateless and work with
   read-only tokens.
4. Re-read and verify with a saved tool command: \`execute_tool\` /
   \`execute_stored_connector\`.
5. Fix any issues and re-read again.
6. For a code tool, PROVE it: \`dry_run_tool\` — see "Proving a tool" below. Skip
   this and \`request_publish_tool\` will sit blocked forever.
7. \`request_publish_*\` — this only QUEUES a human approval. Publishing many
   entities at once (taking a tenant live) is \`request_publish_bulk\`, up to 200
   in one call; it is not transactional, so read the per-entry results.
8. \`list_publish_approvals\` / \`get_publish_approval\` to see whether it was
   approved or rejected. Readiness there is recomputed as you read it
   (\`readiness\` now, \`readinessAtRequest\` then, \`readinessChanged\` if it
   moved), so a blocker you saw earlier may already be gone.

9. If something went wrong:
   - Bad edit, entity still exists → \`list_*_versions\` then \`restore_*_version\`
     to roll the draft back to an earlier version.
   - Never published, want a clean slate → \`discard_*_draft\` resets the draft to
     the last published state (fails if it was never published — there's nothing
     to fall back to).
   - Deleted by mistake → \`restore_*\` (see "Delete is recoverable" below).

## Proving a tool (the publish gate)
Before a code tool may be published, the platform requires that its stored code
has run cleanly once, at its current version.
- \`dry_run_tool(toolId)\` is the run that counts. It executes the tool's OWN
  saved implementation; you supply only sample input. A clean pass clears the
  \`dry_run_required\` blocker.
- \`execute_tool\` does NOT count, however green it comes back. It runs the
  functions YOU pass, which need not be what is stored — proving nothing about
  what would ship. Use it while drafting code you have not saved yet.
- Editing the tool afterwards bumps its version and invalidates the proof, so
  dry-run AFTER your last edit.
- Connectors, builtin-backed validators and platform-shipped tools have no code
  of their own to prove and will refuse (422/403). That is expected, not a
  failure to work around.

## Drafts, not live
- \`create_*\` and \`update_*\` produce a DRAFT. The live runtime is unaffected
  until a human publishes it in Axonity. \`flow\` has the same rule: runtime uses
  the published snapshot from \`read_flow_published\` until \`request_publish_flow\`
  is approved.
- You cannot publish directly — the backend refuses a direct publish from a service
  token with a 403, so there is no tool for it and no way around it.
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
  ONE documented exception: validator specs (\`permissions.outputValidators\`,
  \`permissions.exposedValidatorTools\`) use snake_case keys (\`function\`,
  \`target\`, \`args\`, \`error_message\`, \`tool_name\`, \`validator_name\`) — they are
  the same shape at every level and are stored verbatim, so they are NOT
  camel-aliased. Send them in snake_case.
- \`update_*\` is a partial change for agents/tools and a partial patch for
  workflows: send only the fields you are changing (plus \`expectedVersion\`).
- The backend validates fields; a 422 error names the offending field and why
  (e.g. \`body.capabilityTier: Input should be 'economy', 'standard', 'smart' or
  'reasoning'\`). Fix that field and retry — do not guess at the whole shape.
- **create/update for tool and agent are STRICT** (\`extra="forbid"\`): an
  undeclared OR MISSPELLED key is a 422 that names it, not a silent drop. So
  spelling matters and you get told when it is wrong — good. Other entities are
  more lenient and may drop an unknown key silently; never rely on that.
- \`agent.tags\` is not cosmetic: it drives which policies apply to the agent at
  runtime. An untagged agent looks correct everywhere in the UI and silently
  skips policies scoped to those tags. If you create or update an agent that
  should be governed by a policy, check its tags match what the policy expects.

## After you write, verify
- A 200 means the request was accepted, NOT that it did what you meant. Re-read
  the entity after a mutation and diff it against your intent — a partial update
  only changes what you sent, and on the lenient (non-tool/agent) entities an
  unknown key can be dropped silently rather than rejected.
- Re-reading the ENTITY is not enough for an \`attach_*\`: those links are stored
  outside the entity body and never appear in \`read_agent\`. Read them back with
  \`list_agent_skills\` / \`list_agent_policies\` / \`list_agent_reference_docs\`
  (see Wiring, mechanism B).
- "Complete" is your job, not the backend's. A create succeeds with only the
  required fields set; it does not tell you the entity is USABLE. An agent with
  no \`toolIds\` runs with no tools; a connector tool with an empty
  \`implementation\` has no endpoint to call; a workflow with steps but no
  trigger never fires. After creating, check the entity has everything its
  purpose needs — see the per-entity and wiring sections.
- To test a whole workflow end to end, \`start_workflow_run\` then read the result
  (\`read_run\` / \`read_run_trace\` / \`read_run_cost\`). Note it runs the PUBLISHED
  workflow and really executes (cost, connector side effects), so publish first,
  and only test-run when a human is expecting it.

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

## Per entity — what to create, and what "complete" means

Build in dependency order: a thing you will REFERENCE must exist before the
thing that references it. So: tools and output-schemas first, then agents (which
list tool ids), then workflows (whose steps name agents and tools), then
triggers (which make a workflow fire). Skills/policies/reference-docs can be
made any time before you attach them.

### tool  (\`create_tool\`, strict body)
- Required: \`name\`. Also: \`description\`, \`type\`, \`inputSchema\`,
  \`outputSchema\`, \`implementation\`, \`authConfig\`, \`surfacing\`.
- \`type\`: \`"function"\` (default) | \`"connector"\` | \`"validator"\` |
  \`"evaluator"\`. \`surfacing\`: \`"always"\` (in the agent's tool list) |
  \`"on_demand"\`.
- \`inputSchema\` / \`outputSchema\` are JSON-Schema objects describing the tool's
  params and result. Set them — an agent binds to a tool by its declared I/O; a
  tool with no inputSchema is hard to call correctly.
- \`implementation\` is what makes the tool DO something, and its shape depends on
  \`type\`:
  - **function** — carries the Python. Author and check the code with
    \`validate_tool_code\` and \`format_tool_code\`, and prove it runs with
    \`execute_tool\`, BEFORE \`create_tool\`. A function tool whose
    \`implementation\` is empty is an inert stub.
  - **connector** — carries the HTTP call: typically \`connectorType\`
    ("rest"/"graphql"), \`baseUrl\`, \`method\`, \`path\`, \`headers\`,
    \`queryParams\`, \`body\`, \`responseMapping\`, \`pagination\`. Prefer the
    \`create_connector\` tool, which sets \`type:"connector"\` for you. NEVER put
    a real credential in \`authConfig\` — placeholders only ("{{ MY_SECRET }}"
    or ""); a human fills the secret in Axonity. Test with
    \`execute_stored_connector\` (uses the real, server-side-decrypted secret;
    you see only the result).
  - **validator / evaluator** — a constrained kind that wraps a builtin;
    \`implementation\` names the builtin registry key plus its args. Look at the
    tenant's existing validator/evaluator tools (\`list_tools\`) for the keys in
    use rather than inventing one.
- Complete check: the tool has the I/O schemas its callers need AND a non-empty
  implementation of the right shape for its type.

### agent  (\`create_agent\`, strict body)
- Required: \`name\`. Enumerated fields, with their ONLY valid values:
  - \`capabilityTier\`: \`economy\` | \`standard\` (default) | \`smart\` | \`reasoning\`
  - \`creativityTier\`: \`low\` | \`medium\` (default) | \`high\`
  - \`learningMode\`: \`none\` (default) | \`adaptive\` | \`strict\`
- \`avatar\`, \`tags\` (role tags — see Field shape; set them or policies silently
  skip the agent), \`canOwnProcess\` (bool; must be true for an agent to own a
  workflow step's flow), \`episodicMemoryEnabled\` (bool).
- \`permissions\` (object): \`planning\`, \`delegation\`, \`verboseOutput\` (bools);
  \`outputValidators\` / \`exposedValidatorTools\` (snake_case specs, see Field
  shape); \`expectedOutputSchemaId\` (an output_schema id — MANDATORY whenever you
  attach validators here).
- Wiring fields — see the Wiring section: \`toolIds\`, \`systemToolIds\`,
  \`delegationTargetIds\`.
- Complete check: an agent with no \`toolIds\`/\`systemToolIds\` has no tools and
  can only reason/talk. If it is meant to DO something, give it the tools.

### workflow  (\`create_workflow\`, then edit the document)
- \`create_workflow\` makes a STUB (name, description) with an empty document.
  You then build the graph with either
  - \`apply_workflow_mutations\` — a LIST of command mutations applied in order
    (preferred: the backend validates each and threads the version), or
  - \`replace_workflow_document\` — a full-document atomic PUT.
- The document is a graph: \`steps.all[]\` (each \`{ id, type, name, ... }\`) and
  \`steps.edges[]\` (each \`{ id, from, to, type? }\`) plus \`triggers\`. Step
  \`type\` is one of: \`manual\`, \`agent\`, \`automation\`, \`subprocess\`,
  \`connector\`, \`decision\`, \`loop\`, \`for_each\`, \`end\`.
- Referential integrity is enforced: step and trigger ids must be unique, and
  every edge \`from\`/\`to\` must reference an id that exists in the document
  (\`from\` may be a trigger or step; \`to\` must be a step). A dangling edge is a
  hard error.
- Complete check: run \`validate_workflow\` on the document — it returns
  \`launchable\` plus an \`issues\` list. A workflow is not done until it is
  launchable AND has a trigger (see Triggers).

### persona
- An agent's character — 1:1 with an agent. Created only through its agent
  (\`create_agent_persona\`: \`name\`, \`characterText\`); then a normal entity
  (\`read_persona\`, \`update_persona\`, delete/restore/versions).

### output_schema
- A reusable output contract, versioned and publishable. Referenced BY id from a
  tool's validators or an agent's \`permissions.expectedOutputSchemaId\` — so
  create it first, then point things at the id the create call returns.

### skill / policy / reference_doc
- Memory entities attached to agents (and skills also to workflows). Create them,
  then wire with the \`attach_*\` tools — see Wiring.

### prompt_snippet
- Reusable prompt fragments; a normal entity. Wire-level oddity:
  \`list_deleted_prompt_snippets\` returns the backend \`items\` envelope.

### flow
- A reusable workflow fragment in the authored-entity lifecycle. \`create_flow\` /
  \`update_flow\` write draft state; runtime uses \`read_flow_published\` until
  approval. \`request_publish_flow\` to publish, \`discard_flow_draft\` to reset.

### company
- The tenant's single company document (mission, value streams, org structure).
  A SINGLETON — one per tenant, no id, so there is no list/create/delete:
  \`read_company\`, \`update_company\` (a WHOLE-document save with
  \`expectedVersion\`, like \`replace_workflow_document\`), \`list_company_versions\`,
  \`read_company_version\`, \`restore_company_version\`, \`read_company_published\`.
  Publish it like anything else with \`request_publish_company\` — but because it
  is a singleton this takes NO id (the server resolves your tenant's one
  company). Direct company publish is closed to machine tokens, so the approval
  queue is the only path.

## Wiring — how the pieces connect
There are THREE mechanisms, and using the wrong one silently no-ops. Know which
each link uses.

**A) Set a field on the entity (via create/update)** — an id or id-array that
lives in the entity body:
- tool → agent: add the tool's id to the agent's \`toolIds\`. This is how an
  agent gets a (non-system) tool. There is no attach_tool_to_agent route.
- system tool → agent: add the catalog id to \`systemToolIds\`. Get ids from
  \`list_system_tools\`. No grant/revoke tool — you set the array via
  \`update_agent\`. \`toolIds\` and \`systemToolIds\` are DIFFERENT lists; a
  system-tool id does not go in \`toolIds\`.
- agent → agent (delegation): add the callee agent's id to the caller's
  \`delegationTargetIds\` (and set \`permissions.delegation: true\`).
- output_schema → agent: \`permissions.expectedOutputSchemaId\` (a single id).
- Changing any of these is read-then-write under optimistic locking: read the
  agent, edit the field — an id-array is a FULL replace, so include the ids you
  are keeping — then \`update_agent\` with \`expectedVersion\`.

**B) Call an attach route (a link, not a field).** \`attach_*\`/\`detach_*\` POST/
DELETE a link and do NOT touch the entity body:
- skill → agent: \`attach_skill_to_agent\`; skill → workflow:
  \`attach_skill_to_workflow\`.
- policy → agent: \`attach_policy_to_agent\`.
- reference_doc → agent: \`attach_reference_to_agent\` (agents only — there is no
  workflow-scoped reference-doc route).
- VERIFY every one of these with the read-back before \`request_publish_*\`:
  \`list_agent_skills\`, \`list_agent_policies\`, \`list_agent_reference_docs\`.
  This is not optional politeness — because a link lives OUTSIDE the entity body,
  \`read_agent\` will not show it, so the read-back is the only way to tell an
  attach that landed from one that silently did nothing. (Mechanism A is
  different: those ids ARE in the body, so re-reading the agent proves them.
  \`attach_skill_to_workflow\` has no read-back — the backend has no list route
  for it.)

**C) Reference an id INSIDE the workflow document** (this is how agents and tools
get "into" a workflow — there is no attach route for it):
- agent → workflow: an \`agent\` step names its agent in the step's
  \`contract.owners[]\` as \`{ "type": "agent", "id": "<agentId>" }\`.
- tool → workflow: on an \`agent\` step, list tool ids under
  \`contract.tools.toolIds[]\` (and/or per plan-step \`contract.activities[]\`
  entries of \`{ "kind": "tool", "toolId": "<id>" }\`). On an \`automation\` step,
  set \`config.automationType: "tool"\` and \`config.toolId\`. A \`connector\` step
  references a connector tool the same way.
- Every id you place in a document must be a REAL id in THIS tenant. The workflow
  validator flags a step whose owner agent or referenced tool no longer exists —
  \`validate_workflow\` is how you catch a bad reference before publishing.
- Prefer \`apply_workflow_mutations\` (e.g. \`add_step\`, \`update_step\`,
  \`add_edge\`) over hand-building this JSON: the backend fills defaults and
  validates each edit. Read the returned document to see the exact shape it
  produced, then adjust.

## Prompt elements & placement (Memory V2)
A prompt snippet is a LIBRARY item — creating it changes nothing on its own. It
only shapes a run once it is PLACED into a flow step's prompt stack. Placement is
per flow step, in one of two channels, at an order:
- \`read_workflow_prompt_stacks(workflowId)\` (or \`read_flow_prompt_stacks(flowId)\`)
  resolves a workflow/flow to its steps and each step's system/user stacks — this
  is how you DISCOVER the \`flowStepId\`s you place against. Start here.
- \`attach_prompt_snippet_to_flow_step(flowStepId, snippetId, target, displayOrder?)\`
  — \`target\` is \`"system"\` (instructions the model is steered by) or \`"user"\`
  (content presented as the user turn).
- \`list_flow_step_prompts\` shows a step's current system/user stacks (with each
  attachment's \`linkId\`); \`update_flow_step_prompt(linkId, …)\` moves/reorders one;
  \`reorder_flow_step_prompts(flowStepId, snippetIds)\` sets the whole order;
  \`detach_prompt_snippet_from_flow_step(linkId)\` unlinks (the snippet survives).
- A WILDCARD snippet applies to EVERY step (top of every stack) — use it for
  cross-cutting instructions instead of attaching the same snippet everywhere.
  \`list_wildcard_prompts\` shows them.

Where each kind of instruction belongs — the decision map:
- reusable voice/character for one agent → a **persona** (1:1 with the agent), or a
  reusable **snippet** if it is shared prompt text.
- a rule that must hold everywhere → a **wildcard** snippet, or a **policy** if it
  is a guardrail (policies are governance; snippets are prompt text).
- a step-specific instruction → a flow-step **\`system\`** prompt.
- user-turn scaffolding for a step → a flow-step **\`user\`** prompt.
- background knowledge the agent reads → a **reference doc** (attach to the agent).
- a capability the agent uses → a **tool** (\`agent.toolIds\`) or **skill** (attach).
- long-term recall for an agent → the agent's **\`episodicMemoryEnabled\`** flag
  (Memory V2, opt-in). Session/workflow memory are RUNTIME, not authored: they are
  written by a run, never set here. This connector does not expose them — the
  backend serves them per run, but no tool wraps those reads yet, so do not
  promise a user you can show them.

## Reproducing a setup (recreate, never copy ids)
To rebuild an agent/workflow/tool graph as NEW entities — in this tenant, or in
another tenant by pointing the connector at THAT tenant's token in a separate
session — author it fresh and wire by the NEW ids. An id from a read is
meaningful only in the tenant it came from; sending it back in a create/update
elsewhere points at nothing. Do this instead:
1. Read the source graph (in the session pointed at it) for its SHAPE: names,
   field values, which tools each agent lists, which agents/tools each workflow
   step references. For each source agent also read its LINKS —
   \`list_agent_skills\`, \`list_agent_policies\`, \`list_agent_reference_docs\` —
   they are not in the agent body, so a plain \`read_agent\` misses them and you
   would rebuild an agent that quietly lost its skills and guardrails.
2. Create the leaf dependencies first (tools, output_schemas). Keep a map from
   each OLD id to the NEW id the create call returns.
3. Create agents, translating every referenced id through your map:
   old toolId → new toolId in \`toolIds\`, etc. Never send an old id. If the
   source agent has a persona, recreate it with \`create_agent_persona\` on the
   new agent.
4. Create workflows; when you add agent/tool references into the document,
   translate through the map the same way.
5. Attach skills/policies/reference-docs by the new ids, then read them back
   (\`list_agent_*\`) and diff against what you read in step 1.
6. \`validate_workflow\` and re-read each entity to confirm every reference
   resolved, then \`request_publish_*\`.
The connector never carries a secret across: \`authConfig\` stays placeholders in
the new tenant too, and a human fills the real value there.

## Structural workflow edits
- \`apply_workflow_mutations\` takes a LIST of commands and applies them in order,
  threading the version for you — pass the version you read, not one per command.
- It is NOT transactional. If command N fails, the ones before it stay applied;
  the error tells you how many landed and which index failed. Re-read and resume
  from that index rather than replaying the whole list.
- \`replace_workflow_document\` stores the document's \`name\` and
  \`description\` — they sync onto the workflow's own columns, an omitted key
  leaves the stored value alone, and an explicit \`""\` clears it. \`stageId\`,
  \`capabilityId\`, \`valueStreamId\` and \`onFailure\` are PATCH-only: changing
  one through this route is REFUSED with a 422 naming the field, and
  round-tripping it unchanged passes. Read, edit, write is therefore safe;
  re-linking a workflow to another stage or capability is its own call.
- The response is a SUMMARY (version, appliedCount, launchable, validationIssues,
  stepCount, edgeCount), not the document. That is deliberate: a real workflow
  document overflows the response limit, and a successful call would come back
  looking like a failure — retrying that is how you end up with duplicate steps.
  Ask for the document with \`returnDocument: true\` or \`read_workflow\`.
- Command payloads are STRICT and complete:
  - \`add_step\` builds a whole step in ONE call — \`name\` and \`position\` are
    required, and \`id\`, \`type\`, \`config\`, \`contract\`, \`inputs\` and
    \`outputs\` are accepted next to them. No follow-up \`update_step\` is needed
    just to fill the step in.
  - \`add_edge\` takes the document's own \`from\`/\`to\` as well as
    \`fromStepId\`/\`toStepId\`, and keeps an \`id\` you supply.
  - An unknown or misspelled key is a 422 naming it, not a silent drop — so
    spelling matters and you are told when it is wrong.

## Two platform invariants that look like bugs
Both are deliberate, both run after EVERY edit, and both now report themselves in
the mutation response under \`systemAdjustments\` — so you no longer have to diff
a document to find out what the platform did.
- **A bound input's contract is derived, not authored.** An input that reads an
  upstream output takes its contract — description included — FROM that output.
  Write the text on the producing step's output; a downstream description changing
  when you edit an output is this rule at work, not the platform overwriting you.
  The inputs it re-derived come back in \`rederivedInputs\`.
- **Every step reaches the END point.** The platform guarantees it and wires that
  edge itself; the edges it added or removed come back in \`addedEdges\` /
  \`removedEdges\`. An edge you did not ask for is this, not corruption.

## Validating: two questions, two calls
- \`validate_workflow({ workflowId })\` checks the STORED workflow against the
  tenant catalog — it confirms the agents, tools and flows the steps reference
  actually exist. This is the "can this run?" answer, and it comes back with
  \`catalogChecked: true\`.
- \`validate_workflow({ document })\` is stateless and read-only-token safe, but
  without a catalog it can only judge STRUCTURE: \`launchable\` there means the
  graph is sound, not that it will run. It says so with \`catalogChecked: false\`.
- Pass exactly one. Before telling a human a workflow is ready, check
  \`catalogChecked\` — a green structural verdict is the easiest thing to
  over-read.

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
    "Read the authoring conventions BEFORE creating or updating anything: the " +
      "draft→publish lifecycle, optimistic locking, per-entity create contracts " +
      "(required fields, valid enum values, what 'complete' means), how to WIRE " +
      "tools→agents, agents/tools→workflows and delegation, and how to reproduce " +
      "a setup by creating new entities and remapping ids (never copy an id " +
      "across tenants).",
    {},
    async () => ({ content: [{ type: "text" as const, text: CONVENTIONS }] }),
  );
}
