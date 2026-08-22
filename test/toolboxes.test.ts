import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerConventions } from "../src/tools/conventions.js";
import { registerToolboxTools } from "../src/tools/toolboxes.js";

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

function fakeServer() {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const server = {
    tool: (
      name: string,
      description: string,
      _s: unknown,
      handler: (a: never) => Promise<ToolResult>,
    ) => {
      handlers.set(name, handler as Handler);
      descriptions.set(name, description);
    },
  };
  return { server, handlers, descriptions };
}

function fakeClient(response: unknown = { ok: true }) {
  return {
    get: vi.fn(async () => response),
    post: vi.fn(async () => response),
    put: vi.fn(async () => response),
    patch: vi.fn(async () => response),
    del: vi.fn(async () => response),
  };
}

function register(response?: unknown) {
  const { server, handlers, descriptions } = fakeServer();
  const client = fakeClient(response);
  registerToolboxTools(server as never, client as unknown as AxonityClient);
  return { handlers, descriptions, client };
}

describe("toolboxes are readable and writable", () => {
  it("list_toolboxes reads the collection, unfiltered and unpaged", async () => {
    const { handlers, client } = register({ items: [] });
    await handlers.get("list_toolboxes")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/toolboxes");
  });

  it("create_toolbox sends name AND description", async () => {
    const { handlers, client } = register();
    await handlers.get("create_toolbox")!({ name: "Carerix", description: "ATS calls." });
    expect(client.post).toHaveBeenCalledWith("/api/v1/toolboxes", {
      name: "Carerix",
      description: "ATS calls.",
    });
  });

  it("update_toolbox omits what the caller did not change", async () => {
    const { handlers, client } = register();
    await handlers.get("update_toolbox")!({
      toolboxId: "tb-1",
      expectedVersion: 3,
      name: "Carerix ATS",
    });
    // `description` is absent, not null: null would blank it on the backend.
    expect(client.put).toHaveBeenCalledWith("/api/v1/toolboxes/tb-1", {
      expectedVersion: 3,
      name: "Carerix ATS",
    });
  });

  it("list_toolbox_dependent_tools reads the warning list", async () => {
    const { handlers, client } = register({ toolNames: [] });
    await handlers.get("list_toolbox_dependent_tools")!({ toolboxId: "tb-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/toolboxes/tb-1/dependent-tools");
  });
});

describe("the optimistic lock on delete keeps the backend's spelling", () => {
  /**
   * This route takes `expected_version`, while delete_tool / delete_workflow
   * take `expectedVersion`. The caller says `expectedVersion` either way — the
   * inconsistency is real and is exactly what a caller should not have to know,
   * so it is pinned here rather than left to be rediscovered from a 422.
   */
  it("delete_toolbox sends expected_version as a QUERY parameter", async () => {
    const { handlers, client } = register();
    await handlers.get("delete_toolbox")!({
      toolboxId: "tb-1",
      expectedVersion: 7,
      confirm: true,
    });
    expect(client.del).toHaveBeenCalledWith("/api/v1/toolboxes/tb-1", {
      expected_version: 7,
    });
  });
});

describe("membership: declaring is not adding", () => {
  it("set_toolbox_tools PUTs the full list", async () => {
    const { handlers, client } = register();
    await handlers.get("set_toolbox_tools")!({ toolboxId: "tb-1", toolIds: ["a", "b"] });
    expect(client.put).toHaveBeenCalledWith("/api/v1/toolboxes/tb-1/tools", {
      toolIds: ["a", "b"],
    });
  });

  it("an empty list is sent as an empty list, not dropped", async () => {
    const { handlers, client } = register();
    await handlers.get("set_toolbox_tools")!({ toolboxId: "tb-1", toolIds: [] });
    expect(client.put).toHaveBeenCalledWith("/api/v1/toolboxes/tb-1/tools", {
      toolIds: [],
    });
  });

  it("the description says it REPLACES and points at the safe alternative", () => {
    const { descriptions } = register();
    const text = descriptions.get("set_toolbox_tools")!;
    expect(text).toMatch(/REPLACES/);
    expect(text).toContain("assign_tool_toolbox");
  });

  it("assign_tool_toolbox moves one tool, and null ungroups it", async () => {
    const { handlers, client } = register();
    await handlers.get("assign_tool_toolbox")!({ toolId: "t-1", toolboxId: "tb-2" });
    expect(client.put).toHaveBeenCalledWith("/api/v1/tools/t-1/toolbox", {
      toolboxId: "tb-2",
    });

    await handlers.get("assign_tool_toolbox")!({ toolId: "t-1", toolboxId: null });
    // Explicit null must SURVIVE — dropping it would turn "take it out of its
    // box" into "leave it alone", which is the one thing this route exists for.
    expect(client.put).toHaveBeenLastCalledWith("/api/v1/tools/t-1/toolbox", {
      toolboxId: null,
    });
  });
});

describe("a toolbox credential gets the same guard as a connector's", () => {
  it("set_toolbox_auth passes a placeholder config through", async () => {
    const { handlers, client } = register();
    const authConfig = { type: "bearer", secretId: "s-1", config: { token: "{{ TOKEN }}" } };
    await handlers.get("set_toolbox_auth")!({ toolboxId: "tb-1", authConfig });
    expect(client.put).toHaveBeenCalledWith("/api/v1/toolboxes/tb-1/auth", {
      authConfig,
    });
  });

  it("null clears the shared credential", async () => {
    const { handlers, client } = register();
    await handlers.get("set_toolbox_auth")!({ toolboxId: "tb-1", authConfig: null });
    expect(client.put).toHaveBeenCalledWith("/api/v1/toolboxes/tb-1/auth", {
      authConfig: null,
    });
  });

  it("a real-looking credential is refused BEFORE it leaves the connector", async () => {
    const { handlers, client } = register();
    const result = await handlers.get("set_toolbox_auth")!({
      toolboxId: "tb-1",
      authConfig: { config: { apiKey: "sk_live_ABCDEFGHIJKLMNOP" } },
    });

    expect(result.isError).toBe(true);
    expect(client.put).not.toHaveBeenCalled();
    // The message names where, and does not echo the value.
    expect(result.content[0].text).toContain("apiKey");
    expect(result.content[0].text).not.toContain("sk_live_ABCDEFGHIJKLMNOP");
  });

  it("a credential nested deeper is caught too", async () => {
    const { handlers, client } = register();
    const result = await handlers.get("set_toolbox_auth")!({
      toolboxId: "tb-1",
      authConfig: { config: { headers: { Authorization: "Bearer AKIAIOSFODNN7EXAMPLE" } } },
    });

    expect(result.isError).toBe(true);
    expect(client.put).not.toHaveBeenCalled();
  });
});

describe("the guide carries what the schema cannot say", () => {
  it("names the three traps an agent hits without them", async () => {
    const { server, handlers } = fakeServer();
    registerConventions(server as never);
    const result = await handlers.get("axonity_conventions")!({});
    const text = result.content[0].text;

    // 1. Declaring is not adding.
    expect(text).toMatch(/DECLARES the membership/);
    // 2. A box grants nothing — the link is to individual tools.
    expect(text).toMatch(/NEVER changes what an agent may call/);
    // 3. Deleting a box spares its tools.
    expect(text).toMatch(/does NOT delete its tools/);
    // And the reason a tool must be filed at all.
    expect(text).toContain("toolboxId");
  });
});
