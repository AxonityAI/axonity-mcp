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
    del: vi.fn(async () => undefined),
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
const FLOW: EntityDef = {
  singular: "flow",
  basePath: "/api/v1/flows",
  updateMethod: "PATCH",
  label: "flows",
  deleteVersionParam: "expectedVersion",
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

  it("registers full authored-entity flow lifecycle (draft, publish request, discard)", () => {
    const { server, handlers } = fakeServer();
    registerEntityTools(server as never, fakeClient() as unknown as AxonityClient, FLOW);
    const names = [...handlers.keys()];
    expect(names).toContain("request_publish_flow");
    expect(names).toContain("discard_flow_draft");
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

  it("request_publish_flow posts with entityType flow", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(server as never, client as unknown as AxonityClient, FLOW);
    await handlers.get("request_publish_flow")!({ id: "f-1", changeSummary: "go live" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/publish-approvals", {
      entityType: "flow",
      entityId: "f-1",
      changeSummary: "go live",
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

  it("uses `plural` for list_<plural> instead of a naive +s suffix", async () => {
    const POLICY: EntityDef = {
      singular: "policy",
      basePath: "/api/v1/policies",
      updateMethod: "PUT",
      label: "policies",
      plural: "policies",
    };
    const { server, handlers } = fakeServer();
    registerEntityTools(server as never, fakeClient() as unknown as AxonityClient, POLICY);
    // Not list_policys — that was the bug this field fixes.
    expect([...handlers.keys()]).toContain("list_policies");
    expect([...handlers.keys()]).not.toContain("list_policys");
  });

  it("has no delete/restore/list_deleted/discard family when deleteVersionParam is unset", () => {
    const { server, handlers } = fakeServer();
    registerEntityTools(server as never, fakeClient() as unknown as AxonityClient, AGENT);
    const names = [...handlers.keys()];
    expect(names.some((n) => n.startsWith("delete_"))).toBe(false);
    expect(names.some((n) => n.startsWith("restore_"))).toBe(false);
    expect(names.some((n) => n.startsWith("list_deleted_"))).toBe(false);
    expect(names.some((n) => n.startsWith("discard_"))).toBe(false);
  });
});

describe("registerEntityTools — delete/restore/list-deleted/discard-draft", () => {
  const WORKFLOW_DELETABLE: EntityDef = {
    singular: "workflow",
    basePath: "/api/v1/workflows",
    updateMethod: "PATCH",
    label: "workflows",
    deleteVersionParam: "expectedVersion",
  };
  const SKILL_DELETABLE: EntityDef = {
    singular: "skill",
    basePath: "/api/v1/skills",
    updateMethod: "PUT",
    label: "skills",
    deleteVersionParam: "expected_version",
  };

  it("registers delete/restore/list_deleted/discard alongside the base five", () => {
    const { server, handlers } = fakeServer();
    registerEntityTools(
      server as never,
      fakeClient() as unknown as AxonityClient,
      WORKFLOW_DELETABLE,
    );
    expect([...handlers.keys()]).toEqual([
      "list_workflows",
      "read_workflow",
      "create_workflow",
      "update_workflow",
      "delete_workflow",
      "restore_workflow",
      "list_deleted_workflows",
      "discard_workflow_draft",
      "request_publish_workflow",
    ]);
  });

  it("sends the aliased expectedVersion query key for workflow's delete", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(server as never, client as unknown as AxonityClient, WORKFLOW_DELETABLE);
    await handlers.get("delete_workflow")!({ id: "w-1", expectedVersion: 4, confirm: true });
    expect(client.del).toHaveBeenCalledWith("/api/v1/workflows/w-1", { expectedVersion: 4 });
  });

  it("sends the raw expected_version query key for skill's delete", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(server as never, client as unknown as AxonityClient, SKILL_DELETABLE);
    await handlers.get("delete_skill")!({ id: "s-1", expectedVersion: 4, confirm: true });
    expect(client.del).toHaveBeenCalledWith("/api/v1/skills/s-1", { expected_version: 4 });
  });

  it("restore takes no version at all", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(server as never, client as unknown as AxonityClient, WORKFLOW_DELETABLE);
    await handlers.get("restore_workflow")!({ id: "w-1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/w-1/restore");
  });

  it("list_deleted hits the /deleted collection by default", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(server as never, client as unknown as AxonityClient, WORKFLOW_DELETABLE);
    await handlers.get("list_deleted_workflows")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/workflows/deleted");
  });

  it("list_deleted uses ?deleted=true when deletedListPath is 'query'", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(server as never, client as unknown as AxonityClient, {
      ...WORKFLOW_DELETABLE,
      deletedListPath: "query",
    });
    await handlers.get("list_deleted_workflows")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/workflows", { deleted: true });
  });

  it("list_deleted_prompt_snippets uses the normalized /deleted collection", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(
      server as never,
      client as unknown as AxonityClient,
      {
        singular: "prompt_snippet",
        basePath: "/api/v1/prompt-snippets",
        updateMethod: "PATCH",
        label: "prompt snippets",
        deleteVersionParam: "expectedVersion",
      },
    );
    await handlers.get("list_deleted_prompt_snippets")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/prompt-snippets/deleted");
  });

  it("discard-draft posts with no body", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(server as never, client as unknown as AxonityClient, WORKFLOW_DELETABLE);
    await handlers.get("discard_workflow_draft")!({ id: "w-1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/w-1/discard-draft");
  });

  it("omits discard_<entity>_draft when hasDiscardDraft is false", () => {
    const { server, handlers } = fakeServer();
    registerEntityTools(server as never, fakeClient() as unknown as AxonityClient, {
      ...WORKFLOW_DELETABLE,
      hasDiscardDraft: false,
    });
    expect([...handlers.keys()]).not.toContain("discard_workflow_draft");
  });

  it("declares a confirm field on delete's schema", () => {
    // Zod enforces the literal at the MCP layer; this asserts the schema shape
    // rather than re-implementing zod's own validation.
    let capturedShape: Record<string, unknown> | undefined;
    const capturingServer = {
      tool: (name: string, _d: string, shape: Record<string, unknown>) => {
        if (name === "delete_workflow") capturedShape = shape;
      },
    };
    registerEntityTools(
      capturingServer as never,
      fakeClient() as unknown as AxonityClient,
      WORKFLOW_DELETABLE,
    );
    expect(capturedShape).toBeDefined();
    expect(capturedShape!.confirm).toBeDefined();
  });
});

describe("registerEntityTools — creatable/readable flags", () => {
  it("omits create_<entity> when creatable is false (persona's shape)", () => {
    const PERSONA: EntityDef = {
      singular: "persona",
      basePath: "/api/v1/personas",
      updateMethod: "PUT",
      label: "personas",
      creatable: false,
      deleteVersionParam: "expected_version",
    };
    const { server, handlers } = fakeServer();
    registerEntityTools(server as never, fakeClient() as unknown as AxonityClient, PERSONA);
    const names = [...handlers.keys()];
    expect(names).not.toContain("create_persona");
    expect(names).toContain("list_personas");
    expect(names).toContain("update_persona");
    expect(names).toContain("delete_persona");
  });

  it("omits read_<entity>/discard_<entity>_draft when readable/hasDiscardDraft are false", () => {
    // A hypothetical entity missing those routes — real prompt_snippet gained
    // both in axonity-flow#699 and no longer needs either flag, but the
    // generator must still support an entity that genuinely lacks them.
    const NO_READ_NO_DISCARD: EntityDef = {
      singular: "widget",
      basePath: "/api/v1/widgets",
      updateMethod: "PATCH",
      label: "widgets",
      readable: false,
      deleteVersionParam: "expectedVersion",
      hasDiscardDraft: false,
      deletedListPath: "query",
    };
    const { server, handlers } = fakeServer();
    registerEntityTools(
      server as never,
      fakeClient() as unknown as AxonityClient,
      NO_READ_NO_DISCARD,
    );
    const names = [...handlers.keys()];
    expect(names).not.toContain("read_widget");
    expect(names).not.toContain("discard_widget_draft");
    expect(names).toContain("create_widget");
    expect(names).toContain("list_deleted_widgets");
  });

  it("flow now has version/discard/publish lifecycle tools", () => {
    const FLOW: EntityDef = {
      singular: "flow",
      basePath: "/api/v1/flows",
      updateMethod: "PATCH",
      label: "flows",
      deleteVersionParam: "expectedVersion",
    };
    const { server, handlers } = fakeServer();
    registerEntityTools(server as never, fakeClient() as unknown as AxonityClient, FLOW);
    const names = [...handlers.keys()];
    expect(names).toContain("request_publish_flow");
    expect(names).toContain("discard_flow_draft");
    expect(names).toContain("delete_flow");
    expect(names).toContain("restore_flow");
    expect(names).toContain("list_deleted_flows");
  });
});
