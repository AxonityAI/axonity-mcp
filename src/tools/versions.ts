/**
 * Version history, rollback, and version-level delete/restore.
 *
 * Two different identifiers appear in these routes and confusing them silently
 * 404s:
 *   - `version`    — an INTEGER checkpoint number (1, 2, 3 …), used to read one.
 *   - `versionId`  — the UUID of the version row, used to restore/delete it.
 *
 * A MAJOR version is a named release inside that history, and all four verbs
 * exist for it: `create_*_major_version` cuts a new one ("Save As" on the
 * current draft), `ensure_*_major_version` makes sure an unnamed working one
 * exists (idempotent), `name_*_major_version` renames one, and the list/read/
 * restore verbs above reach them like any other version. Creating one used to
 * be the missing verb — the connector could list, read, restore, delete and
 * rename a named major but not cut one, which `ENTITY-LIFECYCLE-CONTRACT.md`
 * treats as a first-class act.
 *
 * There are also two unrelated things both called "restore" here:
 *   - `restore_<entity>_version`         — roll the DRAFT back to an old,
 *     still-live version. Takes `expectedVersion` in the body.
 *   - `restore_deleted_<entity>_version` — undo a DELETED version row coming
 *     back into history. No body — a restore must never lose to a stale-version
 *     guard.
 *
 * The published snapshot also lives in two places depending on the entity
 * family: `/{id}/published` for workflow/agent/tool/method, `/{id}/versions/published`
 * for the memory entities (including output_schema and prompt_snippet, which
 * gained full versioning alongside them). `publishedPath` selects the right one.
 *
 * Only entities that actually expose `/versions*` get these verbs.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { defineTool, formerName } from "./aliases.js";
import { guard, jsonResult } from "./result.js";
import { pathId, seg } from "../ids.js";

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
   * `"versions"` → `/{id}/versions/published` (skill, policy, reference_doc)
   */
  publishedPath: "entity" | "versions";
  /**
   * Replaces the generic closing sentence of `restore_<entity>_version` ("It
   * changes only the draft …") for a kind whose restore also moves something
   * live.
   */
  restoreNote?: string;
  /**
   * The word this kind went by before it was renamed. Each version tool is
   * also registered under the old name for one release (`tools/aliases.ts`).
   */
  formerSingular?: string;
}

export function registerVersionTools(
  server: McpServer,
  client: AxonityClient,
  { singular, basePath, publishedPath, restoreNote, formerSingular }: VersionedEntity,
): void {
  const tool = (
    name: string,
    description: string,
    shape: z.ZodRawShape,
    handler: (args: never) => Promise<unknown>,
  ): void =>
    defineTool(
      server,
      name,
      description,
      shape,
      handler,
      formerSingular ? { name: formerName(name, singular, formerSingular) } : undefined,
    );

  tool(
    `list_${singular}_versions`,
    `List a ${singular}'s version history — checkpoints (every save) and major ` +
      `versions (named releases). Use this to find the versionId you need for ` +
      `restore_${singular}_version.`,
    {
      id: pathId.describe(`The ${singular}'s id.`),
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
          await client.get(`${basePath}/${seg(id)}/versions`, { type, limit, offset }),
        ),
      ),
  );

  tool(
    `read_${singular}_version`,
    `Read one historical version of a ${singular} by its CHECKPOINT NUMBER (an ` +
      `integer like 3, from the \`version\` field in list_${singular}_versions) — ` +
      `not by its versionId. Use it to diff two versions before rolling back.`,
    {
      id: pathId.describe(`The ${singular}'s id.`),
      version: z
        .number()
        .int()
        .describe("The integer checkpoint number, e.g. 3."),
    },
    async ({ id, version }) =>
      guard(async () =>
        jsonResult(await client.get(`${basePath}/${seg(id)}/versions/${seg(version)}`)),
      ),
  );

  tool(
    `restore_${singular}_version`,
    `Roll a ${singular}'s DRAFT back to an earlier version. Takes the versionId ` +
      `(a UUID from list_${singular}_versions), NOT the checkpoint number. The ` +
      `current draft is snapshotted first, so this is itself undoable. ` +
      (restoreNote ??
        `It changes only the draft — what is live stays live until a human ` +
          `approves a new publish.`),
    {
      id: pathId.describe(`The ${singular}'s id.`),
      versionId: pathId.describe("The version row's UUID."),
      expectedVersion: z
        .number()
        .int()
        .describe("The draft version you last read — 409 if stale."),
    },
    async ({ id, versionId, expectedVersion }) =>
      guard(async () =>
        jsonResult(
          await client.post(`${basePath}/${seg(id)}/versions/${seg(versionId)}/restore`, {
            expectedVersion,
          }),
        ),
      ),
  );

  tool(
    `delete_${singular}_version`,
    `Permanently remove one entry from a ${singular}'s version history. The ` +
      `working draft and the currently published version are protected and ` +
      `cannot be targeted this way. Recoverable with ` +
      `restore_deleted_${singular}_version until it is purged for good.`,
    {
      id: pathId.describe(`The ${singular}'s id.`),
      versionId: pathId.describe("The version row's UUID (not the checkpoint number)."),
      confirm: CONFIRM,
    },
    async ({ id, versionId }) =>
      guard(async () => {
        await client.del(`${basePath}/${seg(id)}/versions/${seg(versionId)}`);
        return jsonResult({ deleted: true, id, versionId });
      }),
  );

  tool(
    `list_deleted_${singular}_versions`,
    `List a ${singular}'s deleted version rows — restore candidates for ` +
      `restore_deleted_${singular}_version. Deleted version numbers stay ` +
      `reserved (not reused), so gaps in the numbering are expected, not corruption.`,
    { id: pathId.describe(`The ${singular}'s id.`) },
    async ({ id }) =>
      guard(async () => jsonResult(await client.get(`${basePath}/${seg(id)}/versions/deleted`))),
  );

  tool(
    `restore_deleted_${singular}_version`,
    `Undo delete_${singular}_version — bring a removed version row back into ` +
      `history. This does NOT change the current draft (unlike ` +
      `restore_${singular}_version); it only makes the row visible/restorable ` +
      `again. Takes no version check.`,
    {
      id: pathId.describe(`The ${singular}'s id.`),
      versionId: pathId
        .describe(`The version row's UUID, from list_deleted_${singular}_versions.`),
    },
    async ({ id, versionId }) =>
      guard(async () =>
        jsonResult(
          await client.post(`${basePath}/${seg(id)}/versions/${seg(versionId)}/restore-deleted`),
        ),
      ),
  );

  tool(
    `create_${singular}_major_version`,
    `Cut a new NAMED major version of a ${singular} — "Save As" for the ` +
      `current draft. The draft's state becomes a labelled release in history ` +
      `and work continues from there. Use it to mark a milestone you may want ` +
      `to come back to by name rather than by hunting through checkpoints. ` +
      `\n\nThis does NOT publish: what is live stays live until a human ` +
      `approves a request_publish_${singular}. Renaming an existing major ` +
      `version is name_${singular}_major_version; this creates one.`,
    {
      id: pathId.describe(`The ${singular}'s id.`),
      name: z
        .string()
        .min(1)
        .max(255)
        .describe('What to call this release, e.g. "Pre-migration baseline".'),
      description: z
        .string()
        .optional()
        .describe("A longer note on what this version represents."),
    },
    async ({ id, name, description }) =>
      guard(async () =>
        jsonResult(
          await client.post(`${basePath}/${seg(id)}/versions`, {
            name,
            ...(description ? { description } : {}),
          }),
        ),
      ),
  );

  tool(
    `ensure_${singular}_major_version`,
    `Make sure a ${singular} has a working draft major version, creating an ` +
      `unnamed one ("Version N") if it has none. IDEMPOTENT — calling it when ` +
      `one already exists changes nothing and returns the same answer, so it is ` +
      `safe to call before a run of edits. Returns the draft's major version ` +
      `number and name. Use create_${singular}_major_version when you want a ` +
      `NAMED release instead.`,
    { id: pathId.describe(`The ${singular}'s id.`) },
    async ({ id }) =>
      guard(async () =>
        jsonResult(await client.post(`${basePath}/${seg(id)}/versions/ensure`)),
      ),
  );

  tool(
    `name_${singular}_major_version`,
    `Give a ${singular}'s major version a name — label a release so it is easy to ` +
      `find in history. Targets a MAJOR version by its integer number (from ` +
      `list_${singular}_versions), not a checkpoint or a versionId. This only ` +
      `renames; it does not create, publish, or roll anything back.`,
    {
      id: pathId.describe(`The ${singular}'s id.`),
      majorVersion: z
        .number()
        .int()
        .describe("The major version's integer number, e.g. 2."),
      name: z.string().min(1).max(255).describe("The new name for that major version."),
    },
    async ({ id, majorVersion, name }) =>
      guard(async () =>
        jsonResult(
          await client.patch(
            `${basePath}/${seg(id)}/versions/major/${seg(majorVersion)}`,
            { name },
          ),
        ),
      ),
  );

  tool(
    `read_${singular}_published`,
    `Read the LIVE published version of a ${singular} — what the runtime ` +
      `actually uses, as opposed to the draft that read_${singular} returns. ` +
      `Diff the two to see what a pending publish would change.`,
    { id: pathId.describe(`The ${singular}'s id.`) },
    async ({ id }) =>
      guard(async () =>
        jsonResult(
          await client.get(
            publishedPath === "entity"
              ? `${basePath}/${seg(id)}/published`
              : `${basePath}/${seg(id)}/versions/published`,
          ),
        ),
      ),
  );
}
