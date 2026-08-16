import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { projectCatalog, registerAuthoringSpecTools } from "../src/tools/authoringSpec.js";
import { registerConventions } from "../src/tools/conventions.js";

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

function fakeClient(response: unknown) {
  return {
    get: vi.fn(async () => response),
    post: vi.fn(async () => response),
    put: vi.fn(async () => response),
    patch: vi.fn(async () => response),
    del: vi.fn(async () => response),
  };
}

const CATALOG = {
  rulesVersion: "a1b2c3d4",
  operations: [
    {
      type: "add_step",
      description: "Add a step to the workflow.",
      payloadSchema: { type: "object", properties: { name: { type: "string" } } },
    },
    {
      type: "add_edge",
      description: "Connect two steps.",
      payloadSchema: { type: "object", properties: { from: { type: "string" } } },
    },
  ],
};

function body(r: ToolResult): Record<string, unknown> {
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

describe("the vocabulary comes from the server", () => {
  it("reads the catalogue route", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient(CATALOG);
    registerAuthoringSpecTools(server as never, client as unknown as AxonityClient);

    await handlers.get("get_workflow_authoring_spec")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/workflows/operations");
  });

  it("defaults to the index, and says how to get the schemas", async () => {
    const { server, handlers } = fakeServer();
    registerAuthoringSpecTools(
      server as never,
      fakeClient(CATALOG) as unknown as AxonityClient,
    );

    const out = body(await handlers.get("get_workflow_authoring_spec")!({}));
    expect(out.rulesVersion).toBe("a1b2c3d4");
    expect(out.operations).toEqual([
      { type: "add_step", description: "Add a step to the workflow." },
      { type: "add_edge", description: "Connect two steps." },
    ]);
    expect(out.schemasOmitted).toContain("types");
  });

  it("returns the live payload schema for the commands asked for", async () => {
    const { server, handlers } = fakeServer();
    registerAuthoringSpecTools(
      server as never,
      fakeClient(CATALOG) as unknown as AxonityClient,
    );

    const out = body(
      await handlers.get("get_workflow_authoring_spec")!({ types: ["add_edge"] }),
    );
    expect(out.operations).toEqual([CATALOG.operations[1]]);
    expect(out.schemasOmitted).toBeUndefined();
  });

  /**
   * #8's acceptance criterion, tested as a property rather than asserted in
   * prose: a server operation this repository has never heard of must reach the
   * agent unchanged. Anything that filtered against a local list would fail here
   * — which is exactly the failure mode #32 was filed for.
   */
  it("passes through an operation this connector has never heard of", async () => {
    const invented = {
      rulesVersion: "future",
      operations: [
        { type: "teleport_step", description: "Not a thing today.", payloadSchema: {} },
      ],
    };
    const { server, handlers } = fakeServer();
    registerAuthoringSpecTools(
      server as never,
      fakeClient(invented) as unknown as AxonityClient,
    );

    const index = body(await handlers.get("get_workflow_authoring_spec")!({}));
    expect(index.operations).toEqual([
      { type: "teleport_step", description: "Not a thing today." },
    ]);

    const full = body(
      await handlers.get("get_workflow_authoring_spec")!({ types: ["teleport_step"] }),
    );
    expect(full.operations).toEqual(invented.operations);
  });

  it("reports a name this deploy lacks instead of rejecting it locally", () => {
    // The connector is not the authority on what exists. An unknown name is a
    // fact about this backend, reported as one.
    const out = projectCatalog(CATALOG, ["add_step", "attach_output_schema"]) as Record<
      string,
      unknown
    >;

    expect(out.operations).toEqual([CATALOG.operations[0]]);
    expect(out.unknownTypes).toEqual(["attach_output_schema"]);
    expect(out.unknownTypesNote).toContain("without `types`");
  });

  it("leaves a response it does not recognise alone", () => {
    expect(projectCatalog(null)).toBe(null);
    const noOperations = { rulesVersion: "x" };
    expect(projectCatalog(noOperations)).toBe(noOperations);
  });
});

describe("the guide sends an agent to the spec first", () => {
  it("states the protocol and the cache key", async () => {
    const handlers = new Map<string, () => Promise<ToolResult>>();
    const server = {
      tool: (name: string, _d: string, _s: unknown, h: () => Promise<ToolResult>) =>
        handlers.set(name, h),
    };
    registerConventions(server as never);
    const text = (await handlers.get("axonity_conventions")!()).content[0].text;

    expect(text).toContain("get_workflow_authoring_spec");
    expect(text).toContain("rulesVersion");
    // Why it is not written down here, so nobody helpfully adds the list back.
    expect(text).toMatch(/right only by maintenance/);
  });
});
