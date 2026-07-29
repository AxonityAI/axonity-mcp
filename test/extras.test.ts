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

  it("points each agent-scoped attach/detach at its read-back", () => {
    // An attach returns 200 without proving the link resolved, and the link is
    // not in the entity body — so the description has to name the read-back or an
    // agent has no way to know one exists (#12).
    const descriptions = new Map<string, string>();
    const server = {
      tool: (name: string, description: string) => descriptions.set(name, description),
    };
    registerAttachTools(server as never, fakeClient() as unknown as AxonityClient);

    for (const [tool, readBack] of [
      ["attach_skill_to_agent", "list_agent_skills"],
      ["detach_skill_from_agent", "list_agent_skills"],
      ["attach_policy_to_agent", "list_agent_policies"],
      ["attach_reference_to_agent", "list_agent_reference_docs"],
    ]) {
      expect(descriptions.get(tool), `${tool} should mention ${readBack}`).toContain(readBack);
    }

    // The workflow-scoped variant has no list route on the backend, so it must
    // not promise one.
    expect(descriptions.get("attach_skill_to_workflow")).not.toMatch(/list_/);
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

/**
 * #24 — a detach must report what the SERVER did.
 *
 * 27 detach commands during the Talentus migration all answered
 * `detached: true`. Not one of those links existed: the documents applied
 * tenant-wide, so there was nothing to detach and nothing was detached. The
 * client was the reason the answer was always the same — it threw the response
 * away and asserted success locally.
 */
describe("detach reports the backend's answer, not a local claim", () => {
  function detachWith(body: unknown) {
    const { server, handlers } = fakeServer();
    const client = { ...fakeClient(), del: vi.fn(async () => body) };
    registerAttachTools(server as never, client as unknown as AxonityClient);
    return { handlers, client };
  }

  function payload(result: unknown) {
    return JSON.parse((result as { content: { text: string }[] }).content[0].text);
  }

  it("says so when the backend reports nothing was removed", async () => {
    // SkillLinkResponse carries `linked` — see backend schemas/skill_v2.py.
    const { handlers } = detachWith({
      skillId: "sk-1",
      targetId: "ag-1",
      targetType: "agent",
      linked: true,
    });
    const result = await handlers.get("detach_skill_from_agent")!({
      agentId: "ag-1",
      skillId: "sk-1",
    });

    const body = payload(result);
    expect(body.linked).toBe(true);
    expect(body.detached).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('"detached": true');
  });

  it("reflects a backend answer that a link WAS removed", async () => {
    const { handlers } = detachWith({
      skillId: "sk-1",
      targetId: "ag-1",
      targetType: "agent",
      linked: false,
    });
    const body = payload(
      await handlers.get("detach_skill_from_agent")!({ agentId: "ag-1", skillId: "sk-1" }),
    );
    expect(body.linked).toBe(false);
  });

  it("makes no claim about what changed when the route answers 204", async () => {
    const { handlers } = detachWith(undefined);
    const body = payload(
      await handlers.get("detach_policy_from_agent")!({ agentId: "ag-1", policyId: "po-1" }),
    );

    expect(body.detached).toBeUndefined();
    expect(body.completed).toBe(true);
    expect(body.note).toMatch(/NOT a confirmation/);
    expect(body.note).toMatch(/list_agent_policies/);
    // The ids are echoed as the request, never as an outcome.
    expect(body.request).toEqual({ agentId: "ag-1", policyId: "po-1" });
  });

  it("attach still forwards the backend body unchanged", async () => {
    const { server, handlers } = fakeServer();
    const client = {
      ...fakeClient(),
      post: vi.fn(async () => ({ skillId: "sk-1", targetId: "ag-1", linked: true })),
    };
    registerAttachTools(server as never, client as unknown as AxonityClient);

    const body = payload(
      await handlers.get("attach_skill_to_agent")!({ agentId: "ag-1", skillId: "sk-1" }),
    );
    expect(body).toEqual({ skillId: "sk-1", targetId: "ag-1", linked: true });
  });
});
