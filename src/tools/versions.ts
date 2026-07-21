/**
 * Version history, rollback, and version-level delete/restore.
 *
 * Two different identifiers appear in these routes and confusing them silently
 * 404s:
 *   - `version`    — an INTEGER checkpoint number (1, 2, 3 …), used to read one.
 *   - `versionId`  — the UUID of the version row, used to restore/delete it.
 *
 * There are also two unrelated things both called "restore" here:
 *   - `restore_<entity>_version`         — roll the DRAFT back to an old,
 *     still-live version. Takes `expectedVersion` in the body.
 *   - `restore_deleted_<entity>_version` — undo a DELETED version row coming
 *     back into history. No body — a restore must never lose to a stale-version
 *     guard.
 *
 * The published snapshot also lives in two places depending on the entity
 * family: `/{id}/published` for workflow/agent/tool/flow, `/{id}/versions/published`
 * for the memory entities (including output_schema and prompt_snippet, which
 * gained full versioning alongside them). `publishedPath` selects the right one.
 *
 * Only entities that actually expose `/versions*` get these verbs.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

/** A required literal — an agent cannot satisfy it by filling in a default. */
const CONFIRM = z
  .literal(true)
  .describe("Must be true. Acknowledges you understand this is destructive.");

export interface VersionedEntity {
  /** Tool noun, e.g. "workflow". */
  singular: string;
  /** REST collection path, e.g. "/api/v1/workflows". */
  basePath: string;
  /**
   * Where the published snapshot lives.
   * `"entity"` → `/{id}/published` (workflow, agent, tool)
   * `"versions"` → `/{id}/versions/published` (skill, policy, reference_doc, persona)
   */
  publishedPath: "entity" | "versions";
}

export function registerVersionTools(
  server: McpServer,
  client: AxonityClient,
  { singular, basePath, publishedPath }: VersionedEntity,
): void {
  server.tool(
    `list_${singular}_versions`,
    `List a ${singular}'s version history — checkpoints (every save) and major ` +
      `versions (named releases). Use this to find the versionId you need for ` +
      `restore_${singular}_version.`,
    {
      id: z.string().describe(`The ${singular}'s id.`),
      type: z
        .enum(["checkpoint", "major", "all"])
        .optional()
        .describe("Which kind to list. Defaults to all."),
      limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
      offset: z.number().int().min(0).optional().describe("Default 0."),
    },
    async ({ id, type, limit, offset }) =>
      guard(async () =>
        jsonResult(
          await client.get(`${basePath}/${id}/versions`, { type, limit, offset }),
        ),
      ),
  );

  server.tool(
    `read_${singular}_version`,
    `Read one historical version of a ${singular} by its CHECKPOINT NUMBER (an ` +
      `integer like 3, from the \`version\` field in list_${singular}_versions) — ` +
      `not by its versionId. Use it to diff two versions before rolling back.`,
    {
      id: z.string().describe(`The ${singular}'s id.`),
      version: z
        .number()
        .int()
        .describe("The integer checkpoint number, e.g. 3."),
    },
    async ({ id, version }) =>
      guard(async () =>
        jsonResult(await client.get(`${basePath}/${id}/versions/${version}`)),
      ),
  );

  server.tool(
    `restore_${singular}_version`,
    `Roll a ${singular}'s DRAFT back to an earlier version. Takes the versionId ` +
      `(a UUID from list_${singular}_versions), NOT the checkpoint number. The ` +
      `current draft is snapshotted first, so this is itself undoable. It ` +
      `changes only the draft — what is live stays live until a human approves a ` +
      `new publish.`,
    {
      id: z.string().describe(`The ${singular}'s id.`),
      versionId: z.string().describe("The version row's UUID."),
      expectedVersion: z
        .number()
        .int()
        .describe("The draft version you last read — 409 if stale."),
    },
    async ({ id, versionId, expectedVersion }) =>
      guard(async () =>
        jsonResult(
          await client.post(`${basePath}/${id}/versions/${versionId}/restore`, {
            expectedVersion,
          }),
        ),
      ),
  );

  server.tool(
    `delete_${singular}_version`,
    `Permanently remove one entry from a ${singular}'s version history. The ` +
      `working draft and the currently published version are protected and ` +
      `cannot be targeted this way. Recoverable with ` +
      `restore_deleted_${singular}_version until it is purged for good.`,
    {
      id: z.string().describe(`The ${singular}'s id.`),
      versionId: z.string().describe("The version row's UUID (not the checkpoint number)."),
      confirm: CONFIRM,
    },
    async ({ id, versionId }) =>
      guard(async () => {
        await client.del(`${basePath}/${id}/versions/${versionId}`);
        return jsonResult({ deleted: true, id, versionId });
      }),
  );

  server.tool(
    `list_deleted_${singular}_versions`,
    `List a ${singular}'s deleted version rows — restore candidates for ` +
      `restore_deleted_${singular}_version. Deleted version numbers stay ` +
      `reserved (not reused), so gaps in the numbering are expected, not corruption.`,
    { id: z.string().describe(`The ${singular}'s id.`) },
    async ({ id }) =>
      guard(async () => jsonResult(await client.get(`${basePath}/${id}/versions/deleted`))),
  );

  server.tool(
    `restore_deleted_${singular}_version`,
    `Undo delete_${singular}_version — bring a removed version row back into ` +
      `history. This does NOT change the current draft (unlike ` +
      `restore_${singular}_version); it only makes the row visible/restorable ` +
      `again. Takes no version check.`,
    {
      id: z.string().describe(`The ${singular}'s id.`),
      versionId: z
        .string()
        .describe(`The version row's UUID, from list_deleted_${singular}_versions.`),
    },
    async ({ id, versionId }) =>
      guard(async () =>
        jsonResult(
          await client.post(`${basePath}/${id}/versions/${versionId}/restore-deleted`),
        ),
      ),
  );

  server.tool(
    `read_${singular}_published`,
    `Read the LIVE published version of a ${singular} — what the runtime ` +
      `actually uses, as opposed to the draft that read_${singular} returns. ` +
      `Diff the two to see what a pending publish would change.`,
    { id: z.string().describe(`The ${singular}'s id.`) },
    async ({ id }) =>
      guard(async () =>
        jsonResult(
          await client.get(
            publishedPath === "entity"
              ? `${basePath}/${id}/published`
              : `${basePath}/${id}/versions/published`,
          ),
        ),
      ),
  );
}
