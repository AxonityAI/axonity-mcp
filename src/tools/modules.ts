/** Generic module settings (axonity-flow#1826, R1). The API owns the
 * manifest, permissions, resolution, revisions and atomic writes. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

// A dot segment would be normalized by URL even after encodeURIComponent.
const id = z.string().refine((value) => value !== "." && value !== "..", {
  message: "A module identifier cannot be a URL dot segment.",
}).describe("Module identifier — the id returned by list_modules.");
const key = z.string().describe("Setting key — a field key from read_module_settings_schema.");
const expectedRevision = z.string().nullable().describe(
  "Expected revision — the field's revision from read_module_settings, including an inherited " +
  "field's tombstone revision. Send null only if this context has never had a value.",
);
const change = z.discriminatedUnion("operation", [
  z.object({
    key,
    operation: z.literal("set").describe("Set a workspace override."),
    // z.unknown() alone accepts a missing key. Explicit null is a value;
    // undefined is not JSON and must never become an omitted value on the wire.
    value: z.unknown().refine((v) => v !== undefined, "Set requires an explicit value.").describe(
      "Setting value — a JSON value matching the live field schema; null is an explicit value.",
    ),
    expectedRevision,
    locked: z.boolean().optional().describe(
      "Own lock — set or clear this workspace override's lock when the field permits it. " +
      "Omit to preserve its own lock; a first override starts unlocked.",
    ),
  }).strict(),
  z.object({
    key,
    operation: z.literal("inherit").describe("Remove this context's override and own lock."),
    expectedRevision,
  }).strict(),
  z.object({
    key,
    operation: z.literal("follow_deploy").describe(
      "Use the server's latest deployed value and preserve this context's own lock.",
    ),
    expectedRevision,
  }).strict(),
]);

const SETTINGS_RESPONSE =
  "Returns the workspace settings object {moduleId, level, subjectId, fields}. " +
  "Each field is {key, revision, hasOverride, value, effectiveIsSet, effectiveValue, " +
  "sourceLevel, locked, ownLocked, followsDeploy, hasDeployment, deploymentValue, " +
  "mayWrite, roleConflict, needsChoice, sources, via, changedAt, actorLabel}. " +
  "hasOverride distinguishes no workspace override from an explicit null value; " +
  "effectiveIsSet distinguishes no effective value from an effective JSON null. " +
  "hasDeployment says whether deploymentValue exists. locked is the effective lock; " +
  "ownLocked belongs to this workspace context. mayWrite reports current write " +
  "permission; roleConflict and needsChoice report resolution state. " +
  "sources is a list of {level, subjectId, value, locked, via, changedAt, actorLabel} " +
  "records filtered by the server for this caller. via, changedAt and actorLabel " +
  "are server-provided provenance and may be null. ";

export function registerModuleTools(server: McpServer, client: AxonityClient): void {
  server.tool(
    "list_modules",
    "List the workspace's modules. Returns a Page object with items (module records " +
      "including id, label, description, enabled, ownEnabled, emergencyStopped, alwaysOn, " +
      "source, parent, dependsOn, navigation, shellSlots, surface and settings), " +
      "nextCursor, pageSize and hasMore. ownEnabled is the saved workspace choice; " +
      "enabled is effective availability and emergencyStopped is the installation " +
      "emergency-stop state. This is one page: pass nextCursor as " +
      "cursor until it is null to read every module. The backend chooses the default " +
      "page size when limit is omitted.",
    {
      limit: z.number().int().optional().describe("Page size — optional number of modules requested."),
      cursor: z.string().optional().describe("Next page cursor — the previous response's nextCursor."),
    },
    async ({ limit, cursor }) => guard(async () =>
      jsonResult(await client.get("/api/v1/modules", { limit, cursor }))),
  );

  server.tool(
    "read_module_settings_schema",
    "Read the module's live setting-field schema before changing settings. Returns " +
      "{moduleId, fields, rights}. fields is a list of {key, kind, label, description, " +
      "levels, right, lockable, perEnvironment, staysHome, agentReadsText, to, " +
      "rolesCombine, default, hasDefault, choiceOptions, fields, item}. kind and " +
      "label describe the value type and human name; hasDefault distinguishes an " +
      "absent default from JSON null. fields and item describe nested object/list " +
      "values with {name, kind, label, description, required, choiceOptions, to, " +
      "fields, item}. rights is a list of {id, role}. The server filters what " +
      "this caller may discover; this " +
      "reads the schema, not personal setting values. Use its field definitions to " +
      "choose valid values instead of assuming module-specific keys.",
    { id },
    async ({ id }) => guard(async () =>
      jsonResult(await client.get(`/api/v1/modules/${encodeURIComponent(id)}/settings/schema`))),
  );

  server.tool(
    "read_module_settings",
    "Read module settings at workspace level. " + SETTINGS_RESPONSE +
      "Read this before update_module_settings and reuse each changed field's revision. " +
      "This tool has no installation, role, user or personal-resolution selector.",
    { id },
    async ({ id }) => guard(async () =>
      jsonResult(await client.get(`/api/v1/modules/${encodeURIComponent(id)}/settings`, { level: "workspace" }))),
  );

  server.tool(
    "update_module_settings",
    "Save module settings at workspace level in one atomic request. Read " +
      "read_module_settings_schema and read_module_settings first. changes is a list " +
      "of {key, operation, expectedRevision, value?, locked?}: set requires value and " +
      "optionally locked; inherit and follow_deploy accept neither value nor locked. " +
      "expectedRevision is required for every change. inherit removes the workspace " +
      "override and own lock; follow_deploy uses the server's latest deployed value " +
      "and preserves the own lock. The backend validates field rights, levels, locks " +
      "and revisions, rejects duplicate keys, and derives actor and provenance from " +
      "the authenticated request. An author-scoped token can write permitted workspace " +
      "fields, including admin-classified fields; it cannot select another context. " +
      "A stale revision is refused: reread settings before deciding what to save. " +
      SETTINGS_RESPONSE,
    {
      id,
      changes: z.array(change).describe(
        "Setting changes — list of {key, operation, expectedRevision, value?, locked?}. " +
        "set requires value; only set accepts locked. inherit and follow_deploy carry " +
        "key, operation and expectedRevision only. Unknown change fields are refused.",
      ),
    },
    async ({ id, changes }) => guard(async () =>
      jsonResult(await client.patch(
        `/api/v1/modules/${encodeURIComponent(id)}/settings`, { changes }, { level: "workspace" },
      ))),
  );
}
