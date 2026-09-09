import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerCompanyTools } from "../src/tools/company.js";
import { registerConventions } from "../src/tools/conventions.js";
import { registerPromptPlacementTools } from "../src/tools/promptPlacement.js";
import { registerRunTools } from "../src/tools/runs.js";
import { registerApprovalTools } from "../src/tools/validation.js";
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
    // Was `detached: true` — a claim this connector minted itself, which is the
    // fiction #24 removes. This fake answers with a body, so the contract here is
    // that the body is forwarded verbatim. The 204 path has its own test below.
    expect(JSON.parse(text(res))).toEqual({ ok: true });
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
    // `discard_company_draft` used to be on this list, and it belonged there:
    // company had no discard route, so a tool would have been a 405 dressed as
    // a capability. axonity-flow#1388 added the route — company was the last
    // versioned entity without one — so the reason expired and the tool is
    // registered now, asserted below. What stays forbidden is what a SINGLETON
    // genuinely cannot have: there is nothing to list, nothing to create
    // beside the one, and no id to delete or restore by.
    const { handlers } = setup();
    const names = [...handlers.keys()];
    for (const forbidden of [
      "list_companies",
      "create_company",
      "delete_company",
      "restore_company",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("discards the draft with no version, and says why it can be refused", async () => {
    // No expectedVersion on purpose: a discard is a RECOVERY action against
    // whatever the draft currently holds, so a stale version number must not
    // be able to block it. That is the backend's contract, and a version
    // argument here would invent a check the route does not make.
    const { handlers, client } = setup();
    await handlers.get("discard_company_draft")!({});
    expect(client.post).toHaveBeenCalledWith("/api/v1/company/discard-draft");
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

describe("prompt-snippet detach makes no unfounded claim (#24)", () => {
  it("reports acceptance only — the route is 204 by design", async () => {
    const { server, handlers } = fakeServer();
    // DELETE /flow-step-prompts/{id} is declared 204_NO_CONTENT in
    // prompt_snippets.py, so there is genuinely nothing to forward.
    const client = { ...fakeClient(), del: vi.fn(async () => undefined) };
    registerPromptPlacementTools(server as never, client as unknown as AxonityClient);

    const result = await handlers.get("detach_prompt_snippet_from_flow_step")!({
      linkId: "ln-1",
    });
    const body = JSON.parse(text(result));

    expect(client.del).toHaveBeenCalledWith("/api/v1/flow-step-prompts/ln-1");
    expect(body.detached).toBeUndefined();
    expect(body.completed).toBe(true);
    expect(body.note).toMatch(/list_flow_step_prompts/);
    expect(body.request).toEqual({ linkId: "ln-1" });
  });
});

describe("release bundles — one approval for a workflow and its closure (#799)", () => {
  it("proposes a release by workflow id and never publishes", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerApprovalTools(server as never, client as unknown as AxonityClient);

    await handlers.get("request_publish_release")!({
      workflowId: "wf-1",
      changeSummary: "the refreshed rewrite prompt",
    });

    expect(client.post).toHaveBeenCalledWith("/api/v1/publish-approvals/release", {
      workflowId: "wf-1",
      changeSummary: "the refreshed rewrite prompt",
    });
    // Requesting only. Nothing in this tool may decide.
    expect(client.post).toHaveBeenCalledTimes(1);
  });

  it("omits changeSummary rather than sending an empty one", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerApprovalTools(server as never, client as unknown as AxonityClient);

    await handlers.get("request_publish_release")!({ workflowId: "wf-1" });

    expect(client.post).toHaveBeenCalledWith("/api/v1/publish-approvals/release", {
      workflowId: "wf-1",
    });
  });

  it("registers no tool that decides a release", async () => {
    const { server, handlers } = fakeServer();
    registerApprovalTools(server as never, fakeClient() as unknown as AxonityClient);

    const deciding = [...handlers.keys()].filter((name) =>
      /approve|reject/.test(name),
    );
    expect(deciding).toEqual([]);
  });

  it("tells the agent what a release is for, in its own description", async () => {
    // The tool description IS the interface: an agent that cannot tell this
    // apart from request_publish_bulk will keep making 162 requests.
    const descriptions = new Map<string, string>();
    const server = {
      tool: (name: string, description: string) => descriptions.set(name, description),
    };
    registerApprovalTools(server as never, fakeClient() as unknown as AxonityClient);

    const description = descriptions.get("request_publish_release")!;
    expect(description).toMatch(/all-or-nothing/);
    expect(description).toMatch(/does NOT publish/);
    expect(description).toMatch(/changedCount/);
  });
});
