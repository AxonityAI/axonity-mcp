# `openapi.snapshot.json` — pinned backend contract

This is a vendored copy of the Axonity Flow backend's OpenAPI schema
(`GET /openapi.json`). `test/conformance.test.ts` pins the MCP's route surface
and the enums quoted in `axonity_conventions` to it, so a divergence between
this connector and the backend fails CI instead of misleading an agent.

Why vendor it (rather than fetch live): CI has no running backend, and a pinned
copy makes a renamed field / removed route / changed enum show up as a real
diff in review.

## Provenance

- **Full refresh after axonity-flow#2104, replacing everything below:** a
  WHOLE dump with `dump_openapi.py` from a clean, read-only worktree of
  axonity-flow `main` at `c9f77464` (#2103 merged as #2104). 749 → 749
  operations: no route added or removed. `GET /api/v1/authoring/entity-contracts`
  and its `EntityContractsResponse` now come from `main`, identical to the
  branch dump they replace. What moved: `ConditionalTriggerIn` and
  `ConditionalTriggerUpdate`, whose `checkKind`/`checkConfig` now carry
  `x-refused` with where the value is authored instead (the workflow's trigger
  element, effective at publish). No new undecided operation, so
  `OPEN_FOR_DECISION_79` is unchanged. `entity-contracts.tool-conditional_trigger.json`
  was re-recorded from the route on `main` (`?kinds=tool,conditional_trigger`,
  through the ASGI app) and is byte-identical to the one it replaces;
  `test/driftContract.test.ts` replays it.
- **Full refresh (#73, #95), replaced by the entry above:** a WHOLE dump with
  `dump_openapi.py` from a clean checkout of axonity-flow `main` at
  `bbdc657a` — not a splice. 653 → 748 operations, none removed. Brings in,
  among the rest, `ConditionalTriggerIn` with `workflowId` required and the
  check fields documented as refused (axonity-flow `conditional_trigger_service`),
  `ConnectorResponseMapping.type` with `file` and `filename` (#2079), and
  `executor` in `CreateToolRequest.type`. The five routes #73 named were all
  already covered by tools. The 38 operations the refresh brought in that no
  tool covers and no rule excludes are listed in `OPEN_FOR_DECISION_79` in
  `test/completeness.test.ts` — deliberately NOT decided here; that is #79.
- **Queries, concept links and what fills a table, on top of the above:**
  axonity-flow#2010 (S1 queries, #2011; S6 concept links, #2016) and #2013
  (a table's filler), dumped with `dump_openapi.py` from axonity-flow `main`
  at `6dcfd64f` and consumed by axonity-mcp#90, #91, #92 and #93. Spliced in,
  not a full dump, PER OPERATION: every operation under `/api/v1/queries`
  (24), the three of `/api/v1/concept-links`, and `GET /api/v1/data-tables`
  (its new `filled_by` filter) — with the 18 schemas they reach that were not
  here yet (`QueryDetail`, `RhythmPayload`, `ConceptLinkItem` among them).
  Replaced whole, because the filler moved inside them: `CreateDataTableRequest`,
  `UpdateDataTableRequest`, `DataTableResponse`, `DataTableSummary` (no more
  `provenance` / `clearProvenance` / `isDynamic`; `filledBy`,
  `fillingQueryId`, `rhythm`, `clearFillingQuery`, `clearRhythm` instead)
  and `DataTableToolSummary`. 22 of the query operations are COVERED; the
  direct publish/unpublish pair falls under the standing rule. Left out on
  purpose: `PATCH`/`DELETE /api/v1/data-tables/{table_id}/rows/{row_id}`, the
  table editor's by-id road to the same row writes the match-based tools
  already make — #79's to decide, not this work's. After this,
  `npm run check:contract` against `6dcfd64f` lists 95 operations missing
  rather than 117, and no route under `/queries`, `/concept-links` or
  `/data-tables` with a different contract.
- **Applications and executors, on top of the above:** axonity-flow#1901
  (with #1965, #2009 and #2030), dumped with `dump_openapi.py` from
  axonity-flow `main` at `3ee90b58` — the build live on the sandbox — and
  consumed by axonity-mcp#86. Spliced in, not a full dump: every path under
  `/api/v1/applications` and `/api/v1/executors` (34 operations), the 21
  schemas they reference, and `application` (with `query`) in the
  `entityType` enum of `CreateApprovalRequest` and `PublishApprovalItem`.
  29 operations are COVERED; the direct publish/unpublish pair falls under the
  standing rule, and registering, revoking and setting an executor's
  applications from its own side are excluded with reasons in
  `test/denyList.ts`. Takes these out of #79's list.
- **Who may read what, and the knowledge graph, on top of the above:**
  axonity-flow#1918 (PR #1939), dumped with `dump_openapi.py` from
  axonity-flow `main` at `45d726fa` and consumed by axonity-mcp#88 (S1, S2,
  S5). Spliced in, not a full dump, and spliced PER OPERATION: the `GET`s of
  `/api/v1/audiences`, `/api/v1/roles` and `/api/v1/users/{user_id}/roles`,
  and every operation under `/api/v1/knowledge` except the settings
  (`/knowledge/settings`, `/knowledge/source-types*`, `PATCH
  /knowledge/sources/{id}`) — 40 operations, with the 65 schemas they reach
  (`ClearanceSchema` among them). Left out on purpose: the writes of audiences, roles
  and a colleague's roles, and the graph's settings. Those are #88's S3 and
  S4, which wait on a decision about what a token may administer; they arrive
  with that work. Also spliced, PER FIELD: `level` and `audienceIds` on the
  create/update requests of policy, skill, reference doc and data table, and
  `clearance` on the agent schemas and `PatchWorkflowRequest`. Per field
  because those schemas moved for other reasons too on `main` — notably a
  data table no longer takes `provenance` there (`filledBy`,
  `fillingQueryId`, `rhythm` instead), which is a change of its own and not
  taken here. 8 of the knowledge operations are COVERED; the rest are
  excluded with reasons in `test/denyList.ts`. Takes these out of #79's list.
- **Measures as one formula, phases 2 and 3, on top of the above:**
  axonity-flow#1908 (PRs #1940 and #1946), dumped with `dump_openapi.py` from
  axonity-flow `main` at `cf8d0c19` and consumed by axonity-mcp#83. Spliced
  in, not a full dump: no measure or data-table ROUTE changed shape, only the
  schemas behind them — `CalendarPayload` and `ReadFromEntry` (new), and
  `CreateDataTableRequest`, `UpdateDataTableRequest`, `DataTableResponse`,
  `DataTableSummary` (`dateTable`, `calendars`), `TableColumnPayload`
  (`unique`, axonity-flow#1941, taken because it sits in the same request),
  `FormulaLeaf` (`readFrom`, `window`), `MeasureDesignResponse` (the
  calendars), `MeasureDetail` / `MeasureSummary` (`formula`, `dependsOn`,
  `usedBy`, `dashboards`), `MeasureQueryItem` (`explain`, `useDraftChain`)
  and `MeasureQueryResult` (`parts`, `leaves`, `code`, `warnings`). After
  this, `npm run check:contract` against `cf8d0c19` reports no route under
  `/measures` or `/data-tables` with a different contract; what it still
  reports is #79's (applications, executors, config branches, platform
  administration, the two row routes, …) and two routes outside this work
  (`GET /conversations`, `GET /runs/{id}/items`).
- **Measures as one formula, on top of the above:** axonity-flow#1908 phase 1
  (PR #1934), dumped with `dump_openapi.py` from axonity-flow `main` at
  `a723cc38` and consumed by axonity-mcp#83. Spliced in, not a full dump:
  the three operations it adds (`GET /measures/formula-spec`,
  `GET /measures/formula-symbols`, `POST /measures/validate`), the changed
  `POST /measures/{id}/restore`, and the schemas they and the measure writes
  reference (`CreateMeasureRequest`, `UpdateMeasureRequest`,
  `MeasureDefinitionPayload`, `FormulaLeaf`, `FormulaProblem`,
  `ValidateFormulaRequest`, `ValidateFormulaResponse`). All three new
  operations are COVERED. The semantic-model splice below is now on `main`:
  every route under `/measures`, `/data-tables`, `/table-relationships`,
  `/dashboards`, `/concepts` and `/data-sources` matches `a723cc38` except
  the two `/data-tables/{id}/rows/{row_id}` writes, which are among the ~100
  routes still waiting for a decision in axonity-mcp#79 (applications,
  executors, config branches, platform administration, invoices, usage, …).
  **Regenerate in full from `main` when #79 is decided.**
- **Semantic model, on top of the above:** the contract of axonity-flow
  epic #1881 (S1 provenance on the table, S3 concepts, S4 retired
  `semanticKind`, S12 measure as an entity), dumped with `dump_openapi.py`
  from the LOCAL branch `semantic-model` at `5d801700` — not yet on
  axonity-flow `main`. Consumed by axonity-mcp#81. Spliced in, not a full
  dump: every existing path under `/data-sources`, `/data-tables`,
  `/measures`, `/concepts`, `/reference-docs` and `/publish-approvals` was
  replaced by that branch's version, the 24 operations the branch adds over
  `main` were added (`/concepts`, the `/measures` entity family,
  `POST /data-tables/{id}/refresh`), and the five `/data-sources/{id}/syncs`
  operations it removes were removed. 531 → 550 operations; every new one is
  COVERED. **Regenerate from axonity-flow `main` once the branch is merged**,
  and expect only the #79 arrivals as a difference.
- **Added on top of `484c1628`:** the 34 operations of axonity-flow#1849
  (dashboards on your own data) under `/api/v1/data-sources`,
  `/api/v1/table-relationships`, `/api/v1/dashboards` and `/api/v1/measures`,
  with the 36 component schemas they reference, copied verbatim from
  `dump_openapi.py` on axonity-flow `main` at `f61aeb43` and spliced in with
  the dump script's own formatting. Consumed by axonity-mcp#78; every one is
  COVERED. **Only these were taken.** A full dump at `f61aeb43` carries 602
  operations against this file's 497 — the other ~70 arrivals (config
  branches, platform models, invoices, usage, SSO, secret reveal/transfer,
  …) are a decision of their own, cover or exclude, and do not belong in a
  change about warehouses. No operation was removed, and no schema already
  here changed.
- **Added on top of `484c1628`:** `GET /api/v1/authoring/prompt-placement`
  and its `PromptPlacementResponse` (`{markdown, rulesVersion}`), copied
  verbatim from `app.openapi()` of axonity-flow#1829 (not yet on main), so the
  rest of the snapshot keeps its `484c1628` provenance; the entry is written
  with the dump script's own formatting (sorted keys,
  `ensure_ascii=False`, trailing newline) so the next regeneration replaces it
  as an ordinary diff. `axonity_conventions` reads it on every call to append
  this deploy's prompt-placement rules. Until axonity-flow ships it,
  `npm run check:contract` lists it under "gone from axonity-flow" — expected.
- **Added on top of `484c1628`:** `GET /api/v1/authoring/semantic-knowledge`
  and its `AuthoringRulesResponse` (`{markdown, rulesVersion}`), copied
  verbatim from `app.openapi()` of axonity-flow `worktree-dashboards` at
  `9dd8feac` (not yet on main), in the dump script's own formatting, the same
  way as the placement route above. `axonity_semantic_conventions` reads it.
  Until axonity-flow ships it, `npm run check:contract` lists it under "gone
  from axonity-flow" — expected.
- Generated from **axonity-flow `main`** at commit `484c1628` — the validator
  contract reaching the OpenAPI (axonity-flow#1515, on top of #1514's standard
  call), consumed here by axonity-mcp#73. The surface moves **490 → 495
  operations** and no operation was removed. All five arrivals are COVERED;
  none of them touches a boundary `denyList.ts` keeps shut, so there was
  nothing to exclude:
  - `GET /conditional-triggers` — every conditional start in the tenant, where
    the connector could only ask per workflow. Richer rows than the per-workflow
    route: the workflow's name, whether the schedule is paused, and how many
    ticks are waiting. That last number should be one, and more than one means
    the schedule forked (axonity-flow#1278) — a fault that otherwise surfaces
    only as a workflow running three times an interval.
    → `list_tenant_conditional_triggers`.
  - `GET /data-tables/{id}/rows` — the paged, filtered reader. `read_data_table`
    answers with EVERY row, and the reasoning that put paging on
    `list_data_tables` (a library grows by authoring; a tenant's reference data
    has no ceiling) bites harder one level down where the rows are.
    → `list_data_table_rows`.
  - `GET /workflows/{id}/components` — what a workflow is made of, composed over
    two hops: what the document names, and what each agent then actually
    receives. The connector could only ask the REVERSE (`list_workflows_using`).
    The guide's own "Reproducing a setup" told an agent to walk this by hand.
    → `list_workflow_components`, and the guide now starts that step with it.
  - `POST /workflows/{id}/components/duplicate` — give this workflow its own
    copy of a shared component. Not a breach of "recreate, never copy ids":
    that rule is about carrying an id across TENANTS, and this is one tenant
    with the backend rewriting the references.
    → `duplicate_workflow_component`.
  - `POST /company/discard-draft` — company was the twelfth versioned entity and
    the last without one (axonity-flow#1388), so its draft was the only draft in
    the tenant nobody could walk back. → `discard_company_draft`.

  **One guard had to move.** `StepSchema.properties.type` no longer enums the
  nine step types; it is a bare string. That is the backend reaching the same
  conclusion this connector did — the transport is permissive, the spec is the
  authority — but `conformance.test.ts` was reading that enum as the ALPHABET
  for its "the connector states no vocabulary of its own" sweep. An empty
  alphabet matches nothing, so the sweep would have passed on every text
  forever. The `.toBe(9)` tripwire fired exactly as designed, and the step types
  now sit written-out beside the trigger types and rule kinds, with the caveat
  those already carry: a value added on the backend is invisible to the list,
  which can make it miss an accusation but never invent one.
- Previously **`4a6357fc`** — epic
  axonity-flow#1217 (*a table is a library element you design yourself*, PR
  #1231) plus its two follow-ups #1234 (core entity wiring) and #1235 (the
  authoring API), consumed here by axonity-mcp#63. The surface moves
  **444 → 490 operations**, and only half the arrivals are the ones that were
  asked for — a snapshot is a dump, not a selection:
  - **24 `/api/v1/data-tables/**` routes.** The entity family, the eleven
    version routes spelled exactly as an output schema's, three row writes
    (`POST`/`PATCH`/`DELETE .../rows`) and `GET .../tools`. All covered, except
    the two direct-publish routes, which the standing `direct version publish`
    rule already forbade — publishing is a human decision, here as everywhere.
  - **22 that came with them**, from epics that landed in the same span:
    seven `/api/v1/platform/workspaces*` (platform administration), five
    `/api/v1/users*` (member administration and a password-reset link), four
    `/api/v1/auth/*` (outside the tenant API by construction), two
    `/task-queue` stop routes (already covered by the operator-act rule),
    `GET /runs/{id}/outline/items`, and the three
    `/workflows/{id}/reference-docs` link routes from axonity-flow#1061.
    The last four are COVERED — the outline continuation and the doc-link trio
    are the connector's business, and this file used to say the doc link "does
    not exist". The rest are excluded with reasons in `test/denyList.ts`.
  - No operation was removed.
- Previously **`0efc4681`** — epic
  axonity-flow#1027/#1028, *a process owns its own interface*. **No route
  moved**; the surface stays at 444 operations. What changed is inside the
  authoring contract, and it is the kind of change a pass-through connector
  never breaks on:
  - `WorkflowStartContract` gained **`inputs`** — what the PROCESS needs to
    start, declared once and carried by every start. A start's own `parameters`
    are now what it declares ON TOP, and the process-level name wins where the
    two overlap. Older documents still declare on the invocation trigger and
    both are read.
  - The mutation vocabulary gained `set_workflow_inputs` and lost
    `attach_output_schema` / `detach_output_schema`. **Nothing here needed
    changing for that** — the connector states no vocabulary of its own and
    reads it from `GET /workflows/operations` (#8/#32/#44). This is that
    decision paying its way.
- Previously **`77526bff`** — epic axonity-flow#1006 (tools live in toolboxes),
  consumed by axonity-mcp#54. The
  route count moves 437 → 444: seven toolbox routes plus
  `PUT /tools/{id}/toolbox`, and `GET /conversation-attachments/{id}/text` is
  gone (#1000 removed it unused). Also arriving in the same span, not yet
  consumed here: `GET /runs/{id}/outline`, four `/cron-schedules` routes and two
  `/task-queue` release routes.
- The two toolbox routes the #54 issue text does not list are covered anyway,
  because the backend grew them after the issue was written:
  `PUT /toolboxes/{id}/auth` (a shared credential — it gets the connector
  credential guard) and `GET /toolboxes/{id}/dependent-tools` (which tools that
  credential is holding up).
- This supersedes the `ae0923b6` refresh from #53, and carries it: no operation
  had moved there, but four component schemas had (`ChannelReplyRequest` gained
  a required `sender`, and three service-token models changed). None is
  reachable from this connector — `channel-reply` is uncovered and service
  tokens are deny-listed in `test/exclusions.test.ts` — and it was refreshed
  anyway, because the conformance test pins enums to this file and a snapshot
  that is "stale but only in the parts we do not use" is how it goes stale in
  the parts we do.
- The authoring surface itself comes from epic axonity-flow#961 (the nine
  stories consumed by axonity-mcp#45), plus #964 and #978, dumped at `7dcdad92`.
- **#964** is why the catalogue now carries three vocabularies for a value's
  type: `parameterTypes` (a trigger parameter's / constant's `type`),
  `outputKinds` (a step output's / input's `kind` — narrower, *different key*)
  and `schemaFieldKinds` (inside a field's `schema`, which wins where present).
  The first cut of those models gave a trigger parameter a `kind`, which every
  reader ignores; this connector copied it and had to correct it in #47.
- **#978** prunes nine `/_test/*` dev routes that the previous dump wrongly
  included, so the route count moves 446 → 437 with nothing real removed.
- Note what the snapshot still does NOT carry, because it is the reason #45
  exists: `StepSchema.type` enums all nine step types while the validator
  accepts seven, and the trigger types, schedule-rule shapes and three value
  vocabularies live only in the runtime answer of
  `GET /workflows/operations`. The transport schema is permissive; the
  validator is the authority. A conformance check pinned to this file cannot
  see below that line — which is exactly why every tool description and the
  authoring guide read those vocabularies from the server instead.
  (Previously `b564532d`, then `002d1921` — epic #791 (the publish gate tells
  the truth) plus #792/#795: `POST /tools/{id}/dry-run` and
  `POST /publish-approvals/bulk`. Before that `93fda3c4` — PR #780, the backend
  half of epic axonity-flow#764 (stories B1–B8), which changed the authoring
  contract itself: `add_step` accepts a complete step, `add_edge` accepts
  `from`/`to` and honours a caller id, payload models became `extra="forbid"`,
  mutation responses carry `systemAdjustments`, and
  `POST /workflows/{id}/validate` was added alongside `catalogChecked`. Before
  that `0c301308` and `c7fe5421`.)
- Deterministic output (sorted keys, dev/test routes pruned): regenerating on
  the same backend commit produces a byte-identical file.

## Regenerate (after any authoring-surface change on the backend)

```bash
# in a checkout of axonity-flow, on the target commit:
python backend/scripts/dump_openapi.py -o <this-repo>/test/fixtures/openapi.snapshot.json
```

Then run `npm test` here. If the conformance test now fails, the backend
contract moved — reconcile the MCP tools / conventions enums with the new
schema before shipping. See `docs/MCP-AUTHORING-CONTRACT.md` in axonity-flow for
the full contract rationale (story #722, Option 1).
