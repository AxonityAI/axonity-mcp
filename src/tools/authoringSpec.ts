/**
 * The building blocks of this deploy, read from the server instead of restated
 * here.
 *
 * `apply_workflow_mutations` used to name all 22 command types in its own
 * description. That list was correct only by maintenance, and it had already
 * been wrong in the dangerous direction once: it advertised three operations
 * the API rejected with a 422 (#32, axonity-flow#802). A conformance test then
 * pinned the prose to the schema — the right fix for a list you keep, and still
 * a list you keep.
 *
 * `GET /workflows/operations` (axonity-flow#802 B4) removes the list instead of
 * guarding it. It is generated from the engine's mutation registry — the same
 * source the mutations route validates against — so a command this tool reports
 * is a command the API accepts, by construction rather than by agreement. A new
 * server operation becomes discoverable with no change in this repository,
 * which is the acceptance criterion #8 was filed for.
 *
 * axonity-flow#961 S1 extends that property to three more lists that had no
 * route at all, and it is the same story each time: `conventions.ts` named nine
 * step types where seven validate — `loop` and `for_each` both answer
 * `step_invalid_type` — because a list nobody could read is a list that drifts.
 * So the response now carries four generated lists, and this connector names
 * none of them:
 *   - `operations`         — the mutation commands, as before.
 *   - `triggerTypes`       — every value a trigger's `typeId` may hold.
 *   - `stepTypes`          — every value a step's `type` may hold, INCLUDING the
 *     ones an author may not write, each with the reason and what to write
 *     instead. Omitting those would read as "does not exist".
 *   - `scheduleRuleKinds`  — the shapes a schedule rule takes, each with a
 *     working example the backend round-trips through its own parser on every
 *     read, so a published example cannot rot.
 *
 * `rulesVersion` is a content hash over all four: same hash, nothing to
 * re-fetch. It is what makes "read the spec at the start of each authoring
 * task" cheap enough to actually do.
 *
 * **Cost.** The full catalog is ~20 KB — the payload schemas are the bulk of it,
 * and `add_step` alone is 3 KB. Handing that to an agent that wanted to know
 * which commands exist is the mistake #33 was filed about: a default that is
 * correct but unaffordable produces the shortcut, not the careful read. So the
 * payload SCHEMAS are what the index drops, per command, on request. The three
 * vocabulary lists are small and are the answer to "what may I write at all",
 * so they always ride along — trimming them would recreate the gap this closed.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

interface OperationRow {
  type?: unknown;
  description?: unknown;
  payloadSchema?: unknown;
}

interface CatalogResponse {
  operations?: unknown;
  rulesVersion?: unknown;
}

/**
 * Project the catalog to what was asked for, keeping the envelope.
 *
 * Exported for testing. `types` is matched against the server's own `type`
 * values with NO local list to check them against — an unknown name comes back
 * in `unknownTypes` rather than being rejected here, because the connector is
 * not the authority on what exists. That is the whole point of reading the
 * catalogue.
 *
 * Only `operations` is ever projected. The envelope is spread through on both
 * paths, so `triggerTypes` / `stepTypes` / `scheduleRuleKinds` — and anything
 * the backend adds next to them — survive unread and unnamed here.
 */
export function projectCatalog(response: unknown, types?: string[]): unknown {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    return response;
  }

  const source = response as CatalogResponse;
  if (!Array.isArray(source.operations)) return response;

  const rows = source.operations as OperationRow[];
  const wanted = types && types.length > 0 ? new Set(types) : undefined;

  if (wanted) {
    const present = new Set(
      rows.map((row) => (typeof row.type === "string" ? row.type : "")),
    );
    const unknownTypes = [...wanted].filter((t) => !present.has(t));

    return {
      ...source,
      operations: rows.filter(
        (row) => typeof row.type === "string" && wanted.has(row.type),
      ),
      ...(unknownTypes.length > 0
        ? {
            unknownTypes,
            // Not an error: this deploy's catalogue is the authority, and a
            // name it does not carry is simply not a command here.
            unknownTypesNote:
              "This backend's catalogue has no such operation. Call again " +
              "without `types` to see what it does have.",
          }
        : {}),
    };
  }

  return {
    ...source,
    operations: rows.map((row) => ({ type: row.type, description: row.description })),
    // Say what was dropped and how to get it — the omission a reader cannot see
    // is the same trap as the cost it avoids. Note this names `operations`
    // only: the vocabulary lists beside it are returned in full.
    schemasOmitted:
      "`operations` is an index (type + description) — its payload schemas are " +
      'omitted. Pass `types: ["add_step", …]` for the live payload schema of ' +
      "the commands you are about to write; the full catalogue is ~20 KB and " +
      "is rarely what you need. Everything else in this response is complete.",
  };
}

export function registerAuthoringSpecTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "get_workflow_authoring_spec",
    "Everything THIS Axonity deploy can be built from, read live from the " +
      "server — not a list this connector keeps. Read it at the start of an " +
      "authoring task, before `apply_workflow_mutations`. Four lists come back:" +
      "\n- `operations` — the mutation commands, with their payload schemas." +
      "\n- `triggerTypes` — every value a trigger's `typeId` may hold. " +
      "`category: true` marks a broad category id rather than a concrete type; " +
      "both validate, but reach for the concrete one." +
      "\n- `stepTypes` — every value a step's `type` may hold. Types you may " +
      "NOT author are listed too, with `authorable: false` and a `reason` " +
      "saying how to express that intention instead — so reaching for one gets " +
      "you an answer rather than a `step_invalid_type`." +
      "\n- `scheduleRuleKinds` — the shapes a schedule rule takes, each with a " +
      "working `example` to copy and the sentence it `describes`. Every example " +
      "is round-tripped through the platform's own parser as it is served, so " +
      "it is one this deploy demonstrably accepts." +
      "\n\nBy default `operations` is an INDEX: each command's `type` and " +
      "one-line `description`. Pass `types` to get the live `payloadSchema` for " +
      "the commands you are about to write — the full catalogue with every " +
      "schema is ~20 KB, which is rarely what you need. The other three lists " +
      "are always returned complete. " +
      "\n\n`rulesVersion` is a content hash over all four: while it is " +
      "unchanged there is nothing to re-fetch. Re-read the spec when it changes, " +
      "or when a mutation fails with a 422 that suggests your idea of a command " +
      "is out of date. " +
      "\n\nAnything missing here is something this backend will reject. Each " +
      "list is generated from the same registry that ENFORCES it — the handler " +
      "table, the trigger-type constants, the validator's own step-type set, " +
      "the schedule-rule specs — so the answer and the enforcement cannot " +
      "disagree. That is why neither this connector's guide nor its tool " +
      "descriptions name any of these values.",
    {
      types: z
        .array(z.string())
        .optional()
        .describe(
          'Command types to return in full, e.g. ["add_step", "add_edge"]. ' +
            "Omit for the index. A name this deploy does not have comes back " +
            "under `unknownTypes` rather than as an error.",
        ),
    },
    async ({ types }) =>
      guard(async () =>
        jsonResult(
          projectCatalog(await client.get("/api/v1/workflows/operations"), types),
        ),
      ),
  );
}
