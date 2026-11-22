/** The prompt `new-flow-app`: a convenience over the same starter route the tool reads. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";

export const NEW_FLOW_APP_PROMPT = "new-flow-app";

/**
 * The prompt carries no logic of its own: its text says what the tool says,
 * and everything after it is the answer of `GET /api/v1/apps/starter`.
 */
export function registerNewFlowAppPrompt(server: McpServer, client: AxonityClient): void {
  server.registerPrompt(
    NEW_FLOW_APP_PROMPT,
    {
      title: "New Flow App",
      description:
        "Start a new Flow App: fetches the starter of this Flow installation and tells the agent " +
        "to follow it instead of writing app files from memory.",
      argsSchema: {
        slug: z.string().optional().describe("The slug the new app should get, if the user already chose one."),
      },
    },
    async ({ slug }) => {
      const starter = await client.get("/api/v1/apps/starter");
      const lines = [
        "The user wants to create a new Flow App. Do not write manifest or app files from memory. " +
          "Follow the starter steps below exactly.",
        ...(slug ? [`The slug the user chose: ${slug}`] : []),
        "",
        JSON.stringify(starter, null, 2),
      ];
      return { messages: [{ role: "user" as const, content: { type: "text" as const, text: lines.join("\n") } }] };
    },
  );
}
