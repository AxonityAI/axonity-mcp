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

3. Ask Claude Code things like *"list my Axonity workflows"*, *"create a workflow
   called Onboarding"*, or *"add a step to workflow X"*.

## Tools

194 tools total. `axonity_conventions` (read this first) covers the authoring
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
`create_agent_persona`); `flow` has no `request_publish_flow`, no
`discard_flow_draft`, and no version family at all (a flow is live the moment
you save it — see `clone_flow` below).

Plus `apply_workflow_mutations` for structural workflow edits (add steps, connect
edges) via mutation commands, sequenced and version-threaded for you.

### Version history, rollback, and version-level delete

For the nine versioned entities (everything above except `flow`):

| Tool | What it does |
|------|--------------|
| `list_<entity>_versions` | List version history (checkpoints + named majors). |
| `read_<entity>_version` | Read one, by **integer checkpoint number**. |
| `restore_<entity>_version` | Roll the draft back to an old version (`expectedVersion` in body). |
| `delete_<entity>_version` | Remove one history entry. Draft and published version are protected. |
| `list_deleted_<entity>_versions` | Restore candidates for the row above. |
| `restore_deleted_<entity>_version` | Undo the delete above. No version check. |
| `read_<entity>_published` | The live snapshot, as opposed to the draft. |

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
  removes the link only — the skill or policy itself is untouched.
- **Catalog & cloning**: `list_system_tools` (read-only catalog — enabling one
  for an agent is `update_agent` with the id added to `systemToolIds`),
  `clone_flow`, `clone_prompt_snippet`.

### Validate and run before you publish

| Tool | What it does |
|------|--------------|
| `validate_workflow` | Structural + schema check of a workflow document. Returns `launchable` and an `issues` list. Stateless, and does not verify that referenced agents/tools exist. |
| `analyze_workflow_reachable_outputs` | What a given step can read from upstream — bind inputs to real fields instead of guessing. |
| `validate_tool_code` | Syntax and banned-pattern check for Python tool code. |
| `format_tool_code` | Format tool code with Black. |
| `execute_tool` | Actually RUN tool code (not just validate it) and see the real output. |
| `execute_stored_connector` | Test-run an already-saved connector. The backend decrypts its real secret server-side — the agent supplies only input parameters and never sees the secret. |

### Triggers — what makes a workflow run

`list_/create_/delete_` for **webhook triggers** (plus
`rotate_webhook_trigger`), **cron schedules**, and **conditional triggers**
(plus `update_conditional_trigger`). Trigger deletes are **hard** deletes with
no restore, and a webhook token is shown **once** at create or rotate.

### Runs — evaluating what you built

`list_runs`, `list_workflow_runs`, `read_run`, `read_run_trace`,
`read_run_cost`, `read_runs_summary`, `archive_run` / `unarchive_run`,
`bulk_archive_runs` / `bulk_delete_runs`. There is no findings endpoint —
evaluation means reading a run's validator verdicts and its trace.

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
- **A read-only token is genuinely read-only.** Any write from a token without
  the `write` scope is refused with a 403.
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

## Development

```bash
npm install
npm run typecheck
npm test
npm run build   # emits dist/
```
