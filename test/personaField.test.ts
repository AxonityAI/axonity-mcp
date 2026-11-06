import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { collectCalledRoutes } from "../src/contract.js";
import { registerAll } from "../src/index.js";
import { CONVENTIONS } from "../src/tools/conventions.js";

/**
 * axonity-flow#2176 (R5b): the persona is a field of the agent, and ten agent
 * fields and three mechanisms are gone. The 21 persona routes no longer exist,
 * `persona` is no longer a kind the approval queue takes, and a create or update
 * that sends a retired field is a 422 that names it.
 *
 * What this file holds: no tool calls a persona route or asks for a persona's
 * publication, and nothing this connector tells an agent names a retired field.
 */

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/openapi.snapshot.json", import.meta.url)),
    "utf8",
  ),
) as {
  components: {
    schemas: Record<
      string,
      { properties?: Record<string, { enum?: string[] }>; required?: string[] }
    >;
  };
};

const createAgent = snapshot.components.schemas.CreateAgentRequest;
const createAgentFields = new Set(Object.keys(createAgent.properties ?? {}));

function registered() {
  const descriptions = new Map<string, string>();
  const server = {
    tool: (name: string, description: string) => {
      descriptions.set(name, description);
    },
  };
  const client = {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    del: vi.fn(async () => ({})),
  };
  registerAll(server as never, client as unknown as AxonityClient);
  return descriptions;
}

/** The persona-by-id tools that had a route under /api/v1/personas, and its publication. */
const RETIRED_TOOLS = [
  "list_personas",
  "list_deleted_personas",
  "read_persona",
  "update_persona",
  "delete_persona",
  "restore_persona",
  "discard_persona_draft",
  "list_persona_versions",
  "list_deleted_persona_versions",
  "read_persona_version",
  "read_persona_published",
  "create_persona_major_version",
  "ensure_persona_major_version",
  "name_persona_major_version",
  "delete_persona_version",
  "restore_persona_version",
  "restore_deleted_persona_version",
  "request_publish_persona",
];

/**
 * Agent fields #2176 retired. Spelled out because a guide that still names
 * them is what sends an agent into the 422; the first test proves each one is
 * really gone from the platform's create body, so this list cannot pin a field
 * that still exists.
 */
const RETIRED_AGENT_FIELDS = [
  "learningMode",
  "canOwnProcess",
  "episodicMemoryEnabled",
  "permissions",
  "tags",
];
/** Keys of the retired `permissions` bag, named only inside it. */
const RETIRED_PERMISSION_KEYS = [
  "outputValidators",
  "exposedValidatorTools",
  "expectedOutputSchemaId",
  "verboseOutput",
];

describe("the persona is a field of the agent (axonity-flow#2176)", () => {
  it("the retired fields are really gone from the platform, and persona is there", () => {
    for (const field of RETIRED_AGENT_FIELDS) {
      expect(createAgentFields.has(field), field).toBe(false);
    }
    expect(createAgentFields.has("persona")).toBe(true);
    expect(snapshot.components.schemas.PersonaResponse).toBeUndefined();
    expect(snapshot.components.schemas.AgentPermissions).toBeUndefined();
    expect(
      snapshot.components.schemas.CreateApprovalRequest?.properties?.entityType?.enum,
    ).not.toContain("persona");
  });

  it("no tool is registered for a persona route that is gone", () => {
    const names = [...registered().keys()];
    for (const name of RETIRED_TOOLS) expect(names, name).not.toContain(name);
    // The migration path stays, on the agent's field.
    expect(names).toContain("read_agent_persona");
    expect(names).toContain("create_agent_persona");
  });

  it("no tool calls a persona route", async () => {
    const calls = await collectCalledRoutes(registerAll as never);
    const persona = calls.filter(
      (c) => c.path.startsWith("/api/v1/personas") || /\/agents\/[^/]+\/persona$/.test(c.path),
    );
    expect(persona).toEqual([]);
  });

  it("nothing the connector tells an agent names a retired agent field or persona tool", () => {
    const texts: [string, string][] = [
      ["axonity_conventions", CONVENTIONS],
      ...[...registered()].map(([name, d]) => [name, d] as [string, string]),
    ];
    const needles = [
      ...RETIRED_AGENT_FIELDS.filter((f) => f !== "permissions" && f !== "tags").map(
        (f) => `\`${f}\``,
      ),
      ...RETIRED_PERMISSION_KEYS,
      "permissions.",
      "agent.tags",
      ...RETIRED_TOOLS,
      "characterText",
    ];
    const found: string[] = [];
    for (const [where, text] of texts) {
      for (const needle of needles) if (text.includes(needle)) found.push(`${where}: ${needle}`);
    }
    expect(found).toEqual([]);
  });
});

/** The `### agent` section of the guide, up to the next section. */
function agentSection(): string {
  const start = CONVENTIONS.indexOf("### agent ");
  expect(start, "the guide has an agent section").toBeGreaterThanOrEqual(0);
  const end = CONVENTIONS.indexOf("\n### ", start + 1);
  return CONVENTIONS.slice(start, end < 0 ? undefined : end);
}

describe("the guide's create_agent section is the platform's CreateAgentRequest", () => {
  it("every camelCase field it names is a field of the agent's create or update body", () => {
    // Tool names are snake_case and values are lowercase, so a backticked
    // camelCase token in this section is a field name. `expectedVersion` is an
    // update field, hence both bodies.
    const updateFields = Object.keys(
      snapshot.components.schemas.UpdateAgentRequest.properties ?? {},
    );
    const known = new Set([...createAgentFields, ...updateFields]);
    const named = [...agentSection().matchAll(/`([a-z]+[A-Z][A-Za-z]*)`/g)].map((m) => m[1]);
    expect(named.length, "the section names its fields").toBeGreaterThan(5);
    expect(named.filter((field) => !known.has(field))).toEqual([]);
  });

  it("names persona as the agent's own field", () => {
    expect(agentSection()).toContain("`persona`");
  });

  it("quotes every value of each enumerated field, and no other", () => {
    const section = agentSection();
    for (const field of ["capabilityTier", "creativityTier", "delegation", "reasoningLevel"]) {
      const values = createAgent.properties?.[field]?.enum ?? [];
      expect(values.length, field).toBeGreaterThan(1);
      const line = section.split("\n").find((l) => l.includes(`\`${field}\`:`));
      expect(line, `${field} has its own line`).toBeDefined();
      const quoted = [...line!.matchAll(/`([a-z_]+)`/g)]
        .map((m) => m[1])
        .filter((token) => token !== field);
      expect(quoted.sort(), field).toEqual([...values].sort());
    }
  });
});
