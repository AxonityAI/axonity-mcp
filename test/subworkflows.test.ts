import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerConventions } from "../src/tools/conventions.js";
import { registerSubworkflowTools } from "../src/tools/subworkflows.js";

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

describe("an agent can find what a sub-process step may call", () => {
  it("reads the callable catalogue", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient([
      { id: "w1", name: "Publish one vacancy", callable: true, parameters: [] },
    ]);
    registerSubworkflowTools(server as never, client as unknown as AxonityClient);

    await handlers.get("list_callable_workflows")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/workflows/callable", undefined);
  });

  it("forwards `exclude` so a workflow is never offered to itself", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient([]);
    registerSubworkflowTools(server as never, client as unknown as AxonityClient);

    await handlers.get("list_callable_workflows")!({ exclude: "w-self" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/workflows/callable", {
      exclude: "w-self",
    });
  });

  it("passes the non-callable rows through instead of filtering them", async () => {
    // The backend lists a blocked workflow WITH its reason on purpose. Dropping
    // those rows client-side would turn "here is what to fix" back into "where
    // is my workflow?", which is the question the route exists to answer.
    const rows = [
      { id: "w1", name: "Ready", callable: true, parameters: [], outcomes: [] },
      {
        id: "w2",
        name: "Draft only",
        callable: false,
        blockedReason: "Never published — there is no version to run yet",
      },
    ];
    const { server, handlers } = fakeServer();
    registerSubworkflowTools(
      server as never,
      fakeClient(rows) as unknown as AxonityClient,
    );

    const result = await handlers.get("list_callable_workflows")!({});
    expect(JSON.parse(result.content[0].text)).toEqual(rows);
  });

  it("says why to pick a target here rather than let the validator judge it", () => {
    const { server, descriptions } = fakeServer();
    registerSubworkflowTools(
      server as never,
      fakeClient() as unknown as AxonityClient,
    );
    const description = descriptions.get("list_callable_workflows")!;

    // axonity-flow#961 S7 made the validator check a subprocess target, so the
    // old claim — "it does NOT check any of this, a bad target fails at RUN
    // time" — is now false and must not be here. What remains true is the
    // ORDER: this tool is how you pick, the validator only judges afterwards.
    expect(description).toMatch(/validate_workflow/);
    expect(description).toMatch(/BEFORE/);
    expect(description).toMatch(/blockedReason/);
    expect(
      description,
      "the validator does check the target now — see axonity-flow#961 S7",
    ).not.toMatch(/does\s+NOT\s+check/i);
  });
});

describe("the authoring guide carries the subworkflow contract", () => {
  it("names the fields an agent would otherwise guess wrong", async () => {
    const handlers = new Map<string, () => Promise<ToolResult>>();
    const server = {
      tool: (name: string, _d: string, _s: unknown, h: () => Promise<ToolResult>) =>
        handlers.set(name, h),
    };
    registerConventions(server as never);
    const text = (await handlers.get("axonity_conventions")!()).content[0].text;

    for (const needle of [
      "subprocess-invocation",
      "targetWorkflowId",
      "ownerAgentId",
      // Writing this and believing it works is the obvious mistake: the engine
      // ignores it and the arrow decides instead.
      "IGNORED",
      "fireAndForget",
      "errorStrategy",
      "list_callable_workflows",
      "cannot call itself",
    ]) {
      expect(text, needle).toContain(needle);
    }
  });
});
