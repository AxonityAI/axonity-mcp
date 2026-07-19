#!/usr/bin/env node
/**
 * Axonity Flow — MCP connector (epic #652 / C4).
 *
 * A local stdio MCP server that lets an external agent (e.g. Claude Code) read,
 * draft, and update workflows, agents and tools in an Axonity tenant. Add it to
 * your client with:
 *
 *   claude mcp add axonity -- npx -y @axonity-ai/mcp
 *
 * with AXONITY_TOKEN (a service token minted in Axonity → Settings → API tokens)
 * and, if self-hosting, AXONITY_API_URL in the environment.
 *
 * It talks to Axonity ONLY over the public REST API; the backend re-enforces
 * tenant + scope on every call. Publishing is human-approved and lands in a
 * later slice (C3) — this connector never publishes directly.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AxonityClient } from "./client.js";
import { loadConfig } from "./config.js";
import { registerConventions } from "./tools/conventions.js";
import {
  registerAttachTools,
  registerConnectorTools,
  registerPersonaTools,
} from "./tools/extras.js";
import { type EntityDef, registerEntityTools } from "./tools/register.js";
import { registerWorkflowMutations } from "./tools/workflowMutations.js";

/**
 * The entities the connector covers. Core entities (C4) plus memory
 * entities (C5) — skills, policies, reference docs — which have the same
 * draft→publish lifecycle via #443's unified versioning.
 */
const ENTITIES: EntityDef[] = [
  {
    singular: "workflow",
    basePath: "/api/v1/workflows",
    updateMethod: "PATCH",
    label: "workflows (business processes)",
  },
  {
    singular: "agent",
    basePath: "/api/v1/agents",
    updateMethod: "PUT",
    label: "agents",
  },
  {
    singular: "tool",
    basePath: "/api/v1/tools",
    updateMethod: "PUT",
    label: "tools (functions, connectors, validators, evaluators)",
  },
  {
    singular: "skill",
    basePath: "/api/v1/skills",
    updateMethod: "PUT",
    label: "skills (reusable know-how for agents)",
  },
  {
    singular: "policy",
    basePath: "/api/v1/policies",
    updateMethod: "PUT",
    label: "policies (rules and guardrails for agents)",
  },
  {
    singular: "reference_doc",
    basePath: "/api/v1/reference-docs",
    updateMethod: "PUT",
    label: "reference docs (background knowledge for agents)",
  },
];

export function buildServer(client: AxonityClient): McpServer {
  const server = new McpServer({ name: "axonity", version: "0.1.0" });
  registerConventions(server);
  for (const def of ENTITIES) {
    registerEntityTools(server, client, def);
  }
  registerWorkflowMutations(server, client);
  registerPersonaTools(server, client);
  registerConnectorTools(server, client);
  registerAttachTools(server, client);
  return server;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new AxonityClient(config);
  const server = buildServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr — stdout is the MCP channel and must stay clean.
  console.error(`Axonity MCP connector ready (${config.apiUrl}).`);
}

// Only run when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Axonity MCP connector failed to start:", err);
    process.exit(1);
  });
}
