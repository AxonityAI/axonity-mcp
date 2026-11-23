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
 * with AXONITY_TOKEN (a personal token, or a service token you still have)
 * and, if self-hosting, AXONITY_API_URL in the environment.
 *
 * It talks to Axonity ONLY over the public REST API; the backend re-enforces
 * tenant + scope on every call. Publishing is human-approved and lands in a
 * later slice (C3) — this connector never publishes directly.
 *
 * The same tools also run hosted by Axonity behind its `/mcp`
 * (AXONITY_MCP_TRANSPORT=http, see `http.ts`), for a caller with a personal
 * token. stdio stays the default.
 */

import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AxonityClient } from "./client.js";
import { loadConfig, loadHttpConfig, transportOf } from "./config.js";
import { startHostedServer } from "./http.js";
import { forPersonalTokens, routesPerTool } from "./routeClasses.js";
import { TOKEN_ROUTE_CLASSES } from "./generated/tokenRouteClasses.js";
import { type BackendPlan, type ProbeServer, followBackendContract } from "./contract.js";
import { registerConventions } from "./tools/conventions.js";
import { registerEntityContractTools } from "./tools/entityContract.js";
import {
  FULL_MONTH_NOTE,
  PERIODS,
  registerDashboardTools,
  registerDataSourceTools,
  registerMeasureTools,
} from "./tools/dataSources.js";
import { registerDataTableTools } from "./tools/dataTables.js";
import { assertFormulaShape, registerMeasureFormulaTools } from "./tools/measureFormula.js";
import { assertPlaceholderCredentials } from "./tools/credentials.js";
import {
  registerAttachTools,
  registerCatalogTools,
  registerConnectorTools,
  registerDependencyTools,
  registerPersonaTools,
  registerAgentTeamTools,
} from "./tools/extras.js";
import { registerApplicationTools } from "./tools/applications.js";
import { registerAccessTools } from "./tools/access.js";
import { registerAuthoringSpecTools } from "./tools/authoringSpec.js";
import { registerCompanyTools } from "./tools/company.js";
import { registerComponentTools } from "./tools/components.js";
import { registerConceptTools } from "./tools/concepts.js";
import { registerMeasureInfluenceTools } from "./tools/measureInfluences.js";
import { registerKnowledgeGraphTools } from "./tools/knowledgeGraph.js";
import { registerModelTools } from "./tools/model.js";
import { registerModuleTools } from "./tools/modules.js";
import { registerFlowAppTools } from "./tools/flowApps.js";
import { registerOperationsTools } from "./tools/operations.js";
import { registerMethodTools } from "./tools/methods.js";
import { registerPromptPlacementTools } from "./tools/promptPlacement.js";
import { registerQueryTools } from "./tools/queries.js";
import { LIST_FILTERS } from "./generated/listFilters.js";
import { type EntityDef, registerEntityTools } from "./tools/register.js";
import { registerTrashTools } from "./tools/trash.js";
import { registerRunTools } from "./tools/runs.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { registerNewFlowAppPrompt } from "./prompts/newFlowApp.js";
import { registerActionApprovalTools } from "./tools/actionApprovals.js";
import { registerFlowAppResources } from "./resources/flowApp.js";
import { registerRunInputFileTools } from "./tools/runInputFiles.js";
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

/**
 * What fills a table (axonity-flow#2013). The inline `provenance` bag is gone:
 * its SQL, source and grain moved to a named query, and what stays on the
 * table is which filler it has and when it runs.
 */
const FILL_NOTE =
  "WHAT FILLS IT — `filledBy`, one word: `author` (the default: reference " +
  "data its author maintains), `workflow` (a workflow writes the rows, " +
  "limited to `allowedOperations`), `query` (a named query fetches them) or " +
  "`source` (the rows stay in a data source and this table describes them). " +
  "A table has ONE filler. `isDynamic` is no longer sent: it follows from " +
  "`versioning` (below) — a table read live is dynamic, one frozen at each " +
  "publication is not, and a source table never is. " +
  "\n\nA SOURCE TABLE (`filledBy: \"source\"`) holds no rows here. " +
  "`external` says where it lives: `sourceId` (one of this workspace's data " +
  "sources, list_data_sources), `container` (what that source calls the " +
  "thing the table is in: a BigQuery dataset, a PostgreSQL schema) and " +
  "`object` (the table's own name there, exactly as SQL names it). " +
  "`external` is required for a source table and refused otherwise; rows, " +
  "`allowedOperations`, `fillingQueryId`, `rhythm` and `dateTable` are " +
  "refused on one. " +
  "\n\n`grain` says what one row is (\"one row per order line\"): required " +
  "for a source table, refused when a query fills the table (its query says " +
  "it). " +
  "\n\n`versioning` — how the rows are versioned, apart from what fills " +
  "them: `config` (frozen into each published version: a change reaches a " +
  "run when the table is published) or `live` (a run reads them as they are " +
  "now). Only a table its author fills may choose; every other filler is " +
  "`live`. Left out on create: `config` for an author's table, `live` " +
  "otherwise; on an update the table keeps its versioning unless `filledBy` " +
  "changes, and then it gets the new filler's default. " +
  "\n\nWHAT A MEASURE READS: every table whose rows Flow holds, whatever " +
  "fills it — not a source table, whose rows stay in its data source. A " +
  "`config` table — an author's table by default (a plan, a target per " +
  "period, a mapping) — is read AS PUBLISHED: a row changed in the draft " +
  "counts for no number until the table is published again " +
  "(ensure_data_table_major_version, then request_publish_data_table). A " +
  "`live` table — every table a query or a workflow fills, and an author's " +
  "table set to `live` — has its rows read as they are now. " +
  "\n\nFILLED BY A QUERY: `fillingQueryId` is the query (create_query, " +
  "list_queries), and one query fills one table. It is refused on a table " +
  "another filler fills. A query table may be saved without one — unfinished, " +
  "it fills nothing — but a `rhythm` without one is refused, and so is " +
  "refresh_data_table. The query carries the SQL, the source " +
  "and the grain. `rhythm` says when and how it fills: " +
  "`{ cron, timezone?, keyColumns?, mode?, enabled? }` — `cron` when it " +
  "runs, read in `timezone` (default UTC; an empty cron never runs by " +
  "itself); `mode` `upsert` (the default: replaces the rows that match " +
  "`keyColumns` and adds the rest) or `append` (takes no key); `enabled: " +
  "false` pauses it and keeps its rows. Leave `rhythm` out and the table " +
  "fills only when asked: refresh_data_table. The fill runs the query as " +
  "it stands. " +
  "\n\n`provenance` and `clearProvenance` no longer exist and are refused " +
  "— the query took their place. " +
  "\n\nMEASURES ARE NOT ON THE TABLE. A measure is its own entity " +
  "(create_measure); a table carries only its `timeAxis` " +
  "(`{ column, grain }`), which every measure over it reads.";

/**
 * The date table and its calendars (axonity-flow#1908, phase 2): what a time
 * window in a formula is measured in. Metadata on a table, not an entity.
 */
/** What a change to the model may do to a published measure (axonity-flow#1908). */
const BREAKS_MEASURE_NOTE =
  "`breaks_measure`: refused when a PUBLISHED measure reads what this " +
  "change takes away — a column, the table, or the relationship a part " +
  "reaches a dimension over. The refusal names the measures: repair them " +
  "first (update_measure, then publish), then retry.";

/**
 * The database (axonity-flow #2444, R0b). Every sentence is the schema's own
 * field description or a refusal in `services/table_database_service.py` and
 * `domain/table_databases.py`.
 */
const DATABASE_NOTE =
  "A DATABASE is a named group of tables. `kind` is `data_model` (tables of " +
  "one subject that join; the default), `shared` (tables other databases use " +
  "— the conformed dimensions, such as a calendar or the countries) or " +
  "`workspace` (tables the platform keeps for the workspace itself, no data " +
  "model). `name` is unique in the workspace, and so is `slug`, the handle a " +
  "person types and a configuration file is named by: lowercase letters, " +
  "digits and single hyphens; left out on create it is derived from the " +
  "name. `owner` is who answers for it, a role or a person, as text.";

const DATABASE_UPDATE_NOTE =
  "A new name keeps the old slug unless `slug` is sent. A system database " +
  "(one the platform ships) is locked: an edit of it is refused. A table is not " +
  "moved here: a database holds no list of its tables, the table says " +
  "which one it is in — update_data_table with `databaseId`, or " +
  "`clearDatabase: true`.";

const DATABASE_DELETE_NOTE =
  "Only an EMPTY database is deleted: one that still holds live tables is " +
  "refused with a 409 (\"This database still holds N tables. Move the " +
  "tables to another database first; the tables stay.\") — move them with " +
  "update_data_table (`databaseId`, or `clearDatabase: true` to take one out " +
  "of every database), then delete. A system database is refused too.";

const DATE_TABLE_NOTE =
  "THE DATE TABLE — `dateTable: true` marks the ONE table of the workspace " +
  "with a row per day (its `timeAxis` on the day column, grain `day`, no " +
  "gaps): what makes a week mean the same thing to every fact. A second one " +
  "is refused. On it, `calendars` (at most 10): " +
  "`[{ name, label?, isDefault?, grains: { year?, quarter?, month?, week?, " +
  "day? } }]`, each grain naming the column of this table that holds that " +
  "period — e.g. a calendar `production` whose `week` is the production " +
  "week. `name` is what a formula writes (`rolling([revenue], 4 week, " +
  "production)`); exactly one is `isDefault`, used when a formula names " +
  "none. A grain left out is a grain that calendar does not have. A formula " +
  "stores its calendar BY ID: when you change `calendars`, read the table " +
  "first and send every calendar back WITH its `id` — the list is replaced " +
  "whole, and a calendar sent without one is a new calendar. " +
  "`dateTable: false` takes the calendars with it. A fact table reaches " +
  "the date table through its own `timeAxis`.";

/**
 * A dashboard's periods — its own `layout.period`, a tile's `config.period`,
 * `period` on each compared row of a bars tile — take the names
 * query_measures takes (backend `src/domain/dashboards.py`).
 */
const TILE_PERIOD_NOTE =
  `THE PERIOD — the dashboard's own \`layout.period\`, a tile's ` +
  `\`config.period\`, and \`period\` on each compared row of a bars tile — ` +
  `is one of: ${PERIODS}. ${FULL_MONTH_NOTE} ` +
  "`layout.periodPicker` is free (default), full_periods or hidden. " +
  "full_periods requires layout.period to be last_month, last_quarter, " +
  "last_3_full_months, last_12_full_months or year_to_last_full_month. " +
  "The viewer may also choose a closed month/quarter without changing the " +
  "saved layout; query it with period null and start/end dates, end inclusive. " +
  "hidden hides the viewer's selector and keeps layout.period. A tile's own " +
  "period or fixed start/end dates take precedence (not on a statement tile, " +
  "which reads the dashboard's period).";

/** Number comparisons and expected bands are validated by the backend. */
const TILE_NUMBER_NOTE =
  "\n\nA NUMBER TILE may carry `config.against: {measure, label?}`: " +
  "a non-empty measure NAME different from config.measure, and an optional " +
  "label of at most 120 characters (otherwise the basis measure's label). " +
  "This sets it against another number, never its status. Quantity and " +
  "filter compatibility are checked when queried. `config.sparkline` is " +
  "none, trend (default) or bullet; bullet requires config.against. " +
  "none/bullet ask for grain none, trend for auto. Only number tiles accept " +
  "against or sparkline. compare and against are independent: set " +
  "`compare: \"none\"` explicitly for the basis comparison alone. " +
  "For an S card with both comparisons, omit the trend or choose M; the " +
  "viewer enforces this space constraint, not the API schema. " +
  "`config.showExpected` is a boolean, only on number or trend tiles, " +
  "to request the measure's expected band. The period and comparison " +
  "caption come from the answer; caption remains context, with no variables.";

/** Section mechanics and arranging (axonity-flow#2576 parts 5 and 8) — validated by the backend. */
const LAYOUT_ARRANGING_NOTE =
  "\n\nSECTIONS — the status chip of a section is computed: the worst status " +
  "of its tiles that have limits, with the reason; no tile with limits, no " +
  "chip; a `section.status` an author typed still wins. Its \"Follow up\" " +
  "links the tiles outside their limits. `section.answer` is the one-sentence " +
  "answer slot above the tiles (plain text, at most 400 characters; empty " +
  "shows nothing; leave a field out to clear it; null is refused). `section.collapse` is open or closed (how a foldable " +
  "section opens; absent = not foldable). `section.phoneOrder` is a list of " +
  "tile ids in the order a phone shows them; tiles not named follow in " +
  "desktop order, an id no longer in the section is skipped, a repeated id is " +
  "refused. `layout.overview` (true) puts a summary at the top: each titled " +
  "section with its chip and answer, clickable. SIZES besides S, M, L, XL: " +
  "\"T\" tall 1×2, \"W\" three wide 3×1, \"R\" a full row as high as its " +
  "content; every type takes them. In View the tile before a gap at the end " +
  "of a row widens to fill it and the order never changes, so a gap under " +
  "a short tile beside a tall one stays." +
  "\n\nTHE VIEWER — bars per group with `against` or `compare` draw the plan " +
  "and last year as a marker line on each bar. A viewer may keep a period on " +
  "one tile from the drill panel; it is not saved, only carried in the link " +
  "(`?period=…&tile.<id>=…&split=<id>`), and never changes a section's " +
  "status, answer or the overview.";

/** The statement tile (P&L), axonity-flow#2576 part 1 — validated by the backend. */
const TILE_STATEMENT_NOTE =
  "\n\nA STATEMENT TILE (`statement`, size L, XL or one of T, W, R — R grows " +
  "with its lines) is a P&L: lines of " +
  "measures. `config.rows` is the list of lines, at most 20 lines, each " +
  "`{label, measure, style?, indent?}`: `measure` by NAME, `style` " +
  "line (default), subtotal (bold) or total (bold, ruled above), `indent` 0–2. " +
  "A line has no period of its own, and a statement sets no period, start, " +
  "end, measure or statusMeasure: every line reads the dashboard's period " +
  "(or the one a viewer keeps on the tile) and its own measure. " +
  "`config.statementColumns` picks and orders " +
  "the columns from: period, period_last_year, period_change, period_share, " +
  "period_share_change, ytd, ytd_last_year, ytd_change, ytd_share, " +
  "ytd_share_change — `period` is the dashboard's period, `ytd` the year up to " +
  "that period's last day, `_change` the change against last year, `_share` " +
  "the share of the `config.shareOf` row (the LABEL of one of its lines) and " +
  "`_share_change` how that share moved, in percentage points. Omitted: period, " +
  "period_change, ytd, ytd_change, plus ytd_share and ytd_share_change when " +
  "shareOf is set; a share column needs shareOf. Values keep their sign: a " +
  "cost stored as a negative amount reads with a minus, and a change is " +
  "coloured by the measure's own direction. Each line's measure counts as " +
  "named by the dashboard (it cannot be renamed or deleted while there). " +
  "Set `config.tableId` on the tile for its lines to open the drill panel; " +
  "without it a line is plain text. " +
  "The lines are set here; Edit does not offer the type.";

/**
 * What writing a measure takes (axonity-flow#1908). The contract, not a manual:
 * the words of the formula are in get_measure_formula_spec and nowhere else.
 */
const MEASURE_NOTE =
  "READ get_measure_formula_spec FIRST; never write a function, operator or " +
  "grain from memory. A measure is ONE formula, `definition.expression`, " +
  "as text or as the stored tree. Four kinds, one grammar: " +
  "\n- a BASE aggregates one COLUMN of one table: " +
  "`sum(orders.amount) where orders.channel = 'd2c'`. It reads a column, " +
  "never a calculation per row — a value per row belongs in the query " +
  "that fills the table, as a column of its own; " +
  "\n- a DERIVED measure computes with other measures by name: " +
  "`[revenue_d2c] + [revenue_retail]`, `divide([cm1], [net_revenue])`, " +
  "`divide([revenue_d2c], [net_revenue] ignore orders.channel)` for a share " +
  "of the total. Two fact tables may meet in one number; they are never " +
  "joined; " +
  "\n- TIME (`shift`, `to_date`, `rolling`) and CUMULATIVE (`running`): " +
  "the same measure in another window, measured in a calendar of the " +
  "workspace's date table (create_data_table / update_data_table with " +
  "`dateTable` and `calendars`); without one they are refused with " +
  "`no_date_table`. " +
  "\n\nBuild bottom-up: the base measures first, each with its `quantity` " +
  "(what it counts: EUR, customers, orders), then the derived ones; " +
  "validate_measure before every save, and publish from the bottom up. " +
  "\n\nFields: `label` (what a tile shows), `description` (what the number " +
  "means — mandatory, an agent reads it to decide whether this is the " +
  "number asked for), `definition`, `concept` (the NAME of the concept this " +
  "number means — it must exist, create_concept first, and a derived " +
  "measure needs one too), `questions` (what it answers, in the words " +
  "someone would ask) and optionally `name`, the handle — derived from the " +
  "label when omitted and unique in the workspace. `definition` is " +
  "`{ expression, quantity?, format?, direction?, limits?, rangeMethod? }`; " +
  "`quantity` is derived for a formula over measures. " +
  "\n\nA STATUS IS A MEASURE AND ITS LIMITS. `limits` are the bands a " +
  "status is read from, LOWEST VALUES FIRST: `[{ status: \"off_track\", " +
  "upTo: -0.05, includesUpTo: false }, { status: \"watch\", upTo: 0, " +
  "includesUpTo: false }, { status: \"on_track\" }]`. `status` is " +
  "on_track, watch or off_track. Every band but the last has `upTo`, in " +
  "the measure's own unit as the number comes out (a percentage as a " +
  "fraction: 0.05 is 5%), rising strictly from band to band, and " +
  "`includesUpTo` — whether the bound itself belongs to this band; it is " +
  "required, because whether exactly -5% is still off track is the " +
  "owner's call. The last band has neither. At least two bands. Take the " +
  "bounds from the owner — never invent them. No `limits`, no status: " +
  "there is no default. A wrong list is refused with `bad_limits`. To " +
  "watch a figure against its plan, write the measure 'deviation from " +
  "plan' (recipe `against_plan_with_limits` in get_measure_formula_spec) " +
  "and put the limits on THAT; a tile can show the figure and read its " +
  "status from the deviation (`statusMeasure`). `direction` stays: it " +
  "colours a change (is going up good?), not the status. " +
  "\n\nAN EXPECTED RANGE is optional `definition.rangeMethod`: " +
  "`{method, grain, periods}`. Read `rangeMethods` in " +
  "get_measure_formula_spec for the methods, when they fit and their " +
  "settings. The owner chooses all three; there is no default. The " +
  "backend checks them on save (`bad_range_method`), including a time " +
  "axis and a grain no finer than any table the measure reads. An " +
  "expected range describes what is normal and never changes the status. " +
  "\n\nThe fields from before the formula — `tableId`, `clearTable`, " +
  "`definition.aggregation`, `column`, `numerator`, `denominator` — and " +
  "`definition.target` and `watchMargin`, from before a status was a " +
  "measure and its limits, are refused with `legacy_field`. " +
  "\n\nIt is a DRAFT until published: request_publish_measure. Only a " +
  "published measure gives a certified number.";

/**
 * What an application is made of (axonity-flow#1901). The limits are the point:
 * an executor enforces them on every command, so a wrong key is a limit nobody
 * enforces — the platform refuses unknown keys, and this says which exist.
 */
const APPLICATION_NOTE =
  "Fields: `name` (unique in the workspace), `technology` (`win32` for a " +
  "Windows desktop program, `web` for a site in a browser), `description` " +
  "and `limits` — what an agent may NEVER do in it, enforced by the executor " +
  "on the machine. `limits` keys stay snake_case, the way the executor reads " +
  "them, and an unknown key is refused: `processes` (executables it may " +
  "touch, `app.exe`), `windows` (window classes it may act in), " +
  "`never_keys` (key combinations it may never send, `ctrl+a`), " +
  "`never_buttons` (button captions it may never press), `folders` (folders " +
  "it stays inside), `domains` (web domains it stays inside, " +
  "`nl.wikipedia.org`), `secrets` (workspace secrets it may type, BY NAME — " +
  "never a value), `home` (a website's start address) and `readers` (per " +
  "control class, how a screen reader reads it). " +
  "\n\nAn executor receives only the PUBLISHED limits, never a draft: " +
  "request_publish_application, then a human approves. Which machines run it " +
  "is set_application_executors.";

/**
 * Who may read a piece of knowledge (axonity-mcp#88, S2; axonity-flow#1918).
 * The four knowledge kinds carry a label; the backend already took the fields,
 * and nothing told an agent they exist or that `null` means "nobody".
 */
const LABEL_NOTE =
  "WHO MAY READ IT — the label. `level` is how sensitive it is (public, " +
  "internal or confidential); `audienceIds` is whom it is meant for, as ids " +
  "from list_audiences — never guess one and never match on a name. Leave " +
  "both out and it gets the workspace default: internal, for Staff. " +
  "Sending `level: null` means NO label: nobody can read it — no colleague, " +
  "no agent — until a colleague who maintains its audience labels it. You " +
  "can only give a label you can read yourself.";

const LABEL_UPDATE_NOTE =
  "CHANGING WHO MAY READ IT. Narrowing is always allowed: a higher " +
  "`level`, or an audience taken away. WIDENING — a lower level, or an " +
  "audience added — makes it readable for more people, which is publishing " +
  "it, and only a colleague who maintains those audiences may do that. A " +
  "token never can: the refusal says so, and the way forward is to ask a " +
  "colleague in Axonity, not to try another route. `audienceIds` replaces " +
  "the whole set — send the ones it keeps too. `level: null` removes the " +
  "label, which leaves it readable by nobody.";

/** What an agent or a process may read (axonity-mcp#88, S2). */
const CLEARANCE_SHAPE =
  "`clearance` is `{ maxLevel, audienceIds }`: up to which level it reads " +
  "(public, internal or confidential; null reads nothing) and for which " +
  "audiences (ids from list_audiences).";

const AGENT_CLEARANCE_NOTE =
  "WHAT THE AGENT MAY READ. " +
  CLEARANCE_SHAPE +
  " Only an ADMINISTRATOR sets it, so a token sending it is refused: leave " +
  "it out and the agent gets the workspace default, internal for Staff. " +
  "Inside a workflow the agent never reads more than the workflow's own " +
  "clearance.";

/**
 * An agent holds a whole box (DECISIONS.md 11). Each sentence is the backend's:
 * `expand_toolbox_grants` (which version of the box counts, what is left out),
 * `AgentService._validate_toolbox_ids` (refused by name) and
 * `AgentService.archived_box_blockers` (an archived box blocks the publish).
 */
const AGENT_TOOLBOX_NOTE =
  "WHOLE TOOLBOXES. `toolboxIds` gives the agent every tool a toolbox holds, " +
  "without naming each one in `toolIds`. What it gets is the published " +
  "version of the box, read at each run: a tool put in the box reaches the " +
  "agent on its next run once the BOX is published, with no new publication " +
  "of the agent, and a tool put in but not yet published reaches nobody. An " +
  "id that is not a live toolbox of this workspace is refused (\"These " +
  "toolboxes do not exist in this workspace\"), not dropped. An archived box " +
  "the agent holds blocks its publication. Sending `toolboxIds` replaces the " +
  "list; `[]` empties it. Who holds a box: list_toolbox_agents.";

const TOOL_LIST_NOTE =
  "`needsSecret` is true when the tool's own credential names a secret; a " +
  "credential inherited from its toolbox is not counted here. `dryRunStale` is " +
  "true when the tool is live, carries authored code, and that code has " +
  "changed since its last clean dry-run: the live version keeps running, and " +
  "the next publish needs a new dry-run. Who uses a tool: read_tool_used_by.";

/** From `publish_readiness.toolbox_member_blockers`, the sentence a publish says. */
const TOOLBOX_PUBLISH_NOTE =
  "Publishing a box makes what it holds live for every agent that holds it " +
  "whole (list_toolbox_agents). It is refused while a tool in the box has no " +
  "published version (\"Tool '…' in this box has no published version. " +
  "Publish it first, or take it out of the box.\") or is archived (\"… is " +
  "archived. Unarchive it first, or take it out of the box.\"): publish or " +
  "unarchive those first.";

/**
 * Restore and discard on a box put the membership back through `tools.toolbox_id`
 * (`ToolboxService.restore_version` / `discard_draft`), so tools move at once,
 * with the live consequences a filing has: how they are advertised and which
 * shared credential they inherit.
 */
const TOOLBOX_RESTORE_NOTE =
  "For a toolbox it also puts the membership back at once: tools move in or " +
  "out of the box immediately, which changes how they are advertised and " +
  "which shared credential they inherit, while what an agent holding the box " +
  "gets stays on the published version until a human approves a new publish.";

const TOOLBOX_DISCARD_NOTE =
  "For a toolbox this puts the membership back at once: tools move in or out " +
  "of the box immediately, with the same live effect on how they are " +
  "advertised and which shared credential they inherit.";

/**
 * What an agent must know before it writes a method. Each sentence is the
 * backend's own behaviour (`MethodService`, `routes/methods.py`), and
 * `test/methods.test.ts` pins them: the transition-target message, the
 * start-step rule (`_runner_start_name`, `update_method`), the replace of the
 * whole step list (`_replace_steps`), the in-use refusal (`refuse_if_in_use`).
 */
const METHOD_CREATE_NOTE =
  "A method is a `name`, a `description` and `methodSteps`: how an agent works " +
  "through a workflow step. Each step has a `name` (unique in the method), a " +
  "`displayOrder` and an `exitTool` (`{ name, jsonSchema }`, required), and may " +
  "have `transitions` saying where it goes next: `{ when: 'auto', next }` goes " +
  "to one step; `{ when: 'fork', forkField, routes, default }` reads " +
  "`forkField` from the exit tool's payload and goes to the step `routes` names " +
  "for that value, else to `default`. A target (`next`, `default`, a route's " +
  "value) is another step of the same request, by its name — or by the id a " +
  "read gave it; anything else is refused (\"Transition target … does not match " +
  "any step.\"). A step with no transition ends the method. `firstStepName` " +
  "says which step it starts on; left out, it starts on the step with the " +
  "lowest `displayOrder`. This makes a draft: the runtime reads the published " +
  "version (read_method_published), which request_publish_method asks a " +
  "person to approve.";

const METHOD_UPDATE_NOTE =
  "`methodSteps` replaces the WHOLE step list: send every step you keep, as " +
  "read_method gave it (a step is matched by its `id`, else by its name; a " +
  "step you leave out is removed). Leave `methodSteps` out to change only the " +
  "name or description. The start is explicit: every save pins the step it " +
  "starts on, so reordering never moves where it starts. `firstStepName` " +
  "moves it to another step; if the step it was on is gone and you name none, " +
  "it falls to the step with the lowest `displayOrder`. A method provided by " +
  "the platform cannot be edited — the update is refused (403); clone_method makes " +
  "a copy of your own, which you can.";

const METHOD_DELETE_NOTE =
  "A method that a PUBLISHED workflow still runs is refused with a 409 " +
  "(\"Cannot delete: method is referenced by published workflow(s): …\"): " +
  "a draft that names it does not block, because a draft does not run it. " +
  "read_method_used_by says which workflows and agents. A method the " +
  "platform provides is refused too.";

const METHOD_PUBLISH_NOTE =
  "A method's approval names no version: its `version` is null.";

const METHOD_LIST_NOTE =
  "Each row: id, name, description, `stepCount`, `usedByCount` (how many " +
  "agents run it, through workflows in use), `publishedMajorVersion` and " +
  "`draftMajorVersion` (null while there is none), `isPlatform` (true for one " +
  "the platform provides: read it, clone_method to change a copy), " +
  "`archivedAt`, `module`, `scope`, `version`, `updatedAt`. The steps are in " +
  "read_method.";

const WORKFLOW_CLEARANCE_NOTE =
  "WHAT THE PROCESS MAY READ. " +
  CLEARANCE_SHAPE +
  " Set it to the audiences of whoever the process serves. A new workflow " +
  "starts with the workspace default (internal, for Staff); change it with " +
  "update_workflow({ fields: { clearance } }). It takes effect through the " +
  "publish approval like the rest of the workflow, and no agent in the " +
  "process ever reads more than this.";

/**
 * What a query is made of (axonity-flow#2010, S1). A query is a named, typed
 * read of one source: it answers an agent's question once published, and it
 * fills a table. The SQL, source and grain that used to sit in a table's
 * `provenance` live here now.
 */
const QUERY_NOTE =
  "A QUERY is a named, typed read of one data source. Published, it does " +
  "two things: it becomes a read tool an agent can be given (its " +
  "`description` is what that agent reads), and it can fill a table " +
  "(`filledBy: \"query\"`, `fillingQueryId` on the table). " +
  "\n\nFields: `name` (unique in the workspace; the tool carries it), " +
  "`description` (what it answers), `dataSourceId` (required — " +
  "list_data_sources), `sql` (read-only, in the warehouse's own dialect, " +
  "with each input written `:name`; read_data_source_schema spells the " +
  "tables), `grain` (what ONE ROW is, as a sentence — \"one row per month " +
  "per country\"), `questions` (how somebody would ask for this, at most " +
  "20), `parameters`, `returns` and `reads`. " +
  "\n\n`reads` (`[{ container, object }]`) is the objects of the source " +
  "the query reads, each a `container` (dataset or schema) and an `object` " +
  "(table or view) as the source names them — your statement, not a parse " +
  "of the SQL; the catalogue shows an object as 'in a data table' from it. " +
  "\n\n`parameters` (at most 20): `[{ name, label?, kind, description?, " +
  "required?, default?, choiceOptions? }]`. `kind` is text, number, date, " +
  "datetime, time, yes-no or choice — one value, never a list or an " +
  "object. A value is BOUND, never written into the statement. An optional " +
  "one with no value binds NULL, which is what `(:land is null or l = " +
  ":land)` is written for. " +
  "\n\n`returns`: `[{ name, label?, kind, description, concept? }]`, one " +
  "per column the statement hands back, named exactly as it returns it. " +
  "`kind` adds object and list to the parameter kinds. Every column needs " +
  "a `description` before the query can be published. " +
  "\n\nThe statement can carry its own figures: a query with no table " +
  "behind it (a `select … union all select …` of plan values) is a query " +
  "like any other. Try it with test_query before you ask for publication; " +
  "its answer suggests `returns` from what came back.";

/**
 * The entities the connector covers. Core entities (C4), memory entities (C5)
 * — skills, policies, reference docs — which have the same draft→publish
 * lifecycle via #443's unified versioning, and `data_table` (axonity-flow#1217),
 * which joins them on exactly the same shape.
 */
export const ENTITIES: EntityDef[] = [
  {
    singular: "workflow",
    archivable: true,
    archiveGuard: "in_use",
    basePath: "/api/v1/workflows",
    updateMethod: "PATCH",
    label: "workflows (business processes)",
    deleteVersionParam: "expectedVersion",
    createNote: WORKFLOW_CLEARANCE_NOTE,
    updateWarning: WORKFLOW_CLEARANCE_NOTE,
  },
  {
    singular: "agent",
    archivable: true,
    archiveGuard: "in_use",
    statusRetired: true,
    basePath: "/api/v1/agents",
    updateMethod: "PUT",
    label: "agents",
    createExample: ["name", "persona"],
    deleteVersionParam: "expectedVersion",
    createNote: AGENT_CLEARANCE_NOTE + "\n\n" + AGENT_TOOLBOX_NOTE,
    updateWarning: AGENT_CLEARANCE_NOTE + "\n\n" + AGENT_TOOLBOX_NOTE,
  },
  {
    singular: "tool",
    archivable: true,
    archiveGuard: "in_use",
    statusRetired: true,
    basePath: "/api/v1/tools",
    updateMethod: "PUT",
    label: "tools (functions, connectors, validators, evaluators)",
    // A connector is just a tool, so create_tool/update_tool can carry an
    // authConfig too — they get the same credential guard as create_connector.
    guardFields: assertPlaceholderCredentials,
    deleteVersionParam: "expectedVersion",
    listNote: TOOL_LIST_NOTE,
  },
  {
    // A box is a versioned kind since Tools (R9 of agent-first, DECISIONS.md 18):
    // draft, publication through approval, archive, the Trash. What the generic
    // registrar says about those is generated here; list, create, update and
    // delete are `tools/toolboxes.ts`, which types the fields and keeps the
    // lock's spelling. Not a `statusRetired` kind: a box never had a `status`.
    singular: "toolbox",
    plural: "toolboxes",
    archivable: true,
    archiveGuard: "in_use",
    restoreRename: true,
    basePath: "/api/v1/toolboxes",
    updateMethod: "PUT",
    label: "toolboxes (the groups a workspace's tools are filed in, and what an agent can hold whole)",
    deleteVersionParam: "expected_version",
    ownTools: ["list", "create", "update", "delete"],
    publishNote: TOOLBOX_PUBLISH_NOTE,
    discardNote: TOOLBOX_DISCARD_NOTE,
  },
  {
    singular: "skill",
    archivable: true,
    restoreRename: true,
    statusRetired: true,
    basePath: "/api/v1/skills",
    updateMethod: "PUT",
    label: "skills (reusable know-how for agents)",
    deleteVersionParam: "expected_version",
    createNote: LABEL_NOTE,
    updateWarning: LABEL_UPDATE_NOTE,
  },
  {
    singular: "policy",
    archivable: true,
    restoreRename: true,
    statusRetired: true,
    basePath: "/api/v1/policies",
    updateMethod: "PUT",
    label: "policies (rules and guardrails for agents)",
    createExample: ["name", "summary"],
    plural: "policies",
    deleteVersionParam: "expected_version",
    createNote: LABEL_NOTE,
    updateWarning: LABEL_UPDATE_NOTE,
  },
  {
    singular: "reference_doc",
    archivable: true,
    restoreRename: true,
    statusRetired: true,
    basePath: "/api/v1/reference-docs",
    updateMethod: "PUT",
    label: "reference docs (background knowledge for agents)",
    createExample: ["title", "description"],
    deleteVersionParam: "expected_version",
    createNote: LABEL_NOTE,
    updateWarning: LABEL_UPDATE_NOTE,
  },
  {
    singular: "output_schema",
    archivable: true,
    archiveGuard: "in_use",
    restoreRename: true,
    statusRetired: true,
    basePath: "/api/v1/output-schemas",
    updateMethod: "PUT",
    label: "output schemas (reusable step/agent output contracts)",
    // Now fully version-controlled and in the publish-approval gateway
    // alongside the memory entities — no longer live-on-write.
    deleteVersionParam: "expected_version",
  },
  {
    singular: "prompt_snippet",
    archivable: true,
    archiveGuard: "locked",
    basePath: "/api/v1/prompt-snippets",
    updateMethod: "PATCH",
    label: "prompt snippets (reusable prompt fragments)",
    deleteVersionParam: "expectedVersion",
  },
  {
    // A "flow" until Flow renamed it (agent-first R6): the old tool names stay
    // one release as an alias, and `flowSteps` is still read as `methodSteps`.
    singular: "method",
    formerSingular: "flow",
    formerFields: { flowSteps: "methodSteps" },
    archivable: true,
    archiveGuard: "in_use",
    basePath: "/api/v1/methods",
    updateMethod: "PATCH",
    label: "methods (how an agent works through a workflow step: its steps and where each goes next)",
    deleteVersionParam: "expectedVersion",
    createNote: METHOD_CREATE_NOTE,
    updateWarning: METHOD_UPDATE_NOTE,
    deleteNote: METHOD_DELETE_NOTE,
    publishNote: METHOD_PUBLISH_NOTE,
    listNote: METHOD_LIST_NOTE,
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
    archivable: true,
    archiveGuard: "in_use",
    restoreRename: true,
    statusRetired: true,
    basePath: "/api/v1/data-tables",
    updateMethod: "PUT",
    plural: "data_tables",
    label: "tables (authored reference data agents and decisions read)",
    deleteVersionParam: "expected_version",
    listPaging: { defaultPageSize: 20, maxPageSize: 200 },
    createNote: `${FILL_NOTE}\n\n${DATE_TABLE_NOTE}\n\n${LABEL_NOTE}`,
    deleteNote: BREAKS_MEASURE_NOTE,
    publishNote: BREAKS_MEASURE_NOTE,
    updateWarning:
      FILL_NOTE +
      " On an update: `clearFillingQuery: true` takes the query away and " +
      "leaves the rows that are there; `rhythm` is replaced whole when sent; " +
      "`clearRhythm: true` takes it away (the table then fills only when " +
      "asked), which is not the same as pausing it. " +
      "`clearExternal: true` takes a table's place in a data source away, " +
      "only together with a `filledBy` other than `source` (the table is " +
      "handed back to Flow), and that change needs it: a source table keeps " +
      "its place. " +
      "`clearGrain: true` takes away what one row is; it is refused on a source " +
      "table, which must say it. " +
      "`databaseId` files the table in one of the workspace's databases (an id " +
      "that is not a live database of this workspace is refused); " +
      "`clearDatabase: true` takes the table out of its database, and wins over " +
      "`databaseId` when both are sent. " +
      "`clearTimeAxis: true` takes the time axis away; on a date table that " +
      "carries calendars only together with `calendars: []` or " +
      "`dateTable: false` (which takes the calendars with it) in the same " +
      "update, because a calendar needs a dated row per day. " +
      "\n\n" +
      DATE_TABLE_NOTE +
      "\n\n`rows` AND `columns` ARE WHOLE-COLLECTION FIELDS: sending either " +
      "REPLACES it entirely. Passing one row in `rows` does not append it — it " +
      "deletes every other row in the table. To change content, use " +
      "add_data_table_row / update_data_table_row / delete_data_table_row, " +
      "which address a single row and cannot destroy the rest. Use `rows` here " +
      "only when you genuinely mean to replace the whole content." +
      "\n\n" +
      LABEL_UPDATE_NOTE,
  },
  {
    // Main #2470 brought databases onto the shared lifecycle (§4.9).
    // The same registrar and guards apply; no separate archive implementation.
    singular: "table_database",
    archivable: true,
    archiveGuard: "in_use",
    restoreRename: true,
    statusRetired: true,
    basePath: "/api/v1/table-databases",
    updateMethod: "PUT",
    plural: "table_databases",
    label: "databases (the named groups the tables of a workspace live in)",
    createExample: ["name", "kind"],
    deleteVersionParam: "expectedVersion",
    listPaging: { defaultPageSize: 20, maxPageSize: 200 },
    createNote: DATABASE_NOTE,
    deleteNote: DATABASE_DELETE_NOTE,
    updateWarning: DATABASE_NOTE + "\n\n" + DATABASE_UPDATE_NOTE,
  },
  {
    // A measure was a field on a table; the semantic model (axonity-flow#1881
    // S12, #1841) made it an entity of its own, in the same order and spelling
    // as a table's routes — so the whole family, versions and publish request
    // included, comes from the registrars with no code of its own.
    singular: "measure",
    archivable: true,
    archiveGuard: "in_use",
    restoreRename: true,
    statusRetired: true,
    basePath: "/api/v1/measures",
    updateMethod: "PUT",
    label: "measures (the agreed definition of one number in the model)",
    deleteVersionParam: "expectedVersion",
    listPaging: { defaultPageSize: 20, maxPageSize: 200 },
    // read_measure is in tools/measureFormula.ts: it asks the platform to
    // write the stored tree back as formula text, which a plain GET cannot.
    readable: false,
    guardFields: assertFormulaShape,
    createNote: MEASURE_NOTE,
    deleteNote:
      "`still_referenced`: a measure other measures rest on is refused, " +
      "with their names. Change or delete those first — the one furthest " +
      "from it first. read_measure's `usedBy` lists them beforehand.",
    publishNote:
      "Certified is the WHOLE chain: refused with `depends_on_unpublished` " +
      "(a measure it rests on is not published — publish from the bottom " +
      "up) or `unverified_relationship` (a part reaches a table over a " +
      "relationship nobody verified — verify it first). The approval's " +
      "`changesWith` names what moves with it: the measures that rest on " +
      "it (`measures`, the whole chain above) and the dashboards with a " +
      "tile on any of them (`dashboards`). Say so in `changeSummary` when " +
      "it is not empty.",
    updateWarning:
      MEASURE_NOTE +
      " `tableId` and `clearTable` are gone: a measure has no home table, " +
      "the tables it reads follow from its formula. Sending `definition` " +
      "replaces it whole, so send the `expression` and its `limits` with " +
      "it — a definition sent without them takes the measure's status away. " +
      "Sending definition without rangeMethod removes the expected range; " +
      "include it to keep the range.",
  },
  {
    // A named read of one source (axonity-flow#2010, S1), with routes in the
    // same order and spelling as a measure's — so the whole family comes from
    // the registrars. Running it once, and who holds its tool, are in
    // tools/queries.ts.
    singular: "query",
    archivable: true,
    restoreRename: true,
    statusRetired: true,
    basePath: "/api/v1/queries",
    updateMethod: "PUT",
    plural: "queries",
    label: "queries (named, typed reads of a data source that answer an agent and fill tables)",
    deleteVersionParam: "expectedVersion",
    listPaging: { defaultPageSize: 20, maxPageSize: 200 },
    createNote: QUERY_NOTE,
    deleteNote:
      "A query that fills a table, or whose tool an agent holds, is used: " +
      "read_query_usage says who holds its tool, and list_data_tables " +
      "({ filledBy: \"query\" }) which tables it fills.",
    publishNote:
      "Refused while read_query's `publishBlockers` is not empty — each one " +
      "names what is missing (a grain, a column without a description, a " +
      "parameter the statement does not use). Publishing makes its read tool " +
      "live for every agent that holds it.",
    updateWarning:
      QUERY_NOTE +
      " On an update, `parameters`, `returns`, `questions` and `reads` are replaced " +
      "WHOLE when sent: read first and send the complete list, each item " +
      "of the first three with its `id` so it stays the same item.",
  },
  {
    // A program an agent operates through an executor (axonity-flow#1901),
    // with routes in the same order and spelling as a table's — so the whole
    // family comes from the registrars. What is not generic (the executors it
    // runs on, what it has learned) is in tools/applications.ts.
    singular: "application",
    archivable: true,
    restoreRename: true,
    statusRetired: true,
    basePath: "/api/v1/applications",
    updateMethod: "PUT",
    label: "applications (programs an agent operates through an executor, with their limits)",
    deleteVersionParam: "expected_version",
    listPaging: { defaultPageSize: 20, maxPageSize: 200 },
    createNote: APPLICATION_NOTE,
    updateWarning:
      APPLICATION_NOTE +
      " `limits` is replaced WHOLE when sent: read the application first and " +
      "send the complete object, or a limit you left out is gone.",
    publishNote:
      "The limits are what an executor on a customer's machine is allowed to " +
      "do, which is why only a human makes them live. Until the approval is " +
      "decided, the executors keep the limits published before. " +
      "\n\nPublishing is also what rebuilds the application's act/observe " +
      "tools from the published version. To publish again WITHOUT a change — " +
      "an application already live, no draft, the request refused as " +
      "`already_live` — call ensure_application_major_version first: it opens " +
      "a draft of the current content, and this request then goes through. " +
      "Never edit a field just to make a draft. A platform release rebuilds " +
      "these tools by itself on start, so a new tool shape after a deploy " +
      "needs no publish. To take a workflow live with the application its " +
      "agents operate, request this alongside request_publish_release: a " +
      "release does not carry the application yet.",
  },
  // The three below arrived with axonity-flow#1849 (axonity-mcp#78). None is
  // versioned or publish-approved: a change is live the moment it is saved, so
  // there is no draft to discard and no request_publish_*. Each lists one page
  // on the shared cursor.
  {
    singular: "data_source",
    archivable: true,
    archiveGuard: "in_use",
    restoreRename: true,
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
      "filled from this source by a query that reads it (create_query, " +
      "then `filledBy: \"query\"` and `fillingQueryId` on the table) — not " +
      "through a sync, and not through a reference doc.",
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
    createExample: ["fromTableId", "fromColumn", "toTableId", "toColumn"],
    publishable: false,
    hasDiscardDraft: false,
    deleteVersionParam: "expected_version",
    listPaging: { defaultPageSize: 20, maxPageSize: 200 },
    deleteNote: BREAKS_MEASURE_NOTE,
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
    archivable: true,
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
      "checked when saved and a refusal names what is wrong. " +
      "\n\nA TILE'S STATUS comes from the limits of the measure it shows. " +
      "To show one number and judge it by another — revenue, judged by " +
      "'revenue against plan' — give the tile `config.statusMeasure`, the " +
      "NAME of that measure: it is computed over the same period and filters " +
      "as the number. Only a tile that shows a measure takes it; a number " +
      "tile shows the status. While a tile names a measure as its " +
      "`statusMeasure`, that measure cannot be renamed or deleted." +
      "\n\n" +
      TILE_PERIOD_NOTE + TILE_NUMBER_NOTE + TILE_STATEMENT_NOTE +
      LAYOUT_ARRANGING_NOTE,
    updateWarning:
      "NO DRAFT: a saved dashboard is what everyone it is shared with sees. " +
      "`layout` is replaced WHOLE when sent — read first and send it complete. " +
      "A tile may carry `config.statusMeasure`: the measure whose limits give " +
      "it its status, when that is not the measure it shows. " +
      TILE_PERIOD_NOTE + TILE_NUMBER_NOTE + TILE_STATEMENT_NOTE +
      LAYOUT_ARRANGING_NOTE,
  },
];

/**
 * Entities with version history. Every authored entity here exposes the
 * `/versions*` routes, `method` included (verified against the backend:
 * `/api/v1/methods/{id}/versions…`), so each gets the version tools. The
 * persona is not here: since axonity-flow#2176 it is a field of the agent and
 * its history is the agent's.
 */
const VERSIONED: VersionedEntity[] = [
  { singular: "workflow", basePath: "/api/v1/workflows", publishedPath: "entity" },
  { singular: "agent", basePath: "/api/v1/agents", publishedPath: "entity" },
  { singular: "tool", basePath: "/api/v1/tools", publishedPath: "entity" },
  {
    singular: "toolbox",
    basePath: "/api/v1/toolboxes",
    publishedPath: "versions",
    restoreNote: TOOLBOX_RESTORE_NOTE,
  },
  { singular: "skill", basePath: "/api/v1/skills", publishedPath: "versions" },
  { singular: "policy", basePath: "/api/v1/policies", publishedPath: "versions" },
  {
    singular: "reference_doc",
    basePath: "/api/v1/reference-docs",
    publishedPath: "versions",
  },
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
  {
    singular: "method",
    formerSingular: "flow",
    basePath: "/api/v1/methods",
    publishedPath: "entity",
  },
  {
    singular: "data_table",
    basePath: "/api/v1/data-tables",
    publishedPath: "versions",
  },
  {
    singular: "table_database",
    basePath: "/api/v1/table-databases",
    publishedPath: "versions",
  },
  { singular: "measure", basePath: "/api/v1/measures", publishedPath: "versions" },
  { singular: "query", basePath: "/api/v1/queries", publishedPath: "versions" },
  {
    singular: "application",
    basePath: "/api/v1/applications",
    publishedPath: "versions",
  },
];

/**
 * Register the whole tool surface onto a server. Split out from `buildServer`
 * so a test can drive the real registration against a recording server — e.g.
 * to assert no tool ever targets a deny-listed route (publish/approve/secret/…).
 * `ServerLike` is the minimal `.tool()` surface both `McpServer` and a test
 * double satisfy.
 */
type ServerLike = Pick<McpServer, "tool">;

/** Where the tools are served from, where that changes what a tool may do. */
export interface RegisterOptions {
  /**
   * Served by Axonity itself (`/mcp`, HTTP mode) rather than as a local process
   * beside the MCP client. A tool that reads THIS machine's files must not do
   * so there: this machine is the Axonity server, not the caller's.
   */
  hosted?: boolean;
}

export function registerAll(
  server: ServerLike,
  client: AxonityClient,
  options: RegisterOptions = {},
): void {
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
  registerEntityContractTools(server as McpServer, client);
  registerWorkflowMutations(server as McpServer, client);
  registerValidationTools(server as McpServer, client);
  registerExecutionTools(server as McpServer, client);
  registerApprovalTools(server as McpServer, client);
  registerActionApprovalTools(server as McpServer, client);
  registerTriggerTools(server as McpServer, client);
  registerRunTools(server as McpServer, client, { hosted: options.hosted === true });
  registerRunInputFileTools(server as McpServer, client, { hosted: options.hosted === true });
  registerPersonaTools(server as McpServer, client);
  registerAgentTeamTools(server as McpServer, client);
  registerConnectorTools(server as McpServer, client);
  registerAttachTools(server as McpServer, client);
  registerDependencyTools(server as McpServer, client);
  registerCatalogTools(server as McpServer, client);
  registerPromptPlacementTools(server as McpServer, client);
  registerMethodTools(server as McpServer, client);
  registerCompanyTools(server as McpServer, client);
  registerSecretTools(server as McpServer, client);
  registerSubworkflowTools(server as McpServer, client);
  registerToolboxTools(server as McpServer, client);
  registerOperationsTools(server as McpServer, client);
  registerModuleTools(server as McpServer, client);
  registerFlowAppTools(server as McpServer, client);
  registerDataTableTools(server as McpServer, client);
  registerDataSourceTools(server as McpServer, client);
  registerMeasureTools(server as McpServer, client);
  registerMeasureFormulaTools(server as McpServer, client);
  registerDashboardTools(server as McpServer, client);
  registerConceptTools(server as McpServer, client);
  registerMeasureInfluenceTools(server as McpServer, client);
  registerQueryTools(server as McpServer, client);
  registerComponentTools(server as McpServer, client);
  registerApplicationTools(server as McpServer, client);
  registerAccessTools(server as McpServer, client);
  registerKnowledgeGraphTools(server as McpServer, client);
  registerTrashTools(server as McpServer, client);
  registerModelTools(server as McpServer, client);
}

/** How the server introduces itself, on either transport. */
export const SERVER_INFO = { name: "axonity", version: "0.1.0" };

/** The entry a new Flow-App starts from besides the tools: one prompt, three resources. */
export function registerEntrySurface(server: McpServer, client: AxonityClient): void {
  registerNewFlowAppPrompt(server, client);
  registerFlowAppResources(server, client);
}

/** What the hosted connector replays per request beside its tools, the same as the local one. */
export const HOSTED_SURFACE = { instructions: SERVER_INSTRUCTIONS, registerEntry: registerEntrySurface };

/**
 * A server that registers every tool except `hidden` — the tools whose routes
 * the backend does not mount (`followBackendContract`). Skipping at `.tool()`
 * keeps every registrar unaware of it: none of them uses the return value.
 */
function withoutTools(server: ServerLike, hidden: ReadonlySet<string>): ServerLike {
  if (hidden.size === 0) return server;
  const tool = (name: string, ...rest: unknown[]) =>
    hidden.has(name) ? undefined : (server.tool as (...a: unknown[]) => unknown).call(server, name, ...rest);
  return { tool: tool as ServerLike["tool"] };
}

/**
 * The local server. `plan` is what the startup contract check decided: which
 * tools to leave out, and a notice for the instructions. Without one, every
 * tool is offered and the instructions are the measured text alone.
 */
export function buildServer(
  client: AxonityClient,
  plan: Partial<Pick<BackendPlan, "hidden" | "notice">> = {},
): McpServer {
  const instructions = plan.notice
    ? `${SERVER_INSTRUCTIONS}\n\n${plan.notice}`
    : SERVER_INSTRUCTIONS;
  const server = new McpServer(SERVER_INFO, { instructions });
  registerAll(withoutTools(server, new Set(plan.hidden?.keys() ?? [])), client);
  registerEntrySurface(server, client);
  return server;
}

/** The hosted surface: the same tools, for a caller elsewhere. */
export const registerHosted = (server: ProbeServer, client: AxonityClient): void =>
  // The four-argument `.tool()` every registrar uses; the same cast the
  // startup contract check makes.
  registerAll(server as never, client, { hosted: true });

/**
 * The hosted connector (AXONITY_MCP_TRANSPORT=http), started by Axonity beside
 * its API. Every caller holds a personal token, so every tool is worded with
 * what such a token may do there (`routeClasses.ts`). No contract check at
 * startup: it ships in the same image as the API it calls.
 */
async function mainHttp(): Promise<void> {
  const config = loadHttpConfig();
  const routes = await routesPerTool(registerHosted);
  await startHostedServer({
    ...config,
    serverInfo: SERVER_INFO,
    register: registerHosted,
    ...HOSTED_SURFACE,
    prepare: (tools) => forPersonalTokens(tools, routes, TOKEN_ROUTE_CLASSES),
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (isVersionRequest(argv)) {
    // dist/index.js → ../package.json, in the repo and in the installed package.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    console.log(pkg.version);
    return;
  }
  assertNoExtraArguments(argv);
  if (transportOf() === "http") {
    await mainHttp();
    return;
  }
  const config = loadConfig();
  const client = new AxonityClient(config);

  // Ask the deploy what it mounts BEFORE any tool is registered, and offer only
  // the tools it can serve: an older backend gets fewer tools and one clear
  // notice, never a tool that 404s mid-task. It cannot fail and cannot hang:
  // an unreadable contract offers every tool with a warning, and the whole
  // check is bounded by a timeout.
  // `registerAll` wants McpServer's overloaded `.tool()`; the probe server has
  // the one four-argument form every registrar here actually uses. The cast is
  // the same one every test that drives registerAll makes.
  const plan = await followBackendContract(
    client,
    (probe, probeClient) => registerAll(probe as never, probeClient),
    { apiUrl: config.apiUrl },
  );
  const server = buildServer(client, plan);

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

/**
 * `axonity-mcp --version` prints the package version and exits. It is the one
 * argument accepted, so the release smoke (scripts/smoke-packed-bin.mjs) can
 * start the packed bin once without a token or a network.
 */
export function isVersionRequest(argv: string[]): boolean {
  return argv.length === 1 && argv[0] === "--version";
}

export function assertNoExtraArguments(argv: string[]): void {
  if (argv.length === 0) return;
  throw new Error(
    [
      "This MCP server does not accept command-line arguments.",
      "Usage:",
      "  axonity-mcp",
      "  axonity-mcp --version",
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
