/** The Flow-App authoring contract as three resources, read live from the installation. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AxonityClient } from "../client.js";

interface Authoring {
  surface?: unknown;
  manifestSchema?: unknown;
}

/** Each resource is a view of the one answer of `GET /api/v1/apps/authoring`. */
export const FLOW_APP_RESOURCES: {
  name: string;
  uri: string;
  description: string;
  pick: (answer: Authoring) => unknown;
}[] = [
  {
    name: "flow-app-contract",
    uri: "axonity://flow-app/contract",
    description:
      "The whole authoring contract of this Flow installation: surface, manifest schema, answer shapes and the contract hash.",
    pick: (answer) => answer,
  },
  {
    name: "flow-app-surface-v1",
    uri: "axonity://flow-app/surface/v1",
    description: "The Flow-App surface (version 1): the operations an app may call and the error codes it can get.",
    pick: (answer) => answer.surface,
  },
  {
    name: "flow-app-manifest-schema",
    uri: "axonity://flow-app/manifest-schema",
    description: "The JSON schema a Flow-App manifest must satisfy.",
    pick: (answer) => answer.manifestSchema,
  },
];

export function registerFlowAppResources(server: McpServer, client: AxonityClient): void {
  for (const resource of FLOW_APP_RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      { description: resource.description, mimeType: "application/json" },
      async (uri) => {
        const answer = await client.get<Authoring>("/api/v1/apps/authoring");
        return {
          contents: [
            { uri: uri.href, mimeType: "application/json", text: JSON.stringify(resource.pick(answer), null, 2) },
          ],
        };
      },
    );
  }
}
