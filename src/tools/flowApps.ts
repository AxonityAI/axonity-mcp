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
}
