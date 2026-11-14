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

## Who may write

Reads (`list_modules`, schema, settings) are open to any token the backend lets
read. `update_module_settings` writes the **workspace level only**:

- a **service token** with the author scope;
- a **personal token** (the hosted `/mcp` connector serves only personal
  tokens) whose owner is an administrator of the workspace and who left "Run
  actions" on for the token (the backend's `actie_beheerder` class). It writes
  with that person's live rights and the save is recorded under that person,
  with the token named (decision B84, 14/11/2026). In the hosted connector the
  tool's description states both conditions, worded from
  `src/generated/tokenRouteClasses.ts`.

Role, personal and installation settings are never written through a token: the
backend refuses a token there (`module_settings_service.py` `context()`), the
tools have no selector for them, and `test/denyList.ts` plus the pinned route
table (`test/modules.test.ts`) keep the personal and installation routes closed.
The connector decides none of this; the backend's answer is the authority.

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
