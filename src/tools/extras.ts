/**
 * Secondary MCP tools (epic #652 C5): personas (agent-scoped), connectors
 * (a tool subtype), and attaching memory to a target.
 *
 * These use routes with shapes that don't fit the generic entity registrar:
 * personas are 1:1 with an agent (no standalone list), connectors are a tool
 * with `type: "connector"` and MUST NOT carry real credentials, and attach is a
 * path-only link.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

/** A value is a safe placeholder if it's empty or a `{{ … }}` template. */
function isPlaceholder(value: unknown): boolean {
  if (value === "" || value === null || value === undefined) return true;
  return typeof value === "string" && /^\s*\{\{.*\}\}\s*$/.test(value);
}

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

  server.tool(
    "update_persona",
    "Update a persona by its id (read the agent's persona first for its version).",
    {
      personaId: z.string().describe("The persona's id."),
      expectedVersion: z
        .number()
        .int()
        .describe("The version you last read — 409 if stale."),
      fields: z.record(z.unknown()).describe("The fields to change (camelCase)."),
    },
    async ({ personaId, expectedVersion, fields }) =>
      guard(async () =>
        jsonResult(
          await client.put(`/api/v1/personas/${personaId}`, {
            expectedVersion,
            ...fields,
          }),
        ),
      ),
  );
}

export function registerConnectorTools(
  server: McpServer,
  client: AxonityClient,
): void {
  const authGuard = (fields: Record<string, unknown>) => {
    const authConfig = fields.authConfig as Record<string, unknown> | undefined;
    if (authConfig && !Object.values(authConfig).every(isPlaceholder)) {
      throw new Error(
        "authConfig must contain only placeholders (empty or {{ … }}). Never put " +
          "real credentials in a connector — a human fills secrets in the Axonity " +
          "tool editor.",
      );
    }
  };

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
        authGuard(fields);
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
        authGuard(fields);
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
  const attach = (
    name: string,
    description: string,
    path: (a: string, b: string) => string,
    firstArg: string,
    secondArg: string,
  ) =>
    server.tool(
      name,
      description,
      {
        [firstArg]: z.string(),
        [secondArg]: z.string(),
      },
      async (args: Record<string, string>) =>
        guard(async () =>
          jsonResult(await client.post(path(args[firstArg], args[secondArg]))),
        ),
    );

  attach(
    "attach_skill_to_agent",
    "Scope a skill to an agent so the agent uses it.",
    (agentId, skillId) => `/api/v1/agents/${agentId}/skills-v2/${skillId}`,
    "agentId",
    "skillId",
  );
  attach(
    "attach_skill_to_workflow",
    "Scope a skill to a workflow.",
    (workflowId, skillId) => `/api/v1/workflows/${workflowId}/skills-v2/${skillId}`,
    "workflowId",
    "skillId",
  );
  attach(
    "attach_policy_to_agent",
    "Scope a policy to an agent.",
    (agentId, policyId) => `/api/v1/agents/${agentId}/policies/${policyId}`,
    "agentId",
    "policyId",
  );
  attach(
    "attach_reference_to_agent",
    "Scope a reference doc to an agent.",
    (agentId, refId) => `/api/v1/agents/${agentId}/reference-docs/${refId}`,
    "agentId",
    "refId",
  );
}
