/**
 * Two reads over the model: its Gaps and its Overview (axonity-flow #2444, R0b,
 * epic #2429).
 *
 * Both are counted when asked, nothing is kept by hand (route docstring,
 * `modules/insights/routes/model.py`), and both belong to the Insights module:
 * the router refuses every route of a switched-off module
 * (`routes/modules.py` `module_required`). What a count covers is what the
 * caller may read (the routes take the reader context), so two callers can see
 * different numbers. Each sentence is the schema's own description
 * (`modules/insights/schemas/model.py`, pinned in the snapshot).
 *
 * Reads only, no parameter: there is nothing to narrow.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

export function registerModelTools(server: McpServer, client: AxonityClient): void {
  server.tool(
    "read_model_gaps",
    "Read the five fixed checks over the semantic model, worked out now, " +
      "firing or not. Answers { checks, firing }: `firing` is how many of the " +
      "checks fire, and `checks` lists every one in the order the screen shows " +
      "them. Each check is { code, target, count, fires, of, sample }: `code` " +
      "is table_query_missing, measure_draft, measure_no_concept, no_influences " +
      "or source_table_unverified; `count` is how many things it found, all of " +
      "them; `fires` is whether it found something — or, for no_influences, " +
      "whether it found nothing (a check that does not fire is not a gap); `of` " +
      "is how many things it looked at where the screen says 'x of y' (the " +
      "measures, for measure_no_concept) and null elsewhere; `sample` is the " +
      "names of the first three things found, in name order; `target` is the " +
      "screen where a person fixes it: tables, measures, measure_tree or " +
      "source_tables. What it counts is what you may read. It belongs to the " +
      "Insights module: a workspace that has it switched off is refused.",
    {},
    async () => guard(async () => jsonResult(await client.get("/api/v1/model/gaps"))),
  );

  server.tool(
    "read_model_overview",
    "Read what exists in each layer of the semantic model, counted now. " +
      "Answers { dataSources, queries, tables, relationships, measures, " +
      "influences, concepts, databases }: `dataSources` is connected data " +
      "sources, `queries` the live queries you may read, `databases` the live " +
      "databases (the groups tables live in); `tables` is { total, byFilledBy, " +
      "ungrouped } — live tables you may read, per word that fills them " +
      "(author, workflow, query, source), and those that live in no database " +
      "yet; `relationships` is { total, verified } — live relationships between " +
      "tables and how many are verified against the data; `measures` is " +
      "{ total, base, derived, published } — live measures, those that read a " +
      "table themselves, those built on other measures, and those with a live " +
      "published version; `influences` is { total, active, planned } — written " +
      "influences between measures, those that hold now, and those marked " +
      "planned (a link still missing); `concepts` is { total, byKind } — " +
      "concepts written, per kind: concept, state, metric, rule. It belongs to " +
      "the Insights module: a workspace that has it switched off is refused.",
    {},
    async () => guard(async () => jsonResult(await client.get("/api/v1/model/overview"))),
  );
}
