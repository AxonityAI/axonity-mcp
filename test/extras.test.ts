import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import {
  registerAttachTools,
  registerConnectorTools,
  registerPersonaTools,
} from "../src/tools/extras.js";

function fakeServer() {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: (a: never) => Promise<unknown>) => {
      handlers.set(name, handler as (args: Record<string, unknown>) => Promise<unknown>);
    },
  };
  return { server, handlers };
}

function fakeClient() {
  return {
    get: vi.fn(async () => ({ ok: true })),
    post: vi.fn(async () => ({ ok: true })),
    put: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
  };
}

describe("persona tools", () => {
  it("reads and creates agent-scoped", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerPersonaTools(server as never, client as unknown as AxonityClient);

    await handlers.get("read_agent_persona")!({ agentId: "ag-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/agents/ag-1/persona");

    await handlers.get("create_agent_persona")!({ agentId: "ag-1", fields: { name: "V" } });
    expect(client.post).toHaveBeenCalledWith("/api/v1/agents/ag-1/persona", { name: "V" });
  });

  it("does not register update_persona — the generic persona entity provides it", () => {
    // Registering it here too would be a duplicate tool name.
    const { server, handlers } = fakeServer();
    registerPersonaTools(server as never, fakeClient() as unknown as AxonityClient);
    expect([...handlers.keys()]).not.toContain("update_persona");
    expect([...handlers.keys()]).not.toContain("list_personas");
  });
});

describe("connector tools", () => {
  it("creates a tool of type connector", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerConnectorTools(server as never, client as unknown as AxonityClient);
    await handlers.get("create_connector")!({ fields: { name: "Slack" } });
    expect(client.post).toHaveBeenCalledWith("/api/v1/tools", {
      type: "connector",
      name: "Slack",
    });
  });

  it("rejects real credentials in authConfig (placeholder-only)", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerConnectorTools(server as never, client as unknown as AxonityClient);
    const result = (await handlers.get("create_connector")!({
      fields: { name: "X", authConfig: { apiKey: "sk-real-secret" } },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/placeholder/i);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("accepts placeholder authConfig", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerConnectorTools(server as never, client as unknown as AxonityClient);
    await handlers.get("create_connector")!({
      fields: { name: "X", authConfig: { apiKey: "{{ SLACK_TOKEN }}" } },
    });
    expect(client.post).toHaveBeenCalled();
  });
});

describe("attach tools", () => {
  it("attaches a skill to an agent via the link route", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerAttachTools(server as never, client as unknown as AxonityClient);
    await handlers.get("attach_skill_to_agent")!({ agentId: "ag-1", skillId: "sk-1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/agents/ag-1/skills-v2/sk-1");
  });

  it("attaches a reference doc to an agent", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerAttachTools(server as never, client as unknown as AxonityClient);
    await handlers.get("attach_reference_to_agent")!({ agentId: "ag-1", refId: "rd-1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/agents/ag-1/reference-docs/rd-1");
  });

  it("reads back an agent's attached skills, policies, and reference docs", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerAttachTools(server as never, client as unknown as AxonityClient);

    await handlers.get("list_agent_skills")!({ agentId: "ag-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/agents/ag-1/skills-v2");

    await handlers.get("list_agent_policies")!({ agentId: "ag-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/agents/ag-1/policies");

    await handlers.get("list_agent_reference_docs")!({ agentId: "ag-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/agents/ag-1/reference-docs");
  });

  it("read-backs issue no write", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerAttachTools(server as never, client as unknown as AxonityClient);
    await handlers.get("list_agent_skills")!({ agentId: "ag-1" });
    expect(client.post).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
  });
});
