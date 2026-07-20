# Implementation plan — Epic #1: full authoring & lifecycle over MCP

Status: **superseded in part.** Verified against `axonity-flow` @ `backend/src` by direct
code read (routes, schemas, services). Where the code and the epic disagree, the code wins.

## Revision 2 — 2026-07-19, re-verified against axonity-flow @ `1c7820ed`

Issue #1 was revised and **issue #3 is now the plan of record** (ordering + acceptance bar),
with #2 carrying defect evidence from the UC1 migration and `axonity-flow#678` the backend
half. This document remains useful for the verified endpoint contract (§1-§3); its
sequencing (§4) and security section (§5) are superseded by #3. Changes:

1. **The two security findings are FIXED and this doc's §5.1-5.2 are obsolete.**
   `_enforce_service_token_write_scope` (`auth/dependencies.py:552-567`) refuses any
   `POST/PUT/PATCH/DELETE` from a token lacking the `write` scope at the single
   service-token choke point in `get_auth_context` — so the rule holds for every route,
   including ones that forget a per-route guard. `forbid_service_token`
   (`dependencies.py:570-586`) blocks direct publish/unpublish for service tokens; applied
   at 21 sites across 7 route files. **Consequence: the README's read-only-token guidance is
   now accurate — do not remove it.** `errors.ts`'s `ForbiddenError` text is also now correct.
2. **New residual gap (report to axonity-flow):** `forbid_service_token` is *not* applied to
   `POST /api/v1/personas/{id}/versions/publish/{major}` (`personas.py:389`) or
   `POST /api/v1/company/publish` (`company.py:258`) — both still take plain
   `get_auth_context`. A write-scoped service token can still publish a persona and the
   company document directly, bypassing the approval queue.
3. **A critical defect this plan missed entirely — `apply_workflow_mutations` never works.**
   Independently confirmed: the connector posts `{expectedVersion, mutations: [...]}`
   (`src/tools/workflowMutations.ts:41-44`) but `WorkflowMutationRequest`
   (`schemas/workflow.py:417-422`) requires `{type, payload, expectedVersion}` — **one**
   mutation, and there is no batch route. Both required fields are absent, so every call
   422s on shape before content is considered. Workflows can be created but never built.
   This is #3's P0 item 1 and outranks everything in §3 below.
4. **Delete is now gated on a backend restore endpoint** (`flow#678` B3). Delete on this
   platform means *recoverably removed*; per #3 item 8, no delete verb ships before restore
   exists. §3's M3 must not be built standalone.
5. **`update_*` is correct as written.** A prior review claimed `expectedVersion` had to move
   to a query param — it does not. Updates take it in the **JSON body** for every entity.
   The query-param form (§1.1a) applies to **DELETE only**. Do not touch `register.ts`'s
   update path.
6. Versioned-entity count: #1 says 7, this doc says 8. Both are right — 8 entities in the API
   have `/versions*` routes, but `prompt_snippet` is not modelled by the connector, leaving 7
   in scope.

---

## 1. Corrections to the epic — read before implementing

The epic's ground rule 5 says "do not fabricate routes that aren't there". These are the
places where the epic itself names a route or behaviour that does not exist, or that
differs from what shipped. Each one would produce a broken tool if implemented as written.

| # | Epic says | Reality | Impact |
|---|---|---|---|
| 1 | `POST /api/v1/tool-code/validate-code` | `POST /api/v1/tools/validate-code` — `routes/tool_code.py:18` declares `prefix="/api/v1/tools"`; `main.py:888` adds no prefix. No `/api/v1/tool-code` exists anywhere. | M1 would 404 |
| 2 | `POST /api/v1/webhook-triggers` (create) | Create is workflow-scoped: `POST /api/v1/workflows/{workflow_id}/webhook-triggers` — `webhook_admin.py:108`. Only *rotate* and *delete* are flat. | M5 would 404 |
| 3 | "add a single-get if `/{id}` GET exists" | **No `GET /api/v1/publish-approvals/{id}`.** The file has exactly four routes: list, create, approve, reject. | M7: build list only |
| 4 | "a findings tool if a findings endpoint exists" | **No findings endpoint.** Grep for `finding` across routes/schemas returns one unrelated comment. Closest data is `validatorVerdicts` + `agentInvocations` on `GET /runs/{id}`. | M6: drop the findings tool; document verdicts instead |
| 5 | System tools "grant/revoke — verify" | **No grant/revoke routes exist.** Only `GET /api/v1/system-tools` (member-OK). An agent's system tools are set by writing `systemToolIds` on the agent itself (`routes/agents.py:103,152`). | M8: catalogue read only |
| 6 | Acceptance: `list_runs({ archivedOnly: true })` | `GET /api/v1/runs` has **no** `archived_only`; it has `include_archived`. `archived_only` exists only on `GET /api/v1/workflows/{id}/runs`. | M3/M6 acceptance test as written cannot pass |
| 7 | Delete "+ output-schemas, prompt-snippets where wrapped" | Entity DELETE also exists for **skill, policy, reference_doc, persona** — the epic understates coverage. | M3 can cover more than planned |
| 8 | M2 "verify per-entity" | **output_schema and flow have no version system at all** — zero `/versions*` routes. The other 8 entities have the full set. | M2 must not register version tools for output schemas |
| 9 | `restore .../versions/{version_id}` and `read .../versions/{version}` | Two *different* param types: `{version}` is an **integer checkpoint number**; `{version_id}` is the **UUID** of the `entity_versions` row. | Getting this wrong silently 404s |

### 1.1 The three inconsistencies that shape the design

**(a) `expectedVersion` on DELETE is not spelled the same way twice.** It is a *query
parameter*, not a body field, and `CamelModel` does not govern query params — each route
declares its own:

| Wire key | Entities |
|---|---|
| `expectedVersion` | workflow, agent, tool, flow, secret |
| `expected_version` | skill, policy, reference_doc, persona, output_schema |
| *(none — no optimistic lock)* | prompt_snippet |

A single spelling 422s half the entities. `EntityDef` must carry this per entity.

**(b) 409 means two different things.** `VersionConflictError` (stale write → re-read and
retry) and `ReferenceConflictError` (entity is referenced by a published workflow/agent →
retrying will never help) both surface as HTTP 409. `src/errors.ts` currently maps *every*
409 to "read it again and retry", which will send an agent into a futile retry loop on a
delete that can never succeed.

**(c) Publish shape forks by entity family.**

| Family | Publish | Get published |
|---|---|---|
| workflow, agent, tool | `POST /{base}/{id}/publish` | `GET /{base}/{id}/published` |
| skill, policy, reference_doc, persona, prompt_snippet | `POST /{base}/{id}/versions/publish/{major}` | `GET /{base}/{id}/versions/published` |

Only *get published* is in scope (we never publish directly), but the read path forks too.

### 1.2 Behavioural traps to encode in tool descriptions

- `DELETE /workflows/{id}` does **not** refuse a published workflow, but
  `POST /workflows/bulk-delete` **does** (`workflow_service.py:~1058`). Same verb, two rules.
- `DELETE /agents/{id}` and `DELETE /tools/{id}` refuse when referenced by a *published*
  workflow (409 `ReferenceConflictError`).
- `DELETE /output-schemas/{id}` refuses when referenced by any workflow or agent, matched
  **by name**, regardless of publish state.
- `DELETE /policies/{id}` refuses `is_system` policies and the error tells the caller to
  set `status='archived'` instead — i.e. an archived status exists at the model layer but
  is not reachable through any route.
- `prompt_snippet` delete is a **hard** delete (row removed), unlike every other entity.
- `flows.py:104` docstring claims a 403 for framework-scoped flows; no such check exists in
  `flow_service.delete_flow`. The docstring is stale — do not document that behaviour.

### 1.3 Wire format — settled

`backend/src/schemas/base.py:1-27`: `CamelModel` sets `alias_generator=to_camel` with
`populate_by_name=True`. Bodies **accept both** casings and **return camelCase**. Send
camelCase — it is the canonical contract. Query and path params are **not** covered by this
and must be matched literally per route (see 1.1a).

---

## 2. Cross-cutting prerequisites (P0) — land before any story

None of the eight stories can be built cleanly without these. They are small and each is
independently testable.

### P0.1 — `AxonityClient`: `delete()` and query-string support
`src/client.ts` has only `get/post/put/patch` and no way to pass query params. M2 (`limit`/
`offset`), M3 (`expectedVersion` on delete), M6 (run filters) and M7 (`status`) all need them.

Add an optional `query?: Record<string, string | number | boolean | undefined>` to
`request()`, serialised with `URLSearchParams`, undefined entries dropped. Add
`del(path, query?)`. Keep the existing 204→`undefined` behaviour — several deletes return
204 and several return `{success:true}`, so tools must tolerate both.

### P0.2 — `src/errors.ts`: make failures actionable
1. **Surface the server detail.** `errorForStatus` captures `detail` but `AxonityApiError`'s
   message is just `"Axonity API request failed (422)."`, and `errorResult` renders only
   `err.message`. The agent is told "422" and nothing else. Fold a compact rendering of
   `detail` into the message for 400/404/409/422. This is a prerequisite for M1/M4/M5,
   which are all validate-and-fix loops.
2. **Disambiguate 409.** Inspect the detail: reference-conflict messages start
   `"Cannot delete ..."` / mention "used by". Emit a distinct `ReferenceConflictError`
   whose message says *do not retry — detach or unpublish the referencing entity first*.
3. **Add `NotFoundError` (404)** — every new delete/read-by-id tool needs it.

### P0.3 — `EntityDef` gains capability metadata
Today: `{singular, basePath, updateMethod, label}`. The stories need per-entity truth, and
the codebase has no other place to put it:

```ts
export interface EntityDef {
  singular: string;
  plural: string;                                   // P0.4 — no more `${singular}s`
  basePath: string;
  updateMethod: "PUT" | "PATCH";
  label: string;
  /** Query key for the optimistic lock on DELETE. `null` = route has no lock. */
  deleteVersionParam: "expectedVersion" | "expected_version" | null;
  /** false for output_schema/flow — they have no /versions routes at all. */
  versioned: boolean;
  /** Where the published snapshot lives; forks by entity family. */
  publishedPath: "entity" | "versions";
  /** Omit delete_* for entities we deliberately don't expose. */
  deletable: boolean;
}
```

### P0.4 — fix `list_policys`
`register.ts:44` builds `list_${singular}s`, so `policy` → `list_policys`. Renaming a tool
is a breaking change for any agent with it in context, so it must happen while the package
has effectively no users. Adding `plural` to `EntityDef` fixes it and unblocks correct
naming for `list_output_schemas` in M4.

### P0.5 — ship the entry-point fix first
`0.1.0` on npm never starts under `npx` (the `import.meta.url` guard fails through the
`node_modules/.bin` symlink). Already fixed locally with regression tests. Release as
`0.1.1` and `npm deprecate` `0.1.0` **before** any of this work, so testers are not chasing
a dead binary.

---

## 3. Stories

Order differs from the epic's: M7 is promoted next to M1 because both are tiny, and M3
(delete) is pulled forward because it is what was actually asked for. Each story is
independently shippable, with vitest coverage mirroring `test/register.test.ts`.

### M1 — Validation (2 tools)
| Tool | Route | Body |
|---|---|---|
| `validate_workflow` | `POST /api/v1/workflows/validate` | `{document}` → `{launchable, issues:[{code,message,severity,stepIds,edgeIds}]}` |
| `validate_tool_code` | `POST /api/v1/tools/validate-code` | `{imports, functions:[{name,code}], classes?}` → `{valid, errors:[{line,column,message,severity,functionName}]}` |

Worth adding while in here (same routers, same shapes, both member-OK):
`analyze_workflow_reachable_outputs` (`POST /api/v1/workflows/reachable-outputs`,
`{document, stepId}`) and `format_tool_code` (`POST /api/v1/tools/format-code`, `{code}`).
Both directly serve the authoring loop.

Note in the tool description that workflow validation is **stateless** — it does not verify
that referenced agents/tools exist.

**Acceptance:** malformed document → `launchable:false` with issues; banned import →
`valid:false` with the line; `axonity_conventions` updated to *validate → apply → request_publish*.

### M2 — Approval readback (1 tool)
`list_publish_approvals({status?})` → `GET /api/v1/publish-approvals?status=pending|approved|rejected`.
No pagination params exist. No single-get route — do not build one.

Row shape: `{id, entityType, entityId, entityName, status, readiness, changeSummary,
requestedByKind, createdAt, decidedAt, decidedByName}`.

**Acceptance:** after `request_publish_skill`, the list shows a pending row for that entity;
after a human approves in the UI, the same row reads `approved`.

### M3 — Delete (7 + 2 tools)
`delete_<entity>({id, expectedVersion, confirm})` for workflow, agent, tool, skill, policy,
reference_doc, persona. `confirm: z.literal(true)` — a required literal, so the agent cannot
satisfy it by accident. Description states destructive/irreversible.

Per-entity query key from `EntityDef.deleteVersionParam` (§1.1a). Tool descriptions must
carry the refusal rules from §1.2 so the agent can act on a 409 instead of retrying.

Plus `delete_<entity>_version({id, versionId, confirm})` for the 8 versioned entities, and
`bulk_delete_workflows({workflows:[{id, expectedVersion}], confirm})` →
`POST /api/v1/workflows/bulk-delete`, returning `{results:[{id,success,error}], deletedCount,
failedCount}` — a partial-success shape the description must call out.

**Archive is not in this story.** Only runs have archive (M6). There is no entity archive
route; see §5.

**Acceptance:** `delete_workflow` → `read_workflow` 404s; deleting an agent referenced by a
published workflow returns a *non-retryable* reference-conflict message.

### M4 — Version history (4 tools × 8 entities, via `registerEntityTools`)
Registered only when `EntityDef.versioned` — excludes output_schema and flow.

| Tool | Route | Notes |
|---|---|---|
| `list_<entity>_versions({id, type?, limit?, offset?})` | `GET .../versions` | `type` ∈ `checkpoint\|major\|all` (default `all`), `limit` 1-200 default 50 |
| `read_<entity>_version({id, version})` | `GET .../versions/{version}` | `version` = **integer checkpoint number** |
| `restore_<entity>_version({id, versionId, expectedVersion})` | `POST .../versions/{version_id}/restore` | `version_id` = **row UUID**; body `{expectedVersion}` |
| `read_<entity>_published({id})` | `GET /{id}/published` *or* `GET .../versions/published` | forks per `publishedPath` |

Deliberately **out of scope**: create-named-version, rename, ensure-draft. They exist for all
8 entities but serve the Builder UI's checkpoint model, not the agent's authoring loop; adding
them triples the tool count for little gain. Listed in §5 as optional.

**Acceptance:** after a publish, `list_workflow_versions` returns ≥1;
`restore_workflow_version` puts a prior version back into the draft and `read_workflow`
reflects it.

### M5 — Output schemas (5 tools)
Model as an `EntityDef` with `versioned:false`, `publishedPath` unused,
`deleteVersionParam:"expected_version"`, `plural:"output_schemas"`.

Create body: `{name, description, schemaBody, producedBy, consumedBy, source?, status?}`.
Update body carries `expectedVersion` **in the body** (not a query param — unlike its own
DELETE, which uses the `expected_version` query key; this asymmetry is real and must be
handled explicitly).

**Acceptance:** create → read → update → delete round-trip; delete of a referenced schema
returns the reference-conflict message.

### M6 — Triggers (8 tools)
All member-OK (`get_auth_context`), despite the `*_admin.py` filenames.

| Tool | Route |
|---|---|
| `list_webhook_triggers({workflowId})` | `GET /api/v1/workflows/{id}/webhook-triggers` |
| `create_webhook_trigger({workflowId, triggerId, expectedInputSchema?})` | `POST /api/v1/workflows/{id}/webhook-triggers` → `{trigger, plaintextToken}` |
| `rotate_webhook_trigger({webhookId, confirm})` | `POST /api/v1/webhook-triggers/{id}/rotate` — no body |
| `delete_webhook_trigger({webhookId, confirm})` | `DELETE /api/v1/webhook-triggers/{id}` — **hard**, 204 |
| `list_cron_schedules({workflowId})` | `GET /api/v1/workflows/{id}/cron-schedules` |
| `create_cron_schedule({workflowId, triggerId, cronExpr, timezone?, enabled?})` | `POST /api/v1/workflows/{id}/cron-schedules` |
| `delete_cron_schedule({scheduleId, confirm})` | `DELETE /api/v1/cron-schedules/{id}` — **hard**, 204 |
| `list_/create_/update_/delete_conditional_trigger` | `.../conditional-triggers`; create takes `{triggerId, agentId, conditionText, repeatIntervalMinutes, enabled?}` |

The cron expression field is `cronExpr`, not `cron`/`expression`. `plaintextToken` is
returned **once** — the tool description must say so, and the value must not be re-fetchable.

**Acceptance:** create a cron schedule → list shows it → delete removes it.

### M7 — Run observability (8 tools)
| Tool | Route | Notes |
|---|---|---|
| `list_runs({status?, createdAfter?, createdBefore?, includeArchived?, limit?, offset?})` | `GET /api/v1/runs` | `status` is a **comma-separated string**; limit clamped ≤200 |
| `list_workflow_runs({workflowId, archivedOnly?})` | `GET /api/v1/workflows/{id}/runs` | this is the only route with `archived_only` |
| `read_run({runId})` | `GET /api/v1/runs/{id}` | includes `validatorVerdicts`, `agentInvocations` |
| `read_run_trace({runId})` | `GET /api/v1/runs/{id}/trace` | step-by-step tool calls |
| `read_run_cost({runId})` | `GET /api/v1/runs/{id}/cost` | |
| `read_runs_summary()` | `GET /api/v1/runs/summary` | |
| `archive_run` / `unarchive_run({runId})` | `POST /api/v1/runs/{id}/archive` / `/unarchive` | the **only** archive in the product |
| `bulk_archive_runs` / `bulk_delete_runs({runIds, confirm})` | `POST /api/v1/runs/bulk/archive` / `/bulk/delete` | body `{runIds}`, 1-500; returns `{succeeded, failed}` |

The epic frames this as "the evaluator answer". There is no findings endpoint — the
substitute is `validatorVerdicts` on `read_run` plus `read_run_trace`. Say so in
`axonity_conventions` rather than implying findings exist.

**Not in scope:** triggering runs (`POST /workflows/{id}/runs`). The agent can author and
observe; letting it *start* tenant work is a separate product decision, not a wrapper gap.
Flagged in §5 for an explicit yes/no.

### M8 — Detach + system tools (5 tools)
`detach_skill_from_agent`, `detach_skill_from_workflow`, `detach_policy_from_agent`,
`detach_reference_from_agent` — `DELETE` on the same paths the existing `attach_*` tools POST
to. Today the connector can wire memory onto an agent and never unwire it.

`list_system_tools()` → `GET /api/v1/system-tools` → `[{id,label,description,category}]`.
No grant/revoke exists; the description should state that enabling a system tool means
writing `systemToolIds` via `update_agent`.

`delete_connector` is just `delete_tool` (a connector *is* a tool) — do not add a second tool.

---

## 4. Sequencing and releases

| Release | Contents | Rationale |
|---|---|---|
| **0.1.1** | Entry-point fix + regression tests; deprecate 0.1.0 | Unblocks anyone testing at all |
| **0.2.0** | P0.1-P0.4, M1, M2 | Breaking (`list_policys` → `list_policies`); do it while unused. Validation + approval readback close the authoring loop |
| **0.3.0** | M3, M4 | Delete + version history — the lifecycle ask |
| **0.4.0** | M5, M6 | Schemas + triggers — makes a workflow actually runnable |
| **0.5.0** | M7, M8 | Observability + detach |

Each release: `typecheck` + `test` + `build` green, README tool inventory updated,
`axonity_conventions` updated when the loop changes.

Tool count goes from 41 to roughly **105**. That is a lot of context for a calling agent.
Worth deciding early whether to gate families behind an env var (e.g.
`AXONITY_MCP_TOOLS=core,lifecycle,runs`) rather than registering all of them
unconditionally. Recommend deciding at 0.3.0, before the count doubles.

---

## 5. Backend follow-ups (axonity-flow — not this repo)

Ordered by severity, not by epic order.

1. ~~`require_write` is enforced on exactly one route.~~ **FIXED** in `axonity-flow#676` —
   enforced centrally at the service-token choke point. See Revision 2.
2. ~~The publish gate is opt-in.~~ **FIXED** in `axonity-flow#676` via `forbid_service_token`.
   See Revision 2. **But** two publish routes were missed and still take plain
   `get_auth_context`: `POST /api/v1/personas/{id}/versions/publish/{major}`
   (`personas.py:389`) and `POST /api/v1/company/publish` (`company.py:258`). A write-scoped
   service token can still publish those directly, bypassing the approval queue.
3. **Entity archive as a restorable state.** Only runs have archive/unarchive. Policies hint
   at an `archived` status at the model layer (the `is_system` delete error suggests it) but
   no route sets it. Until this exists, "archive an entity" *is* soft-delete.
4. **`expectedVersion` query-param casing.** Five routes use raw `expected_version` while four
   use the aliased `expectedVersion`. Any client must special-case per entity. Worth
   normalising in a versioned API change.
5. **409 conflates two conditions.** Version conflict (retryable) and reference conflict (not
   retryable) share a status code, forcing clients to string-match the detail. Distinct codes
   or a machine-readable `code` field would fix it.
6. **`POST /api/v1/tools/execute` and `/execute-connector` are `require_admin`**, so a service
   token can never test-run a tool it just authored. This is the biggest hole in the
   author→verify loop and is worth an explicit product decision.
7. **No discard/reset-draft endpoint** for any entity (verified: zero matches). An agent that
   makes a bad draft edit can only restore a prior version, which requires one to exist.
8. **Server-side version diff** — agents currently diff client-side by reading two versions.
9. **Stale docstring**: `flows.py:104` claims a 403 for framework-scoped flows; no such check
   exists in `flow_service.delete_flow`.

---

## 6. Open decisions for the maintainer

1. **Rename `list_policys` → `list_policies`?** Breaking, but the package has one broken
   published version and no real users. Recommend yes, now.
2. **Expose run triggering (`POST /workflows/{id}/runs`)?** Not a wrapper gap — a product
   decision about whether an external agent may start tenant work.
3. **Expose secrets?** `secrets.py` is member-accessible, so the connector *could* write real
   secret values. That contradicts the placeholder-only connector invariant. Recommend
   explicitly not wrapping it, and saying so in `axonity_conventions`.
4. **Tool-count gating** — see §4.
5. **Version-management tools** (create-named-version, rename, ensure-draft) — deferred in M4;
   confirm that is acceptable.
