# @axonity-ai/mcp — Axonity Flow MCP connector

A local [Model Context Protocol](https://modelcontextprotocol.io) server that lets
an external agent (e.g. **Claude Code** on your laptop) read, draft, and update
**workflows, agents, tools, skills, policies and reference docs** in your Axonity
tenant — the same verbs the internal Builder team has, minus direct publish.

It runs on your machine and talks to Axonity **only over the public REST API**,
authenticated with a per-tenant **service token**. The backend re-enforces
tenant + scope on every call, so the connector is not a trust boundary.

## Setup

1. **Mint a service token** in Axonity → **Settings → API tokens**. Copy it once
   (it starts with `axs_`); you won't see it again. Use a **read-only** token if
   you only want the agent to read.
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

| Tool | What it does |
|------|--------------|
| `axonity_conventions` | The authoring rules (drafts vs live, optimistic locking, per-entity fields). Read this first. |
Each entity — **workflow, agent, tool, skill, policy, reference_doc** — gets the
same five verbs:

| Tool (per `<entity>`) | What it does |
|------|--------------|
| `list_<entity>s` | List the tenant's entities. |
| `read_<entity>` | Read one by id (incl. its version — read before you update). |
| `create_<entity>` | Create a new **draft**. |
| `update_<entity>` | Update a draft (carries `expectedVersion`; 409 on a stale write). |
| `request_publish_<entity>` | Ask for a draft to be published — creates a pending approval; never publishes. |

Plus `apply_workflow_mutations` for structural workflow edits (add steps, connect
edges) via mutation commands.

Also:

- **Personas** (agent-scoped, 1:1 with an agent): `read_agent_persona`,
  `create_agent_persona`, `update_persona`.
- **Connectors** (a tool of type `connector`): `create_connector`,
  `update_connector` — `authConfig` must be placeholders only; a human fills real
  secrets in Axonity.
- **Attach / detach memory**: `attach_skill_to_agent`,
  `attach_skill_to_workflow`, `attach_policy_to_agent`,
  `attach_reference_to_agent`, and a `detach_*_from_*` for each. Detaching
  removes the link only — the skill or policy itself is untouched.

### Validate before you publish

| Tool | What it does |
|------|--------------|
| `validate_workflow` | Structural + schema check of a workflow document. Returns `launchable` and an `issues` list. Stateless, and does not verify that referenced agents/tools exist. |
| `analyze_workflow_reachable_outputs` | What a given step can read from upstream — bind inputs to real fields instead of guessing. |
| `validate_tool_code` | Syntax and banned-pattern check for Python tool code. |
| `format_tool_code` | Format tool code with Black. |

### Version history and rollback

For **workflow, agent, tool, skill, policy, reference_doc and persona**:
`list_<entity>_versions`, `read_<entity>_version` (by integer checkpoint
number), `restore_<entity>_version` (by version-row UUID), and
`read_<entity>_published` to see what is actually live. Output schemas have no
version history.

### Output schemas

`list_output_schemas`, `read_output_schema`, `create_output_schema`,
`update_output_schema` — the reusable output contracts a validator references.
They have no draft/publish cycle.

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

`list_publish_approvals({ status? })` — how you find out whether a
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
  credential is rejected before it leaves the connector.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build   # emits dist/
```
