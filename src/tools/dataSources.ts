/**
 * Warehouses, the syncs that copy from them, and the numbers read off the
 * tables they fill (axonity-mcp#78, the connector half of axonity-flow#1849).
 *
 * The plain entity verbs — list/read/create/update/delete/restore for a data
 * source, a table relationship and a dashboard — come from `registerEntityTools`
 * (see `ENTITIES` in index.ts). What is here is everything that does not fit
 * that shape: asking a warehouse something, the syncs that belong to ONE source,
 * the measures a dashboard reads, and duplicating a dashboard.
 *
 * **Most writes here are administrator-only on the backend**, and a service
 * token always resolves as a member. So against today's platform those calls
 * answer 403, and `ForbiddenError` says why in words rather than as a generic
 * "not allowed" — the tool descriptions say it up front as well, so an agent
 * does not spend three calls discovering it. Whether that is the right line is
 * the platform's decision, not this connector's: the tools exist so that the
 * moment the backend lets a token through, they work.
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

/** The sentence every admin-only tool here carries, so it is said once. */
export const ADMIN_ONLY =
  "\n\nADMINISTRATOR ONLY. The backend lets only a workspace administrator do " +
  "this, and a service token always counts as a member — so a 403 \"Only " +
  "administrators can perform this action\" means exactly that, not a broken " +
  "call and not a missing scope. Do not retry: tell your human, who can do it " +
  "in Axonity.";

const SOURCE_ID = z.string().describe("The data source's id.");
const SYNC_ID = z.string().describe("The sync's id (from list_data_source_syncs).");

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
      "said. Use it right after create_data_source, and whenever a sync or " +
      "query fails for a reason that sounds like the connection. " +
      "\n\nA FAILURE IS AN ANSWER, NOT AN ERROR: the response is " +
      "`{ ok, message, checkedAt }`, and `ok: false` with a message is the " +
      "warehouse telling you what is wrong (missing credential, wrong project, " +
      "no access). Read `message` — the call itself succeeded." +
      ADMIN_ONLY,
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
      "query or a sync, rather than guessing table names.",
    { id: SOURCE_ID },
    async ({ id }) =>
      guard(async () => jsonResult(await client.get(`${SOURCES}/${id}/schema`))),
  );

  server.tool(
    "query_data_source",
    "Run a READ-ONLY SQL query against the warehouse and get the rows back. " +
      "For looking — checking what a table holds, trying the query a sync " +
      "will run. To fill a table regularly, use create_data_source_sync. " +
      "\n\nTHE ROWS ARE CAPPED. `truncated: true` means rows were left out: " +
      "`rowCount` is what came back, `totalRows` is what matched. Never report " +
      "a count or a total off a truncated answer — aggregate in the SQL " +
      "instead. `bytesScanned` is what it cost. " +
      "\n\nTWO DIFFERENT FAILURES: a 422 is Axonity refusing the QUERY (it " +
      "writes, reads a dataset the source forbids, names a personal column or " +
      "uses `*` where personal columns are configured, would scan more than " +
      "the source allows) — the reason says what to change. A 502 is the " +
      "WAREHOUSE refusing or not answering — the query may be fine; do not " +
      "rewrite it, check test_data_source." +
      ADMIN_ONLY,
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
            "answer belongs in a sync, not in a response.",
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

  server.tool(
    "list_data_source_syncs",
    "The syncs of ONE data source: the queries that keep tables filled from " +
      "that warehouse, on a schedule. Read-only. " +
      "\n\nEach sync says when it runs next (`nextFireAt`), when it last ran " +
      "(`lastRunAt`), how many rows the table held afterwards " +
      "(`lastRowCount`), and — when the last attempt wrote nothing — why " +
      "(`lastError`). A `lastError` here is the first thing to read when a " +
      "dashboard number looks stale.",
    { id: SOURCE_ID },
    async ({ id }) =>
      guard(async () => jsonResult(await client.get(`${SOURCES}/${id}/syncs`))),
  );

  server.tool(
    "create_data_source_sync",
    "Set up a query that fills a table from this warehouse on a schedule. " +
      "\n\nThe table must be a DYNAMIC table (create_data_table with " +
      "`isDynamic: true`). Its rows then come from here, not from authoring. " +
      "Try the SQL with query_data_source first: what one row of its result " +
      "means decides what the table can be asked afterwards. " +
      "\n\nThe response says when it will first run (`nextFireAt`). To run " +
      "it now, follow with run_data_source_sync." +
      ADMIN_ONLY,
    {
      id: SOURCE_ID,
      name: z.string().describe("What the sync is called."),
      description: z.string().optional().describe("What it fills, and why."),
      tableId: z
        .string()
        .describe("The dynamic table the result lands in (a data_table id)."),
      sql: z
        .string()
        .describe(
          "The query whose RESULT is copied into the table. Read-only, in the " +
            "warehouse's own dialect.",
        ),
      mode: z
        .enum(["append", "upsert"])
        .optional()
        .describe(
          "`upsert` (default) replaces rows whose key columns match and adds " +
            "the rest. `append` adds everything that came back, every run — " +
            "only right when each run returns NEW rows.",
        ),
      keyColumns: z
        .array(z.string())
        .optional()
        .describe(
          "Which columns identify a row, for `upsert`. Without them an upsert " +
            "has nothing to match on.",
        ),
      cronExpr: z
        .string()
        .describe('When it runs, as a five-field cron expression, e.g. "0 6 * * *".'),
      timezone: z
        .string()
        .optional()
        .describe('The time zone the cron expression is read in. Defaults to "UTC".'),
      enabled: z
        .boolean()
        .optional()
        .describe("Whether it runs on its schedule. Defaults to true."),
    },
    async ({ id, ...fields }) =>
      guard(async () => jsonResult(await client.post(`${SOURCES}/${id}/syncs`, fields))),
  );

  server.tool(
    "run_data_source_sync",
    "Bring a sync's next run forward to now. " +
      "\n\nTHIS DOES NOT WAIT FOR THE RESULT. The query can take tens of " +
      "seconds, so the platform accepts the request and its scheduler runs " +
      "it. The response is the sync with its new `nextFireAt`. To see how it " +
      "went, read list_data_source_syncs again after a moment: `lastRunAt`, " +
      "`lastRowCount` and `lastError` describe the run." +
      ADMIN_ONLY,
    { id: SOURCE_ID, syncId: SYNC_ID },
    async ({ id, syncId }) =>
      guard(async () =>
        jsonResult(await client.post(`${SOURCES}/${id}/syncs/${syncId}/run`)),
      ),
  );

  server.tool(
    "delete_data_source_sync",
    "Stop a sync. The rows it already wrote STAY in the table; it simply " +
      "stops refreshing them. Recoverable with restore_data_source_sync." +
      ADMIN_ONLY,
    {
      id: SOURCE_ID,
      syncId: SYNC_ID,
      confirm: z
        .literal(true)
        .describe("Must be true. Acknowledges the table stops being refreshed."),
    },
    async ({ id, syncId }) =>
      guard(async () =>
        jsonResult(await client.del(`${SOURCES}/${id}/syncs/${syncId}`)),
      ),
  );

  server.tool(
    "restore_data_source_sync",
    "Bring a stopped sync back. It comes back SWITCHED OFF on purpose — a " +
      "sync is usually stopped because it did the wrong thing — so switching " +
      "it on again is a separate, deliberate step in Axonity." +
      ADMIN_ONLY,
    { id: SOURCE_ID, syncId: SYNC_ID },
    async ({ id, syncId }) =>
      guard(async () =>
        jsonResult(await client.post(`${SOURCES}/${id}/syncs/${syncId}/restore`)),
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
    "What can be asked of one dynamic table: its published measures, its " +
      "columns and its time axis. Read-only. " +
      "\n\nRead this before query_measures or before putting a tile on a " +
      "dashboard — a tile names a measure by the id or name this returns. " +
      "Measures themselves are DEFINED on the table (update_data_table) and " +
      "go live when the table is published; this only reads them.",
    {
      tableId: z.string().describe("The dynamic table's id."),
      useDraft: z
        .boolean()
        .optional()
        .describe(
          "Read the table's working design instead of its published one — to " +
            "preview a measure before publishing. Defaults to false.",
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
      "`{ key, tableId, measure, period?, start?, end?, compare?, grain?, " +
      "splitBy?, filters?, limit?, useDraft? }`. `key` is your own label and " +
      "comes back on the answer. `period` is one of: " +
      PERIODS +
      " (default this_month) — or set it to null and send `start`/`end` " +
      "(YYYY-MM-DD) for a custom range. `compare` is none, previous_period or " +
      "previous_year. `grain` (none, auto, day, week, month, quarter, year) " +
      "draws a series. `splitBy` names a column to group by; `limit` (1-50) " +
      "keeps the largest groups. " +
      "\n\nONE BAD QUESTION DOES NOT FAIL THE CALL: every answer carries " +
      "`ok`, and `ok: false` comes with an `error` of its own. Check each one. " +
      "\n\n`freshAsOf` says how old the newest row behind the number is; " +
      "`certified: false` means it was computed from a draft. Say so when you " +
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
