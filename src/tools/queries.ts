/**
 * Queries — what is not the generic family (axonity-mcp#91, the connector half
 * of axonity-flow#2010 S1 / #2011).
 *
 * A query is an authored, versioned entity like a measure, so list, read,
 * create, update, delete, restore, the version tools and
 * `request_publish_query` come from the registrars (see `ENTITIES` in
 * index.ts). What is here is what a query has and a measure does not: running
 * it once with values, and who holds the read tool its publication mints.
 *
 * A query is also what fills a table now. The inline `provenance` a table used
 * to carry (source, SQL, grain) is a query of its own, and the table points at
 * it with `fillingQueryId` — so without these tools a table could be created
 * through the connector and never be given its filler (#91).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

const QUERIES = "/api/v1/queries";

const QUERY_ID = z.string().describe("The query's id (list_queries).");

export function registerQueryTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "test_query",
    "Run a query ONCE, with values, and see what came back — before asking " +
      "for its publication, and after every change to its SQL. Runs the " +
      "query as it stands now, draft included; nothing is stored and no " +
      "table is filled. " +
      "\n\nThe answer: `columns` and `rows` (capped — `truncated: true` " +
      "means rows were left out, `rowCount` is what came back), " +
      "`bytesScanned` (what it cost), `fromCache`, `elapsedMs`, and " +
      "`returns`: the columns this result suggests for the query's own " +
      "`returns`, keeping every description already written. Copy those into " +
      "update_query and describe each one. A cell that is not a finite number " +
      "comes back as its name (`NaN`, `Infinity`), counted in `notANumber`. " +
      "\n\nTWO DIFFERENT FAILURES, as on query_data_source: a 422 is Axonity " +
      "refusing the STATEMENT (it writes, reads a dataset the source forbids, " +
      "would scan more than the source allows, or a value does not fit its " +
      "parameter) — the reason says what to change. A 502 is the WAREHOUSE " +
      "refusing or not answering; `retryable` says whether sending the same " +
      "statement again is worth it.",
    {
      id: QUERY_ID,
      values: z
        .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe(
          "A value per declared parameter, by its name: " +
            '`{ "land": "BE", "from": "2026-01-01" }`. They are bound, never ' +
            "written into the statement. Leave out an optional one to bind " +
            "NULL. A name the query does not declare is refused.",
        ),
      maxRows: z
        .number()
        .int()
        .optional()
        .describe(
          "How many rows to show. Clamped by the platform — this is for " +
            "looking, not for reading a whole result.",
        ),
    },
    async ({ id, values, maxRows }) =>
      guard(async () =>
        jsonResult(
          await client.post(`${QUERIES}/${id}/test`, {
            values: values ?? {},
            ...(maxRows !== undefined ? { maxRows } : {}),
          }),
        ),
      ),
  );

  server.tool(
    "read_query_usage",
    "Who can reach this query today. Read-only. `tool` is the read tool its " +
      "publication minted (`status: \"active\"` while it is published, " +
      "`\"draft\"` once withdrawn; null if it was never published), and " +
      "`agents` the published agents that hold that tool. Read this before " +
      "renaming a query, changing what it returns or deleting it: the grant " +
      "lives on the agent, so this is the only place that says who a change " +
      "affects. An agent stays listed while the tool is withdrawn, because " +
      "publishing again gives it back. " +
      "\n\nTo give an agent the query, put `tool.id` in the agent's " +
      "`toolIds` — ordinary tool granting.",
    { id: QUERY_ID },
    async ({ id }) =>
      guard(async () => jsonResult(await client.get(`${QUERIES}/${id}/usage`))),
  );

  server.tool(
    "list_query_live_versions",
    "Which major versions of one query are PUBLISHED right now, as a list of " +
      "numbers. Read-only. An empty list means it has never been published: " +
      "no agent can call it yet — request_publish_query is what changes that.",
    { id: QUERY_ID },
    async ({ id }) =>
      guard(async () => jsonResult(await client.get(`${QUERIES}/${id}/live-versions`))),
  );
}
