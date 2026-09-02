/**
 * The parts of a table that are NOT the generic entity family (axonity-mcp#63).
 *
 * A table is an authored, typed, versioned library element that holds ROWS
 * (axonity-flow#1217), and its routes were deliberately written in the same
 * order and spelling as an output schema's — so list/read/create/update/delete/
 * restore/discard-draft/request-publish and the whole eleven-route version
 * family come from `registerEntityTools` and `registerVersionTools` with no code
 * here. Two things do not fit that shape, and both are here:
 *
 * **1. Row writes.** `PUT /data-tables/{id}` replaces the WHOLE `rows` array.
 * `update_data_table` takes a blind `fields` bag by design — the connector stays
 * thin and the backend validates — which means an agent that passes `rows`
 * meaning "add this one" silently destroys the table's content. That is a
 * destructive default reachable by accident, so the three row routes
 * axonity-flow#1235 added get explicit tools that address ONE row and cannot
 * touch the others. `update_data_table` carries the warning as well
 * (`updateWarning` on its `EntityDef`); the tools are what make the warning
 * actionable rather than merely a caution.
 *
 * The row tools take no `expectedVersion`. That is the backend's contract, not
 * an omission: a row write is a single addressed operation the service applies
 * under its own lock, and it RETURNS the table's new `version` for a later
 * `update_data_table` to base itself on. Adding a version argument here would
 * invent a check the route does not make.
 *
 * **2. Which tools a table yields.** A published table mints its own CRUD tools,
 * so granting an agent access to a table is ordinary tool granting rather than a
 * second permission vocabulary. Their names follow a convention, which used to
 * mean the only way to find them was to fetch the whole tool library and match
 * on it. `list_data_table_tools` asks the table instead — and, crucially,
 * reports the operations that are OFFERED but not yet LIVE, which is the answer
 * to the first thing an author gets wrong: a table's tools follow its PUBLISHED
 * version, so ticking "may add rows" and not publishing has granted nothing.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

const BASE = "/api/v1/data-tables";

/**
 * How the two addressed row writes name their row.
 *
 * Deliberately a MATCH rather than a row index: a table's rows have no stable
 * position, so "row 4" is a different row after anyone inserts one. The backend
 * refuses a match that hits zero rows (404) or more than one (with the count)
 * rather than guessing, which is what makes this safe to hand an agent.
 */
const MATCH = {
  matchColumn: z
    .string()
    .describe(
      "The column that identifies the row. It must match EXACTLY ONE row: " +
        "zero is a 404 and more than one is refused with the count, so a write " +
        "never lands on a row you did not mean. Pick a column whose values are " +
        "unique — read the table first if you are not sure.",
    ),
  matchValue: z
    .string()
    .describe(
      "The value that column must hold. Compared the way a decision compares " +
        'it over the same table, so "5000" finds the number 5000 and ' +
        '"benelux" finds the cell holding "Benelux".',
    ),
};

export function registerDataTableTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "add_data_table_row",
    "Append ONE row to a table, without resending the rows already there. " +
      "\n\nUSE THIS RATHER THAN update_data_table TO ADD A ROW. `rows` on " +
      "update_data_table is a whole-collection field: sending one row there " +
      "replaces the table's entire content. This appends, and cannot touch the " +
      "other rows. " +
      "\n\nA key that is not a column is REFUSED and named — never dropped, " +
      "because a silently discarded value is a lost value. Read the table first " +
      "for its column names and what each one means. " +
      "\n\nThe response carries the table's new `version`: base a later " +
      "update_data_table on that number rather than re-reading. " +
      "\n\nThis writes the DRAFT. A run reads the published table, so the row " +
      "is not live until the table is published (request_publish_data_table).",
    {
      id: z.string().describe("The table's id."),
      values: z
        .record(z.unknown())
        .describe(
          "The row's values, keyed by COLUMN NAME (the column's `name`, not " +
            "its label). Required columns must be present.",
        ),
    },
    async ({ id, values }) =>
      guard(async () => jsonResult(await client.post(`${BASE}/${id}/rows`, { values }))),
  );

  server.tool(
    "update_data_table_row",
    "Change named columns on the ONE row a match addresses. Columns you do not " +
      "name keep their values, so this is a partial edit of a row rather than a " +
      "replacement of it. " +
      "\n\nUSE THIS RATHER THAN update_data_table TO EDIT A ROW — `rows` there " +
      "replaces the whole content. " +
      "\n\nAn empty `changes` is refused: an update that changes nothing is a " +
      "mistake dressed as a success. The response reports `changed` — which " +
      "columns actually moved — plus the table's new `version`. " +
      "\n\nThis writes the DRAFT; publish before a run can see it.",
    {
      id: z.string().describe("The table's id."),
      ...MATCH,
      changes: z
        .record(z.unknown())
        .describe(
          "The columns to change and what to change them to, keyed by column " +
            "name. Columns not named here keep their values. Must not be empty.",
        ),
    },
    async ({ id, matchColumn, matchValue, changes }) =>
      guard(async () =>
        jsonResult(
          await client.patch(
            `${BASE}/${id}/rows`,
            { changes },
            { match_column: matchColumn, match_value: matchValue },
          ),
        ),
      ),
  );

  server.tool(
    "delete_data_table_row",
    "Remove the ONE row a match addresses. " +
      "\n\nTHE REMOVED ROW RIDES BACK IN THE RESPONSE, on purpose: after this " +
      "call it is the only copy left, so an operator who deleted the wrong one " +
      "can put it back with add_data_table_row. Keep it. " +
      "\n\nUnlike delete_data_table this is NOT soft-deleted and there is no " +
      "restore_*: the row is gone from the draft. The published table still has " +
      "it until the table is published again, which is the only undo. " +
      "\n\nThe response also carries the table's new `version` and `total`.",
    {
      id: z.string().describe("The table's id."),
      ...MATCH,
      confirm: z
        .literal(true)
        .describe(
          "Must be true. Acknowledges you understand this removes a row from " +
            "the draft and that only the response carries it afterwards.",
        ),
    },
    async ({ id, matchColumn, matchValue }) =>
      guard(async () =>
        jsonResult(
          await client.del(`${BASE}/${id}/rows`, {
            match_column: matchColumn,
            match_value: matchValue,
          }),
        ),
      ),
  );

  server.tool(
    "list_data_table_tools",
    "Which tools this table yields, and which of them a RUN can actually " +
      "reach. Read-only. " +
      "\n\nA published table mints its own CRUD tools, so giving an agent " +
      "access to a table is ordinary tool granting — put a `toolId` from here " +
      "in the agent's `toolIds`. Their names follow a convention, so the " +
      "alternative is fetching the whole tool library and matching on it. " +
      "\n\nREAD THE THREE FLAGS SEPARATELY — collapsing them is how \"I ticked " +
      "'may add rows' and there is no tool\" becomes a mystery: " +
      "`offered` is what the current DRAFT would yield (what the author " +
      "decided), `toolId` is whether a tool row exists today (what a grant " +
      "names), and `isLive` is whether that row is PUBLISHED (what a run can " +
      "reach). A table's tools follow its published version, so a grant that " +
      "has been saved and not published has granted nothing yet. " +
      "\n\n`publishedMajorVersion: null` means the table has never been " +
      "published and nothing here is live.",
    { id: z.string().describe("The table's id.") },
    async ({ id }) =>
      guard(async () => jsonResult(await client.get(`${BASE}/${id}/tools`))),
  );
}
