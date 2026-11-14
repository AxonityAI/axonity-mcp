# Module tools

The connector registers four generic tools for the R1 module-settings API
(AxonityAI/axonity-flow#1826). The tool descriptions own their calling contract;
`axonity_conventions` makes the read-schema/read-values/write/read-back workflow
findable. Module-specific field definitions come from the backend at runtime.

| Tool | API mapping |
| --- | --- |
| `list_modules` | `GET /api/v1/modules`; forward optional `limit` and `cursor` and preserve the Page envelope |
| `read_module_settings_schema` | `GET /api/v1/modules/{id}/settings/schema` |
| `read_module_settings` | `GET /api/v1/modules/{id}/settings`, query `level=workspace` |
| `update_module_settings` | `PATCH /api/v1/modules/{id}/settings`, query `level=workspace`, body `{changes}` |

Module ids are URL-encoded. The caller cannot select an installation, role or
personal context, provide an actor, or declare a deployment origin. Each change
uses a strict discriminated union; unknown fields fail validation. The backend
owns authentication, field permissions, locks, revisions, duplicate-key checks,
value validation and atomicity. The connector does not resolve settings locally
or impose additional key, id or change-count limits.

`test/modules.test.ts` exercises registered tools with a recording HTTP client
and the real MCP SDK over an in-memory transport. This proves argument
validation, forwarding and response/error handling. It does not prove backend
authorization, persistence, atomicity or endpoint availability.

## R1 integration gate

This client preparation is not a standalone release. The vendored snapshot
comes from the real Flow R1 app export; its exact hash and provenance are in
`test/fixtures/README.md`. Before release, compare it with the final Flow R1
export and reconcile any later changes. Run the conformance, exclusions,
completeness and contract-drift checks against that final snapshot. The old bare-list modules
response is not evidence for the new Page response. Never add fake routes to the
snapshot or exclude module endpoints to make a check pass.

Installation, role, user and personal-resolve routes remain outside these tools.
No package version bump, tag or npm publication belongs to this preparation.

## Real backend wire proof

The paired Flow checkout supplies
`backend/tests/modules/module_settings_wire_app.py`. Run the explicit integration
proof from this checkout through the team heavy-task runner:

```sh
node --import tsx scripts/prove-module-settings-wire.mjs /absolute/path/to/flow-worktree
```

It requires the coordinator-owned synthetic PostgreSQL cluster recorded in the
Flow worktree's `workspace/postgres-1826-r1/owner.json`. It refuses another
endpoint and creates a new private database, migrates it to the actual head,
mints ephemeral service tokens and sends real SDK calls through the actual
HTTP client to the Flow ASGI app. It runs no listening server or external
network request and overrides no authentication or service dependency. It
checks Page cursors, live schema, author/read/operate permissions, revision
conflicts, atomic patches, deployment targets and own locks, inherit tombstones,
server MCP provenance, tenant isolation and personal/installation refusal.
The database is removed in `finally`. This command fails when its prerequisites
are unavailable; unit mocks and a skipped integration run do not satisfy it.
Lossless migration rollback has its own Flow proofs.
