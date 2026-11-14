import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerAll } from "../src/index.js";
import { CONVENTIONS } from "../src/tools/conventions.js";

/**
 * axonity-flow agteam01: an agent belongs to one team — one capability of its
 * workspace's company model — written through its own route,
 * `PUT /api/v1/agents/{agent_id}/team`, because the team is on the agent's
 * record, not in a version: the strict agent update refuses it.
 *
 * What this file holds: the platform really has that route and field (read
 * from the vendored OpenAPI snapshot, so the pin cannot outlive the backend),
 * `set_agent_team` calls exactly it with exactly `{ capabilityId }` — every
 * parameter arrives, null included — and the guide tells an agent which door
 * to use.
 */

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/openapi.snapshot.json", import.meta.url)),
    "utf8",
  ),
) as {
  paths: Record<string, Record<string, { requestBody?: unknown }>>;
  components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
};

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function registered() {
  const tools = new Map<string, { description: string; shape: Record<string, unknown>; handler: Handler }>();
  const server = {
    tool: (name: string, description: string, shape: Record<string, unknown>, handler: Handler) => {
      tools.set(name, { description, shape, handler });
    },
  };
  const client = {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async (_path: string, body: unknown) => ({ id: "a1", ...(body as object) })),
    patch: vi.fn(async () => ({})),
    del: vi.fn(async () => ({})),
  };
  registerAll(server as never, client as unknown as AxonityClient);
  return { tools, client };
}

describe("an agent's team (axonity-flow agteam01)", () => {
  it("the platform has the team route and the field on create, list and read", () => {
    expect(snapshot.paths["/api/v1/agents/{agent_id}/team"]?.put).toBeDefined();
    const body = snapshot.components.schemas.SetAgentTeamRequest;
    expect(Object.keys(body?.properties ?? {})).toEqual(["capabilityId"]);
    expect(body?.required).toEqual(["capabilityId"]);
    for (const schema of ["CreateAgentRequest", "GetAgentResponse", "AgentListItem"]) {
      expect(snapshot.components.schemas[schema]?.properties?.capabilityId, schema).toBeDefined();
    }
    // The versioned update does not take it: the team has one door.
    expect(snapshot.components.schemas.UpdateAgentRequest?.properties?.capabilityId).toBeUndefined();
  });

  it("set_agent_team puts { capabilityId } on the team route", async () => {
    const { tools, client } = registered();
    const tool = tools.get("set_agent_team");
    expect(tool).toBeDefined();

    await tool!.handler({ agentId: "a1", capabilityId: "cap-sales" });

    expect(client.put).toHaveBeenCalledWith("/api/v1/agents/a1/team", { capabilityId: "cap-sales" });
  });

  it("null takes the agent out of its team, and is sent as null", async () => {
    const { tools, client } = registered();

    await tools.get("set_agent_team")!.handler({ agentId: "a1", capabilityId: null });

    expect(client.put).toHaveBeenCalledWith("/api/v1/agents/a1/team", { capabilityId: null });
  });

  it("declares exactly the parameters the route reads, both required", () => {
    const { tools } = registered();
    const shape = tools.get("set_agent_team")!.shape as Record<string, { isOptional: () => boolean }>;

    expect(Object.keys(shape).sort()).toEqual(["agentId", "capabilityId"]);
    expect(shape.agentId.isOptional()).toBe(false);
    expect(shape.capabilityId.isOptional()).toBe(false);
  });

  it("the description says which company writes clear a team and which do not (review S-MCP1)", () => {
    const { tools } = registered();
    const text = tools.get("set_agent_team")!.description;

    expect(text).toContain("apply_company_mutation");
    expect(text).toContain("`update_company` and `discard_company_draft` leave the id");
  });

  it("the guide sends a team change to set_agent_team, not update_agent", () => {
    expect(CONVENTIONS).toContain("capabilityId");
    expect(CONVENTIONS).toContain("set_agent_team");
  });
});
