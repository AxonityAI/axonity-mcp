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

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AxonityClient } from "./client.js";
import { loadConfig } from "./config.js";
import { registerConventions } from "./tools/conventions.js";
import { assertPlaceholderCredentials } from "./tools/credentials.js";
import {
  registerAttachTools,
  registerCatalogTools,
  registerConnectorTools,
  registerPersonaTools,
} from "./tools/extras.js";
import { registerCompanyTools } from "./tools/company.js";
import { registerPromptPlacementTools } from "./tools/promptPlacement.js";
import { type EntityDef, registerEntityTools } from "./tools/register.js";
import { registerRunTools } from "./tools/runs.js";
import { registerTriggerTools } from "./tools/triggers.js";
import {
  registerApprovalTools,
  registerExecutionTools,
  registerValidationTools,
} from "./tools/validation.js";
import { type VersionedEntity, registerVersionTools } from "./tools/versions.js";
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
    deleteVersionParam: "expectedVersion",
  },
  {
    singular: "agent",
    basePath: "/api/v1/agents",
    updateMethod: "PUT",
    label: "agents",
    deleteVersionParam: "expectedVersion",
  },
  {
    singular: "tool",
    basePath: "/api/v1/tools",
    updateMethod: "PUT",
    label: "tools (functions, connectors, validators, evaluators)",
    // A connector is just a tool, so create_tool/update_tool can carry an
    // authConfig too — they get the same credential guard as create_connector.
    guardFields: assertPlaceholderCredentials,
    deleteVersionParam: "expectedVersion",
  },
  {
    singular: "skill",
    basePath: "/api/v1/skills",
    updateMethod: "PUT",
    label: "skills (reusable know-how for agents)",
    deleteVersionParam: "expected_version",
  },
  {
    singular: "policy",
    basePath: "/api/v1/policies",
    updateMethod: "PUT",
    label: "policies (rules and guardrails for agents)",
    plural: "policies",
    deleteVersionParam: "expected_version",
  },
  {
    singular: "reference_doc",
    basePath: "/api/v1/reference-docs",
    updateMethod: "PUT",
    label: "reference docs (background knowledge for agents)",
    deleteVersionParam: "expected_version",
  },
  {
    singular: "output_schema",
    basePath: "/api/v1/output-schemas",
    updateMethod: "PUT",
    label: "output schemas (reusable step/agent output contracts)",
    // Now fully version-controlled and in the publish-approval gateway
    // alongside the memory entities — no longer live-on-write.
    deleteVersionParam: "expected_version",
  },
  {
    singular: "persona",
    basePath: "/api/v1/personas",
    updateMethod: "PUT",
    label: "personas (an agent's character, 1:1 with the agent)",
    // Created only through its agent (create_agent_persona) — there is no
    // standalone POST /api/v1/personas.
    creatable: false,
    deleteVersionParam: "expected_version",
  },
  {
    singular: "prompt_snippet",
    basePath: "/api/v1/prompt-snippets",
    updateMethod: "PATCH",
    label: "prompt snippets (reusable prompt fragments)",
    deleteVersionParam: "expectedVersion",
  },
  {
    singular: "flow",
    basePath: "/api/v1/flows",
    updateMethod: "PATCH",
    label: "flows (reusable workflow fragments)",
    deleteVersionParam: "expectedVersion",
  },
];

/**
 * Entities with version history. Every authored entity here exposes the
 * `/versions*` routes, `flow` included (verified against the backend:
 * `/api/v1/flows/{id}/versions…`), so all ten get the version tools.
 */
const VERSIONED: VersionedEntity[] = [
  { singular: "workflow", basePath: "/api/v1/workflows", publishedPath: "entity" },
  { singular: "agent", basePath: "/api/v1/agents", publishedPath: "entity" },
  { singular: "tool", basePath: "/api/v1/tools", publishedPath: "entity" },
  { singular: "skill", basePath: "/api/v1/skills", publishedPath: "versions" },
  { singular: "policy", basePath: "/api/v1/policies", publishedPath: "versions" },
  {
    singular: "reference_doc",
    basePath: "/api/v1/reference-docs",
    publishedPath: "versions",
  },
  { singular: "persona", basePath: "/api/v1/personas", publishedPath: "versions" },
  {
    singular: "output_schema",
    basePath: "/api/v1/output-schemas",
    publishedPath: "versions",
  },
  {
    singular: "prompt_snippet",
    basePath: "/api/v1/prompt-snippets",
    publishedPath: "versions",
  },
  { singular: "flow", basePath: "/api/v1/flows", publishedPath: "entity" },
];

/**
 * Register the whole tool surface onto a server. Split out from `buildServer`
 * so a test can drive the real registration against a recording server — e.g.
 * to assert no tool ever targets a deny-listed route (publish/approve/secret/…).
 * `ServerLike` is the minimal `.tool()` surface both `McpServer` and a test
 * double satisfy.
 */
type ServerLike = Pick<McpServer, "tool">;

export function registerAll(server: ServerLike, client: AxonityClient): void {
  registerConventions(server as McpServer);
  for (const def of ENTITIES) {
    registerEntityTools(server as McpServer, client, def);
  }
  for (const def of VERSIONED) {
    registerVersionTools(server as McpServer, client, def);
  }
  registerWorkflowMutations(server as McpServer, client);
  registerValidationTools(server as McpServer, client);
  registerExecutionTools(server as McpServer, client);
  registerApprovalTools(server as McpServer, client);
  registerTriggerTools(server as McpServer, client);
  registerRunTools(server as McpServer, client);
  registerPersonaTools(server as McpServer, client);
  registerConnectorTools(server as McpServer, client);
  registerAttachTools(server as McpServer, client);
  registerCatalogTools(server as McpServer, client);
  registerPromptPlacementTools(server as McpServer, client);
  registerCompanyTools(server as McpServer, client);
}

export function buildServer(client: AxonityClient): McpServer {
  const server = new McpServer({ name: "axonity", version: "0.1.0" });
  registerAll(server, client);
  return server;
}

async function main(): Promise<void> {
  assertNoExtraArguments(process.argv.slice(2));
  const config = loadConfig();
  const client = new AxonityClient(config);
  const server = buildServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr — stdout is the MCP channel and must stay clean.
  console.error(`Axonity MCP connector ready (${config.apiUrl}).`);
}

/**
 * True when this module is the process entry point.
 *
 * `import.meta.url` is realpath-resolved and percent-encoded, so it can't be
 * compared against a hand-built `file://${argv[1]}` string: npm installs the bin
 * as a symlink (`node_modules/.bin/axonity-mcp`), which is how `npx` runs it, and
 * paths with spaces encode differently. Both mismatches used to leave the server
 * silently unstarted. Resolve argv[1] the same way before comparing.
 */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    // argv[1] isn't a readable path (e.g. `node --eval`); not our entry point.
    return false;
  }
}

export function assertNoExtraArguments(argv: string[]): void {
  if (argv.length === 0) return;
  throw new Error(
    [
      "This MCP server does not accept command-line arguments.",
      "Usage:",
      "  axonity-mcp",
      "",
      "Pass configuration through environment variables instead:",
      "  AXONITY_TOKEN (required): the service token.",
      "  AXONITY_API_URL (optional): API base URL.",
      "",
      `Received arguments: ${argv.join(" ")}`,
    ].join("\n"),
  );
}

// Only run when executed directly (not when imported by tests).
if (isEntryPoint(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error("Axonity MCP connector failed to start:", err);
    process.exit(1);
  });
}
