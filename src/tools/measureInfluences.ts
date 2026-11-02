/**
 * What moves a number — the connector half of axonity-flow#1783 A2 (S9,
 * release 1b).
 *
 * A measure's formula says what it is MADE of; the platform reads that from
 * the formula itself (`dependsOn` on read_measure). What a formula cannot say
 * is what MOVES a number from outside: complaints push lost customers up, a
 * price rise pulls conversion down. That is an influence, and it is what
 * "why did this move?" follows once the formula runs out.
 *
 * Like concepts and concept links, an influence is NOT a new entity type. The
 * entries are rows of one table the platform keeps for the workspace,
 * `measure_influences`, created with the first one — so draft, approval,
 * versions and history are that table's, and publishing the influences is
 * publishing that table. No `request_publish_measure_influence` exists.
 *
 * Changing one is `update_measure_influence` (PUT on the same route), found
 * by `fromMeasure` + `toMeasure` + `kind`: the backend offers it, and an
 * unlink + link to change one sentence would leave a window in which the
 * draft has no row at all.
 *
 * The RULES (no loop, no second row, nothing the formula already says, a
 * measure must exist unless the row is planned) run in the backend; a refusal
 * comes back with its message and its reasons unchanged (`errors.ts`). Here
 * are only the routes and the sentences an agent needs to write a good row.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

const INFLUENCES = "/api/v1/measure-influences";
const TREE = "/api/v1/measures/tree";

const FROM = z
  .string()
  .describe("The measure that moves the other one, by its NAME (list_measures).");
const TO = z.string().describe("The measure that is moved, by its NAME.");
const KIND = z
  .enum(["influence", "formula"])
  .describe(
    "`influence` (the default): the first moves the second from OUTSIDE its " +
      "formula. `formula`: only on a PLANNED row — the second must be " +
      "computed from the first and is not yet. A real formula lives on the " +
      "measure itself, never here.",
  );
const EFFECT = z
  .enum(["same", "opposite"])
  .describe(
    "`same`: when the first rises, the second rises. `opposite`: when the " +
      "first rises, the second falls.",
  );
const WHY = z
  .string()
  .describe(
    "One sentence: why the first moves the second, in the workspace's own " +
      'words — "more complaints mean more customers who stop".',
  );
const OWNER = z
  .string()
  .describe(
    'Who answers for this influence, as text: a role ("CFO", "Head of ' +
      'Customer Care") or a person\'s name. Not a user account — it is ' +
      "written as words, and it is who to ask when the link is disputed.",
  );
const BASIS = z
  .string()
  .describe(
    "Where it comes from — a budget sheet, a study, an analysis of last " +
      "year's orders. Optional; empty is normal for a link the owner knows " +
      "from experience.",
  );
const PLANNED = z
  .boolean()
  .describe(
    "True marks a link that is still MISSING, so the tree shows where " +
      '"why?" stops today. A planned row may name a measure that is not ' +
      "built yet, and may say `kind: \"formula\"`; an ordinary row may do " +
      "neither. When it comes true it is reported as `done`, never removed " +
      "by itself: the author decides. Defaults to false.",
  );

/** Said by every write: where the rule lives, and how it goes live. */
const RULES =
  "\n\nREFUSED, WITH THE REASON: a measure that does not exist (unless the " +
  "row is `planned`), a second row with the same from, to and kind, a link " +
  "the formula already makes (\"already rests on\" — that is `dependsOn`, " +
  "not an influence), `formula` without `planned`, and a LOOP — A moves B " +
  "moves A — checked over formula parts and influences together, with the " +
  "path in the answer. Read the reason and repair the row; never force it " +
  "in another way.";

const LIVE =
  "\n\nNOT LIVE UNTIL PUBLISHED. The influences are rows of one table named " +
  "`measure_influences`, created with the first one: find its id with " +
  "list_data_tables({ name: \"measure_influences\" }), then " +
  "ensure_data_table_major_version and request_publish_data_table on it — " +
  "one approval for every influence you wrote. An agent in a run and " +
  "read_measure_tree read what is published. " +
  "\n\nTHEY TRAVEL WITH THE DEPLOY. Like the measures, the table is " +
  "configuration: build the influences in the first environment (staging), " +
  "and they go to the next one with the deployment. Never write them by " +
  "hand in production.";

/** The fields of one row, the same for a new one and a change. */
const ROW = {
  fromMeasure: FROM,
  toMeasure: TO,
  kind: KIND.optional(),
  effect: EFFECT,
  why: WHY,
  owner: OWNER,
  basis: BASIS.optional(),
  planned: PLANNED.optional(),
};

/** The body as the route takes it: strict, so only what was given. */
function rowBody(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

export function registerMeasureInfluenceTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "list_measure_influences",
    "The influences between measures: what moves one number from OUTSIDE " +
      "its formula, which way, why and whose it is. Read-only. Pass " +
      "`measure` for every influence into or out of one measure, or nothing " +
      "for the whole workspace. " +
      "\n\nEach item is `{ fromMeasure, toMeasure, kind, effect, why, owner, " +
      "basis, planned, state }`. `state`: `active` (both measures are " +
      "there), `planned` (a missing link, still missing), `done` (a planned " +
      "link that came true — remove it if it was a formula, or make it an " +
      "ordinary influence), `points_nowhere` (a measure it names was removed " +
      "or renamed — repair or remove it). " +
      "\n\nReads the DRAFT by default, what you are writing; `useDraft: " +
      "false` for what is published, which is what an agent reads. For the " +
      "whole picture — formula parts and influences in one graph, with " +
      "where it stops — use read_measure_tree.",
    {
      measure: z
        .string()
        .optional()
        .describe("Only the influences into or out of this measure, by its NAME."),
      useDraft: z
        .boolean()
        .optional()
        .describe(
          "true (the default): the draft of the influences table. false: " +
            "what is published.",
        ),
    },
    async ({ measure, useDraft }) =>
      guard(async () => jsonResult(await client.get(INFLUENCES, { measure, useDraft }))),
  );

  server.tool(
    "link_measures",
    "Write one influence into the draft: `fromMeasure` moves `toMeasure` " +
      "from outside its formula — complaints push lost customers up, a price " +
      "rise pulls conversion down. It is what \"why did this move?\" " +
      "follows once the formula runs out, so write the influences the " +
      "owner knows, with the reason in `why`. " +
      "\n\nAN INFLUENCE IS NOT A FORMULA. When a number IS computed from " +
      "another (margin = revenue − cost), that belongs in the measure's " +
      "formula and read_measure shows it as `dependsOn`; it is refused here. " +
      "A link that must become a formula but is not yet is a `planned` row " +
      "with `kind: \"formula\"`. Read axonity_semantic_conventions for when " +
      "to write which. " +
      "\n\nAnswers with the row as written and its `state`. To change the " +
      "effect, why, owner, basis or planned of one that is there, use " +
      "update_measure_influence; to change its from, to or kind, unlink it " +
      "and write a new one." +
      RULES +
      LIVE,
    ROW,
    async (fields) =>
      guard(async () => jsonResult(await client.post(INFLUENCES, rowBody(fields)))),
  );

  server.tool(
    "update_measure_influence",
    "Change one influence in the draft: its `effect`, `why`, `owner`, " +
      "`basis` or `planned`. It is found by `fromMeasure` + `toMeasure` + " +
      "`kind` — what makes it the same influence — so those three cannot " +
      "change here: unlink_measures and link_measures for that. Send the " +
      "WHOLE row (effect, why and owner are required, as on a new one); a " +
      "field you leave out takes its default (`basis` empty, `planned` " +
      "false) — read it with list_measure_influences first. Refused when no " +
      "such row is in the draft. Making a planned row ordinary " +
      "(`planned: false`) is held to the same rules as a new one." +
      RULES +
      LIVE,
    ROW,
    async (fields) =>
      guard(async () => jsonResult(await client.put(INFLUENCES, rowBody(fields)))),
  );

  server.tool(
    "unlink_measures",
    "Take one influence out of the draft. Answers with the influences " +
      "`toMeasure` has left, into it and out of it. Taking away one that is not there is a " +
      "success, not an error. The measures themselves stay. Like a new one, " +
      "the removal counts once the `measure_influences` table is published " +
      "again (ensure_data_table_major_version, request_publish_data_table); " +
      "until then the published version still has it.",
    {
      fromMeasure: z.string().describe("The measure that moves, by its NAME."),
      toMeasure: z.string().describe("The measure that is moved, by its NAME."),
      kind: z
        .enum(["influence", "formula"])
        .optional()
        .describe(
          "`influence` (the default), or `formula` for a planned formula row " +
            "— exactly as list_measure_influences shows it.",
        ),
      confirm: z
        .literal(true)
        .describe("Must be true. Acknowledges the influence is removed from the draft."),
    },
    async ({ fromMeasure, toMeasure, kind }) =>
      guard(async () =>
        jsonResult(await client.del(INFLUENCES, { fromMeasure, toMeasure, kind })),
      ),
  );

  server.tool(
    "read_measure_tree",
    "The measure tree: what a number is made of and what moves it, as one " +
      "graph. Read-only. From one `measure` down — along the measures its " +
      "formula names and the influences into it — or, without `measure`, " +
      "the whole workspace. The same tree the Measure tree screen draws and " +
      "an agent's read_measure_tree reads. " +
      "\n\nAnswers `{ root, nodes, edges, missing }`. A node is " +
      "`{ name, label, unit, published, built }` — `built: false` is a " +
      "measure only a planned row names. An edge is `{ from, to, kind, " +
      "effect, why, owner, basis, planned, state }`: `kind` `formula` is a " +
      "part of the formula (no effect), `influence` an influence. `missing` " +
      "is every place where \"why did this move?\" stops: `{ measure, " +
      "reason, from, to, kind }` with reason `not_built`, `not_published`, " +
      "`planned` or `points_nowhere`. " +
      "\n\nNO VALUES: ask query_measures for the numbers of the nodes, in " +
      "one call, so a number is computed one way. Reads what is PUBLISHED " +
      "by default — the measures and the influences an agent sees; " +
      "`useDraft: true` reads the drafts of both, to check a tree before you " +
      "publish it. An unknown measure is refused by name.",
    {
      measure: z
        .string()
        .optional()
        .describe("The measure to start from, by its NAME. Omit for the whole workspace."),
      useDraft: z
        .boolean()
        .optional()
        .describe(
          "Read the drafts of the measures and of the influences. Defaults " +
            "to false: what is published.",
        ),
    },
    async ({ measure, useDraft }) =>
      guard(async () => jsonResult(await client.get(TREE, { measure, useDraft }))),
  );
}
