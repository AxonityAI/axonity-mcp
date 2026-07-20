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
import { guard, jsonResult } from "./result.js";

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
  ) => {
    const shape = { [firstArg]: z.string(), [secondArg]: z.string() };

    server.tool(
      `attach_${subject}_to_${target}`,
      `Scope a ${subject.replace("_", " ")} to a ${target} so the ${target} uses it.`,
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
        `and stays available to attach elsewhere.`,
      shape,
      async (args: Record<string, string>) =>
        guard(async () => {
          await client.del(path(args[firstArg], args[secondArg]));
          return jsonResult({
            detached: true,
            [firstArg]: args[firstArg],
            [secondArg]: args[secondArg],
          });
        }),
    );
  };

  link(
    "skill",
    "agent",
    (agentId, skillId) => `/api/v1/agents/${agentId}/skills-v2/${skillId}`,
    "agentId",
    "skillId",
  );
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
  );
  // Reference docs attach to agents only — there is no workflow-scoped
  // reference-doc route on the backend, so no `*_to_workflow` pair here.
  link(
    "reference",
    "agent",
    (agentId, refId) => `/api/v1/agents/${agentId}/reference-docs/${refId}`,
    "agentId",
    "refId",
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
    "Fork a flow into a new, tenant-owned copy — including a framework-provided " +
      "one, which is otherwise read-only to your tenant.",
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
