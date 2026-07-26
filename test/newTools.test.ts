import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerCompanyTools } from "../src/tools/company.js";
import { registerConventions } from "../src/tools/conventions.js";
import { registerPromptPlacementTools } from "../src/tools/promptPlacement.js";
import { registerRunTools } from "../src/tools/runs.js";
import { registerVersionTools } from "../src/tools/versions.js";
import { registerWorkflowMutations } from "../src/tools/workflowMutations.js";

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

function fakeServer() {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: (a: never) => Promise<ToolResult>) => {
      handlers.set(name, handler as Handler);
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

function text(r: ToolResult) {
  return r.content[0].text;
}

describe("authoring guide (axonity_conventions) stays complete", () => {
  it("covers the new placement/company/test-run material", async () => {
    const handlers = new Map<string, () => Promise<ToolResult>>();
    const server = {
      tool: (name: string, _d: string, _s: unknown, h: () => Promise<ToolResult>) =>
        handlers.set(name, h),
    };
    registerConventions(server as never);
    const guide = text(await handlers.get("axonity_conventions")!());

    for (const needle of [
      "Prompt elements & placement (Memory V2)",
      "attach_prompt_snippet_to_flow_step",
      "list_wildcard_prompts",
      "episodicMemoryEnabled",
      "### company",
      "start_workflow_run",
      "Wiring",
      "Reproducing a setup",
      // The wiring read-backs (#12): a link lives outside the entity body, so the
      // guide must name the tools that prove an attach landed.
      "list_agent_skills",
      "list_agent_policies",
      "list_agent_reference_docs",
    ]) {
      expect(guide, `guide should mention: ${needle}`).toContain(needle);
    }
  });
});

describe("prompt-element placement", () => {
  function setup() {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerPromptPlacementTools(server as never, client as unknown as AxonityClient);
    return { handlers, client };
  }

  it("lists a step's prompt stack and the wildcards", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_flow_step_prompts")!({ flowStepId: "fs-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/flow-steps/fs-1/prompts");
    await handlers.get("list_wildcard_prompts")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/wildcard-prompts");
  });

  it("attaches a snippet with target + order", async () => {
    const { handlers, client } = setup();
    await handlers.get("attach_prompt_snippet_to_flow_step")!({
      flowStepId: "fs-1",
      snippetId: "sn-1",
      target: "system",
      displayOrder: 2,
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/flow-steps/fs-1/prompts", {
      snippetId: "sn-1",
      target: "system",
      displayOrder: 2,
    });
  });

  it("omits displayOrder when not given (lets the backend default it)", async () => {
    const { handlers, client } = setup();
    await handlers.get("attach_prompt_snippet_to_flow_step")!({
      flowStepId: "fs-1",
      snippetId: "sn-1",
      target: "user",
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/flow-steps/fs-1/prompts", {
      snippetId: "sn-1",
      target: "user",
    });
  });

  it("updates only the fields given, by linkId", async () => {
    const { handlers, client } = setup();
    await handlers.get("update_flow_step_prompt")!({ linkId: "lk-1", target: "system" });
    expect(client.patch).toHaveBeenCalledWith("/api/v1/flow-step-prompts/lk-1", {
      target: "system",
    });
  });

  it("reorders a step and detaches by linkId", async () => {
    const { handlers, client } = setup();
    await handlers.get("reorder_flow_step_prompts")!({
      flowStepId: "fs-1",
      snippetIds: ["a", "b", "c"],
    });
    expect(client.put).toHaveBeenCalledWith("/api/v1/flow-steps/fs-1/prompts/order", {
      snippetIds: ["a", "b", "c"],
    });
    const res = await handlers.get("detach_prompt_snippet_from_flow_step")!({ linkId: "lk-1" });
    expect(client.del).toHaveBeenCalledWith("/api/v1/flow-step-prompts/lk-1");
    expect(JSON.parse(text(res)).detached).toBe(true);
  });
});

describe("company (singleton) tools", () => {
  function setup() {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerCompanyTools(server as never, client as unknown as AxonityClient);
    return { handlers, client };
  }

  it("reads, updates (full document + lock), and reads published", async () => {
    const { handlers, client } = setup();
    await handlers.get("read_company")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/company");

    await handlers.get("update_company")!({ expectedVersion: 4, document: { mission: "x" } });
    expect(client.put).toHaveBeenCalledWith("/api/v1/company", {
      expectedVersion: 4,
      document: { mission: "x" },
    });

    await handlers.get("read_company_published")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/company/published");
  });

  it("has no singleton-inappropriate tools", () => {
    const { handlers } = setup();
    const names = [...handlers.keys()];
    for (const forbidden of [
      "list_companies",
      "create_company",
      "delete_company",
      "restore_company",
      "discard_company_draft",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("requests publish through the approval queue with NO id (singleton)", async () => {
    const { handlers, client } = setup();
    expect([...handlers.keys()]).toContain("request_publish_company");
    await handlers.get("request_publish_company")!({ changeSummary: "updated mission" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/publish-approvals", {
      entityType: "company",
      changeSummary: "updated mission",
    });
    // no entityId in the body — the server resolves the tenant's one company
    const body = client.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("entityId");
  });

  it("names a major version without an id (the singleton's version of the generic tool)", async () => {
    const { handlers, client } = setup();
    await handlers.get("name_company_major_version")!({ majorVersion: 2, name: "Q3 org" });
    expect(client.patch).toHaveBeenCalledWith("/api/v1/company/versions/major/2", {
      name: "Q3 org",
    });
  });

  it("restores a version by versionId under a lock", async () => {
    const { handlers, client } = setup();
    await handlers.get("restore_company_version")!({ versionId: "v-1", expectedVersion: 4 });
    expect(client.post).toHaveBeenCalledWith("/api/v1/company/versions/v-1/restore", {
      expectedVersion: 4,
    });
  });
});

describe("run build-and-test loop", () => {
  function setup() {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerRunTools(server as never, client as unknown as AxonityClient);
    return { handlers, client };
  }

  it("starts a run with optional trigger input", async () => {
    const { handlers, client } = setup();
    await handlers.get("start_workflow_run")!({ workflowId: "wf-1", triggerInput: { a: 1 } });
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/wf-1/runs", {
      triggerInput: { a: 1 },
    });
  });

  it("starts a run with no body when nothing supplied", async () => {
    const { handlers, client } = setup();
    await handlers.get("start_workflow_run")!({ workflowId: "wf-1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/wf-1/runs", {});
  });

  it("cancels, and refuses to delete without confirm handled by schema (handler deletes on call)", async () => {
    const { handlers, client } = setup();
    await handlers.get("cancel_run")!({ runId: "r-1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/runs/r-1/cancel");
    await handlers.get("delete_run")!({ runId: "r-1", confirm: true });
    expect(client.del).toHaveBeenCalledWith("/api/v1/runs/r-1");
  });
});

describe("workflow extras + version naming", () => {
  it("reads trigger parameters and bulk-deletes with per-item versions", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerWorkflowMutations(server as never, client as unknown as AxonityClient);

    await handlers.get("read_workflow_trigger_parameters")!({ workflowId: "wf-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/workflows/wf-1/trigger-parameters");

    await handlers.get("bulk_delete_workflows")!({
      workflows: [{ id: "wf-1", expectedVersion: 2 }],
      confirm: true,
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/bulk-delete", {
      workflows: [{ id: "wf-1", expectedVersion: 2 }],
    });
  });

  it("names a major version generically (PATCH versions/major/{n})", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerVersionTools(server as never, client as unknown as AxonityClient, {
      singular: "skill",
      basePath: "/api/v1/skills",
      publishedPath: "versions",
    });
    await handlers.get("name_skill_major_version")!({
      id: "sk-1",
      majorVersion: 2,
      name: "GA release",
    });
    expect(client.patch).toHaveBeenCalledWith("/api/v1/skills/sk-1/versions/major/2", {
      name: "GA release",
    });
  });
});
