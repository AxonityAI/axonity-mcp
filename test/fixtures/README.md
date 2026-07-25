# `openapi.snapshot.json` — pinned backend contract

This is a vendored copy of the Axonity Flow backend's OpenAPI schema
(`GET /openapi.json`). `test/conformance.test.ts` pins the MCP's route surface
and the enums quoted in `axonity_conventions` to it, so a divergence between
this connector and the backend fails CI instead of misleading an agent.

Why vendor it (rather than fetch live): CI has no running backend, and a pinned
copy makes a renamed field / removed route / changed enum show up as a real
diff in review.

## Provenance

- Generated from **axonity-flow `main`** at commit `0c301308`
  (PR #726 — the backend half of epic axonity-mcp#10, stories #721–#724).
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
