import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerApprovalTools, registerValidationTools } from "../src/tools/validation.js";
import { registerVersionTools } from "../src/tools/versions.js";

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
    del: vi.fn(async () => undefined),
  };
}

function setup(register: (s: never, c: never, d?: never) => void, def?: unknown) {
  const { server, handlers } = fakeServer();
  const client = fakeClient();
  register(server as never, client as never, def as never);
  return { handlers, client };
}

describe("validation tools", () => {
  it("validates a workflow document at the right path", async () => {
    const { handlers, client } = setup(registerValidationTools);
    await handlers.get("validate_workflow")!({ document: { steps: [] } });
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/validate", {
      document: { steps: [] },
    });
  });

  it("validates tool code at /api/v1/tools/validate-code, not /api/v1/tool-code/…", async () => {
    // The epic named a path that does not exist; this pins the real one.
    const { handlers, client } = setup(registerValidationTools);
    await handlers.get("validate_tool_code")!({
      functions: [{ name: "run", code: "def run(): pass" }],
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/tools/validate-code", {
      imports: "",
      functions: [{ name: "run", code: "def run(): pass" }],
    });
  });

  it("passes classes through only when given", async () => {
    const { handlers, client } = setup(registerValidationTools);
    await handlers.get("validate_tool_code")!({
      imports: "import os",
      functions: [],
      classes: [{ name: "C", code: "class C: pass" }],
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/tools/validate-code", {
      imports: "import os",
      functions: [],
      classes: [{ name: "C", code: "class C: pass" }],
    });
  });

  it("analyses reachable outputs with document and stepId", async () => {
    const { handlers, client } = setup(registerValidationTools);
    await handlers.get("analyze_workflow_reachable_outputs")!({
      document: { steps: [] },
      stepId: "s-2",
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/reachable-outputs", {
      document: { steps: [] },
      stepId: "s-2",
    });
  });

  it("formats tool code", async () => {
    const { handlers, client } = setup(registerValidationTools);
    await handlers.get("format_tool_code")!({ code: "def f():pass" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/tools/format-code", {
      code: "def f():pass",
    });
  });
});

describe("approval readback", () => {
  it("filters by status when given", async () => {
    const { handlers, client } = setup(registerApprovalTools);
    await handlers.get("list_publish_approvals")!({ status: "pending" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/publish-approvals", {
      status: "pending",
    });
  });

  it("omits the query entirely when unfiltered", async () => {
    const { handlers, client } = setup(registerApprovalTools);
    await handlers.get("list_publish_approvals")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/publish-approvals", undefined);
  });

  it("exposes no approve or reject tool — those are human-only", () => {
    const { handlers } = setup(registerApprovalTools);
    const names = [...handlers.keys()];
    expect(names.some((n) => /approve|reject/.test(n))).toBe(false);
  });
});

describe("version tools", () => {
  const workflow = {
    singular: "workflow",
    basePath: "/api/v1/workflows",
    publishedPath: "entity" as const,
  };
  const skill = {
    singular: "skill",
    basePath: "/api/v1/skills",
    publishedPath: "versions" as const,
  };

  it("lists versions with paging and type filter", async () => {
    const { handlers, client } = setup(registerVersionTools, workflow);
    await handlers.get("list_workflow_versions")!({ id: "w-1", type: "major", limit: 10 });
    expect(client.get).toHaveBeenCalledWith("/api/v1/workflows/w-1/versions", {
      type: "major",
      limit: 10,
      offset: undefined,
    });
  });

  it("reads one version by integer checkpoint number", async () => {
    const { handlers, client } = setup(registerVersionTools, workflow);
    await handlers.get("read_workflow_version")!({ id: "w-1", version: 3 });
    expect(client.get).toHaveBeenCalledWith("/api/v1/workflows/w-1/versions/3");
  });

  it("restores by version-row UUID, with expectedVersion in the body", async () => {
    // The two identifiers are different types on adjacent routes; mixing them 404s.
    const { handlers, client } = setup(registerVersionTools, workflow);
    await handlers.get("restore_workflow_version")!({
      id: "w-1",
      versionId: "8f1c-uuid",
      expectedVersion: 7,
    });
    expect(client.post).toHaveBeenCalledWith(
      "/api/v1/workflows/w-1/versions/8f1c-uuid/restore",
      { expectedVersion: 7 },
    );
  });

  it("reads the published snapshot at /{id}/published for core entities", async () => {
    const { handlers, client } = setup(registerVersionTools, workflow);
    await handlers.get("read_workflow_published")!({ id: "w-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/workflows/w-1/published");
  });

  it("reads it at /{id}/versions/published for memory entities", async () => {
    const { handlers, client } = setup(registerVersionTools, skill);
    await handlers.get("read_skill_published")!({ id: "s-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/skills/s-1/versions/published");
  });
});
