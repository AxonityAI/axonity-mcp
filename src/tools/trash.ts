/**
 * The Trash — one list of everything deleted, of every kind (Levenscyclus,
 * DECISIONS.md 3).
 *
 * `delete_<entity>` puts an item in the Trash; `restore_<entity>` takes it out.
 * These two tools are how an agent SEES what is in there. Deleting
 * permanently (`DELETE /api/v1/trash/{kind}/{item_id}`) is deliberately not
 * here: it is irreversible and `require_admin` on the backend, and the update
 * of the connector's surface (MCP-UPDATE.md) says not to offer it. The rule
 * that records it is in `test/denyList.ts`.
 *
 * What each sentence says is what the backend answers, with its source in the
 * team file (R3 stap j): the shapes are `TrashItem` and `TrashSummaryResponse`
 * in `backend/src/schemas/trash.py`, the routes `backend/src/routes/trash.py`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

export function registerTrashTools(server: McpServer, client: AxonityClient): void {
  server.tool(
    "list_trash",
    "List what is in the Trash: everything that was deleted, of every kind, " +
      "newest deletion first. THE RESPONSE IS ONE PAGE, NOT THE WHOLE TRASH: " +
      "{ items, nextCursor, pageSize, hasMore } — while hasMore is true you have " +
      "not seen every item; pass nextCursor back as `cursor`. Each item is " +
      "{ kind, id, name, description, deletedAt, deletedBy, restorePath, " +
      "carriedBy }: `kind` is the entity's name (a skill is `skill`), so " +
      "`restore_<kind>` with the `id` brings it back (`restorePath` is that " +
      "route); `carriedBy` lists the agents and workflows that used the item " +
      "when it was deleted, agents first, each with whether it still exists — " +
      "empty when nothing did, null when nothing was recorded. Pass `kind` to " +
      "narrow it to one kind; a kind the Trash does not hold is refused. " +
      "Deleting permanently is an administrator's act in Axonity and there is " +
      "no tool for it; `trash_summary` says whether the Trash empties itself.",
    {
      kind: z
        .string()
        .optional()
        .describe("Only this kind, e.g. `skill`. Leave it out for every kind."),
      limit: z
        .number()
        .int()
        .optional()
        .describe("Page size. The platform clamps it to its own maximum."),
      cursor: z
        .string()
        .optional()
        .describe(
          "The previous response's nextCursor. Omit for the first page. Do not " +
            "construct one.",
        ),
    },
    async ({ kind, limit, cursor }) =>
      guard(async () =>
        jsonResult(await client.get("/api/v1/trash", { kind, limit, cursor })),
      ),
  );

  server.tool(
    "trash_summary",
    "How full the Trash is: { kinds, total, retentionDays, canDeletePermanently }. " +
      "`kinds` has a count per kind this reader can have in the Trash (with the " +
      "name the Trash page gives the kind), `total` is all of them. " +
      "`retentionDays` is the installation's \"Empty the trash after\": the days " +
      "after which an item in the Trash is deleted permanently, null is Never. " +
      "`canDeletePermanently` is whether this caller may delete " +
      "permanently (admin or above); no tool here does it.",
    {},
    async () => guard(async () => jsonResult(await client.get("/api/v1/trash/summary"))),
  );
}
