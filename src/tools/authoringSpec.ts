/**
 * The mutation vocabulary, read from the server instead of restated here.
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
 * `rulesVersion` is a content hash over the catalog: same hash, nothing to
 * re-fetch. It is what makes "read the spec at the start of each authoring
 * task" cheap enough to actually do.
 *
 * **Cost.** The full catalog is ~20 KB — the payload schemas are the bulk of it,
 * and `add_step` alone is 3 KB. Handing that to an agent that wanted to know
 * which commands exist is the mistake #33 was filed about: a default that is
 * correct but unaffordable produces the shortcut, not the careful read. So the
 * index (type + description) is the default, and the schemas come per command,
 * when the agent is actually about to write one.
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
    // is the same trap as the cost it avoids.
    schemasOmitted:
      "Index only (type + description). Pass `types: [\"add_step\", …]` for the " +
      "live payload schema of the commands you are about to write; the full " +
      "catalogue is ~20 KB and is rarely what you need.",
  };
}

export function registerAuthoringSpecTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "get_workflow_authoring_spec",
    "The mutation commands THIS Axonity deploy accepts, read live from the " +
      "server — not a list this connector keeps. Read it at the start of an " +
      "authoring task, before `apply_workflow_mutations`. " +
      "\n\nBy default you get the INDEX: every command's `type` and one-line " +
      "`description`, plus `rulesVersion`. Pass `types` to get the live " +
      "`payloadSchema` for the commands you are about to write — the full " +
      "catalogue with every schema is ~20 KB, which is rarely what you need. " +
      "\n\n`rulesVersion` is a content hash of the catalogue: while it is " +
      "unchanged there is nothing to re-fetch. Re-read the spec when it changes, " +
      "or when a mutation fails with a 422 that suggests your idea of a command " +
      "is out of date. " +
      "\n\nA command missing here is a command this backend will reject — the " +
      "catalogue is generated from the same registry the mutations route " +
      "validates against, so the two cannot disagree.",
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
