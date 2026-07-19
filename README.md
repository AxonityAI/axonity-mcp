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
- **Attach memory to a target**: `attach_skill_to_agent`,
  `attach_skill_to_workflow`, `attach_policy_to_agent`, `attach_reference_to_agent`.

## Publishing

The connector **never publishes directly**. `request_publish_*` creates a
**pending approval** in Axonity; an admin approves it there, and only then does
the draft go live. Rejecting it changes nothing.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build   # emits dist/
```
