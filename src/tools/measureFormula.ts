/**
 * A measure is one formula (axonity-mcp#83, the connector half of phase 1 of
 * axonity-flow#1908).
 *
 * A measure used to be one aggregation over one table, or a division of two
 * parts. It is now ONE expression over the model — `[net_revenue] -
 * [variable_costs]`, `divide([cm1], [net_revenue])` — stored as a tree of ids
 * and shown as text of names, the two one-to-one.
 *
 * **The words of the formula are not here.** They come from
 * `GET /measures/formula-spec`, which the platform generates from the module
 * that also parses — the same list its editor shows. A copy in this connector
 * would be a second list, and two lists drift: the reason
 * `get_workflow_authoring_spec` exists. `get_measure_formula_spec` forwards it
 * untouched.
 *
 * **Checking is the platform's too.** `validate_measure` forwards to
 * `POST /measures/validate`, the route the editor calls while somebody types,
 * so an agent and a person can never disagree about whether a formula is
 * acceptable. `read_measure` asks that same route to write the stored tree back
 * as text, rather than this connector unparsing it.
 *
 * The one rule held HERE is the shape of a write: a measure is written as
 * `definition.expression`, and the fields from before the formula are refused
 * with `legacy_field`. The platform still accepts them while its own form is
 * replaced; an agent has no such form to keep working, and a measure written
 * the old way today is one that has to be migrated again.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

const MEASURES = "/api/v1/measures";

/** The language: every word, operator, grain, limit, code and recipe. */
export const FORMULA_SPEC_ROUTE = `${MEASURES}/formula-spec`;
/** The vocabulary of THIS workspace: its measures, tables, columns, calendars. */
export const FORMULA_SYMBOLS_ROUTE = `${MEASURES}/formula-symbols`;
/** Check a formula without saving it. */
export const VALIDATE_ROUTE = `${MEASURES}/validate`;

/** Top-level fields from before the formula: the measure's "home table". */
const LEGACY_TOP = ["tableId", "clearTable"] as const;
/** Fields inside `definition` that the formula replaces. */
const LEGACY_DEFINITION = ["aggregation", "column", "numerator", "denominator"] as const;

/** Present in the sense that matters: sent, and not a null that clears nothing. */
function isSent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/**
 * Refuse a measure write in the shape from before the formula.
 *
 * Throws with `legacy_field` — the platform's own code for it, so an agent
 * that repairs on codes reads the same word from either side. A `definition`
 * without `expression` is refused too: the platform would quietly store it as
 * a `sum`, which is a definition nobody wrote.
 */
export function assertFormulaShape(fields: Record<string, unknown>): void {
  const found: string[] = LEGACY_TOP.filter((key) => isSent(fields[key]));
  const definition = fields.definition;
  if (definition !== undefined && definition !== null) {
    if (typeof definition !== "object" || Array.isArray(definition)) {
      throw new Error("`definition` must be an object with an `expression`.");
    }
    const def = definition as Record<string, unknown>;
    found.push(
      ...LEGACY_DEFINITION.filter((key) => isSent(def[key])).map(
        (key) => `definition.${key}`,
      ),
    );
    if (found.length === 0 && !isSent(def.expression)) {
      throw new Error(
        "legacy_field: `definition` has no `expression`. A measure is one " +
          "formula — send it as `definition.expression`, e.g. " +
          '"sum(orders.amount)" or "[net_revenue] - [variable_costs]". ' +
          "Read get_measure_formula_spec for the words, and check it with " +
          "validate_measure first.",
      );
    }
  }
  if (found.length === 0) return;
  throw new Error(
    `legacy_field: ${found.map((f) => `\`${f}\``).join(", ")} ` +
      `${found.length === 1 ? "is" : "are"} the shape from before the formula. ` +
      "A measure is one `definition.expression` now, and the tables it reads " +
      "follow from it: `sum(orders.amount)` instead of `tableId` + " +
      "`aggregation` + `column`, `divide(sum(a.x), sum(b.y))` instead of a " +
      "`numerator` and a `denominator`, `… where table.column = 'value'` " +
      "for a condition on one part. Remove these fields and write the " +
      "formula — validate_measure checks it before you save.",
  );
}

/** The parts of a stored measure `read_measure` needs to ask for its text. */
interface MeasureDetail {
  id?: unknown;
  definition?: {
    expression?: unknown;
    quantity?: unknown;
    format?: unknown;
  } | null;
}

/**
 * The stored tree, written back as text with its leaves, by the platform.
 *
 * Best effort, and said so: a read must not fail because the explanation
 * could not be produced. When it cannot, the measure comes back as stored with
 * a sentence saying why its formula text is missing.
 */
async function explainFormula(
  client: AxonityClient,
  measure: MeasureDetail,
  useDraftChain: boolean,
): Promise<Record<string, unknown>> {
  const expression = measure.definition?.expression;
  if (expression === undefined || expression === null) {
    return {
      formula: null,
      formulaNote:
        "This measure has no formula yet — it is still in the shape from " +
        "before the formula. Write one with update_measure " +
        "(`definition.expression`).",
    };
  }
  try {
    const checked = (await client.post(VALIDATE_ROUTE, {
      expression,
      measureId: typeof measure.id === "string" ? measure.id : undefined,
      quantity: measure.definition?.quantity ?? undefined,
      format: measure.definition?.format ?? undefined,
      useDraftChain,
    })) as Record<string, unknown>;
    return {
      formula: {
        text: checked.formula,
        tree: expression,
        leaves: checked.leaves ?? [],
        quantity: checked.quantity ?? null,
        problems: checked.problems ?? [],
        chain: useDraftChain ? "drafts" : "published",
      },
    };
  } catch (err) {
    return {
      formula: { text: null, tree: expression },
      formulaNote:
        "The formula text and its leaves could not be read from this deploy " +
        `(\`POST ${VALIDATE_ROUTE}\`: ${err instanceof Error ? err.message : String(err)}). ` +
        "The stored tree is above.",
    };
  }
}

export function registerMeasureFormulaTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "get_measure_formula_spec",
    "The ONLY valid list of words for a measure's formula — read it BEFORE " +
      "create_measure or update_measure, and never write a function, " +
      "operator or grain from memory. Read-only. " +
      "\n\nServed by the platform from the code that parses a formula, so it " +
      "is the same list its formula editor shows: per word its signature, " +
      "what it returns, its quantity rule and an example; the operators, " +
      "grains and limits; every refusal `code` with `when` and `fix`; " +
      "`recipes` for the numbers a management team asks for (a sum over two " +
      "facts, a margin %, a share of the total); and `buildOrder`. A word " +
      "with `available: false` is coming and is refused by name " +
      "(`not_yet_supported`) — do not use it. " +
      "\n\n`includeWorkspace: true` adds THIS workspace's vocabulary as " +
      "`workspace`: its measures (name, label, quantity, status), its tables " +
      "and columns, and which dimensions each table reaches — the names a " +
      "formula may use. The answer is then `{ spec, workspace }`; without " +
      "it, the spec itself.",
    {
      includeWorkspace: z
        .boolean()
        .optional()
        .describe(
          "Also return this workspace's measures, tables, columns and " +
            "reachable dimensions. Defaults to false.",
        ),
      useDraftChain: z
        .boolean()
        .optional()
        .describe(
          "With includeWorkspace: include tables and measures that were never " +
            "published. Defaults to false — a published number reads " +
            "published definitions.",
        ),
    },
    async ({ includeWorkspace, useDraftChain }) =>
      guard(async () => {
        const spec = await client.get(FORMULA_SPEC_ROUTE);
        if (!includeWorkspace) return jsonResult(spec);
        const workspace = await client.get(FORMULA_SYMBOLS_ROUTE, {
          useDraftChain: useDraftChain ?? false,
        });
        return jsonResult({ spec, workspace });
      }),
  );

  server.tool(
    "validate_measure",
    "Check a measure's formula WITHOUT saving it — call it before every " +
      "create_measure and update_measure. Read-only. The same check the " +
      "platform's editor runs while somebody types. " +
      "\n\nAnswers `{ ok, formula, expression, quantity, leaves, problems }`: " +
      "`formula` is the one spelling of it (names resolved, the brackets " +
      "that apply shown); `expression` the tree that would be stored; " +
      "`quantity` what the number counts, derived; `leaves` every " +
      "aggregation it folds down to — table, aggregation, column, the " +
      "conditions and ignored dimensions on that part, and the measures " +
      "walked to reach it. " +
      "\n\nEach problem has a `code`, a `message` and `where` (an `offset` " +
      "in the text, or a `path` in the tree). `severity: error` blocks " +
      "saving; a warning does not. Repair on the code — " +
      "get_measure_formula_spec lists every one with its `fix` — before you " +
      "ask a person: `parse_error` (the message says what was expected " +
      "where), `unknown_measure` / `unknown_table` / `unknown_column` " +
      "(similar names are suggested), `ambiguous_column` (write " +
      "table.column), `column_kind`, `arity`, `cycle` (the chain is in the " +
      "message), `too_complex` (give a part its own name), " +
      "`quantity_mismatch` (adding euros to dogs, or a format that does not " +
      "fit), `unreachable_dimension` (declare the relationship, or write " +
      "`ignore` to mean the total on purpose), `not_yet_supported`. " +
      "`quantity_generic` is a warning: the migration left the placeholder " +
      "quantity — say what the number counts.",
    {
      expression: z
        .union([z.string(), z.record(z.unknown())])
        .describe(
          "The formula, as text (`divide([cm1], [net_revenue])`) or as the " +
            "stored tree.",
        ),
      measureId: z
        .string()
        .optional()
        .describe(
          "The measure being edited, when there is one — it is what makes a " +
            "reference back to itself a `cycle`.",
        ),
      quantity: z
        .string()
        .optional()
        .describe(
          "What the number counts, when you have said (EUR, customers, " +
            "orders). Required on save for a single aggregation.",
        ),
      format: z
        .record(z.unknown())
        .optional()
        .describe(
          "How it will be shown, as on the measure's `definition.format` — " +
            "checked against what the number counts.",
        ),
      useDraftChain: z
        .boolean()
        .optional()
        .describe(
          "Read the DRAFTS of the measures underneath instead of their " +
            "published versions. Defaults to false, because a published " +
            "number reads published definitions.",
        ),
    },
    async (body) => guard(async () => jsonResult(await client.post(VALIDATE_ROUTE, body))),
  );

  server.tool(
    "read_measure",
    "Read one measure by id, including its current draft and version. Read " +
      "before you update — you need the current version. " +
      "\n\nIts formula comes back twice, from the platform: `formula.text` " +
      "with names, as you would write it, and `formula.tree`, the stored " +
      "form with ids. Beside them `formula.leaves` — the aggregations it " +
      "folds down to, each on its own table — `formula.quantity`, and " +
      "`formula.problems`: a measure that rests on a column or measure that " +
      "has since gone says so here. `readsTables` follows from the leaves; " +
      "there is no home table.",
    {
      id: z.string().describe("The measure's id."),
      useDraftChain: z
        .boolean()
        .optional()
        .describe(
          "Resolve the measures it rests on from their drafts instead of " +
            "their published versions. Defaults to false; set it for a " +
            "measure whose parts were never published, or their names " +
            "cannot be shown.",
        ),
    },
    async ({ id, useDraftChain }) =>
      guard(async () => {
        const measure = (await client.get(`${MEASURES}/${id}`)) as MeasureDetail;
        return jsonResult({
          ...measure,
          ...(await explainFormula(client, measure, useDraftChain ?? false)),
        });
      }),
  );
}
