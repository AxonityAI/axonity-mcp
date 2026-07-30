/**
 * Secondary MCP tools: the agent-scoped persona create/read (personas
 * themselves are a full generic entity — see index.ts — but creation and the
 * by-agent read have no equivalent generic route), connectors (a tool
 * subtype), attaching memory to a target, and a few standalone one-offs.
 *
 * These use routes with shapes that don't fit the generic entity registrar:
 * a persona is created only through its agent, connectors are a tool with
 * `type: "connector"` and MUST NOT carry real credentials, and attach/detach
 * is a path-only link.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { assertPlaceholderCredentials } from "./credentials.js";
import { detachResult, guard, jsonResult } from "./result.js";

export function registerPersonaTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "read_agent_persona",
    "Read an agent's persona (voice/character). A persona is 1:1 with an agent — " +
      "there is no standalone persona list.",
    { agentId: z.string().describe("The agent's id.") },
    async ({ agentId }) =>
      guard(async () =>
        jsonResult(await client.get(`/api/v1/agents/${agentId}/persona`)),
      ),
  );

  server.tool(
    "create_agent_persona",
    "Create an agent's persona. Pass name, characterText and optional status.",
    {
      agentId: z.string().describe("The agent's id."),
      fields: z
        .record(z.unknown())
        .describe('Persona fields, e.g. { "name": "…", "characterText": "…" }.'),
    },
    async ({ agentId, fields }) =>
      guard(async () =>
        jsonResult(await client.post(`/api/v1/agents/${agentId}/persona`, fields)),
      ),
  );

  // Reading/updating a persona by its OWN id (list_personas, read_persona,
  // update_persona, delete_persona, restore_persona, …) is generated generically
  // from the "persona" EntityDef in index.ts — identical PUT semantics to what
  // used to be hand-written here. Only the agent-scoped create/read above are
  // bespoke, because personas have no standalone create route.
}

export function registerConnectorTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "create_connector",
    "Create a connector draft (a tool of type 'connector'). Do NOT put real " +
      "credentials in authConfig — use placeholders; a human fills secrets in Axonity.",
    {
      fields: z
        .record(z.unknown())
        .describe("Connector fields (name, description, implementation, authConfig)."),
    },
    async ({ fields }) =>
      guard(async () => {
        assertPlaceholderCredentials(fields);
        return jsonResult(
          await client.post("/api/v1/tools", { type: "connector", ...fields }),
        );
      }),
  );

  server.tool(
    "update_connector",
    "Update a connector draft (a tool of type 'connector'). Read it first for its " +
      "version; keep authConfig as placeholders only.",
    {
      id: z.string().describe("The connector (tool) id."),
      expectedVersion: z.number().int().describe("Version last read — 409 if stale."),
      fields: z.record(z.unknown()).describe("Fields to change (camelCase)."),
    },
    async ({ id, expectedVersion, fields }) =>
      guard(async () => {
        assertPlaceholderCredentials(fields);
        return jsonResult(
          await client.put(`/api/v1/tools/${id}`, {
            expectedVersion,
            type: "connector",
            ...fields,
          }),
        );
      }),
  );
}

/**
 * The identity fields of a linked entity — enough to audit a tenant's wiring,
 * without the bodies.
 *
 * Verifying that every link is where it belongs should cost what the LINKS
 * cost, not what the documents behind them cost. The backend answers these
 * read-backs with the whole entity, `bodyMd` included; a playbook runs 3-15 KB,
 * so one agent costs ~20 KB and a fourteen-agent tenant exceeds the budget for
 * the audit itself. That is not a tidiness problem: it is why a real check got
 * downgraded to a sample of five agents, and the sixth had no skill attached at
 * all (#33).
 *
 * Names differ per entity — a reference doc has `title` where a skill has
 * `name`, a policy has `summary` where a skill has `description` — so both
 * spellings are carried when present rather than renamed into a shape the
 * backend does not use.
 */
const IDENTITY_FIELDS = [
  "id",
  "name",
  "title",
  "description",
  "summary",
  "status",
  "source",
  "linkSource",
  "scope",
] as const;

/** Keep the envelope, project the rows down to identity. */
export function projectLinkRows(
  response: Record<string, unknown>,
  rowsKey: string,
): Record<string, unknown> {
  const rows = response[rowsKey];
  if (!Array.isArray(rows)) return response;

  return {
    ...response,
    [rowsKey]: rows.map((row) => {
      if (typeof row !== "object" || row === null) return row;
      const source = row as Record<string, unknown>;
      const kept: Record<string, unknown> = {};
      for (const field of IDENTITY_FIELDS) {
        if (source[field] !== undefined) kept[field] = source[field];
      }
      return kept;
    }),
    // Say what was dropped and how to get it — an omission the reader cannot
    // see is the same trap as the cost this fixes.
    bodiesOmitted:
      'Identity only. Pass verbosity: "full" for the complete rows, or read a ' +
      "single entity by id when you actually need its body.",
  };
}

export function registerAttachTools(
  server: McpServer,
  client: AxonityClient,
): void {
  /**
   * Attach and detach are the same path with POST vs DELETE, so both verbs are
   * generated from one definition — that is what keeps them from drifting apart
   * again (only attach existed before, so nothing could be unwired).
   */
  const link = (
    subject: string,
    target: string,
    path: (a: string, b: string) => string,
    firstArg: string,
    secondArg: string,
    /**
     * The read-back tool for this link, when one exists. A 200 here does not
     * prove the link resolved, so the description points at the tool that does —
     * agent-scoped links have one, `skill → workflow` has no list route.
     */
    readBack?: string,
  ) => {
    const shape = { [firstArg]: z.string(), [secondArg]: z.string() };

    server.tool(
      `attach_${subject}_to_${target}`,
      `Scope a ${subject.replace("_", " ")} to a ${target} so the ${target} uses it.` +
        (readBack
          ? ` Verify it landed with \`${readBack}\` before request_publish_${target} — ` +
            `the link lives outside the entity body, so re-reading the ${target} will ` +
            `not show it.`
          : ""),
      shape,
      async (args: Record<string, string>) =>
        guard(async () =>
          jsonResult(await client.post(path(args[firstArg], args[secondArg]))),
        ),
    );

    server.tool(
      `detach_${subject}_from_${target}`,
      `Unscope a ${subject.replace("_", " ")} from a ${target}. This only ` +
        `removes the link — the ${subject.replace("_", " ")} itself is not deleted ` +
        `and stays available to attach elsewhere. The response is the SERVER'S ` +
        `answer, not a success claim by this connector: a detach that had nothing ` +
        `to remove reports that instead of failing, so read the body rather than ` +
        `assuming the link is gone.` +
        (readBack ? ` Confirm what is left with \`${readBack}\`.` : ""),
      shape,
      async (args: Record<string, string>) =>
        guard(async () =>
          detachResult(await client.del(path(args[firstArg], args[secondArg])), {
            readBack,
            request: { [firstArg]: args[firstArg], [secondArg]: args[secondArg] },
          }),
        ),
    );
  };

  link(
    "skill",
    "agent",
    (agentId, skillId) => `/api/v1/agents/${agentId}/skills-v2/${skillId}`,
    "agentId",
    "skillId",
    "list_agent_skills",
  );
  // No read-back for the workflow-scoped variant: the backend has no
  // GET /workflows/{id}/skills-v2, so there is nothing to point at.
  link(
    "skill",
    "workflow",
    (workflowId, skillId) => `/api/v1/workflows/${workflowId}/skills-v2/${skillId}`,
    "workflowId",
    "skillId",
  );
  link(
    "policy",
    "agent",
    (agentId, policyId) => `/api/v1/agents/${agentId}/policies/${policyId}`,
    "agentId",
    "policyId",
    "list_agent_policies",
  );
  // Reference docs attach to agents only — there is no workflow-scoped
  // reference-doc route on the backend, so no `*_to_workflow` pair here.
  link(
    "reference",
    "agent",
    (agentId, refId) => `/api/v1/agents/${agentId}/reference-docs/${refId}`,
    "agentId",
    "refId",
    "list_agent_reference_docs",
  );

  /**
   * The read side of the links above. `attach_*`/`detach_*` write a link but
   * return nothing you can list later, so these are how an agent verifies a
   * link landed — and how it reads a source agent's wiring to reproduce it as
   * new. All three are plain GETs, safe for read-only tokens.
   */
  const listLinks = (
    subject: string,
    plural: string,
    path: (agentId: string) => string,
    /** The key the backend nests the rows under (`skills` / `policies` / `references`). */
    rowsKey: string,
  ) => {
    server.tool(
      `list_agent_${plural}`,
      `List the ${subject} currently scoped to an agent — the read-back for ` +
        `attach_${subject}_to_agent. Use it to confirm a link took, or to read a ` +
        `source agent's wiring before recreating it. Read-only. ` +
        `\n\nReturns IDENTITY by default: id, name, description, status and ` +
        `linkSource (why it is in scope — an explicit link, or tenant-wide). ` +
        `Bodies are omitted, because auditing a tenant means asking this for ` +
        `every agent and a single playbook can run to 15 KB. Read one body ` +
        `deliberately with read_${subject === "reference_doc" ? "reference_doc" : subject} ` +
        `when you actually intend to read it. Pass verbosity: "full" only when ` +
        `you need every field of every row.`,
      {
        agentId: z.string().describe("The agent's id."),
        verbosity: z
          .enum(["identity", "full"])
          .optional()
          .describe(
            'How much of each row to return. "identity" (default) is id, name, ' +
              'description, status and linkSource. "full" is the entire entity, ' +
              "bodies included — expensive, and rarely what an audit needs.",
          ),
      },
      async ({ agentId, verbosity }: { agentId: string; verbosity?: "identity" | "full" }) =>
        guard(async () => {
          const response = await client.get<Record<string, unknown>>(path(agentId));
          if (verbosity === "full") return jsonResult(response);
          return jsonResult(projectLinkRows(response, rowsKey));
        }),
    );
  };

  listLinks("skill", "skills", (id) => `/api/v1/agents/${id}/skills-v2`, "skills");
  listLinks("policy", "policies", (id) => `/api/v1/agents/${id}/policies`, "policies");
  listLinks(
    "reference_doc",
    "reference_docs",
    (id) => `/api/v1/agents/${id}/reference-docs`,
    "references",
  );
}

/**
 * Small standalone tools that don't fit any of the other groupings: the
 * system-tools catalog (read-only — there is no grant/revoke route; enabling
 * one for an agent means writing `systemToolIds` via `update_agent`), and
 * cloning a flow/prompt-snippet into a tenant-owned copy.
 */
export function registerCatalogTools(server: McpServer, client: AxonityClient): void {
  server.tool(
    "list_system_tools",
    "List the tenant's system-tool catalog (id, label, description, category). " +
      "There is no grant/revoke tool — enable one for an agent by adding its id " +
      "to `systemToolIds` via update_agent.",
    {},
    async () => guard(async () => jsonResult(await client.get("/api/v1/system-tools"))),
  );

  server.tool(
    "clone_flow",
    "Fork a flow into a new, independent, tenant-owned copy — including a " +
      "framework-provided one. Prefer this over editing a framework flow " +
      "directly: it is visible and NOT actually protected from update_flow/ " +
      "delete_flow (a backend gap, despite what its docstrings claim), so " +
      "editing one in place risks changing something other tenants share.",
    { flowId: z.string().describe("The flow's id.") },
    async ({ flowId }) =>
      guard(async () => jsonResult(await client.post(`/api/v1/flows/${flowId}/clone`))),
  );

  server.tool(
    "clone_prompt_snippet",
    "Duplicate a prompt snippet into a new, independent copy.",
    { snippetId: z.string().describe("The prompt snippet's id.") },
    async ({ snippetId }) =>
      guard(async () =>
        jsonResult(await client.post(`/api/v1/prompt-snippets/${snippetId}/clone`)),
      ),
  );
}
