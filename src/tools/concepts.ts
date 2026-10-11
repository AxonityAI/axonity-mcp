/**
 * Concepts — what a word means in this workspace, written once (axonity-mcp#81,
 * the connector half of axonity-flow#1881 S3 / #1877).
 *
 * A concept is NOT a new entity type. The entries are rows of one table the
 * platform keeps for the workspace, created with the first entry. So the
 * lifecycle a concept inherits — draft, approval, versions, history — is that
 * table's, and publishing the definitions is `request_publish_data_table` on
 * the `tableId` every write here returns. No `request_publish_concept` exists,
 * because there is no such entity to publish.
 *
 * What these four tools add over the generic row tools is the reason the
 * platform built the route: the fields are fixed and each has a sentence that
 * says what belongs in it. A blind cell dictionary would hand an agent the
 * column names and none of that.
 *
 * Tool names follow the platform's word, `concept`, rather than "term": a
 * measure points at one through a field called `concept`, and two names for
 * one thing is the drift the semantic model exists to remove.
 *
 * Writes take no `expectedVersion`. That is the route's contract, the same as
 * a table row write: a single addressed operation the service applies under
 * its own lock.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

const BASE = "/api/v1/concepts";

const KIND = z
  .enum(["concept", "state", "metric", "rule"])
  .describe(
    "`concept`: one of the company's own words and what it means here. " +
      "`state`: when something counts as being in that state (\"lost\", " +
      "\"active\"). `metric`: what a number means and what it is PER — the " +
      "calculation is a measure, this is the sentence that says CAC is per " +
      "customer. `rule`: a sentence that always applies.",
  );
const NAME = z
  .string()
  .describe(
    'The word as people here say it — "Active customer", not ' +
      '"cust_active_flag". One entry per word; other words go in synonyms.',
  );
const MEANING = z
  .string()
  .describe(
    "One or two sentences, INCLUDING WHAT IT IS NOT. The exclusions are what " +
      'stop an agent guessing: "at least one D2C order in the month — not a ' +
      'trial customer, and not simply anyone who has not churned".',
  );
const SYNONYMS = z
  .array(z.string())
  .describe(
    'Other words people use for exactly this, so a question that says ' +
      '"subscribers" finds it. A synonym may belong to only ONE concept in ' +
      "the workspace.",
  );
const REFERS_TO = z
  .string()
  .describe(
    "What in the model this is about, in one of four forms: " +
      "`measure:active_clients`, `table:orders_monthly`, " +
      "`column:orders_monthly.country`, `value:orders_monthly.status=lost`. " +
      "It must exist. Empty for a word that is not in the model yet.",
  );
const OWNER = z
  .string()
  .describe(
    'Who to ask when this definition is disputed — a role or a person, "CGO". ' +
      "Approval says it may go live; this says whose it is.",
  );
const SCOPE = z
  .string()
  .describe(
    "For a `rule` only: where it applies. Empty is the whole model; " +
      "otherwise `table:orders_monthly` or `column:orders_monthly.net_revenue`.",
  );

const PUBLISHING =
  "\n\nNOT LIVE UNTIL PUBLISHED. The concepts live in one table, and every " +
  "write answers with its `tableId`; request_publish_data_table on that id " +
  "is what makes them count for a certified answer.";

export function registerConceptTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "list_concepts",
    "This workspace's concepts — what each of its own words means — one page " +
      "at a time. Read-only. " +
      "\n\nTHE RESPONSE IS ONE PAGE: { items, nextCursor, pageSize, hasMore }. " +
      "While hasMore is true you have not seen them all — pass nextCursor " +
      "back as cursor. `q` matches any field, synonyms included, across the " +
      "whole list before the page is cut: \"is there already a concept for " +
      "X\" is one call. Do that before create_concept; a word belongs to one " +
      "concept only. " +
      "\n\nAn empty first page means the workspace has written none yet — not " +
      "an error.",
    {
      q: z.string().optional().describe("Keep only concepts with a field containing this text."),
      limit: z.number().int().optional().describe("Page size; clamped to 200."),
      cursor: z
        .string()
        .optional()
        .describe("nextCursor from the previous page. Omit for the first. Never build one."),
    },
    async ({ q, limit, cursor }) =>
      guard(async () => jsonResult(await client.get(BASE, { q, limit, cursor }))),
  );

  server.tool(
    "create_concept",
    "Write one concept: what a word means here, once, with an owner. The " +
      "list it lives in is created with the first one. " +
      "\n\nRead axonity_semantic_conventions first for what a good one says. " +
      "A measure points at a concept by its `name` (create_measure's " +
      "`concept`), so write the concept before the measure that means it." +
      PUBLISHING,
    {
      kind: KIND,
      name: NAME,
      meaning: MEANING,
      owner: OWNER,
      synonyms: SYNONYMS.optional(),
      refersTo: REFERS_TO.optional(),
      scope: SCOPE.optional(),
    },
    async (fields) => guard(async () => jsonResult(await client.post(BASE, fields))),
  );

  server.tool(
    "update_concept",
    "Change named fields of one concept; the fields you do not send keep " +
      "their values. Sending `\"\"` or `[]` is a real edit — it clears that " +
      "field." +
      PUBLISHING,
    {
      id: z.string().describe("The concept's id (from list_concepts)."),
      kind: KIND.optional(),
      name: NAME.optional(),
      meaning: MEANING.optional(),
      owner: OWNER.optional(),
      synonyms: SYNONYMS.optional(),
      refersTo: REFERS_TO.optional(),
      scope: SCOPE.optional(),
    },
    async ({ id, ...changes }) =>
      guard(async () => jsonResult(await client.patch(`${BASE}/${id}`, changes))),
  );

  server.tool(
    "delete_concept",
    "Remove one concept from the working list. The removed entry rides back " +
      "in the response. Every published version still carries it — so an " +
      "answer that leaned on it can still say so — until the list is " +
      "published again without it." +
      PUBLISHING,
    {
      id: z.string().describe("The concept's id."),
      confirm: z
        .literal(true)
        .describe("Must be true. Acknowledges the definition is removed from the draft."),
    },
    async ({ id }) => guard(async () => jsonResult(await client.del(`${BASE}/${id}`))),
  );
}
