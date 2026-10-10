/**
 * Warehouses, and the numbers read off the tables they fill (axonity-mcp#78,
 * the connector half of axonity-flow#1849; reshaped by the semantic model,
 * axonity-mcp#81 / axonity-flow#1881).
 *
 * The plain entity verbs — list/read/create/update/delete/restore for a data
 * source, a table relationship and a dashboard — come from `registerEntityTools`
 * (see `ENTITIES` in index.ts). What is here is everything that does not fit
 * that shape: asking a warehouse something, reading the numbers a dashboard
 * shows, and duplicating a dashboard.
 *
 * **There are no sync tools any more.** A sync was a separate object beside
 * the table it filled; the semantic model made it the table's own
 * `provenance` (source, query, grain, key, mode, schedule), so a changed query
 * goes through the same approval as a changed column. Filling a table is now
 * `create_data_table` / `update_data_table` with `provenance`, and running it
 * early is `refresh_data_table` (tools/dataTables.ts). A measure is no longer
 * a field on a table either: it is its own versioned entity (`create_measure`
 * and the rest of the generic family).
 *
 * **Who may write.** These routes were administrator-only when they arrived,
 * and a service token always resolves as a member, so every write answered
 * 403. The platform lifted that (axonity-flow#1855): a data source is created
 * like any other object now. `ForbiddenError` still says "administrator only"
 * in words when some other route answers that way.
 *
 * **Nothing here holds a credential.** A data source points at a secret by
 * `secretId`; the key itself is put in the vault by a human (secret writes are
 * deny-listed), and the source never carries it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

const SOURCES = "/api/v1/data-sources";
const MEASURES = "/api/v1/measures";

const SOURCE_ID = z.string().describe("The data source's id.");

export function registerDataSourceTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "list_data_source_drivers",
    "Which warehouses can be connected, and what each one needs. Read-only. " +
      "\n\nREAD THIS BEFORE create_data_source. Each driver lists its " +
      "`configFields` — name, label, description, required — and those names " +
      "are exactly the keys `config` takes. Do not assume BigQuery's fields: " +
      "the list is the platform's own, so a warehouse it adds works without " +
      "this connector changing. " +
      "\n\n`capabilities.pricesBeforeRunning` says whether a byte limit " +
      "(`policy.maxBytesBilled`) can actually stop a query on that warehouse; " +
      "where it is false, use `policy.maxSeconds` instead. `credentialKinds` " +
      "says which kind of secret the source's `secretId` must point at.",
    {},
    async () => guard(async () => jsonResult(await client.get(`${SOURCES}/drivers`))),
  );

  server.tool(
    "test_data_source",
    "Ask the warehouse the cheapest question there is, and report what it " +
      "said. Use it right after create_data_source, and whenever a table's " +
      "fill or a query fails for a reason that sounds like the connection. " +
      "\n\nA FAILURE IS AN ANSWER, NOT AN ERROR: the response is " +
      "`{ ok, message, checkedAt }`, and `ok: false` with a message is the " +
      "warehouse telling you what is wrong (missing credential, wrong project, " +
      "no access). Read `message` — the call itself succeeded.",
    { id: SOURCE_ID },
    async ({ id }) =>
      guard(async () => jsonResult(await client.post(`${SOURCES}/${id}/test`))),
  );

  server.tool(
    "read_data_source_schema",
    "Which tables and columns the warehouse holds. Read-only, and free: it " +
      "reads the warehouse's own catalogue, not the data. " +
      "\n\nEach table's `name` is `container.table` — what you write in a " +
      "query. `containerWord` is what this warehouse calls the container " +
      "(\"dataset\" on BigQuery, \"schema\" on PostgreSQL). Column types are " +
      "the warehouse's own names, passed through. Read this before writing a " +
      "query or a table's provenance, rather than guessing table names. " +
      "On a source restricted to `policy.allowedDatasets` it reads those " +
      "datasets one by one, so it answers even when the key may not list " +
      "the whole project.",
    { id: SOURCE_ID },
    async ({ id }) =>
      guard(async () => jsonResult(await client.get(`${SOURCES}/${id}/schema`))),
  );

  server.tool(
    "query_data_source",
    "Run a READ-ONLY SQL query against the warehouse and get the rows back. " +
      "For looking — checking what a warehouse table holds, trying the " +
      "query a table's provenance will run. To fill a table regularly, give " +
      "it a `provenance` (create_data_table / update_data_table). " +
      "\n\nTHE ROWS ARE CAPPED. `truncated: true` means rows were left out: " +
      "`rowCount` is what came back, `totalRows` is what matched. Never report " +
      "a count or a total off a truncated answer — aggregate in the SQL " +
      "instead. `bytesScanned` is what it cost. " +
      "\n\nTWO DIFFERENT FAILURES: a 422 is Axonity refusing the QUERY (it " +
      "writes, reads a dataset the source forbids, names a personal column or " +
      "uses `*` where personal columns are configured, would scan more than " +
      "the source allows) — the reason says what to change. A 502 is the " +
      "WAREHOUSE refusing or not answering — the query may be fine; do not " +
      "rewrite it, check test_data_source.",
    {
      id: SOURCE_ID,
      sql: z
        .string()
        .describe(
          "The query, in the warehouse's own dialect. Read-only: anything " +
            "that writes is refused. Name tables as read_data_source_schema " +
            "spells them.",
        ),
      maxRows: z
        .number()
        .int()
        .optional()
        .describe(
          "How many rows you want back. Clamped by the platform — a bigger " +
            "answer belongs in a table with provenance, not in a response.",
        ),
    },
    async ({ id, sql, maxRows }) =>
      guard(async () =>
        jsonResult(
          await client.post(`${SOURCES}/${id}/query`, {
            sql,
            ...(maxRows !== undefined ? { maxRows } : {}),
          }),
        ),
      ),
  );
}

/** The period names a measure question accepts. Mirrors `PeriodPreset`. */
const PERIODS =
  "today, this_week, last_week, this_month, last_month, this_quarter, " +
  "year_to_date, last_30_days, last_12_months, all_time";

export function registerMeasureTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "read_measure_design",
    "What a number over one dynamic table may ask for: its columns and its " +
      "time axis. Read-only. " +
      "\n\nTHE MEASURES ARE NOT HERE. A measure belongs to the model, not " +
      "to one table: list_measures({ tableId }) answers which measures read " +
      "this table, and create_measure defines one. Read this for the column " +
      "names a measure's `definition`, `splitBy` or `filters` may use.",
    {
      tableId: z.string().describe("The dynamic table's id."),
      useDraft: z
        .boolean()
        .optional()
        .describe(
          "Read the table's working design instead of its published one — to " +
            "preview a change before it is published. Defaults to false.",
        ),
    },
    async ({ tableId, useDraft }) =>
      guard(async () =>
        jsonResult(await client.get(`${MEASURES}/tables/${tableId}`, { useDraft })),
      ),
  );

  server.tool(
    "query_measures",
    "Compute measures: up to 40 questions in one call, each answered on its " +
      "own. Read-only. This is where a dashboard's numbers come from. " +
      "\n\nEach question is " +
      "`{ key, measure, tableId?, period?, start?, end?, compare?, grain?, " +
      "splitBy?, filters?, limit?, useDraft? }`. `key` is your own label and " +
      "comes back on the answer. `measure` is the measure's NAME — its " +
      "handle, unique in the workspace (list_measures); `tableId` is " +
      "optional and no longer what finds it. `period` is one of: " +
      PERIODS +
      " (default this_month) — or set it to null and send `start`/`end` " +
      "(YYYY-MM-DD) for a custom range. `compare` is none, previous_period or " +
      "previous_year. `grain` (none, auto, day, week, month, quarter, year) " +
      "draws a series. `splitBy` names a column to group by; `limit` (1-50) " +
      "keeps the largest groups. " +
      "\n\nONE BAD QUESTION DOES NOT FAIL THE CALL: every answer carries " +
      "`ok`, and `ok: false` comes with an `error` of its own. Check each one. " +
      "\n\n`freshAsOf` says how old the newest row behind the number is; " +
      "`certified: false` means it was computed from a draft; `tables` names " +
      "every table the number came from. Say so when you " +
      "report a number that is either stale or uncertified.",
    {
      queries: z
        .array(z.record(z.unknown()))
        .describe("The questions, 1 to 40, in the shape described above."),
    },
    async ({ queries }) =>
      guard(async () => jsonResult(await client.post(`${MEASURES}/query`, { queries }))),
  );

  server.tool(
    "list_measure_live_versions",
    "Which major versions of one measure are PUBLISHED right now, as a list " +
      "of numbers. Read-only. An empty list means it has never been " +
      "published, so every number it gives is a draft preview " +
      "(`certified: false` on query_measures) — request_publish_measure is " +
      "what changes that.",
    { id: z.string().describe("The measure's id.") },
    async ({ id }) =>
      guard(async () => jsonResult(await client.get(`${MEASURES}/${id}/live-versions`))),
  );

  server.tool(
    "list_measure_rows",
    "The first rows of a published dynamic table in an order — what a list " +
      "tile shows (\"the ten biggest orders this month\"). Read-only. " +
      "\n\n`matched` in the answer is how many rows matched before the limit, " +
      "so you can say \"10 of 312\" rather than imply there are ten.",
    {
      tableId: z.string().describe("The dynamic table's id."),
      sortBy: z.string().optional().describe("The column to order by."),
      descending: z
        .boolean()
        .optional()
        .describe("Largest first. Defaults to true."),
      limit: z.number().int().optional().describe("How many rows, 1-50. Defaults to 10."),
      period: z
        .string()
        .optional()
        .describe(`Only rows in this period, on the table's time axis: ${PERIODS}.`),
      filters: z
        .array(z.record(z.unknown()))
        .optional()
        .describe("Extra conditions, in the same shape a measure's filters take."),
    },
    async (body) => guard(async () => jsonResult(await client.post(`${MEASURES}/rows`, body))),
  );
}

export function registerDashboardTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "duplicate_dashboard",
    "Make a copy of a dashboard, owned by you. The copy starts as a separate " +
      "dashboard: changing it does not touch the original.",
    {
      id: z.string().describe("The dashboard to copy."),
      name: z
        .string()
        .optional()
        .describe("The copy's name. Omit for the platform's default."),
    },
    async ({ id, name }) =>
      guard(async () =>
        jsonResult(
          await client.post(`/api/v1/dashboards/${id}/duplicate`, name ? { name } : {}),
        ),
      ),
  );
}
