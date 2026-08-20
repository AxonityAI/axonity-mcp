#!/usr/bin/env node
/**
 * Generate the list-filter table from the pinned OpenAPI snapshot (#48 M4).
 *
 * The generated `list_*` tools used to take `{}` — always — while the routes
 * underneath accepted filters this connector threw away. #45 M9(3) exposed the
 * ten that existed on the day it was written, by hand. That is the fix without
 * the mechanism: the eleventh filter arrives and nobody notices.
 *
 * So the NAMES and TYPES come from the schema's own query parameters. A filter
 * added on the backend shows up here the moment the snapshot is refreshed —
 * which #48 M1 now guarantees happens.
 *
 * WHAT IS STILL WRITTEN BY HAND, and why it is not the same thing: the prose.
 * Almost none of these parameters carry a `description` in the schema (`scope`,
 * `owner_id`, `includeSystem`, `stage_id` and `capability_id` all have none), so
 * generation alone would hand an agent a filter with no idea what it selects.
 * `NOTES` below is annotation keyed by parameter name — it can only ADD a
 * sentence. A filter with no note is still generated, still exposed and still
 * works; a note for a parameter the schema no longer has fails a test. It never
 * decides what exists, which is the line #44 drew.
 *
 * Usage:
 *   node scripts/generate-list-filters.mjs           # write the module
 *   node scripts/generate-list-filters.mjs --stdout  # print it (used by a test)
 */

import { readFileSync, writeFileSync } from "node:fs";

const SNAPSHOT = "test/fixtures/openapi.snapshot.json";
const OUTPUT = "src/generated/listFilters.ts";

/**
 * Which list route belongs to which generated tool.
 *
 * The tool NAMES are this repository's own vocabulary, not the backend's, so
 * they are legitimately written here — the mapping is what a generator needs to
 * know. The filters are read out of whichever route each one names.
 */
const LIST_ROUTES = {
  workflow: "/api/v1/workflows",
  agent: "/api/v1/agents",
  tool: "/api/v1/tools",
  skill: "/api/v1/skills",
  policy: "/api/v1/policies",
  reference_doc: "/api/v1/reference-docs",
  output_schema: "/api/v1/output-schemas",
  persona: "/api/v1/personas",
  prompt_snippet: "/api/v1/prompt-snippets",
  flow: "/api/v1/flows",
};

/**
 * Query parameters a list route accepts but that are NOT filters.
 *
 * Paging is the tool's own concern and is already modelled per tool with the
 * cursor contract the conformance guard enforces; folding it into a generic
 * `filters` bag would let a caller page without ever being told there are more
 * pages, which is #37 all over again.
 */
const NOT_FILTERS = new Set(["limit", "offset", "cursor", "page", "page_size"]);

/**
 * Prose for the filters we understand. Annotation only — see the header.
 * A key here that the schema does not carry is a stale note and fails the test.
 */
const NOTES = {
  stage_id:
    "Only workflows linked to this stage of the company's value stream. " +
    "Stage ids come from read_company.",
  capability_id:
    "Only workflows linked to this capability. Capability ids come from read_company.",
  includeSystem:
    "Include the platform's own system agents (the Builder team) alongside the " +
    "tenant's. Defaults to false. They are readable, not yours to edit — useful " +
    "when a workflow step names one and you are wondering what it is.",
  scope:
    "Only items with this scope — the same value the entity's own `scope` field " +
    "carries (read one, or read the 422 a wrong value returns). This is how you " +
    "separate the tenant-wide items, which reach every agent, from the ones " +
    "attached to a single owner.",
  owner_id:
    "Only items owned by this entity — the agent or workflow id the scope points " +
    "at. Pair it with `scope`.",
  deleted:
    "Return the tenant's soft-deleted rows instead of the live ones. " +
    "`list_deleted_prompt_snippets` asks the dedicated route for the same thing " +
    "and is usually clearer.",
};

/** camelCase for the tool argument; the wire keeps whatever the route declares. */
export function toArgName(queryName) {
  return queryName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** "string" | "boolean" for the zod shape, from the parameter's schema. */
export function toFilterType(schema) {
  const candidates = schema?.anyOf ?? [schema ?? {}];
  for (const candidate of candidates) {
    if (candidate?.type === "boolean") return "boolean";
  }
  return "string";
}

/** The filters one list route accepts, in schema order. */
export function filtersFor(snapshot, route) {
  const operation = snapshot.paths?.[route]?.get;
  if (!operation) return [];
  return (operation.parameters ?? [])
    .filter((p) => p.in === "query" && !NOT_FILTERS.has(p.name))
    .map((p) => ({
      arg: toArgName(p.name),
      query: p.name,
      type: toFilterType(p.schema),
      // The schema's own words win when it has any; the note is the fallback.
      description:
        p.description ?? p.schema?.description ?? NOTES[p.name] ?? undefined,
    }));
}

/** The whole table, entity -> filters, omitting entities with none. */
export function buildTable(snapshot) {
  const table = {};
  for (const [entity, route] of Object.entries(LIST_ROUTES)) {
    const filters = filtersFor(snapshot, route);
    if (filters.length > 0) table[entity] = filters;
  }
  return table;
}

/** Notes that no longer describe anything — a stale note is a wrong note. */
export function staleNotes(snapshot) {
  const live = new Set();
  for (const route of Object.values(LIST_ROUTES)) {
    for (const filter of filtersFor(snapshot, route)) live.add(filter.query);
  }
  return Object.keys(NOTES).filter((name) => !live.has(name));
}

export function render(snapshot) {
  const table = buildTable(snapshot);
  const entries = Object.entries(table)
    .map(([entity, filters]) => {
      const rows = filters
        .map(
          (f) =>
            `    {\n` +
            `      arg: ${JSON.stringify(f.arg)},\n` +
            `      query: ${JSON.stringify(f.query)},\n` +
            `      type: ${JSON.stringify(f.type)},\n` +
            (f.description
              ? `      description:\n        ${JSON.stringify(f.description)},\n`
              : "") +
            `    },`,
        )
        .join("\n");
      return `  ${JSON.stringify(entity)}: [\n${rows}\n  ],`;
    })
    .join("\n");

  return `/**
 * GENERATED — do not edit. Run \`npm run generate:filters\`.
 *
 * The query-string filters each \`list_*\` route accepts, read from
 * \`test/fixtures/openapi.snapshot.json\` (axonity-mcp#48 M4). Generated rather
 * than hand-listed so the ELEVENTH filter arrives without anyone noticing it
 * had to: #45 M9(3) exposed ten by hand, which fixes the symptom and leaves the
 * mechanism that produced it.
 *
 * \`arg\` is the camelCase name the tool takes; \`query\` is the spelling the
 * route declares. The two differ on most of these, and that inconsistency is
 * real — it is exactly what a caller should not have to know.
 *
 * \`test/listFilters.test.ts\` regenerates this in memory and fails if it has
 * drifted from the snapshot, so a refreshed snapshot cannot leave a filter
 * unexposed in silence.
 */

import type { ListFilter } from "../tools/register.js";

export const LIST_FILTERS: Record<string, ListFilter[]> = {
${entries}
};
`;
}

function main() {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));

  const stale = staleNotes(snapshot);
  if (stale.length > 0) {
    console.error(
      `generate-list-filters: NOTES describes ${stale.join(", ")}, which the ` +
        "snapshot no longer has. Remove the note or refresh the snapshot.",
    );
    process.exit(1);
  }

  const source = render(snapshot);
  if (process.argv.includes("--stdout")) {
    process.stdout.write(source);
    return;
  }
  writeFileSync(OUTPUT, source);
  const count = Object.values(buildTable(snapshot)).flat().length;
  console.log(`Wrote ${OUTPUT} — ${count} filters across the list routes.`);
}

if (process.argv[1]?.endsWith("generate-list-filters.mjs")) main();
