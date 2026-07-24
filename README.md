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

200+ tools total. `axonity_conventions` (read this first) covers the authoring
rules — drafts vs live, optimistic locking, per-entity fields, delete/restore,
and how to tell a retryable error from one that will never succeed.

### The generic entity family

Ten entities — **workflow, agent, tool, skill, policy, reference_doc, persona,
output_schema, prompt_snippet, flow** — share one shape, though not every
entity gets every verb (see the per-entity notes below for the exceptions):

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
`create_agent_persona`).

Plus:
- `apply_workflow_mutations` for structural workflow edits (add steps, connect
  edges) via mutation commands, sequenced and version-threaded for you.
- `replace_workflow_document` for one-shot full-document replacement in a single
  atomic PUT.
- `read_workflow_trigger_parameters` — what input a workflow's triggers expect.
- `bulk_delete_workflows` — soft-delete several at once (each with its own
  `expectedVersion`).

### Version history, rollback, and version-level delete

For the ten versioned entities (including `flow`):

| Tool | What it does |
|------|--------------|
| `list_<entity>_versions` | List version history (checkpoints + named majors). |
| `read_<entity>_version` | Read one, by **integer checkpoint number**. |
| `restore_<entity>_version` | Roll the draft back to an old version (`expectedVersion` in body). |
| `delete_<entity>_version` | Remove one history entry. Draft and published version are protected. |
| `list_deleted_<entity>_versions` | Restore candidates for the row above. |
| `restore_deleted_<entity>_version` | Undo the delete above. No version check. |
| `read_<entity>_published` | The live snapshot, as opposed to the draft. |
| `name_<entity>_major_version` | Give a major version a name (label a release). |

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
- **Attach / detach memory**: `attach_skill_to_agent`,
  `attach_skill_to_workflow`, `attach_policy_to_agent`,
  `attach_reference_to_agent`, and a `detach_*_from_*` for each. Detaching
  removes the link only — the skill or policy itself is untouched. Read the
  links back with `list_agent_skills`, `list_agent_policies`,
  `list_agent_reference_docs`.
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
  `read_company_published`, and `request_publish_company` (takes no id — the
  server resolves your tenant's one company; direct company publish is closed to
  service tokens).
- **Catalog & cloning**: `list_system_tools` (read-only catalog — enabling one
  for an agent is `update_agent` with the id added to `systemToolIds`),
  `clone_flow`, `clone_prompt_snippet`.
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

### Runs — evaluating what you built

`start_workflow_run` (test a workflow you built — it runs the **published**
workflow and really executes), `cancel_run`, `delete_run`, `list_runs`,
`list_workflow_runs`, `read_run`, `read_run_trace`, `read_run_cost`,
`read_runs_summary`, `archive_run` / `unarchive_run`, `bulk_archive_runs` /
`bulk_delete_runs`. There is no findings endpoint — evaluation means reading a
run's validator verdicts and its trace.

### Approvals

`list_publish_approvals({ status?, limit?, offset? })` and
`get_publish_approval({ approvalId })` — how you find out whether a
`request_publish_*` was approved or rejected. Approving and rejecting are
human-only actions in Axonity.

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
  (`/api/v1/secrets`) aren't wrapped at all — the backend refuses any service
  token there outright.
- **Errors carry a machine-readable `code`, not just prose.** A 409 can mean a
  stale write (retry) or a live reference conflict (don't — see
  `axonity_conventions`); the connector tells them apart by `code`, never by
  matching the message text.
- **No tool crosses the authority boundary.** A test drives the whole registered
  surface and fails the build if any tool targets a publish / approve / secret /
  service-token / deploy route (`test/exclusions.test.ts`).
- **Guidance can't silently drift from the backend.** The field/enum facts the
  connector states are pinned to a vendored snapshot of the backend OpenAPI
  schema; `test/conformance.test.ts` fails if a route or documented enum
  diverges (see `test/fixtures/README.md`).

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
