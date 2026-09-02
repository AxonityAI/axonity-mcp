/**
 * GENERATED — do not edit. Run `npm run generate:filters`.
 *
 * The query-string filters each `list_*` route accepts, read from
 * `test/fixtures/openapi.snapshot.json` (axonity-mcp#48 M4). Generated rather
 * than hand-listed so the ELEVENTH filter arrives without anyone noticing it
 * had to: #45 M9(3) exposed ten by hand, which fixes the symptom and leaves the
 * mechanism that produced it.
 *
 * `arg` is the camelCase name the tool takes; `query` is the spelling the
 * route declares. The two differ on most of these, and that inconsistency is
 * real — it is exactly what a caller should not have to know.
 *
 * `test/listFilters.test.ts` regenerates this in memory and fails if it has
 * drifted from the snapshot, so a refreshed snapshot cannot leave a filter
 * unexposed in silence.
 */

import type { ListFilter } from "../tools/register.js";

export const LIST_FILTERS: Record<string, ListFilter[]> = {
  "workflow": [
    {
      arg: "stageId",
      query: "stage_id",
      type: "string",
      description:
        "Only workflows linked to this stage of the company's value stream. Stage ids come from read_company.",
    },
    {
      arg: "capabilityId",
      query: "capability_id",
      type: "string",
      description:
        "Only workflows linked to this capability. Capability ids come from read_company.",
    },
  ],
  "agent": [
    {
      arg: "includeSystem",
      query: "includeSystem",
      type: "boolean",
      description:
        "Include the platform's own system agents (the Builder team) alongside the tenant's. Defaults to false. They are readable, not yours to edit — useful when a workflow step names one and you are wondering what it is.",
    },
  ],
  "policy": [
    {
      arg: "scope",
      query: "scope",
      type: "string",
      description:
        "Only items with this scope — the same value the entity's own `scope` field carries (read one, or read the 422 a wrong value returns). This is how you separate the tenant-wide items, which reach every agent, from the ones attached to a single owner.",
    },
    {
      arg: "ownerId",
      query: "owner_id",
      type: "string",
      description:
        "Only items owned by this entity — the agent or workflow id the scope points at. Pair it with `scope`.",
    },
  ],
  "reference_doc": [
    {
      arg: "scope",
      query: "scope",
      type: "string",
      description:
        "Only items with this scope — the same value the entity's own `scope` field carries (read one, or read the 422 a wrong value returns). This is how you separate the tenant-wide items, which reach every agent, from the ones attached to a single owner.",
    },
    {
      arg: "ownerId",
      query: "owner_id",
      type: "string",
      description:
        "Only items owned by this entity — the agent or workflow id the scope points at. Pair it with `scope`.",
    },
  ],
  "prompt_snippet": [
    {
      arg: "deleted",
      query: "deleted",
      type: "boolean",
      description:
        "Return the tenant's soft-deleted rows instead of the live ones. `list_deleted_prompt_snippets` asks the dedicated route for the same thing and is usually clearer.",
    },
  ],
  "data_table": [
    {
      arg: "name",
      query: "name",
      type: "string",
      description:
        "Only the table with exactly this name. A name is unique within the workspace and is what a tool grant and a decision rule refer to, so this answers 'does it already exist' in one call. Matching is exact, never a substring.",
    },
    {
      arg: "status",
      query: "status",
      type: "string",
      description:
        "Only tables with this lifecycle status: active (in use) or archived (kept, not offered). A value outside the two is refused rather than silently ignored.",
    },
    {
      arg: "isDynamic",
      query: "is_dynamic",
      type: "boolean",
      description:
        "true: only tables a workflow may change. false: only reference data the author maintains. Omit for both.",
    },
  ],
};
