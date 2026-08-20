/**
 * #45 — the connector tells the truth about this deploy, and reaches what
 * axonity-flow#961 opened.
 *
 * Three kinds of assertion live here, and the second is the unusual one:
 *
 *  1. The new routes are wired to the right paths and arguments (M5, M7, M9).
 *  2. The instructions that were WRONG do not come back. Each of those shipped
 *     as confident prose, was verified false against the deployed backend, and
 *     failed at the FIRST call of the flow it described — so each gets a
 *     negative assertion naming what it used to say. A guard you have never
 *     seen fire is not a guard, which is why the phrasing asserted against is
 *     the phrasing that actually shipped.
 *  3. The defaults that protect a response budget (M9.1) — a summary that has
 *     to be asked for is a summary nobody gets.
 */

import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerCompanyTools } from "../src/tools/company.js";
import { registerConventions } from "../src/tools/conventions.js";
import { registerAttachTools, registerDependencyTools, registerCatalogTools } from "../src/tools/extras.js";
import { registerRunTools } from "../src/tools/runs.js";
import { type EntityDef, registerEntityTools } from "../src/tools/register.js";
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
  const descriptions = new Map<string, string>();
  const schemas = new Map<string, Record<string, unknown>>();
  const server = {
    tool: (
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: (a: never) => Promise<ToolResult>,
    ) => {
      handlers.set(name, handler as Handler);
      descriptions.set(name, description);
      schemas.set(name, schema);
    },
  };
  return { server, handlers, descriptions, schemas };
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

async function guideText(): Promise<string> {
  const { server, handlers } = fakeServer();
  registerConventions(server as never);
  const result = await handlers.get("axonity_conventions")!({});
  return result.content[0].text;
}

// ---------------------------------------------------------------------------
// M2 — the instructions that were verified false
// ---------------------------------------------------------------------------

describe("the three false instructions are gone (M2)", () => {
  it("(a) does not tell an agent that add_trigger needs a second call", async () => {
    // What shipped: "give it a trigger with typeId: subprocess-invocation
    // (add_trigger) whose `parameters` are what a caller must pass". Against
    // the deployed backend that was a 422 — AddTriggerPayload forbade extras.
    // axonity-flow#961 S3 made it true instead of making it two calls, so the
    // guide now says so outright.
    const guide = await guideText();
    expect(guide).toMatch(/`parameters` goes in the \\?`?add_trigger\\?`? call itself/);

    const { server, descriptions } = fakeServer();
    registerWorkflowMutations(server as never, fakeClient() as unknown as AxonityClient);
    expect(descriptions.get("apply_workflow_mutations")).toMatch(
      /add_trigger does the same for a trigger/,
    );
  });

  it("(b) does not claim the workflow-skill link has no read-back", async () => {
    const guide = await guideText();
    expect(
      guide,
      "GET /workflows/{id}/skills-v2 exists now (axonity-flow#961 S8)",
    ).not.toMatch(/attach_skill_to_workflow\s+has\s+no\s+read-back/);
    expect(guide).toContain("list_workflow_skills");
  });

  it("(c) does not enumerate the step types", async () => {
    // Nine were listed; seven validate. The absence is guarded generally in
    // conformance.test.ts; this pins the two values that were actually wrong.
    const guide = await guideText();
    expect(guide).not.toMatch(/`loop`/);
    expect(guide).not.toMatch(/`for_each`/);
    expect(guide).toContain("get_workflow_authoring_spec");
  });

  it("does not say the validator skips the sub-process checks (M6)", async () => {
    const guide = await guideText();
    expect(
      guide,
      "axonity-flow#961 S7 added six sub-process/constant checks",
    ).not.toMatch(/does\s+NOT\s+check\s+any\s+of\s+this/);
  });

  it("does not say role tags gate policies (M8)", async () => {
    // Two places said it. The gate was removed at runtime by axonity-flow#932
    // and the public route now refuses `activation.tags` with a 422, so an
    // agent following the old guide authored a gate that does nothing.
    const guide = await guideText();
    expect(guide).not.toMatch(/policies silently\s+skip the agent/);
    expect(guide).not.toMatch(/drives which policies apply to the agent at\s+runtime/);
    expect(guide).toMatch(/It GATES NOTHING/);
    expect(guide).toMatch(/activation\.tags.*422|422.*activation\.tags/s);
  });
});

// ---------------------------------------------------------------------------
// M4/M6 — what the guide has to say instead
// ---------------------------------------------------------------------------

describe("the guide carries what replaced those claims", () => {
  it("explains constants, including that absence is the error and 0 is not", async () => {
    const guide = await guideText();
    expect(guide).toContain("set_workflow_constants");
    expect(guide).toContain("constant_without_value");
    // The trap this exists to avoid: a truthiness test here would make a
    // working workflow unpublishable.
    expect(guide).toMatch(/`0`, `""`, `false` and `\[\]` are values/);
  });

  it("says a webhook trigger needs its own row and a schedule does not", async () => {
    const guide = await guideText();
    expect(guide).toContain("trigger_not_wired");
    expect(guide).toMatch(/create_webhook_trigger/);
    expect(guide).toMatch(/reconciled/);
  });

  it("tells an agent a test run can park, and how to unpark it", async () => {
    const guide = await guideText();
    expect(guide).toContain("read_run_waiting_on");
    expect(guide).toContain("answer_run_question");
    // And that a multi-start workflow needs the start named.
    expect(guide).toContain("triggerId");
    expect(guide).toMatch(/pinned/);
  });
});

// ---------------------------------------------------------------------------
// M5 — the start contract
// ---------------------------------------------------------------------------

describe("starting a run says WHICH start (M5)", () => {
  it("passes triggerId through and omits it when not given", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerRunTools(server as never, client as unknown as AxonityClient);

    await handlers.get("start_workflow_run")!({ workflowId: "w-1" });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/workflows/w-1/runs", {});

    await handlers.get("start_workflow_run")!({
      workflowId: "w-1",
      triggerId: "t-2",
      triggerInput: { name: "Ada" },
    });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/workflows/w-1/runs", {
      triggerId: "t-2",
      triggerInput: { name: "Ada" },
    });
  });

  it("describes the start contract as an object, not a flat parameter list", () => {
    // The response shape changed from array<object> to { triggers, constants }
    // and NO test in either repository caught it — this is that catch.
    const { server, descriptions } = fakeServer();
    registerWorkflowMutations(server as never, fakeClient() as unknown as AxonityClient);
    const description = descriptions.get("read_workflow_trigger_parameters")!;

    expect(description).toMatch(/triggers/);
    expect(description).toMatch(/constants/);
    // The load-bearing warning: a pinned value is the one field a caller must
    // NOT send, and the old flat list showed it beside fields to fill in.
    expect(description).toMatch(/pinned/);
    expect(description).toMatch(/MUST NOT BE SENT/);
  });
});

// ---------------------------------------------------------------------------
// M7 — what uses this?
// ---------------------------------------------------------------------------

describe("what breaks if I change this (M7)", () => {
  it("asks the workflow-reference route by kind and id", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerDependencyTools(server as never, client as unknown as AxonityClient);

    await handlers.get("list_workflows_using")!({ entityKind: "tool", entityId: "t-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/workflows/using/tool/t-1");
  });

  it("maps each library kind to its own dependent-agents route", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerDependencyTools(server as never, client as unknown as AxonityClient);

    for (const [kind, path] of [
      ["skill", "/api/v1/skills/x/dependent-agents"],
      ["policy", "/api/v1/policies/x/dependent-agents"],
      ["reference_doc", "/api/v1/reference-docs/x/dependent-agents"],
    ]) {
      await handlers.get("list_dependent_agents")!({ entityKind: kind, entityId: "x" });
      expect(client.get).toHaveBeenLastCalledWith(path);
    }
  });

  it("reads a workflow's skills back, projected to identity by default", async () => {
    const { server, handlers } = fakeServer();
    const client = {
      ...fakeClient(),
      get: vi.fn(async () => ({
        workflowId: "w-1",
        skills: [{ id: "s-1", name: "Triage", bodyMd: "x".repeat(5000) }],
      })),
    };
    registerAttachTools(server as never, client as unknown as AxonityClient);

    const identity = await handlers.get("list_workflow_skills")!({ workflowId: "w-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/workflows/w-1/skills-v2");
    const projected = JSON.parse(identity.content[0].text);
    expect(projected.skills).toEqual([{ id: "s-1", name: "Triage" }]);
    expect(projected.workflowId).toBe("w-1");

    const full = await handlers.get("list_workflow_skills")!({
      workflowId: "w-1",
      verbosity: "full",
    });
    expect(JSON.parse(full.content[0].text).skills[0].bodyMd).toHaveLength(5000);
  });

  it("scopes an agent's links to a workflow only when asked", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerAttachTools(server as never, client as unknown as AxonityClient);

    await handlers.get("list_agent_skills")!({ agentId: "a-1" });
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/agents/a-1/skills-v2");

    await handlers.get("list_agent_policies")!({ agentId: "a-1", workflowId: "w-1" });
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/agents/a-1/policies", {
      workflow_id: "w-1",
    });
  });
});

// ---------------------------------------------------------------------------
// M9 — the gaps that predate #961
// ---------------------------------------------------------------------------

describe("reading a run no longer costs the whole document (M9.1)", () => {
  it("drops the workflow snapshot unless it is asked for", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerRunTools(server as never, client as unknown as AxonityClient);

    // The backend's own default is true. Passing it explicitly rather than
    // omitting it is the point: an omitted parameter would take the 81%.
    await handlers.get("read_run")!({ runId: "r-1" });
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/runs/r-1", {
      includeSnapshot: false,
    });

    await handlers.get("read_run")!({ runId: "r-1", includeSnapshot: true });
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/runs/r-1", {
      includeSnapshot: true,
    });
  });
});

describe("a run that asks a question can be answered (M9.2)", () => {
  it("reads why a run is parked, its items, its tasks and a batch's progress", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerRunTools(server as never, client as unknown as AxonityClient);

    await handlers.get("read_run_waiting_on")!({ runId: "r-1" });
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/runs/r-1/waiting-on", {
      limit: undefined,
    });

    await handlers.get("list_run_items")!({ runId: "r-1", outcome: "failed" });
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/runs/r-1/items", {
      outcome: "failed",
      limit: undefined,
      cursor: undefined,
    });

    await handlers.get("read_run_items_summary")!({ runId: "r-1" });
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/runs/r-1/items/summary");

    await handlers.get("list_run_tasks")!({ runId: "r-1" });
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/runs/r-1/tasks", {
      limit: undefined,
    });

    await handlers.get("read_run_for_each_progress")!({ runId: "r-1", batchId: "b-1" });
    expect(client.get).toHaveBeenLastCalledWith(
      "/api/v1/runs/r-1/for-each/b-1/progress",
    );
  });

  it("answers an ask_user step and sends a conversation turn", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerRunTools(server as never, client as unknown as AxonityClient);

    await handlers.get("answer_run_question")!({
      runId: "r-1",
      stepId: "s-1",
      answer: "yes",
    });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/runs/r-1/steps/s-1/answer", {
      answer: "yes",
    });

    await handlers.get("send_run_message")!({ runId: "r-1", message: "carry on" });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/runs/r-1/message", {
      message: "carry on",
    });
  });

  it("says whose decision an answer is", () => {
    const { server, descriptions } = fakeServer();
    registerRunTools(server as never, fakeClient() as unknown as AxonityClient);
    // Submitting an answer records it as a person's. Saying so is the whole
    // difference between a test loop and impersonating an operator.
    expect(descriptions.get("answer_run_question")).toMatch(/their decision to make/);
  });
});

describe("list filters reach the backend (M9.3)", () => {
  const POLICY: EntityDef = {
    singular: "policy",
    basePath: "/api/v1/policies",
    updateMethod: "PUT",
    label: "policies",
    plural: "policies",
    listFilters: [
      { arg: "scope", query: "scope", type: "string", description: "s" },
      { arg: "ownerId", query: "owner_id", type: "string", description: "o" },
    ],
  };

  const SKILL: EntityDef = {
    singular: "skill",
    basePath: "/api/v1/skills",
    updateMethod: "PUT",
    label: "skills",
  };

  it("translates the tool's camelCase argument to the route's own spelling", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(server as never, client as unknown as AxonityClient, POLICY);

    await handlers.get("list_policies")!({ scope: "tenant", ownerId: "a-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/policies", {
      scope: "tenant",
      owner_id: "a-1",
    });
  });

  it("leaves a filterless list route called exactly as before", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(server as never, client as unknown as AxonityClient, SKILL);

    await handlers.get("list_skills")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/skills");
  });

  it("narrows a workflow's launches in the query, not in the page", async () => {
    const { server, handlers, descriptions } = fakeServer();
    const client = fakeClient();
    registerRunTools(server as never, client as unknown as AxonityClient);

    await handlers.get("list_workflow_runs")!({
      workflowId: "w-1",
      status: ["failed", "cancelled"],
    });
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/workflows/w-1/runs", {
      status: ["failed", "cancelled"],
      archived_only: undefined,
      limit: undefined,
      cursor: undefined,
    });

    // No copy of the status vocabulary here — the 422 names it.
    expect(descriptions.get("list_workflow_runs")).toMatch(/422/);
  });
});

describe("an entity can cut a new major version (M9.4)", () => {
  it("creates a named one and ensures an unnamed one", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerVersionTools(server as never, client as unknown as AxonityClient, {
      singular: "workflow",
      basePath: "/api/v1/workflows",
      publishedPath: "entity",
    });

    await handlers.get("create_workflow_major_version")!({ id: "w-1", name: "v2" });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/workflows/w-1/versions", {
      name: "v2",
    });

    await handlers.get("create_workflow_major_version")!({
      id: "w-1",
      name: "v2",
      description: "why",
    });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/workflows/w-1/versions", {
      name: "v2",
      description: "why",
    });

    await handlers.get("ensure_workflow_major_version")!({ id: "w-1" });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/workflows/w-1/versions/ensure");
  });

  it("does the same for the company singleton, with no id", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerCompanyTools(server as never, client as unknown as AxonityClient);

    await handlers.get("create_company_major_version")!({ name: "Q3" });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/company/versions", {
      name: "Q3",
    });

    await handlers.get("ensure_company_major_version")!({});
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/company/versions/ensure");
  });
});

describe("the remaining gaps (M9.5)", () => {
  it("reads a release back after proposing one", async () => {
    const { server, handlers, descriptions } = fakeServer();
    const client = fakeClient();
    registerApprovalTools(server as never, client as unknown as AxonityClient);

    await handlers.get("list_publish_releases")!({ status: "pending" });
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/publish-approvals/release", {
      status: "pending",
      limit: undefined,
      cursor: undefined,
    });

    await handlers.get("get_publish_release")!({ releaseId: "rel-1" });
    expect(client.get).toHaveBeenLastCalledWith(
      "/api/v1/publish-approvals/release/rel-1",
    );

    // Paged, so it must say so — the same rule the drift guard enforces.
    expect(descriptions.get("list_publish_releases")).toMatch(/nextCursor/);
  });

  it("edits the company with commands, not only a whole-document PUT", async () => {
    const { server, handlers, descriptions } = fakeServer();
    const client = fakeClient();
    registerCompanyTools(server as never, client as unknown as AxonityClient);

    await handlers.get("apply_company_mutation")!({
      type: "add_stage",
      payload: { name: "Intake" },
      expectedVersion: 4,
    });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/company/mutations", {
      type: "add_stage",
      payload: { name: "Intake" },
      expectedVersion: 4,
    });

    // Company has no operations catalogue, so the honest answer is "the 422
    // names them" — not a list kept here.
    const description = descriptions.get("apply_company_mutation")!;
    expect(description).toMatch(/422/);
    expect(description).toMatch(/no catalogue route/);
  });

  it("lists the package allowlist and the template catalogues", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerCatalogTools(server as never, client as unknown as AxonityClient);

    await handlers.get("list_tool_packages")!({});
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/tools/packages");

    for (const [kind, path] of [
      [undefined, "/api/v1/templates"],
      ["all", "/api/v1/templates"],
      ["agent", "/api/v1/agent-templates"],
      ["tool", "/api/v1/tool-templates"],
      ["workflow", "/api/v1/workflow-templates"],
    ]) {
      await handlers.get("list_templates")!({ kind });
      expect(client.get).toHaveBeenLastCalledWith(path);
    }

    await handlers.get("read_template")!({ templateId: "tpl-1" });
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/templates/tpl-1");
  });
});
