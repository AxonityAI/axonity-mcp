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
import { assertPlaceholderCredentials } from "./credentials.js";
import { guard, jsonResult } from "./result.js";

/** A value is a safe placeholder if it's empty or a `{{ … }}` template. */
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
