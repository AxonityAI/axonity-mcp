# @axonity-ai/mcp — Axonity Flow MCP connector

A local [Model Context Protocol](https://modelcontextprotocol.io) server that lets
an external agent (e.g. **Claude Code** on your laptop) read, draft, update, and
recoverably delete **workflows, agents, tools, skills, policies, reference docs,
personas, output schemas, prompt snippets and flows** in your Axonity tenant —
the same verbs the internal Builder team has, minus direct publish.

It runs on your machine and talks to Axonity **only over the public REST API**,
authenticated with a per-tenant **service token**. The backend re-enforces
tenant + scope on every call, so the connector is not a trust boundary.

## Setup

1. **Mint a service token** in Axonity → **Settings → API tokens**. Copy it once
   (it starts with `axs_`); you won't see it again. Use a **read-only** token if
   you only want the agent to read — it is genuinely enforced, any write from it
   is refused with a 403. Every token expires (you choose 7, 15, 30, 60 or 90
   days at mint time; there is no "never"), and there is no way for the agent to
   check remaining lifetime in advance — an expired token fails exactly like a
   revoked one, so mint a fresh one when that happens.
2. **Add the connector to Claude Code:**

   ```bash
   claude mcp add axonity \
     --env AXONITY_TOKEN=axs_your_token_here \
     --env AXONITY_API_URL=https://app.axonity.ai \
     -- npx -y @axonity-ai/mcp
   ```

   `AXONITY_API_URL` is optional (defaults to the Axonity SaaS URL); set it if you
   self-host.

   Do **not** pass extra CLI arguments to `axonity-mcp`; startup only reads
   environment variables. If arguments are supplied, the process exits with a
   clear usage-style error.

3. Ask Claude Code things like *"list my Axonity workflows"*, *"create a workflow
   called Onboarding"*, or *"add a step to workflow X"*.

## Tools

345 tools total. `axonity_conventions` (read this first) covers the authoring
rules — drafts vs live, optimistic locking, per-entity fields, delete/restore,
and how to tell a retryable error from one that will never succeed.

What the connector does **not** state is as deliberate as what it does: the
mutation commands, the step types, the trigger types, the schedule-rule shapes
and the three value vocabularies are all read live from
`get_workflow_authoring_spec`, because every one of those lists drifted while it
was kept here. A conformance test asserts their absence.

### The generic entity family

Eleven entities — **workflow, agent, tool, skill, policy, reference_doc,
persona, output_schema, prompt_snippet, flow, data_table** — share one shape,
though not every entity gets every verb (see the per-entity notes below for the
exceptions):

| Tool (per `<entity>`) | What it does |
|------|--------------|
| `list_<plural>` | List the tenant's entities. |
| `read_<entity>` | Read one by id (incl. its version — read before you update). |
| `create_<entity>` | Create a new **draft**. |
| `update_<entity>` | Update a draft (`expectedVersion` in the body; 409 on a stale write). |
| `delete_<entity>` | Soft-delete. **Recoverable** — see `restore_<entity>`. |
| `restore_<entity>` | Undo a delete. No version check. |
| `list_deleted_<plural>` | Restore candidates. |
| `discard_<entity>_draft` | Reset the draft to the last published state. |
| `request_publish_<entity>` | Ask for a draft to be published — creates a pending approval; never publishes. |

Exceptions: `persona` has no `create_persona` (create only via
`create_agent_persona`). And `list_data_tables` answers **one page**, not the
whole library — see Tables below.

Some list routes narrow in the query, which is where narrowing belongs — the
backend applies it before the rows come back:
`list_workflows({ stageId?, capabilityId? })`,
`list_agents({ includeSystem? })`,
`list_policies({ scope?, ownerId? })`,
`list_reference_docs({ scope?, ownerId? })`,
`list_prompt_snippets({ deleted? })`,
`list_data_tables({ name?, status?, isDynamic? })`.

That table is **generated** from the pinned schema's own query parameters
(`npm run generate:filters` → `src/generated/listFilters.ts`), not hand-listed.
A filter the backend adds is exposed as soon as the snapshot is refreshed, and
a test fails if the two have parted. The argument names are camelCase; the wire
keeps whatever spelling each route declares, which is not consistent between
them and is not something a caller should have to know.

Plus:
- `get_workflow_authoring_spec` — everything **this deploy** can be built from,
  read live from the server (`GET /workflows/operations`): the mutation
  `operations`, the `triggerTypes`, the `stepTypes` (including the ones you may
  not author, each with the reason and what to write instead), the
  `scheduleRuleKinds` (each with an example the backend round-trips through its
  own parser as it serves it), and **three vocabularies for a value's type that
  are not interchangeable** — `parameterTypes` (a trigger parameter's or
  workflow constant's `type`), `outputKinds` (a step output's or input's
  `kind` — narrower, *different key*) and `schemaFieldKinds` (inside a field's
  `schema`, which wins where present). Getting that last group wrong is silent:
  a `kind` written on a trigger parameter is not a 422, it is a key nothing
  reads, so the value falls back to text. Every list is generated from the
  registry that *enforces* it, so the connector states none of them and a new
  value is discoverable without a release here. `operations` is an index by
  default; pass `types` for a command's live payload schema. `rulesVersion` is
  a content hash over all seven — same hash, nothing to re-fetch.
- `apply_workflow_mutations` for structural workflow edits (add steps, connect
  edges) via mutation commands, sequenced and version-threaded for you.
- `replace_workflow_document` for one-shot full-document replacement in a single
  atomic PUT.
- `read_workflow_trigger_parameters` — how to start the workflow:
  `{ triggers, constants }`, every start with its own parameters and a `pinned`
  flag marking the values the author owns.
- `bulk_delete_workflows` — soft-delete several at once (each with its own
  `expectedVersion`).

### Version history, rollback, and version-level delete

For the eleven versioned entities (including `flow` and `data_table`):

| Tool | What it does |
|------|--------------|
| `list_<entity>_versions` | List version history (checkpoints + named majors). |
| `read_<entity>_version` | Read one, by **integer checkpoint number**. |
| `restore_<entity>_version` | Roll the draft back to an old version (`expectedVersion` in body). |
| `delete_<entity>_version` | Remove one history entry. Draft and published version are protected. |
| `list_deleted_<entity>_versions` | Restore candidates for the row above. |
| `restore_deleted_<entity>_version` | Undo the delete above. No version check. |
| `read_<entity>_published` | The live snapshot, as opposed to the draft. |
| `create_<entity>_major_version` | Cut a new **named** major version — "Save As" on the current draft. |
| `ensure_<entity>_major_version` | Make sure a working draft major version exists. Idempotent. |
| `name_<entity>_major_version` | Rename an existing major version (label a release). |

`{version}` (an int) and `{versionId}` (a UUID) are two different identifiers
across these routes — the tool parameter names say which.

### Also

- **Personas**: `read_agent_persona`, `create_agent_persona` — agent-scoped,
  since a persona can only be created through its agent. Everything else about
  a persona (list, read, update, delete/restore, versions) is the generic
  entity family above.
- **Connectors** (a tool of type `connector`): `create_connector`,
  `update_connector` — `authConfig` must be placeholders only; a human fills real
  secrets in Axonity. (`create_tool`/`update_tool` carry the same guard, so a
  connector authored either way is covered.)
- **Toolboxes** (the group a tool is filed under): `list_toolboxes`,
  `create_toolbox`, `update_toolbox`, `delete_toolbox`, `set_toolbox_tools`,
  `assign_tool_toolbox`, `set_toolbox_auth`, `list_toolbox_dependent_tools`.
  Read `list_toolboxes` before `create_tool` and pass `toolboxId` — a tool made
  without one is ungrouped. Three things worth knowing before you write:
  `set_toolbox_tools` **declares** the membership (anything you leave out is
  evicted — `assign_tool_toolbox` moves a single tool and takes `null` to
  ungroup); a box never changes what an agent may *call*, only how a tool is
  *advertised* (agents link to individual tools, never to a box); and deleting a
  box leaves its tools alive, ungrouped. `set_toolbox_auth` sets the credential a
  box's tools share and carries the same placeholder guard as a connector.
- **Attach / detach memory**: `attach_skill_to_agent`,
  `attach_skill_to_workflow`, `attach_policy_to_agent`,
  `attach_reference_to_agent`, `attach_reference_to_workflow`, and a
  `detach_*_from_*` for each. Detaching removes the link only — the skill or
  policy itself is untouched. Read the links back with `list_agent_skills`,
  `list_agent_policies`, `list_agent_reference_docs`, `list_workflow_skills`
  and `list_workflow_reference_docs`. The three agent read-backs take an
  optional `workflowId` for the **composed runtime view** — what the agent's
  prompt actually assembles inside that workflow, with a `linkSource` per row
  saying why each item is there.
- **What uses this?**: `list_workflows_using({ entityKind, entityId })` names
  the workflows that reference a tool, agent, flow, output schema or workflow,
  **and the steps they reference it in**, with `draft`/`published` per hit.
  `list_dependent_agents({ entityKind, entityId })` is the same question for a
  skill, policy or reference doc. Ask before editing anything shared — the
  alternative is validating every workflow in the tenant.
- **Prompt elements (placement)**: a `prompt_snippet` is a library item; it only
  takes effect once placed into a flow step's prompt stack.
  `read_workflow_prompt_stacks` / `read_flow_prompt_stacks` resolve a
  workflow/flow to its steps and each step's `system`/`user` stacks (this is how
  you find the `flowStepId`s). Then `attach_prompt_snippet_to_flow_step`
  (`target` = `system`|`user`, with an order), `update_flow_step_prompt`,
  `reorder_flow_step_prompts`, `detach_prompt_snippet_from_flow_step`, and
  `list_flow_step_prompts` / `list_wildcard_prompts`.
- **Company** (the tenant's single company document — a singleton, no id):
  `read_company`, `update_company` (whole-document save with `expectedVersion`),
  `list_company_versions`, `read_company_version`, `restore_company_version`,
  `name_company_major_version`, `create_company_major_version`,
  `ensure_company_major_version`, `read_company_published`,
  `apply_company_mutation` (one validated, version-safe command — preferred
  over the whole-document `update_company`, the same way
  `apply_workflow_mutations` is preferred for a workflow), and
  `request_publish_company` (takes no id — the
  server resolves your tenant's one company; direct company publish is closed to
  service tokens).
- **Subworkflows**: `list_callable_workflows` — which workflows a `subprocess`
  step may call, each with its `parameters` and `outcomes`, and a
  `blockedReason` for the ones that cannot (never published, or no
  `subprocess-invocation` trigger). Authoring both halves is ordinary
  `apply_workflow_mutations` work — a callable workflow's signature goes into
  the `add_trigger` call itself. `validate_workflow` **does** check a subprocess
  target now (missing, self-call, deleted, unpublished, not callable), but
  `list_callable_workflows` is still what you run first: it is how you pick a
  target and read the interface you are binding to.
- **The deploy, the tenant and its queues** (read-only): `read_deploy_contract`
  (what this backend actually mounts — read it when a call fails in a way that
  smells like a version mismatch), `list_users` (where an `ownerId` comes from),
  `list_audit_events` (pass `actorKind: "service_token"` to read back what
  external agents — including you — changed), `read_queue_overview`,
  `list_in_flight_runs`, `read_task_queue_summary`, `list_task_queue`,
  `read_task_queue_item`, `export_task_queue`, plus `read_model_tier_map` (what
  `capabilityTier` resolves to), `read_concurrency_status`,
  `read_concurrent_run_cap` and `read_for_each_rate`. Together these answer *why
  is my run not moving* without asking a human to look at a screen. Every write
  in these families — purging or replaying queue work, changing a cap or the
  tier map, importing a tenant bundle, reading someone's notifications — is
  deliberately absent and recorded in `test/denyList.ts`, the list
  `test/exclusions.test.ts` enforces.
- **Secrets** (read-only): `list_secrets`, `read_secret` — the catalogue a
  connector's `authConfig.secretId` points at. Values are never returned by any
  Axonity route; `valueKeys` says which keys a human has filled in, so you can
  tell an unfinished secret from a finished one before wiring to it. Creating or
  changing a secret is a human act in Axonity (#39).
- **Catalog & cloning**: `list_system_tools` (read-only catalog — enabling one
  for an agent is `update_agent` with the id added to `systemToolIds`),
  `clone_flow`, `clone_prompt_snippet`, `list_tool_packages` (the import
  allowlist `validate_tool_code` judges against), `list_templates` /
  `read_template`.
- **Tables** (`data_table`): the tenant's own reference data — a table an
  author designs and maintains, and agents and decisions read. The whole
  lifecycle is the generic family above; three things are not, and each is a
  way to be quietly wrong:
  - `list_data_tables` is **paged** (20 by default, 200 max), alone among the
    library lists, because a tenant's reference data has no ceiling. Page one
    is not the library — follow `nextCursor` while `hasMore`, or narrow with
    `name`, which is exact and unique per workspace.
  - **`rows` and `columns` are whole-collection fields.** Sending `rows`
    through `update_data_table` replaces the table's content; one row there
    deletes every other. `add_data_table_row`, `update_data_table_row` and
    `delete_data_table_row` address a single row by a `matchColumn` /
    `matchValue` pair and cannot touch the rest.
  - **A table's derived tools follow its published version.** A published table
    mints its own CRUD tools, so granting an agent access to one is ordinary
    tool granting. `list_data_table_tools` reports `offered` (what the draft
    would yield), `toolId` (whether a row exists) and `isLive` (whether a run
    can reach it) separately — an author who ticked "may add rows" and has not
    published has granted nothing yet.
- `list_deleted_prompt_snippets` calls `/api/v1/prompt-snippets/deleted`; the
  backend returns it as `{ items: [... ] }`, and the tool forwards that response
  unchanged.

### Validate and run before you publish

| Tool | What it does |
|------|--------------|
| `validate_workflow` | Structural + schema check of a workflow document. Stateless and read-only-token safe; does not verify referenced agents/tools exist. |
| `analyze_workflow_reachable_outputs` | What a given step can read from upstream — bind inputs to real fields instead of guessing. Stateless and read-only-token safe. |
| `validate_tool_code` | Syntax and banned-pattern check for Python tool code. Stateless and read-only-token safe. |
| `format_tool_code` | Format tool code with Black. Stateless and read-only-token safe. |
| `execute_tool` | Actually RUN tool code (not just validate it) and see the real output. |
| `execute_stored_connector` | Test-run an already-saved connector. The backend decrypts its real secret server-side — the agent supplies only input parameters and never sees the secret. |

### Triggers — what makes a workflow run

`list_/create_/delete_` for **webhook triggers** (plus
`rotate_webhook_trigger`), **cron schedules**, and **conditional triggers**
(plus `update_conditional_trigger`). Trigger deletes are **hard** deletes with
no restore, and a webhook token is shown **once** at create or rotate.

**A schedule is a claim you can now check.** `run_cron_schedule_now` fires one
immediately *without* moving `nextFireAt` — testing a schedule must not consume
the run it was going to make. Before it existed, "every weekday at 07:00" could
only be tested by coming back tomorrow, and what is usually wrong is not the
timing but whether it starts anything at all.

**To pause a schedule, disarm it** — `set_cron_schedule_enabled`, not
`delete_cron_schedule`. Deleting throws away the rules the author wrote and
makes "stop this for a week" indistinguishable from "we do not do this any
more". `list_all_cron_schedules` answers *what runs tonight?* across the tenant;
`reconcile_cron_schedules` answers *is that actually what runs?* — it reports
rather than tidying silently, and never arms something someone switched off.

`create_cron_schedule` takes either `cronExpr` or the richer `rules`, and the
trigger must exist in the **published** document. Rule shapes come from
`get_workflow_authoring_spec` → `scheduleRuleKinds`; this connector names none
of its own.

### Runs — evaluating what you built

`start_workflow_run` (test a workflow you built — it runs the **published**
workflow and really executes), `cancel_run`, `delete_run`, `list_runs`,
`list_workflow_runs`, `read_run`, `read_run_trace`, `read_run_cost`,
`read_runs_summary`, `archive_run` / `unarchive_run`, `bulk_archive_runs` /
`bulk_delete_runs`. There is no findings endpoint — evaluation means reading a
run's validator verdicts and its trace.

**Which start, and what it wants.** `read_workflow_trigger_parameters` answers
`{ triggers, constants }` — every way the workflow can be started, each with its
own parameters. Pass the one you mean to `start_workflow_run` as `triggerId`;
omitting it fires the first, which on a workflow with a button *and* a schedule
is an arbitrary choice. A parameter marked `pinned` is one the **author** owns:
it is overwritten on every run, so a caller must not send it.

**`read_run` omits the workflow snapshot by default.** It is immutable, it is
never the answer to a question about the run, and it measured 81% of one real
response — an oversized response turns a call that succeeded into an error.
Pass `includeSnapshot: true` when you actually want to see what executed.

**Start from the outline.** `read_run_outline` is the run's table of contents —
the run, its steps, and the items a fan-out handed out, flat with parent
pointers. It carries no bodies, so its size follows the run's *shape* rather
than its content: a launch over four thousand items costs about what one over
four costs. `itemCap` bounds the items listed per fan-out step and the remainder
is counted in `counts.truncated`, never dropped silently —
`read_run_outline_items` carries on from where the outline stopped, one step at
a time, walked by `offset` (safe here: a fan-out's items are fixed once handed
out, so the ordering cannot shift under you). Then open only what
you want: `read_run_value` for one large step value (by the digest in
`stepStates`) and `read_run_invocation_messages` for one agent's transcript (by
the id in `agentInvocations`). Reading a whole run to find one message is the
habit these replace.

**A run can park rather than finish.** `read_run_waiting_on` says what it is
waiting for; `answer_run_question` answers an `ask_user` step and
`send_run_message` sends a turn to a conversation run. Both record the input as
a person's, so use them on runs you started. Deciding a **plan approval** and
restarting a stuck run are deliberately absent — the first is the human review
the step exists to get, the second is `require_admin` and a service token is
always `role="member"`. Both are recorded in `test/denyList.ts`, together
with stopping runs in bulk (admin), the tenant's storage footprint (admin), an
inbound channel reply (authenticated by the email/WhatsApp adapter, not by a
service token) and the retired `workflow-memory` placeholder.

**`list_todo_steps`** is the same question across the whole tenant: every step
waiting on a human, in any run. It is paged over the waiting **runs**, so
`items` can be longer than `pageSize` — one run may park several steps. Follow
`nextCursor` to the end before concluding anything about how much is waiting.

**What an agent wrote to itself.** `list_run_session_memory` lists the files an
agent left during a run (metadata only, up to 200 per run) and
`read_run_session_memory_file` opens one. When the trace shows a decision but
not what it was reading, the reason is usually here. Workflow-bound reference
material is not — that lives in `reference_docs`.

**Inside a launch**: `read_run_items_summary` is the roll-up ("4,415 processed ·
12 failed"), `list_run_items({ outcome })` the paged rows — filter in the query,
because the failures are scattered and sifting page one finds none of them.
`list_run_tasks` and `read_run_for_each_progress` cover the children a run set
in motion.

`list_workflow_runs({ workflowId, status?, archivedOnly?, limit?, cursor? })` returns one
**page** — `{ items, nextCursor, pageSize, hasMore }`, 20 by default and 200 at
most — so follow `nextCursor` while `hasMore` is true rather than treating the
first page as the answer. It also lists **launches**, not runs: the per-item runs
a FOR EACH creates stay inside their launch, so a launch over 4,415 people is one
entry carrying `forEachProgress`. `list_runs` is the tenant-wide list and is now
paged the same way — `{ items, nextCursor, pageSize, hasMore }`, walked with
`cursor`. It stopped answering with a bare array when the backend converted the
route; the `offset` it used to take is no longer read.

### Approvals

`list_publish_approvals({ status?, limit?, offset? })` and
`get_publish_approval({ approvalId })` — how you find out whether a
`request_publish_*` was approved or rejected. Approving and rejecting are
human-only actions in Axonity.

`request_publish_release({ workflowId, changeSummary? })` proposes a **release**:
a workflow *and everything its run needs* — the agents it runs, their tools and
personas, the flows it pins, the memory scoped to those agents — as ONE approval.
Prefer it over a request per entity. Taking a tenant live entity-by-entity means
a hundred-odd approvals, none of which means anything on its own, and a human
asked that many times is not reviewing. `list_publish_releases` and
`get_publish_release` read one back — the release's members, and its readiness
recomputed as of now.

Unlike `request_publish_bulk`, a release is **all-or-nothing and in dependency
order**: approving it publishes every member or none, so a workflow can never go
live calling a tool that did not. The response carries the bundle's verdict —
`ready`, `changedCount` of `totalCount` (unchanged members are already live and
ride along), `members` with why each is there, and `blockers` that name the
member in the way. Requesting is ours; deciding stays human, like everywhere
else here.

## What this is for — and what it is not

**Authoring.** An agent composing an entity from intent: drafting a workflow,
writing a tool, wiring memory onto an agent, and checking its own work. That is
what these tools are built for.

**Not bulk migration.** Do not use the connector to move many entities verbatim
from one place to another. Axonity's config export/import moves bytes with no
model in the path and fails closed on secrets; content routed through an agent
can be subtly altered in transit, which is precisely the risk a fidelity
migration cannot take.

## Guardrails

These are enforced by the backend, not merely by convention:

- **The connector never publishes.** `request_publish_*` creates a **pending
  approval**; a human approves it in Axonity, and only then does the draft go
  live. A direct publish from a service token is refused with a 403, so there is
  no tool for it and no way around it.
- **A read-only token is genuinely read-only for mutations.** Any write from a token
  without the `write` scope is refused with a 403.
- **The four stateless analysis tools are the exception:** `validate_workflow`,
  `analyze_workflow_reachable_outputs`, `validate_tool_code`, and `format_tool_code`
  can be called by read-only and write tokens because they never mutate state.
- **The token is tenant-bound.** An agent cannot reach another tenant.
- **Secrets never pass through the agent.** A connector's `authConfig` accepts
  placeholders only; a write carrying something that looks like a real
  credential is rejected before it leaves the connector. Tenant secrets
  (`/api/v1/secrets`) are **readable and unwritable**: `list_secrets` /
  `read_secret` give the catalogue and `valueKeys` (which keys are filled, never
  their values) so an agent can point `authConfig.secretId` at the right entry,
  and no tool can create, change or delete one — the backend refuses a service
  token there too. A secret's `metadata` is stored unencrypted and readable
  tenant-wide (axonity-flow#908), so credential-shaped entries in it are
  withheld on read and listed under `metadataRedacted`.
- **Errors carry a machine-readable `code`, not just prose.** A 409 can mean a
  stale write (retry) or a live reference conflict (don't — see
  `axonity_conventions`); the connector tells them apart by `code`, never by
  matching the message text.
- **No tool crosses the authority boundary.** A test drives the whole registered
  surface and fails the build if any tool targets a publish / approve /
  secret-write / service-token / deploy route (`test/denyList.ts`). The
  rules are method-aware: `GET /api/v1/secrets` is allowed, every write verb on
  it is not.
- **Guidance can't silently drift from the backend.** The field/enum facts the
  connector states are pinned to a vendored snapshot of the backend OpenAPI
  schema; `test/conformance.test.ts` fails if a route or documented enum
  diverges (see `test/fixtures/README.md`).
- **Every backend route is decided, and the build says so.**
  `test/completeness.test.ts` partitions all 444 operations in the pinned
  snapshot into *covered by a tool* or *excluded by a rule that carries a
  written reason*, and fails on anything in neither. A route nobody has decided
  about is indistinguishable from one somebody is still working on, which is
  what made "is this connector finished?" a question you could only answer with
  an audit. It is now a build status: a new backend route arrives as a red build
  asking **cover it, or exclude it with a reason?**

**One known exception, not enforced:** a framework-provided `flow` is meant to
be read-only to a tenant, but the backend does not actually block
`update_flow`/`delete_flow` against one. Prefer `clone_flow` over editing a
framework flow in place.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build   # emits dist/
```

## Releasing

Publishing runs from a maintainer's machine, not from CI. npm restricts tokens
that bypass 2FA for direct publishing, so a stored `NPM_TOKEN` cannot ship this
package; `npm login` is the supported path.

**Check the contract first.** Shipping with a stale snapshot is how the
connector fell nine operations behind the backend without any test noticing:

```bash
npm run check:contract          # expects ../axonity-flow; override with AXONITY_FLOW_PATH
```

It dumps the schema from a local `axonity-flow` checkout and diffs it against
`test/fixtures/openapi.snapshot.json`, naming every operation that moved. It
runs here rather than in the release workflow because the publish itself runs
here — a gate in CI cannot stop a local `npm publish`.

Run `npm login` in a real terminal — it prints a URL and waits for you to finish
in the browser, so it needs a session that stays attached (an editor's 2-minute
command timeout will kill it mid-flow).

```bash
npm login                 # browser flow; must complete in an attached terminal
npm whoami                # confirm the account

git checkout main && git pull
npm version <x.y.z> -m "%s"          # commits + tags, so the tag matches the tarball
git push origin main --follow-tags
npm publish                          # prepublishOnly builds dist/ fresh
npm view @axonity-ai/mcp version     # confirm
```

Then cut a GitHub release for the tag. That triggers `Verify release`, which
rebuilds and packs the tagged commit without publishing — it catches a tag that
was cut from a state CI cannot install.

Keep npm 11 locally: Node 20 bundles npm 10, whose resolver writes an
incompatible lockfile tree. CI pins npm 11 for the same reason.

## Staying level with the backend

The snapshot every drift guard reads is only as fresh as the last time someone
regenerated it — and once it wasn't: it sat nine operations behind the backend
while the whole suite stayed green, because a snapshot that has not seen a route
cannot report it missing.

**Before a release, check it** (see §Releasing): `npm run check:contract` dumps
the schema from a local `axonity-flow` checkout and names every operation that
moved. It compares the contract surface — query parameters, request body,
response shape — and not descriptions, so backend docstring churn does not cry
wolf. This is the gate that counts, because the publish runs here too.

**At startup, the connector asks the deploy what it mounts.** It calls
`GET /api/v1/contract` once before accepting its first tool call and, if this
backend lacks a route this build needs, says which on stderr — instead of
failing on the twentieth call, mid-task. It is a diagnostic and never a
dependency: a backend too old to serve `/contract`, an unreachable one, or a
slow one all degrade to the previous behaviour and the connector starts
normally. The result is cached on the `contractHash` the route returns, so an
unchanged deploy costs one request.

**Not here: a scheduled job.** Watching for drift on a timer belongs in
`axonity-flow`, not in this repository. The schema lives there, its CI already
has the backend's dependencies installed, and it can read this repository's
pinned snapshot over plain HTTPS because this repository is public — where the
reverse needs a credential for a private repo, with an approval policy and an
expiry behind it. Tracked in axonity-mcp#48.
