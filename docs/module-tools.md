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

This client preparation is not a standalone release. Before release, refresh
`test/fixtures/openapi.snapshot.json` from the matching, implemented Flow R1
OpenAPI, record its provenance, and reconcile response descriptions against the
actual schemas and services. Run the conformance, exclusions, completeness and
contract-drift checks against that real snapshot. The old bare-list modules
response is not evidence for the new Page response. Never add fake routes to the
snapshot or exclude module endpoints to make a check pass.

Installation, role, user and personal-resolve routes remain outside these tools.
No package version bump, tag or npm publication belongs to this preparation.
