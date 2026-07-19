import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { VersionConflictError } from "../src/errors.js";
import { type EntityDef, registerEntityTools } from "../src/tools/register.js";

/**
 * A minimal fake MCP server that captures registered tool handlers so we can
 * invoke them directly and assert the REST call they make.
 */
function fakeServer() {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: (a: never) => Promise<unknown>) => {
      handlers.set(name, handler as (args: Record<string, unknown>) => Promise<unknown>);
    },
  };
  return { server, handlers };
}

function fakeClient() {
  return {
    get: vi.fn(async () => ({ ok: true })),
    post: vi.fn(async () => ({ id: "new" })),
    put: vi.fn(async () => ({ id: "a", version: 3 })),
    patch: vi.fn(async () => ({ id: "w", version: 3 })),
  };
}

const AGENT: EntityDef = {
  singular: "agent",
  basePath: "/api/v1/agents",
  updateMethod: "PUT",
  label: "agents",
};
const WORKFLOW: EntityDef = {
  singular: "workflow",
  basePath: "/api/v1/workflows",
  updateMethod: "PATCH",
  label: "workflows",
};

describe("registerEntityTools", () => {
  it("registers the verbs for an entity, incl. request-publish", () => {
    const { server, handlers } = fakeServer();
    registerEntityTools(server as never, fakeClient() as unknown as AxonityClient, AGENT);
    expect([...handlers.keys()]).toEqual([
      "list_agents",
      "read_agent",
      "create_agent",
      "update_agent",
      "request_publish_agent",
    ]);
  });

  it("request_publish posts to the approvals queue, never a publish route", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(server as never, client as unknown as AxonityClient, AGENT);
    await handlers.get("request_publish_agent")!({ id: "a-1", changeSummary: "why" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/publish-approvals", {
      entityType: "agent",
      entityId: "a-1",
      changeSummary: "why",
    });
  });

  it("list hits GET on the collection", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(server as never, client as unknown as AxonityClient, AGENT);
    await handlers.get("list_agents")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/agents");
  });

  it("read hits GET on the item", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(server as never, client as unknown as AxonityClient, AGENT);
    await handlers.get("read_agent")!({ id: "a-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/agents/a-1");
  });

  it("create posts the fields as-is", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(server as never, client as unknown as AxonityClient, AGENT);
    await handlers.get("create_agent")!({ fields: { name: "Bob" } });
    expect(client.post).toHaveBeenCalledWith("/api/v1/agents", { name: "Bob" });
  });

  it("update PUTs {expectedVersion, ...fields} for a PUT entity", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(server as never, client as unknown as AxonityClient, AGENT);
    await handlers.get("update_agent")!({
      id: "a-1",
      expectedVersion: 2,
      fields: { name: "Bob" },
    });
    expect(client.put).toHaveBeenCalledWith("/api/v1/agents/a-1", {
      expectedVersion: 2,
      name: "Bob",
    });
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("update PATCHes for a PATCH entity (workflow)", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(server as never, client as unknown as AxonityClient, WORKFLOW);
    await handlers.get("update_workflow")!({
      id: "w-1",
      expectedVersion: 5,
      fields: { name: "Flow" },
    });
    expect(client.patch).toHaveBeenCalledWith("/api/v1/workflows/w-1", {
      expectedVersion: 5,
      name: "Flow",
    });
  });

  it("surfaces a 409 as a clean error result, not a throw", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    client.put.mockRejectedValueOnce(new VersionConflictError());
    registerEntityTools(server as never, client as unknown as AxonityClient, AGENT);
    const result = (await handlers.get("update_agent")!({
      id: "a-1",
      expectedVersion: 1,
      fields: {},
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/conflict/i);
  });
});
