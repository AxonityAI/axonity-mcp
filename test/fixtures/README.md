# `openapi.snapshot.json` — pinned backend contract

This is a vendored copy of the Axonity Flow backend's OpenAPI schema
(`GET /openapi.json`). `test/conformance.test.ts` pins the MCP's route surface
and the enums quoted in `axonity_conventions` to it, so a divergence between
this connector and the backend fails CI instead of misleading an agent.

Why vendor it (rather than fetch live): CI has no running backend, and a pinned
copy makes a renamed field / removed route / changed enum show up as a real
diff in review.

## Provenance

- Generated from **axonity-flow `main`** at commit `b564532d` — epic
  axonity-flow#961, the nine authoring-API stories consumed by axonity-mcp#45.
  Nine routes are new: the reverse dependency look-up
  (`GET /workflows/using/{kind}/{id}`), the workflow skills read-back
  (`GET /workflows/{id}/skills-v2`), the run outline, and the cron-schedule and
  task-queue admin surfaces.
- Note what the snapshot does NOT carry, because it is the reason #45 exists:
  `StepSchema.type` still enums all nine step types while the validator accepts
  seven, and the trigger types and schedule-rule shapes appear nowhere in the
  schema at all. The transport schema is permissive; the authority is the
  validator, and its lists are served at runtime by
  `GET /workflows/operations`. A conformance check pinned to this file cannot
  see below that line — which is exactly why every tool description and the
  authoring guide now read those vocabularies from the server instead.
  (Previously `002d1921` — epic #791 (the publish gate tells the truth) plus
  #792/#795: `POST /tools/{id}/dry-run` and `POST /publish-approvals/bulk`.
  Before that `93fda3c4` — PR #780, the backend half of epic
  axonity-flow#764 (stories B1–B8), which changed the authoring contract
  itself: `add_step` accepts a complete step, `add_edge` accepts `from`/`to`
  and honours a caller id, payload models became `extra="forbid"`, mutation
  responses carry `systemAdjustments`, and `POST /workflows/{id}/validate` was
  added alongside `catalogChecked`. Before that `0c301308` and `c7fe5421`.)
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
