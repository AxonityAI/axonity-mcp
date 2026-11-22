/** Flow-App authoring and discovery through the platform's canonical routes. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

const manifest = z.record(z.unknown()).describe(
  "Candidate flow-app/v1 manifest object. The platform validates it canonically; this MCP " +
    "does not carry a local schema copy.",
);

/** Register the bounded Flow-App tools introduced with #1826 A5. */
export function registerFlowAppTools(server: McpServer, client: AxonityClient): void {
  server.tool(
    "validate_flow_app_manifest",
    "Validate a candidate Flow-App manifest before opening a pull request. The platform uses " +
      "its canonical FlowAppManifest validation and returns {valid, errors}; this writes nothing.",
    { manifest },
    async ({ manifest }) => guard(async () =>
      jsonResult(await client.post("/api/v1/apps/manifest/validate", { manifest }))),
  );

  server.tool(
    "list_flow_app_status",
    "List one page of Flow-App statuses visible to the person behind this MCP token. It returns " +
      "the same app fields and visibility as the dashboard apps list: only apps that person may " +
      "open. Pass nextCursor as cursor until it is null; omit limit to use the backend default.",
    {
      limit: z.number().int().optional().describe("Page size — optional number of apps requested."),
      cursor: z.string().optional().describe("Next page cursor — the previous response's nextCursor."),
    },
    async ({ limit, cursor }) => guard(async () =>
      jsonResult(await client.get("/api/v1/apps/status", { limit, cursor }))),
  );

  // The entry into a new Flow-App (#1826 starter kit): three thin readers over
  // routes of the installation. No value, version or rule is written down here;
  // what the route answers is what the tool answers.
  server.tool(
    "get_flow_app_starter",
    "Start here when the user wants to create a new Flow App, or asks how to begin. Returns the " +
      "single-use download link (see expiresAt) for the starter package of this Flow installation, " +
      "with the build, surface and kit versions and the contract hash it belongs to. Call this " +
      "before writing any file: unpack the package and follow the AGENTS.md inside it. Never write " +
      "Flow App files (manifest, AGENTS.md, app code) from memory; the contract changes per version.",
    {},
    async () => guard(async () => jsonResult(await client.get("/api/v1/apps/starter"))),
  );

  server.tool(
    "get_flow_app_authoring_contract",
    "The authoring contract of this Flow installation, as data: the app surface (operations, error " +
      "codes), the manifest JSON schema, the shape of every answer, and the contract hash. Read it " +
      "when you build or change a Flow App; it is the same content as the axonity://flow-app " +
      "resources, for clients that do not read resources.",
    {},
    async () => guard(async () => jsonResult(await client.get("/api/v1/apps/authoring"))),
  );

  server.tool(
    "check_flow_app_manifest",
    "Check a candidate Flow-App manifest against this workspace, as the person behind this token " +
      "may read it: the schema, and that every table, workflow and agent it asks for exists, is " +
      "published and fits. Run it until it reports no problems, before the pull request. It writes " +
      "nothing; a name you may not read is reported as not existing.",
    { manifest },
    async ({ manifest }) => guard(async () =>
      jsonResult(await client.post("/api/v1/apps/manifest/check", { manifest }))),
  );
}
