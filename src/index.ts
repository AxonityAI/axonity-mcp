#!/usr/bin/env node
/**
 * Axonity Flow — MCP connector (epic #652 / C4).
 *
 * A local stdio MCP server that lets an external agent (e.g. Claude Code) read,
 * draft, and update workflows, agents and tools in an Axonity tenant. Add it to
 * your client with:
 *
 *   claude mcp add axonity -- npx -y @axonity-ai/mcp
 *
 * with AXONITY_TOKEN (a service token minted in Axonity → Settings → API tokens)
 * and, if self-hosting, AXONITY_API_URL in the environment.
 *
 * It talks to Axonity ONLY over the public REST API; the backend re-enforces
 * tenant + scope on every call. Publishing is human-approved and lands in a
 * later slice (C3) — this connector never publishes directly.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AxonityClient } from "./client.js";
import { loadConfig } from "./config.js";
import { reportContractSkew } from "./contract.js";
import { registerConventions } from "./tools/conventions.js";
import {
  registerDashboardTools,
  registerDataSourceTools,
  registerMeasureTools,
} from "./tools/dataSources.js";
import { registerDataTableTools } from "./tools/dataTables.js";
import { assertPlaceholderCredentials } from "./tools/credentials.js";
import {
  registerAttachTools,
  registerCatalogTools,
  registerConnectorTools,
  registerDependencyTools,
  registerPersonaTools,
} from "./tools/extras.js";
import { registerAuthoringSpecTools } from "./tools/authoringSpec.js";
import { registerCompanyTools } from "./tools/company.js";
import { registerComponentTools } from "./tools/components.js";
import { registerConceptTools } from "./tools/concepts.js";
import { registerOperationsTools } from "./tools/operations.js";
import { registerPromptPlacementTools } from "./tools/promptPlacement.js";
import { LIST_FILTERS } from "./generated/listFilters.js";
import { type EntityDef, registerEntityTools } from "./tools/register.js";
import { registerRunTools } from "./tools/runs.js";
import { registerSecretTools } from "./tools/secrets.js";
import { registerSubworkflowTools } from "./tools/subworkflows.js";
import { registerToolboxTools } from "./tools/toolboxes.js";
import { registerTriggerTools } from "./tools/triggers.js";
import {
  registerApprovalTools,
  registerExecutionTools,
  registerValidationTools,
} from "./tools/validation.js";
import { type VersionedEntity, registerVersionTools } from "./tools/versions.js";
import { registerWorkflowMutations } from "./tools/workflowMutations.js";

const PROVENANCE_NOTE =
  "WHERE THE ROWS COME FROM — `provenance`, for a dynamic table filled from " +
  "a warehouse. It replaces the old data-source sync: there is no separate " +
  "sync object any more, so create_data_source_sync / run_data_source_sync " +
  "do not exist. `provenance` is " +
  "`{ sourceId, sql, grain, keyColumns?, mode?, cron, timezone?, enabled? }`: " +
  "`sourceId` the data source; `sql` the query whose RESULT fills the table " +
  "(try it first with query_data_source); `grain` what ONE ROW of that " +
  "result is, as a sentence (\"one row per month per country\") — " +
  "mandatory, it decides what the table can be asked for ever after; " +
  "`keyColumns` which columns identify a row for `mode: \"upsert\"` (the " +
  "default — `append` takes no key); `cron` when it runs, read in " +
  "`timezone` (default UTC); `enabled: false` pauses it. A table with " +
  "provenance has no other filler — a workflow may not also write its " +
  "rows. It is part of the table's design, so a changed query is published " +
  "through request_publish_data_table like a changed column. To fill it " +
  "now rather than at its next turn: refresh_data_table. " +
  "\n\nMEASURES ARE NOT ON THE TABLE. A measure is its own entity " +
  "(create_measure); a table carries only its `timeAxis` " +
  "(`{ column, grain }`), which every measure over it reads.";

/**
 * The entities the connector covers. Core entities (C4), memory entities (C5)
 * — skills, policies, reference docs — which have the same draft→publish
 * lifecycle via #443's unified versioning, and `data_table` (axonity-flow#1217),
 * which joins them on exactly the same shape.
 */
const ENTITIES: EntityDef[] = [
  {
    singular: "workflow",
    basePath: "/api/v1/workflows",
    updateMethod: "PATCH",
    label: "workflows (business processes)",
    deleteVersionParam: "expectedVersion",
  },
  {
    singular: "agent",
    basePath: "/api/v1/agents",
    updateMethod: "PUT",
    label: "agents",
    deleteVersionParam: "expectedVersion",
  },
  {
    singular: "tool",
    basePath: "/api/v1/tools",
    updateMethod: "PUT",
    label: "tools (functions, connectors, validators, evaluators)",
    // A connector is just a tool, so create_tool/update_tool can carry an
    // authConfig too — they get the same credential guard as create_connector.
    guardFields: assertPlaceholderCredentials,
    deleteVersionParam: "expectedVersion",
  },
  {
    singular: "skill",
    basePath: "/api/v1/skills",
    updateMethod: "PUT",
    label: "skills (reusable know-how for agents)",
    deleteVersionParam: "expected_version",
  },
  {
    singular: "policy",
    basePath: "/api/v1/policies",
    updateMethod: "PUT",
    label: "policies (rules and guardrails for agents)",
    plural: "policies",
    deleteVersionParam: "expected_version",
  },
  {
    singular: "reference_doc",
    basePath: "/api/v1/reference-docs",
    updateMethod: "PUT",
    label: "reference docs (background knowledge for agents)",
    deleteVersionParam: "expected_version",
  },
  {
    singular: "output_schema",
    basePath: "/api/v1/output-schemas",
    updateMethod: "PUT",
    label: "output schemas (reusable step/agent output contracts)",
    // Now fully version-controlled and in the publish-approval gateway
    // alongside the memory entities — no longer live-on-write.
    deleteVersionParam: "expected_version",
  },
  {
    singular: "persona",
    basePath: "/api/v1/personas",
    updateMethod: "PUT",
    label: "personas (an agent's character, 1:1 with the agent)",
    // Created only through its agent (create_agent_persona) — there is no
    // standalone POST /api/v1/personas.
    creatable: false,
    deleteVersionParam: "expected_version",
  },
  {
    singular: "prompt_snippet",
    basePath: "/api/v1/prompt-snippets",
    updateMethod: "PATCH",
    label: "prompt snippets (reusable prompt fragments)",
    deleteVersionParam: "expectedVersion",
  },
  {
    singular: "flow",
    basePath: "/api/v1/flows",
    updateMethod: "PATCH",
    label: "flows (reusable workflow fragments)",
    deleteVersionParam: "expectedVersion",
  },
  {
    // A table is the same category of thing as an output schema — authored,
    // typed, versioned, publish-approved — and axonity-flow#1217 deliberately
    // wrote its routes in the same order and spelling, so the whole family
    // comes from the registrar with no new code. What is NOT generic is the
    // list (paged, alone among the entities) and the rows (a whole-collection
    // field a blind `fields` bag can wipe) — hence the two entries below and
    // the explicit row tools in `tools/dataTables.ts`.
    singular: "data_table",
    basePath: "/api/v1/data-tables",
    updateMethod: "PUT",
    plural: "data_tables",
    label: "tables (authored reference data agents and decisions read)",
    deleteVersionParam: "expected_version",
    listPaging: { defaultPageSize: 20, maxPageSize: 200 },
    createNote: PROVENANCE_NOTE,
    updateWarning:
      PROVENANCE_NOTE +
      " Sending `provenance` replaces it whole; `clearProvenance: true` " +
      "takes the source away and leaves the rows that are there. " +
      "\n\n`rows` AND `columns` ARE WHOLE-COLLECTION FIELDS: sending either " +
      "REPLACES it entirely. Passing one row in `rows` does not append it — it " +
      "deletes every other row in the table. To change content, use " +
      "add_data_table_row / update_data_table_row / delete_data_table_row, " +
      "which address a single row and cannot destroy the rest. Use `rows` here " +
      "only when you genuinely mean to replace the whole content.",
  },
  {
    // A measure was a field on a table; the semantic model (axonity-flow#1881
    // S12, #1841) made it an entity of its own, in the same order and spelling
    // as a table's routes — so the whole family, versions and publish request
    // included, comes from the registrars with no code of its own.
    singular: "measure",
    basePath: "/api/v1/measures",
    updateMethod: "PUT",
    label: "measures (the agreed definition of one number in the model)",
    deleteVersionParam: "expectedVersion",
    listPaging: { defaultPageSize: 20, maxPageSize: 200 },
    createNote:
      "Fields: `label` (what a tile shows), `description` (what the number " +
      "means — mandatory, an agent reads it to decide whether this is the " +
      "number asked for), `definition` (the calculation), `tableId` (the " +
      "table it reads; omit only for a ratio whose two sides each name their " +
      "own `table`), `concept` (the NAME of the concept this number means — " +
      "it must exist, create_concept first), `questions` (what it answers, " +
      "in the words someone would ask) and optionally `name`, the handle — " +
      "derived from the label when omitted and unique in the workspace. " +
      "\n\n`definition` is `{ aggregation, column?, numerator?, " +
      "denominator?, filters?, format?, direction?, target?, watchMargin? }`: " +
      "aggregation is sum, average, count, count_distinct, min, max, latest " +
      "(the value at the last date of each period — for a stock) or ratio " +
      "(numerator ÷ denominator, each `{ aggregation, column?, table?, " +
      "filters? }`). A filter is `{ column, operator, value }`. Column names " +
      "come from read_measure_design. A wrong combination is refused with a " +
      "422 that says why. " +
      "\n\nIt is a DRAFT until published: request_publish_measure. Only a " +
      "published measure gives a certified number.",
  },
  // The three below arrived with axonity-flow#1849 (axonity-mcp#78). None is
  // versioned or publish-approved: a change is live the moment it is saved, so
  // there is no draft to discard and no request_publish_*. Each lists one page
  // on the shared cursor.
  {
    singular: "data_source",
    basePath: "/api/v1/data-sources",
    updateMethod: "PUT",
    label: "data sources (warehouses the workspace may read, e.g. BigQuery)",
    publishable: false,
    hasDiscardDraft: false,
    deleteVersionParam: "expected_version",
    listPaging: { defaultPageSize: 20, maxPageSize: 200 },
    createNote:
      "CALL list_data_source_drivers FIRST. `sourceType` is a driver's " +
      "`driverId` (default \"bigquery\"), and `config` takes exactly the keys " +
      "that driver's `configFields` name — do not guess them. `secretId` " +
      "points at the vault secret holding the warehouse key; a human puts the " +
      "key there, never you, and the source never carries the key itself. A " +
      "source may be created without one and tested once it has it. " +
      "`policy` holds the limits every query is held to " +
      "(maxBytesBilled, maxSeconds, allowedDatasets, forbiddenDatasets, " +
      "personalColumns, dateFilters); all are empty by default. " +
      "\n\nThen test_data_source to see whether it answers. A table is " +
      "filled from this source through its own `provenance.sourceId` " +
      "(create_data_table) — not through a sync, and not through a " +
      "reference doc.",
    updateWarning:
      "NO DRAFT: this changes the live source, which every table it fills and every query " +
      "uses at once. `config` and `policy` are replaced WHOLE when sent — " +
      "read first and send the complete block.",
  },
  {
    singular: "table_relationship",
    basePath: "/api/v1/table-relationships",
    updateMethod: "PUT",
    label: "table relationships (how two tables join, for measures across them)",
    publishable: false,
    hasDiscardDraft: false,
    deleteVersionParam: "expected_version",
    listPaging: { defaultPageSize: 20, maxPageSize: 200 },
    createNote:
      "Fields: `fromTableId` + `fromColumn` (the MANY side — the facts, e.g. " +
      "orders), `toTableId` + `toColumn` (the ONE side — e.g. countries), " +
      "`cardinality` (many_to_one, the default, or one_to_one; there is no " +
      "many-to-many, it has no safe join) and an optional `description`. A " +
      "declaration that would make a total ambiguous — a second path between " +
      "the same two tables, say — is refused with a 422 that says why. Read " +
      "the sentence; it is the point.",
    updateWarning:
      "Only `verified` (somebody checked that the keys really match) and " +
      "`description` can change. To change the columns, delete and declare " +
      "it again.",
  },
  {
    singular: "dashboard",
    basePath: "/api/v1/dashboards",
    updateMethod: "PUT",
    label: "dashboards (tiles of measures over the workspace's model)",
    publishable: false,
    hasDiscardDraft: false,
    deleteVersionParam: "expected_version",
    listPaging: { defaultPageSize: 20, maxPageSize: 200 },
    createNote:
      "Fields: `name`, `description`, `visibility` (\"workspace\", the " +
      "default — everyone sees it — or \"private\") and `layout`, the " +
      "sections of tiles; omit it for an empty dashboard. A tile names a " +
      "measure by its name (list_measures). The layout is " +
      "checked when saved and a refusal names what is wrong.",
    updateWarning:
      "NO DRAFT: a saved dashboard is what everyone it is shared with sees. " +
      "`layout` is replaced WHOLE when sent — read first and send it complete.",
  },
];

/**
 * Entities with version history. Every authored entity here exposes the
 * `/versions*` routes, `flow` included (verified against the backend:
 * `/api/v1/flows/{id}/versions…`), so all eleven get the version tools.
 */
const VERSIONED: VersionedEntity[] = [
  { singular: "workflow", basePath: "/api/v1/workflows", publishedPath: "entity" },
  { singular: "agent", basePath: "/api/v1/agents", publishedPath: "entity" },
  { singular: "tool", basePath: "/api/v1/tools", publishedPath: "entity" },
  { singular: "skill", basePath: "/api/v1/skills", publishedPath: "versions" },
  { singular: "policy", basePath: "/api/v1/policies", publishedPath: "versions" },
  {
    singular: "reference_doc",
    basePath: "/api/v1/reference-docs",
    publishedPath: "versions",
  },
  { singular: "persona", basePath: "/api/v1/personas", publishedPath: "versions" },
  {
    singular: "output_schema",
    basePath: "/api/v1/output-schemas",
    publishedPath: "versions",
  },
  {
    singular: "prompt_snippet",
    basePath: "/api/v1/prompt-snippets",
    publishedPath: "versions",
  },
  { singular: "flow", basePath: "/api/v1/flows", publishedPath: "entity" },
  {
    singular: "data_table",
    basePath: "/api/v1/data-tables",
    publishedPath: "versions",
  },
  { singular: "measure", basePath: "/api/v1/measures", publishedPath: "versions" },
];

/**
 * Register the whole tool surface onto a server. Split out from `buildServer`
 * so a test can drive the real registration against a recording server — e.g.
 * to assert no tool ever targets a deny-listed route (publish/approve/secret/…).
 * `ServerLike` is the minimal `.tool()` surface both `McpServer` and a test
 * double satisfy.
 */
type ServerLike = Pick<McpServer, "tool">;

export function registerAll(server: ServerLike, client: AxonityClient): void {
  registerConventions(server as McpServer, client);
  for (const def of ENTITIES) {
    // Filters are GENERATED from the pinned schema (#48 M4), never declared on
    // the EntityDef — a filter the backend adds reaches an agent as soon as the
    // snapshot is refreshed, which the drift job now guarantees happens.
    registerEntityTools(server as McpServer, client, {
      ...def,
      listFilters: LIST_FILTERS[def.singular],
    });
  }
  for (const def of VERSIONED) {
    registerVersionTools(server as McpServer, client, def);
  }
  registerAuthoringSpecTools(server as McpServer, client);
  registerWorkflowMutations(server as McpServer, client);
  registerValidationTools(server as McpServer, client);
  registerExecutionTools(server as McpServer, client);
  registerApprovalTools(server as McpServer, client);
  registerTriggerTools(server as McpServer, client);
  registerRunTools(server as McpServer, client);
  registerPersonaTools(server as McpServer, client);
  registerConnectorTools(server as McpServer, client);
  registerAttachTools(server as McpServer, client);
  registerDependencyTools(server as McpServer, client);
  registerCatalogTools(server as McpServer, client);
  registerPromptPlacementTools(server as McpServer, client);
  registerCompanyTools(server as McpServer, client);
  registerSecretTools(server as McpServer, client);
  registerSubworkflowTools(server as McpServer, client);
  registerToolboxTools(server as McpServer, client);
  registerOperationsTools(server as McpServer, client);
  registerDataTableTools(server as McpServer, client);
  registerDataSourceTools(server as McpServer, client);
  registerMeasureTools(server as McpServer, client);
  registerDashboardTools(server as McpServer, client);
  registerConceptTools(server as McpServer, client);
  registerComponentTools(server as McpServer, client);
}

export function buildServer(client: AxonityClient): McpServer {
  const server = new McpServer({ name: "axonity", version: "0.1.0" });
  registerAll(server, client);
  return server;
}

async function main(): Promise<void> {
  assertNoExtraArguments(process.argv.slice(2));
  const config = loadConfig();
  const client = new AxonityClient(config);
  const server = buildServer(client);

  // Ask the deploy what it mounts BEFORE the transport is connected, so a
  // missing route is reported at startup rather than on the twentieth tool call
  // (#48 M2). It cannot fail and cannot hang: every path inside degrades to
  // today's behaviour and the whole thing is bounded by a timeout.
  // `registerAll` wants McpServer's overloaded `.tool()`; the probe server has
  // the one four-argument form every registrar here actually uses. The cast is
  // the same one every test that drives registerAll makes.
  await reportContractSkew(
    client,
    (probe, probeClient) => registerAll(probe as never, probeClient),
    { apiUrl: config.apiUrl },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr — stdout is the MCP channel and must stay clean.
  console.error(`Axonity MCP connector ready (${config.apiUrl}).`);
}

/**
 * True when this module is the process entry point.
 *
 * `import.meta.url` is realpath-resolved and percent-encoded, so it can't be
 * compared against a hand-built `file://${argv[1]}` string: npm installs the bin
 * as a symlink (`node_modules/.bin/axonity-mcp`), which is how `npx` runs it, and
 * paths with spaces encode differently. Both mismatches used to leave the server
 * silently unstarted. Resolve argv[1] the same way before comparing.
 */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    // argv[1] isn't a readable path (e.g. `node --eval`); not our entry point.
    return false;
  }
}

export function assertNoExtraArguments(argv: string[]): void {
  if (argv.length === 0) return;
  throw new Error(
    [
      "This MCP server does not accept command-line arguments.",
      "Usage:",
      "  axonity-mcp",
      "",
      "Pass configuration through environment variables instead:",
      "  AXONITY_TOKEN (required): the service token.",
      "  AXONITY_API_URL (optional): API base URL.",
      "",
      `Received arguments: ${argv.join(" ")}`,
    ].join("\n"),
  );
}

// Only run when executed directly (not when imported by tests).
if (isEntryPoint(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error("Axonity MCP connector failed to start:", err);
    process.exit(1);
  });
}
