/**
 * Registers the read/draft/update/lifecycle MCP tools for one Axonity entity type.
 *
 * Every entity gets the same verbs the internal Builder team has, minus direct
 * publish:
 *   list_<plural>     — GET    <basePath>
 *   read_<entity>     — GET    <basePath>/{id}
 *   create_<entity>   — POST   <basePath>              (a new draft)
 *   update_<entity>   — PUT|PATCH <basePath>/{id}       (read-then-write)
 *   delete_<entity>   — DELETE <basePath>/{id}          (soft-delete, recoverable)
 *   restore_<entity>  — POST   <basePath>/{id}/restore  (undo a delete)
 *   list_deleted_<plural> — restore candidates
 *   discard_<entity>_draft — reset the draft to the last published state
 *
 * The connector stays thin: entity fields pass through as JSON and the backend
 * validates them (a structured error names the offending field — see errors.ts).
 * Updates carry `expectedVersion` in the body so a stale write 409s rather than
 * clobbering. Deletes carry it as a QUERY param instead, and the key's spelling
 * is not uniform across entities (`deleteVersionParam` on `EntityDef` says which).
 *
 * `request_publish_*` never publishes — it creates a pending approval a human
 * decides in Axonity.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

/** A required literal — an agent cannot satisfy it by filling in a default. */
const CONFIRM = z
  .literal(true)
  .describe("Must be true. Acknowledges you understand this is destructive.");

export interface EntityDef {
  /** Singular tool noun, e.g. "workflow". */
  singular: string;
  /** REST collection path, e.g. "/api/v1/workflows". */
  basePath: string;
  /** HTTP verb the update route uses (workflows PATCH; agents/tools PUT). */
  updateMethod: "PUT" | "PATCH";
  /** One-line human description of the entity, for the tool docs. */
  label: string;
  /**
   * Optional pre-write check on the caller's fields, applied to `create_*` and
   * `update_*`. Throws to reject. Used to run the connector credential guard on
   * plain tool writes, which would otherwise bypass it.
   */
  guardFields?: (fields: Record<string, unknown>) => void;
  /**
   * Whether `request_publish_<entity>` is generated. Default true, and true for
   * every current entity: all ten (flow included) are valid `entityType`s for a
   * publish approval on the backend (`ApprovalEntityType`). Set false only for a
   * future entity that genuinely cannot be publish-approved.
   */
  publishable?: boolean;
  /**
   * The plural noun for `list_<plural>` / `list_deleted_<plural>`. Defaults to
   * `${singular}s`, which is wrong for at least "policy" — set it explicitly
   * rather than shipping `list_policys`.
   */
  plural?: string;
  /** Whether `create_<entity>` is generated. Default true. False for `persona`, whose create is agent-scoped (`create_agent_persona`). */
  creatable?: boolean;
  /**
   * Whether `read_<entity>` is generated. Default true, and true for every
   * current entity — `prompt_snippet` does have a single-read route
   * (`GET /api/v1/prompt-snippets/{id}`). Kept as an escape hatch for a future
   * entity with no single-read route.
   */
  readable?: boolean;
  /**
   * The query-string key DELETE expects for the optimistic lock. Its presence
   * is what turns on `delete_/restore_/list_deleted_/discard_*` — omit it for
   * an entity with no lifecycle routes. The two spellings are a real backend
   * inconsistency, not a typo: `expectedVersion` (workflow, agent, tool,
   * prompt_snippet, flow) vs `expected_version` (skill, policy, reference_doc,
   * output_schema, persona).
   */
  deleteVersionParam?: "expectedVersion" | "expected_version";
  /**
   * Whether `discard_<entity>_draft` is generated. Default true when the entity
   * is deletable, and true for every current entity — both `flow` and
   * `prompt_snippet` have a discard-draft route
   * (`POST .../{id}/discard-draft`). Escape hatch for a future entity lacking one.
   */
  hasDiscardDraft?: boolean;
  /**
   * How to list soft-deleted rows. `"collection"` (default) is `GET
   * <basePath>/deleted` and is what every current entity uses, `prompt_snippet`
   * included (`GET /api/v1/prompt-snippets/deleted`). `"query"` (`?deleted=true`
   * on the main list) is retained for a future entity that needs it.
   */
  deletedListPath?: "collection" | "query";
}

export function registerEntityTools(
  server: McpServer,
  client: AxonityClient,
  def: EntityDef,
): void {
  const { singular, basePath, updateMethod, label, guardFields } = def;
  const plural = def.plural ?? `${singular}s`;
  const publishable = def.publishable !== false;
  const creatable = def.creatable !== false;
  const readable = def.readable !== false;

  server.tool(
    `list_${plural}`,
    `List all ${label} in your Axonity tenant (id, name, status, version).`,
    {},
    async () => guard(async () => jsonResult(await client.get(basePath))),
  );

  if (readable) {
    server.tool(
      `read_${singular}`,
      `Read one ${singular} by id, including its current draft and version. ` +
        `Read before you update — you need the current version.`,
      { id: z.string().describe(`The ${singular}'s id.`) },
      async ({ id }) =>
        guard(async () => jsonResult(await client.get(`${basePath}/${id}`))),
    );
  }

  if (creatable) {
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
        guard(async () => {
          guardFields?.(fields);
          return jsonResult(await client.post(basePath, fields));
        }),
    );
  }

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
        guardFields?.(fields);
        const body = { expectedVersion, ...fields };
        const path = `${basePath}/${id}`;
        const data =
          updateMethod === "PUT"
            ? await client.put(path, body)
            : await client.patch(path, body);
        return jsonResult(data);
      }),
  );

  if (def.deleteVersionParam) {
    const deleteVersionParam = def.deleteVersionParam;
    const hasDiscardDraft = def.hasDiscardDraft !== false;

    server.tool(
      `delete_${singular}`,
      `Delete a ${singular}. Destructive, but RECOVERABLE — it is soft-deleted ` +
        `and can be brought back with restore_${singular} (it will not appear in ` +
        `list_${plural} until then). Read it first for its version. A 409 here ` +
        `may be a stale version (re-read and retry) or a reference conflict ` +
        `(something published still uses it — re-reading will not help; the ` +
        `error tells you which).`,
      {
        id: z.string().describe(`The ${singular}'s id.`),
        expectedVersion: z
          .number()
          .int()
          .describe("The version you last read — rejected with 409 if stale."),
        confirm: CONFIRM,
      },
      async ({ id, expectedVersion }) =>
        guard(async () => {
          await client.del(`${basePath}/${id}`, { [deleteVersionParam]: expectedVersion });
          return jsonResult({ deleted: true, id });
        }),
    );

    server.tool(
      `restore_${singular}`,
      `Undo delete_${singular} — bring a soft-deleted ${singular} back. Takes no ` +
        `version check (a restore must never lose to a stale-version guard). Can ` +
        `409 if a live ${singular} now holds a name/slot this one also claims.`,
      { id: z.string().describe(`The ${singular}'s id.`) },
      async ({ id }) =>
        guard(async () => jsonResult(await client.post(`${basePath}/${id}/restore`))),
    );

    server.tool(
      `list_deleted_${plural}`,
      `List soft-deleted ${label} — the restore candidates for restore_${singular}.`,
      {},
      async () =>
        guard(async () =>
          jsonResult(
            def.deletedListPath === "query"
              ? await client.get(basePath, { deleted: true })
              : await client.get(`${basePath}/deleted`),
          ),
        ),
    );

    if (hasDiscardDraft) {
      server.tool(
        `discard_${singular}_draft`,
        `Discard uncommitted draft edits on a ${singular}, resetting it to its ` +
          `last published state. Fails if it has never been published — there is ` +
          `no published state to fall back to.`,
        { id: z.string().describe(`The ${singular}'s id.`) },
        async ({ id }) =>
          guard(async () =>
            jsonResult(await client.post(`${basePath}/${id}/discard-draft`)),
          ),
      );
    }
  }

  if (!publishable) return;

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
