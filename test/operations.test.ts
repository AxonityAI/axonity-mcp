import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerAttachTools, registerCatalogTools } from "../src/tools/extras.js";
import { registerRunTools } from "../src/tools/runs.js";
import { registerTriggerTools } from "../src/tools/triggers.js";

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

function setup(register: (s: never, c: never) => void) {
  const { server, handlers } = fakeServer();
  const client = fakeClient();
  register(server as never, client as never);
  return { handlers, client };
}

describe("webhook triggers", () => {
  it("creates workflow-scoped, not at a flat /webhook-triggers path", async () => {
    // The epic named the flat path; only rotate/delete are flat.
    const { handlers, client } = setup(registerTriggerTools);
    await handlers.get("create_webhook_trigger")!({ workflowId: "w-1", triggerId: "t-1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/w-1/webhook-triggers", {
      triggerId: "t-1",
    });
  });

  it("includes expectedInputSchema only when given", async () => {
    const { handlers, client } = setup(registerTriggerTools);
    await handlers.get("create_webhook_trigger")!({
      workflowId: "w-1",
      triggerId: "t-1",
      expectedInputSchema: { type: "object" },
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/w-1/webhook-triggers", {
      triggerId: "t-1",
      expectedInputSchema: { type: "object" },
    });
  });

  it("rotates and deletes at the flat trigger path", async () => {
    const { handlers, client } = setup(registerTriggerTools);
    await handlers.get("rotate_webhook_trigger")!({ webhookId: "h-1", confirm: true });
    expect(client.post).toHaveBeenCalledWith("/api/v1/webhook-triggers/h-1/rotate");

    await handlers.get("delete_webhook_trigger")!({ webhookId: "h-1", confirm: true });
    expect(client.del).toHaveBeenCalledWith("/api/v1/webhook-triggers/h-1");
  });
});

describe("cron schedules", () => {
  it("sends cronExpr — not `cron` or `expression`", async () => {
    const { handlers, client } = setup(registerTriggerTools);
    await handlers.get("create_cron_schedule")!({
      workflowId: "w-1",
      triggerId: "t-1",
      cronExpr: "0 9 * * 1-5",
      timezone: "Europe/Brussels",
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/w-1/cron-schedules", {
      triggerId: "t-1",
      cronExpr: "0 9 * * 1-5",
      timezone: "Europe/Brussels",
    });
  });

  it("omits optional fields rather than sending undefined", async () => {
    const { handlers, client } = setup(registerTriggerTools);
    await handlers.get("create_cron_schedule")!({
      workflowId: "w-1",
      triggerId: "t-1",
      cronExpr: "* * * * *",
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/w-1/cron-schedules", {
      triggerId: "t-1",
      cronExpr: "* * * * *",
    });
  });

  it("deletes at the flat schedule path", async () => {
    const { handlers, client } = setup(registerTriggerTools);
    await handlers.get("delete_cron_schedule")!({ scheduleId: "c-1", confirm: true });
    expect(client.del).toHaveBeenCalledWith("/api/v1/cron-schedules/c-1");
  });
});

describe("conditional triggers", () => {
  it("creates workflow-scoped with the full body", async () => {
    const { handlers, client } = setup(registerTriggerTools);
    await handlers.get("create_conditional_trigger")!({
      workflowId: "w-1",
      triggerId: "t-1",
      agentId: "a-1",
      conditionText: "a new CV arrives",
      repeatIntervalMinutes: 15,
    });
    expect(client.post).toHaveBeenCalledWith(
      "/api/v1/workflows/w-1/conditional-triggers",
      {
        triggerId: "t-1",
        agentId: "a-1",
        conditionText: "a new CV arrives",
        repeatIntervalMinutes: 15,
      },
    );
  });

  it("patches only the fields supplied", async () => {
    const { handlers, client } = setup(registerTriggerTools);
    await handlers.get("update_conditional_trigger")!({
      triggerId: "ct-1",
      enabled: false,
    });
    expect(client.patch).toHaveBeenCalledWith("/api/v1/conditional-triggers/ct-1", {
      enabled: false,
    });
  });
});

describe("run observability", () => {
  it("maps camelCase args to the route's snake_case query params", async () => {
    const { handlers, client } = setup(registerRunTools);
    await handlers.get("list_runs")!({
      status: "running,failed",
      includeArchived: true,
      limit: 10,
    });
    expect(client.get).toHaveBeenCalledWith("/api/v1/runs", {
      status: "running,failed",
      created_after: undefined,
      created_before: undefined,
      include_archived: true,
      limit: 10,
      offset: undefined,
    });
  });

  it("uses archived_only on the workflow-scoped route, not include_archived", async () => {
    // The two routes genuinely differ; this is the one that trips people up.
    const { handlers, client } = setup(registerRunTools);
    await handlers.get("list_workflow_runs")!({ workflowId: "w-1", archivedOnly: true });
    expect(client.get).toHaveBeenCalledWith("/api/v1/workflows/w-1/runs", {
      archived_only: true,
    });
  });

  it("reads detail, trace and cost at their own paths", async () => {
    const { handlers, client } = setup(registerRunTools);
    await handlers.get("read_run")!({ runId: "r-1" });
    await handlers.get("read_run_trace")!({ runId: "r-1" });
    await handlers.get("read_run_cost")!({ runId: "r-1" });
    expect(client.get).toHaveBeenNthCalledWith(1, "/api/v1/runs/r-1");
    expect(client.get).toHaveBeenNthCalledWith(2, "/api/v1/runs/r-1/trace");
    expect(client.get).toHaveBeenNthCalledWith(3, "/api/v1/runs/r-1/cost");
  });

  it("archives and unarchives", async () => {
    const { handlers, client } = setup(registerRunTools);
    await handlers.get("archive_run")!({ runId: "r-1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/runs/r-1/archive");
    await handlers.get("unarchive_run")!({ runId: "r-1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/runs/r-1/unarchive");
  });

  it("sends runIds for bulk operations", async () => {
    const { handlers, client } = setup(registerRunTools);
    await handlers.get("bulk_archive_runs")!({ runIds: ["r-1", "r-2"] });
    expect(client.post).toHaveBeenCalledWith("/api/v1/runs/bulk/archive", {
      runIds: ["r-1", "r-2"],
    });
    await handlers.get("bulk_delete_runs")!({ runIds: ["r-1"], confirm: true });
    expect(client.post).toHaveBeenCalledWith("/api/v1/runs/bulk/delete", {
      runIds: ["r-1"],
    });
  });
});

describe("attach / detach symmetry", () => {
  it("registers a detach for every attach", () => {
    const { handlers } = setup(registerAttachTools);
    const names = [...handlers.keys()];
    const attaches = names.filter((n) => n.startsWith("attach_"));
    expect(attaches).toHaveLength(4);
    for (const a of attaches) {
      expect(names).toContain(a.replace("attach_", "detach_").replace("_to_", "_from_"));
    }
  });

  it("detaches with DELETE on the same path attach POSTs to", async () => {
    const { handlers, client } = setup(registerAttachTools);
    await handlers.get("attach_skill_to_agent")!({ agentId: "a-1", skillId: "s-1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/agents/a-1/skills-v2/s-1");

    await handlers.get("detach_skill_from_agent")!({ agentId: "a-1", skillId: "s-1" });
    expect(client.del).toHaveBeenCalledWith("/api/v1/agents/a-1/skills-v2/s-1");
  });

  it("detaches a skill from a workflow and a policy from an agent", async () => {
    const { handlers, client } = setup(registerAttachTools);
    await handlers.get("detach_skill_from_workflow")!({ workflowId: "w-1", skillId: "s-1" });
    expect(client.del).toHaveBeenCalledWith("/api/v1/workflows/w-1/skills-v2/s-1");

    await handlers.get("detach_policy_from_agent")!({ agentId: "a-1", policyId: "p-1" });
    expect(client.del).toHaveBeenCalledWith("/api/v1/agents/a-1/policies/p-1");
  });

  it("has no reference-doc/workflow pair — that route does not exist", () => {
    const { handlers } = setup(registerAttachTools);
    const names = [...handlers.keys()];
    expect(names).not.toContain("attach_reference_to_workflow");
    expect(names).not.toContain("detach_reference_from_workflow");
  });
});

describe("catalog and cloning", () => {
  it("lists the system-tools catalog", async () => {
    const { handlers, client } = setup(registerCatalogTools);
    await handlers.get("list_system_tools")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/system-tools");
  });

  it("clones a flow", async () => {
    const { handlers, client } = setup(registerCatalogTools);
    await handlers.get("clone_flow")!({ flowId: "f-1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/flows/f-1/clone");
  });

  it("clones a prompt snippet", async () => {
    const { handlers, client } = setup(registerCatalogTools);
    await handlers.get("clone_prompt_snippet")!({ snippetId: "ps-1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/prompt-snippets/ps-1/clone");
  });
});
