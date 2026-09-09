# `openapi.snapshot.json` — pinned backend contract

This is a vendored copy of the Axonity Flow backend's OpenAPI schema
(`GET /openapi.json`). `test/conformance.test.ts` pins the MCP's route surface
and the enums quoted in `axonity_conventions` to it, so a divergence between
this connector and the backend fails CI instead of misleading an agent.

Why vendor it (rather than fetch live): CI has no running backend, and a pinned
copy makes a renamed field / removed route / changed enum show up as a real
diff in review.

## Provenance

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
