import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import {
  registerApprovalTools,
  registerExecutionTools,
  registerValidationTools,
} from "../src/tools/validation.js";
import { registerConventions } from "../src/tools/conventions.js";
import { registerVersionTools } from "../src/tools/versions.js";
import { registerWorkflowMutations } from "../src/tools/workflowMutations.js";

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
  it("documents that the 4 stateless analysis tools are safe for read-only tokens", () => {
    const captured: Record<string, string> = {};
    const capturingServer = {
      tool: (name: string, description: string) => {
        if ([
          "validate_workflow",
          "analyze_workflow_reachable_outputs",
          "validate_tool_code",
          "format_tool_code",
        ].includes(name)) {
          captured[name] = description;
        }
      },
    };
    registerValidationTools(capturingServer as never, {} as never);
    for (const tool of Object.keys(captured)) {
      expect(captured[tool]).toMatch(/read-only/i);
    }
  });

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

describe("execution tools", () => {
  it("runs tool code at /api/v1/tools/execute", async () => {
    const { handlers, client } = setup(registerExecutionTools);
    await handlers.get("execute_tool")!({
      functions: [{ name: "run", code: "def run(): return 1" }],
      inputParams: { x: 1 },
      timeout: 10,
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/tools/execute", {
      imports: "",
      functions: [{ name: "run", code: "def run(): return 1" }],
      inputParams: { x: 1 },
      timeout: 10,
    });
  });

  it("test-runs a stored connector by tool id, sending only inputParams", async () => {
    const { handlers, client } = setup(registerExecutionTools);
    await handlers.get("execute_stored_connector")!({
      toolId: "t-1",
      inputParams: { query: "hello" },
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/tools/t-1/execute-connector", {
      inputParams: { query: "hello" },
    });
  });

  it("execute_stored_connector's schema cannot carry a url or authConfig", () => {
    // Structural guarantee: the admin-only body-supplied form takes url+authConfig;
    // this tool must be unable to send either, by construction of its zod shape.
    let capturedShape: Record<string, unknown> | undefined;
    const capturingServer = {
      tool: (name: string, _d: string, shape: Record<string, unknown>) => {
        if (name === "execute_stored_connector") capturedShape = shape;
      },
    };
    registerExecutionTools(capturingServer as never, {} as never);
    expect(capturedShape).toBeDefined();
    expect(Object.keys(capturedShape!).sort()).toEqual(["inputParams", "toolId"]);
  });

  it("never targets the flat, admin-only /api/v1/tools/execute-connector (no id)", async () => {
    const { handlers, client } = setup(registerExecutionTools);
    await handlers.get("execute_stored_connector")!({ toolId: "t-1" });
    const [path] = client.post.mock.calls[0] as [string];
    expect(path).toBe("/api/v1/tools/t-1/execute-connector");
    expect(path).not.toBe("/api/v1/tools/execute-connector");
  });

  it("does not describe execution tools as read-only compatible", () => {
    const captured: Record<string, string> = {};
    const capturingServer = {
      tool: (name: string, description: string) => {
        if (["execute_tool", "execute_stored_connector"].includes(name)) {
          captured[name] = description;
        }
      },
    };
    registerExecutionTools(capturingServer as never, {} as never);
    for (const tool of Object.keys(captured)) {
      expect(captured[tool].toLowerCase()).not.toContain("read-only");
    }
  });
});

describe("approval readback", () => {
  it("filters by status when given", async () => {
    const { handlers, client } = setup(registerApprovalTools);
    await handlers.get("list_publish_approvals")!({ status: "pending" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/publish-approvals", {
      status: "pending",
      limit: undefined,
      offset: undefined,
    });
  });

  it("pages with limit/offset", async () => {
    const { handlers, client } = setup(registerApprovalTools);
    await handlers.get("list_publish_approvals")!({ limit: 10, offset: 20 });
    expect(client.get).toHaveBeenCalledWith("/api/v1/publish-approvals", {
      status: undefined,
      limit: 10,
      offset: 20,
    });
  });

  it("reads one approval by id", async () => {
    const { handlers, client } = setup(registerApprovalTools);
    await handlers.get("get_publish_approval")!({ approvalId: "appr-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/publish-approvals/appr-1");
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

  it("reads flow published at /api/v1/flows/{id}/published", async () => {
    const flow = {
      singular: "flow",
      basePath: "/api/v1/flows",
      publishedPath: "entity" as const,
    };
    const { handlers, client } = setup(registerVersionTools, flow);
    await handlers.get("read_flow_published")!({ id: "f-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/flows/f-1/published");
  });

  it("reads it at /{id}/versions/published for memory entities", async () => {
    const { handlers, client } = setup(registerVersionTools, skill);
    await handlers.get("read_skill_published")!({ id: "s-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/skills/s-1/versions/published");
  });

  it("deletes a version row by its UUID", async () => {
    const { handlers, client } = setup(registerVersionTools, workflow);
    await handlers.get("delete_workflow_version")!({
      id: "w-1",
      versionId: "8f1c-uuid",
      confirm: true,
    });
    expect(client.del).toHaveBeenCalledWith("/api/v1/workflows/w-1/versions/8f1c-uuid");
  });

  it("lists deleted version rows", async () => {
    const { handlers, client } = setup(registerVersionTools, workflow);
    await handlers.get("list_deleted_workflow_versions")!({ id: "w-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/workflows/w-1/versions/deleted");
  });

  it("restores a deleted version row with no body — distinct from restore_<entity>_version", async () => {
    const { handlers, client } = setup(registerVersionTools, workflow);
    await handlers.get("restore_deleted_workflow_version")!({
      id: "w-1",
      versionId: "8f1c-uuid",
    });
    expect(client.post).toHaveBeenCalledWith(
      "/api/v1/workflows/w-1/versions/8f1c-uuid/restore-deleted",
    );
  });
});

/**
 * #22 — a tool description is the only contract an authoring agent has.
 *
 * These pin the facts that cost real time during the Talentus migration: the
 * add-vs-read shape difference, the edge field names, the derived-input rule and
 * the END invariant. Asserted against the payload models in axonity-flow
 * (`workflow_mutation_handlers.py`) as they stand — if the backend stories that
 * change those models land, these tests are the reminder to rewrite the text.
 */
describe("tool descriptions state the contract the platform enforces", () => {
  function describedTools(register: (s: never, c: never) => void) {
    const descriptions: Record<string, string> = {};
    const server = {
      tool: (name: string, description: string) => {
        descriptions[name] = description;
      },
    };
    register(server as never, fakeClient() as never);
    return descriptions;
  }

  it("apply_workflow_mutations names the real add_step / add_edge payloads", () => {
    const text = describedTools(registerWorkflowMutations).apply_workflow_mutations;

    // AddStepPayload after #766: name + position required, and contract/inputs/
    // outputs accepted alongside them, so a step is complete in one call.
    expect(text).toMatch(/name.*position|position.*name/s);
    expect(text).toMatch(/ONE call/);
    expect(text).toMatch(/contract, inputs, outputs/);
    // extra="forbid" on the payload models — an unknown key is a 422, not a drop.
    expect(text).toMatch(/STRICT/);
    expect(text).toMatch(/422/);
    // AddEdgePayload after #767: from/to accepted, caller id honoured.
    expect(text).toMatch(/fromStepId/);
    expect(text).toMatch(/from\/to/);
    expect(text).toMatch(/HONOURS an id/);
  });

  it("apply_workflow_mutations states both invariants AND that they report themselves", () => {
    const text = describedTools(registerWorkflowMutations).apply_workflow_mutations;
    expect(text, "derived input contracts").toMatch(/DERIVED from the/);
    expect(text, "END wiring").toMatch(/END point/);
    // #771 — the adjustments ride on the response, so an author no longer has to
    // diff the whole document to find an edge they did not ask for.
    expect(text).toMatch(/systemAdjustments/);
    expect(text).toMatch(/rederivedInputs/);
  });

  it("apply_workflow_mutations says the response is a summary and how to get the document", () => {
    const text = describedTools(registerWorkflowMutations).apply_workflow_mutations;
    expect(text).toMatch(/SUMMARY/);
    expect(text).toMatch(/returnDocument: true/);
    expect(text).toMatch(/read_workflow/);
  });

  it("validate_workflow does not let `launchable` read as `runnable`", () => {
    const text = describedTools(registerValidationTools).validate_workflow;
    expect(text).toMatch(/EXACTLY ONE/);
    expect(text).toMatch(/catalogChecked/);
    expect(text).toMatch(/structurally\s+sound/);
  });

  it("routes by workflowId to the catalog-aware route, by document to the stateless one", async () => {
    const { handlers, client } = setup(registerValidationTools);

    await handlers.get("validate_workflow")!({ workflowId: "wf-1" });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/workflows/wf-1/validate");

    await handlers.get("validate_workflow")!({ document: { steps: [] } });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/workflows/validate", {
      document: { steps: [] },
    });
  });

  it("refuses both or neither rather than guessing which question was asked", async () => {
    const { handlers, client } = setup(registerValidationTools);

    for (const args of [{}, { workflowId: "wf-1", document: { steps: [] } }]) {
      const result = (await handlers.get("validate_workflow")!(args)) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/exactly one/i);
    }
    expect(client.post).not.toHaveBeenCalled();
  });

  it("forwards the backend's own catalogChecked verdict", async () => {
    const { server, handlers } = fakeServer();
    const client = {
      ...fakeClient(),
      post: vi.fn(async () => ({ launchable: true, catalogChecked: false, issues: [] })),
    };
    registerValidationTools(server as never, client as unknown as AxonityClient);

    const result = (await handlers.get("validate_workflow")!({ document: {} })) as {
      content: { text: string }[];
    };
    const payload = JSON.parse(result.content[0].text);
    expect(payload.launchable).toBe(true);
    // The backend says whether the catalog was consulted; the client does not
    // invent a label of its own on top of it.
    expect(payload.catalogChecked).toBe(false);
  });

  it("the conventions guide carries the same two invariants", async () => {
    const handlers = new Map<string, () => Promise<{ content: { text: string }[] }>>();
    registerConventions({
      tool: (name: string, _d: string, _s: unknown, h: () => Promise<{ content: { text: string }[] }>) =>
        handlers.set(name, h),
    } as never);
    const guide = (await handlers.get("axonity_conventions")!()).content[0].text;

    expect(guide).toMatch(/derived, not authored/i);
    expect(guide).toMatch(/Every step reaches the END point/);
    expect(guide).toMatch(/add_step/);
    expect(guide).toMatch(/fromStepId/);
  });
});

/**
 * #28 — the verb that satisfies the publish gate.
 *
 * A code tool may not be published until its STORED code has run cleanly once.
 * `execute_tool` cannot supply that proof by design: it runs caller-supplied
 * functions, which need not be what is stored. 28 of 49 tools in the Talentus
 * tenant sat blocked because this client had no way to call the run that counts.
 */
describe("dry_run_tool", () => {
  it("runs the tool's stored code — no code in the request", async () => {
    const { handlers, client } = setup(registerExecutionTools);
    await handlers.get("dry_run_tool")!({
      toolId: "tl-1",
      inputParams: { invoice: "INV-1" },
    });

    expect(client.post).toHaveBeenCalledWith("/api/v1/tools/tl-1/dry-run", {
      inputParams: { invoice: "INV-1" },
    });
    // The whole point: the payload carries sample input and nothing else.
    const body = client.post.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["inputParams"]);
  });

  it("defaults inputParams to an empty object rather than omitting it", async () => {
    const { handlers, client } = setup(registerExecutionTools);
    await handlers.get("dry_run_tool")!({ toolId: "tl-1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/tools/tl-1/dry-run", {
      inputParams: {},
    });
  });

  it("execute_tool says it does not satisfy the gate, and names the verb that does", () => {
    const descriptions: Record<string, string> = {};
    registerExecutionTools(
      { tool: (n: string, d: string) => { descriptions[n] = d; } } as never,
      fakeClient() as never,
    );
    expect(descriptions.execute_tool).toMatch(/does NOT satisfy the publish gate/);
    expect(descriptions.execute_tool).toMatch(/dry_run_tool/);
    expect(descriptions.dry_run_tool).toMatch(/dry_run_required/);
  });
});

/** #29 — bulk publish requests, without touching the human decision. */
describe("request_publish_bulk", () => {
  it("posts the bundle to the bulk route", async () => {
    const { handlers, client } = setup(registerApprovalTools);
    await handlers.get("request_publish_bulk")!({
      requests: [
        { entityType: "tool", entityId: "tl-1" },
        { entityType: "company", changeSummary: "mission" },
      ],
    });

    expect(client.post).toHaveBeenCalledWith("/api/v1/publish-approvals/bulk", {
      requests: [
        { entityType: "tool", entityId: "tl-1" },
        { entityType: "company", changeSummary: "mission" },
      ],
    });
  });

  it("warns that it is not transactional, so a blanket retry double-requests", () => {
    const descriptions: Record<string, string> = {};
    registerApprovalTools(
      { tool: (n: string, d: string) => { descriptions[n] = d; } } as never,
      fakeClient() as never,
    );
    expect(descriptions.request_publish_bulk).toMatch(/NOT TRANSACTIONAL/);
    expect(descriptions.request_publish_bulk).toMatch(/double-requests/);
  });

  it("registers no bulk decision tool — approving stays human", () => {
    const names: string[] = [];
    registerApprovalTools(
      { tool: (n: string) => names.push(n) } as never,
      fakeClient() as never,
    );
    expect(names).toContain("request_publish_bulk");
    for (const forbidden of ["bulk_approve_approvals", "approve_publish_approval", "bulk_reject_approvals"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("readiness descriptions say the verdict is recomputed on read", () => {
    const descriptions: Record<string, string> = {};
    registerApprovalTools(
      { tool: (n: string, d: string) => { descriptions[n] = d; } } as never,
      fakeClient() as never,
    );
    for (const tool of ["list_publish_approvals", "get_publish_approval"]) {
      expect(descriptions[tool], tool).toMatch(/recomputed/);
      expect(descriptions[tool], tool).toMatch(/readinessAtRequest/);
    }
  });
});
