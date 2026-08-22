/**
 * The company entity — a tenant's single company document (mission, value
 * streams, org structure). Unlike the other authored entities it is a
 * SINGLETON: one per tenant, addressed at `/api/v1/company` with no id, so it
 * has no list / create / delete / restore / discard routes. It is
 * version-controlled like the memory entities, and editable two ways: command
 * mutations (`apply_company_mutation`, preferred — the backend validates each
 * and threads the version) or a whole-document PUT (`update_company`). Workflow
 * has had both for a long time; company was whole-document-only here even
 * though `POST /api/v1/company/mutations` existed.
 *
 * Publishing: company is currently NOT a publish-approval entity type on the
 * backend, so there is no request_publish_company — a company change is
 * published directly by a human/admin in Axonity. (Tracked in axonity-flow: the
 * decision on whether company joins the approval queue.)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

export function registerCompanyTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "read_company",
    "Read this tenant's company document (its current draft and version). There " +
      "is one company per tenant — no id. Read it before you update, to get the " +
      "version for optimistic locking.",
    {},
    async () => guard(async () => jsonResult(await client.get("/api/v1/company"))),
  );

  server.tool(
    "create_company_from_template",
    "Create this tenant's company document from a template — how a tenant that " +
      "has none gets one. Pick the template with list_templates({ kind: " +
      "\"all\" }) and read it with read_template first: the template decides the " +
      "value stream, the stages and the capabilities that everything else in " +
      "the tenant will hang off. " +
      "\n\nThis is a WRITE on the singleton every workflow refers to. Run " +
      "read_company first — if one already exists, instantiating over it is " +
      "almost never what you meant, and update_company or " +
      "apply_company_mutation is. Like every other write here it produces a " +
      "DRAFT; a human publishes it.",
    {
      templateId: z.string().describe("The template's id, from list_templates."),
      companyName: z
        .string()
        .optional()
        .describe("Name for the new company. Omit to take the template's own."),
      confirm: z
        .literal(true)
        .describe(
          "Must be true. Acknowledges this creates the tenant's company " +
            "document from a template — check read_company first.",
        ),
    },
    async ({ templateId, companyName }) =>
      guard(async () =>
        jsonResult(
          await client.post("/api/v1/company/from-template", {
            templateId,
            ...(companyName ? { companyName } : {}),
          }),
        ),
      ),
  );

  server.tool(
    "read_company_published",
    "Read the LIVE published company document — what the runtime uses, as opposed " +
      "to the draft read_company returns. Diff the two to see what a publish would change.",
    {},
    async () =>
      guard(async () => jsonResult(await client.get("/api/v1/company/published"))),
  );

  server.tool(
    "update_company",
    "Save the company draft as a WHOLE document (full-document PUT, not a field " +
      "merge). Read it first for its version; on a 409 conflict re-read and retry. " +
      "This writes the draft only — a human publishes it in Axonity (company is " +
      "not part of the request_publish_* approval flow).",
    {
      expectedVersion: z
        .number()
        .int()
        .describe("The version you last read — rejected with 409 if stale."),
      document: z
        .record(z.unknown())
        .describe("The complete company document to persist (as read_company returns it)."),
    },
    async ({ expectedVersion, document }) =>
      guard(async () =>
        jsonResult(
          await client.put("/api/v1/company", { expectedVersion, document }),
        ),
      ),
  );

  server.tool(
    "list_company_versions",
    "List the company document's version history — checkpoints and major versions.",
    {
      type: z
        .enum(["checkpoint", "major", "all"])
        .optional()
        .describe("Which kind to list. Defaults to all."),
      limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
      offset: z.number().int().min(0).optional().describe("Default 0."),
    },
    async ({ type, limit, offset }) =>
      guard(async () =>
        jsonResult(await client.get("/api/v1/company/versions", { type, limit, offset })),
      ),
  );

  server.tool(
    "read_company_version",
    "Read one historical company version by its CHECKPOINT NUMBER (the integer " +
      "`version` from list_company_versions), including its document.",
    { version: z.number().int().describe("The integer checkpoint number, e.g. 3.") },
    async ({ version }) =>
      guard(async () =>
        jsonResult(await client.get(`/api/v1/company/versions/${version}`)),
      ),
  );

  server.tool(
    "restore_company_version",
    "Roll the company draft back to an earlier version. Takes the versionId (a " +
      "UUID from list_company_versions), not the checkpoint number. Changes only " +
      "the draft; what is live stays live until a human publishes.",
    {
      versionId: z.string().describe("The version row's UUID."),
      expectedVersion: z
        .number()
        .int()
        .describe("The draft version you last read — 409 if stale."),
    },
    async ({ versionId, expectedVersion }) =>
      guard(async () =>
        jsonResult(
          await client.post(`/api/v1/company/versions/${versionId}/restore`, {
            expectedVersion,
          }),
        ),
      ),
  );

  server.tool(
    "create_company_major_version",
    "Cut a new NAMED major version of the company document — \"Save As\" for " +
      "the current draft, so a milestone is findable by name instead of by " +
      "hunting through checkpoints. Takes no id (singleton). This does NOT " +
      "publish: what is live stays live until a human approves a " +
      "request_publish_company.",
    {
      name: z
        .string()
        .min(1)
        .max(255)
        .describe('What to call this release, e.g. "Q3 operating model".'),
      description: z
        .string()
        .optional()
        .describe("A longer note on what this version represents."),
    },
    async ({ name, description }) =>
      guard(async () =>
        jsonResult(
          await client.post("/api/v1/company/versions", {
            name,
            ...(description ? { description } : {}),
          }),
        ),
      ),
  );

  server.tool(
    "ensure_company_major_version",
    "Make sure the company document has a working draft major version, " +
      "creating an unnamed one if it has none. IDEMPOTENT — safe to call before " +
      "a run of edits; when one already exists nothing changes. Returns the " +
      "draft's major version number and name.",
    {},
    async () =>
      guard(async () => jsonResult(await client.post("/api/v1/company/versions/ensure"))),
  );

  server.tool(
    "apply_company_mutation",
    "Apply ONE structural command to the company document — the validated, " +
      "version-safe way to change its layers, value streams, stages and " +
      "capabilities, and to link workflows to them. Prefer this over " +
      "update_company: that route is a whole-document PUT, which is the same " +
      "reason apply_workflow_mutations is preferred for a workflow. Read the " +
      "company first for its version. " +
      "\n\nOne command per call — this route has no batch form, unlike the " +
      "workflow one. Apply a sequence yourself, using the version each response " +
      "returns as the next call's expectedVersion. " +
      "\n\nWHICH COMMANDS EXIST is not listed here and this connector keeps no " +
      "copy: unlike workflows, company has no catalogue route to read, so a " +
      "wrong `type` is a 422 that names every value the route accepts. Read " +
      "that error rather than guessing twice.",
    {
      type: z
        .string()
        .describe(
          "The command name. A value this deploy does not accept comes back as " +
            "a 422 listing the ones it does.",
        ),
      payload: z
        .record(z.unknown())
        .describe("The command's arguments (camelCase keys)."),
      expectedVersion: z
        .number()
        .int()
        .describe("The version you last read — rejected with 409 if stale."),
    },
    async ({ type, payload, expectedVersion }) =>
      guard(async () =>
        jsonResult(
          await client.post("/api/v1/company/mutations", {
            type,
            payload,
            expectedVersion,
          }),
        ),
      ),
  );

  server.tool(
    "name_company_major_version",
    "Give one of the company document's major versions a name — label a release " +
      "so it is easy to find in history. Targets a MAJOR version by its integer " +
      "number (from list_company_versions), not a checkpoint or a versionId. Like " +
      "everything else on this singleton it takes no id. This only renames; it " +
      "does not create, publish, or roll anything back.",
    {
      majorVersion: z
        .number()
        .int()
        .describe("The major version's integer number, e.g. 2."),
      name: z.string().min(1).max(255).describe("The new name for that major version."),
    },
    async ({ majorVersion, name }) =>
      guard(async () =>
        jsonResult(
          await client.patch(`/api/v1/company/versions/major/${majorVersion}`, { name }),
        ),
      ),
  );

  server.tool(
    "request_publish_company",
    "Request that the company document be published. Like request_publish_* for " +
      "every other entity, this does NOT publish — it creates a pending approval " +
      "a human approves in Axonity. Company is a singleton, so unlike the others " +
      "this takes NO id: the server resolves the one company from your tenant. " +
      "(Direct company publish is closed to service tokens — this is the only " +
      "path.)",
    {
      changeSummary: z
        .string()
        .optional()
        .describe("A short note for the approver on what changed and why."),
    },
    async ({ changeSummary }) =>
      guard(async () =>
        jsonResult(
          await client.post("/api/v1/publish-approvals", {
            entityType: "company",
            ...(changeSummary ? { changeSummary } : {}),
          }),
        ),
      ),
  );
}
