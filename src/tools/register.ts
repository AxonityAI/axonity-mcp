/**
 * Registers the read/draft/update MCP tools for one Axonity entity type.
 *
 * Every entity (workflow, agent, tool) gets the same verbs the internal
 * Builder team has, minus direct publish:
 *   list_<entity>   — GET  /api/v1/<entity>s
 *   read_<entity>   — GET  /api/v1/<entity>s/{id}
 *   create_<entity> — POST /api/v1/<entity>s              (a new draft)
 *   update_<entity> — PUT|PATCH /api/v1/<entity>s/{id}    (read-then-write)
 *
 * The connector stays thin: entity fields pass through as JSON and the backend
 * validates them (422 surfaces the field detail). Updates carry `expectedVersion`
 * so a stale write 409s rather than clobbering — the agent re-reads and retries.
 *
 * `request_publish_*` never publishes — it creates a pending approval a human
 * decides in Axonity (epic #652 C3).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

export interface EntityDef {
  /** Singular tool noun, e.g. "workflow". */
  singular: string;
  /** REST collection path, e.g. "/api/v1/workflows". */
  basePath: string;
  /** HTTP verb the update route uses (workflows PATCH; agents/tools PUT). */
  updateMethod: "PUT" | "PATCH";
  /** One-line human description of the entity, for the tool docs. */
  label: string;
}

export function registerEntityTools(
  server: McpServer,
  client: AxonityClient,
  def: EntityDef,
): void {
  const { singular, basePath, updateMethod, label } = def;

  server.tool(
    `list_${singular}s`,
    `List all ${label} in your Axonity tenant (id, name, status, version).`,
    {},
    async () => guard(async () => jsonResult(await client.get(basePath))),
  );

  server.tool(
    `read_${singular}`,
    `Read one ${singular} by id, including its current draft and version. ` +
      `Read before you update — you need the current version.`,
    { id: z.string().describe(`The ${singular}'s id.`) },
    async ({ id }) =>
      guard(async () => jsonResult(await client.get(`${basePath}/${id}`))),
  );

  server.tool(
    `create_${singular}`,
    `Create a new ${singular} draft. Pass the entity's fields (camelCase) in ` +
      `\`fields\`; the backend validates them. Returns the created ${singular} ` +
      `with its id and version.`,
    {
      fields: z
        .record(z.unknown())
        .describe(
          `The ${singular}'s fields as a JSON object (camelCase keys), e.g. ` +
            `{ "name": "…", "description": "…" }.`,
        ),
    },
    async ({ fields }) =>
      guard(async () => jsonResult(await client.post(basePath, fields))),
  );

  server.tool(
    `update_${singular}`,
    `Update a ${singular} draft. Read it first to get \`expectedVersion\`; on a ` +
      `409 conflict, read again and retry. Pass only the fields you are ` +
      `changing (camelCase) in \`fields\`.`,
    {
      id: z.string().describe(`The ${singular}'s id.`),
      expectedVersion: z
        .number()
        .int()
        .describe("The version you last read — rejected with 409 if stale."),
      fields: z
        .record(z.unknown())
        .describe(`The fields to change, as a JSON object (camelCase keys).`),
    },
    async ({ id, expectedVersion, fields }) =>
      guard(async () => {
        const body = { expectedVersion, ...fields };
        const path = `${basePath}/${id}`;
        const data =
          updateMethod === "PUT"
            ? await client.put(path, body)
            : await client.patch(path, body);
        return jsonResult(data);
      }),
  );

  server.tool(
    `request_publish_${singular}`,
    `Request that a ${singular} be published. This does NOT publish it — it ` +
      `creates a pending approval a human approves in Axonity. Returns the ` +
      `pending approval (with its readiness).`,
    {
      id: z.string().describe(`The ${singular}'s id.`),
      changeSummary: z
        .string()
        .optional()
        .describe("A short note for the approver on what changed and why."),
    },
    async ({ id, changeSummary }) =>
      guard(async () =>
        jsonResult(
          await client.post("/api/v1/publish-approvals", {
            entityType: singular,
            entityId: id,
            ...(changeSummary ? { changeSummary } : {}),
          }),
        ),
      ),
  );
}
