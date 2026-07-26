/**
 * The company entity — a tenant's single company document (mission, value
 * streams, org structure). Unlike the other authored entities it is a
 * SINGLETON: one per tenant, addressed at `/api/v1/company` with no id, so it
 * has no list / create / delete / restore / discard routes. It is
 * version-controlled like the memory entities, and edited as a whole document
 * (a full-document PUT under optimistic locking), not field-by-field.
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
