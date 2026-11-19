/**
 * Methods (R6 of agent-first): what Flow called a "flow" is a method, and the
 * connector follows.
 *
 * What is held here, and against what:
 *   - The routes a tool calls are the ones the pinned OpenAPI schema mounts
 *     (a capture of Flow `main` after the Methods merge): `/api/v1/methods`,
 *     `/api/v1/method-steps`, `/api/v1/method-step-prompts`. Never `/flows`.
 *   - The old tool names and old argument spellings still work for one release,
 *     as a visible alias that says so — and an alias reaches the SAME route.
 *   - Every parameter reaches the wire (Zod drops an unknown key without a
 *     word).
 *   - Each sentence an agent reads is pinned by a phrase from the backend's own
 *     message or schema description; the source is named beside it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { registerAll } from "../src/index.js";
import { registerConventions } from "../src/tools/conventions.js";
import { placementClient } from "./placementStub.js";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

type Schema = { properties?: Record<string, unknown>; enum?: string[] };
const snapshot = JSON.parse(read("./fixtures/openapi.snapshot.json")) as {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, Schema> };
};

type Result = { isError?: boolean; content: { text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function surface() {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const shapes = new Map<string, Record<string, unknown>>();
  const client = {
    get: vi.fn(async () => ({ ok: true })),
    post: vi.fn(async () => ({ ok: true })),
    put: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
  };
  registerAll(
    {
      tool: (name: string, d: string, s: Record<string, unknown>, h: Handler) => {
        handlers.set(name, h);
        descriptions.set(name, d);
        shapes.set(name, s);
      },
    } as never,
    client as never,
  );
  return { handlers, descriptions, shapes, client };
}

const M = "/api/v1/methods";

/** Old tool name -> the name it has now. The whole list, spelled out. */
const RENAMED: Record<string, string> = {
  list_flows: "list_methods",
  read_flow: "read_method",
  create_flow: "create_method",
  update_flow: "update_method",
  delete_flow: "delete_method",
  restore_flow: "restore_method",
  list_deleted_flows: "list_deleted_methods",
  discard_flow_draft: "discard_method_draft",
  archive_flow: "archive_method",
  unarchive_flow: "unarchive_method",
  request_publish_flow: "request_publish_method",
  list_flow_versions: "list_method_versions",
  read_flow_version: "read_method_version",
  restore_flow_version: "restore_method_version",
  delete_flow_version: "delete_method_version",
  list_deleted_flow_versions: "list_deleted_method_versions",
  restore_deleted_flow_version: "restore_deleted_method_version",
  create_flow_major_version: "create_method_major_version",
  ensure_flow_major_version: "ensure_method_major_version",
  name_flow_major_version: "name_method_major_version",
  read_flow_published: "read_method_published",
  clone_flow: "clone_method",
  list_flow_step_prompts: "list_method_step_prompts",
  attach_prompt_snippet_to_flow_step: "attach_prompt_snippet_to_method_step",
  update_flow_step_prompt: "update_method_step_prompt",
  reorder_flow_step_prompts: "reorder_method_step_prompts",
  detach_prompt_snippet_from_flow_step: "detach_prompt_snippet_from_method_step",
  read_flow_prompt_stacks: "read_method_prompt_stacks",
};

/** What each tool needs to be called, spelled the way it is spelled NOW. */
const ARGS: Record<string, Record<string, unknown>> = {
  read_method: { id: "m1" },
  update_method: { id: "m1", expectedVersion: 3, fields: { name: "n" } },
  delete_method: { id: "m1", expectedVersion: 3, confirm: true },
  restore_method: { id: "m1" },
  discard_method_draft: { id: "m1" },
  archive_method: { id: "m1" },
  unarchive_method: { id: "m1" },
  list_method_versions: { id: "m1" },
  read_method_version: { id: "m1", version: 2 },
  restore_method_version: { id: "m1", versionId: "v1", expectedVersion: 3 },
  delete_method_version: { id: "m1", versionId: "v1", confirm: true },
  list_deleted_method_versions: { id: "m1" },
  restore_deleted_method_version: { id: "m1", versionId: "v1" },
  create_method_major_version: { id: "m1", name: "Baseline" },
  ensure_method_major_version: { id: "m1" },
  name_method_major_version: { id: "m1", majorVersion: 2, name: "Baseline" },
  read_method_published: { id: "m1" },
  clone_method: { methodId: "m1" },
  list_method_step_prompts: { methodStepId: "ms1" },
  attach_prompt_snippet_to_method_step: {
    methodStepId: "ms1", snippetId: "s1", target: "system",
  },
  update_method_step_prompt: { linkId: "lk1", target: "user" },
  reorder_method_step_prompts: { methodStepId: "ms1", snippetIds: ["a", "b"] },
  detach_prompt_snippet_from_method_step: { linkId: "lk1" },
  read_method_prompt_stacks: { methodId: "m1" },
  request_publish_method: { id: "m1", changeSummary: "go" },
  list_methods: {},
  create_method: { fields: { name: "n" } },
  list_deleted_methods: {},
};

/** The same call, the old way: an old name takes old argument names. */
const OLD_ARGS: Record<string, Record<string, unknown>> = {
  clone_flow: { flowId: "m1" },
  list_flow_step_prompts: { flowStepId: "ms1" },
  attach_prompt_snippet_to_flow_step: {
    flowStepId: "ms1", snippetId: "s1", target: "system",
  },
  reorder_flow_step_prompts: { flowStepId: "ms1", snippetIds: ["a", "b"] },
  read_flow_prompt_stacks: { flowId: "m1" },
};

const paths = (client: ReturnType<typeof surface>["client"]) =>
  [client.get, client.post, client.put, client.patch, client.del].flatMap((f) =>
    f.mock.calls.map((c) => String((c as unknown[])[0])),
  );

describe("the method tools call the routes the backend mounts now", () => {
  it("the family: list, read, create, update, delete, restore, trash list, discard, archive", async () => {
    const { handlers, client } = surface();
    await handlers.get("list_methods")!({});
    expect(client.get).toHaveBeenLastCalledWith(M, expect.anything());
    await handlers.get("read_method")!({ id: "m1" });
    expect(client.get).toHaveBeenLastCalledWith(`${M}/m1`);
    await handlers.get("create_method")!({ fields: { name: "n" } });
    expect(client.post).toHaveBeenLastCalledWith(M, { name: "n" });
    await handlers.get("update_method")!({ id: "m1", expectedVersion: 3, fields: { name: "n" } });
    expect(client.patch).toHaveBeenLastCalledWith(`${M}/m1`, { expectedVersion: 3, name: "n" });
    await handlers.get("delete_method")!({ id: "m1", expectedVersion: 3, confirm: true });
    expect(client.del).toHaveBeenLastCalledWith(`${M}/m1`, { expectedVersion: 3 });
    await handlers.get("restore_method")!({ id: "m1" });
    expect(client.post).toHaveBeenLastCalledWith(`${M}/m1/restore`);
    await handlers.get("list_deleted_methods")!({});
    expect(client.get).toHaveBeenLastCalledWith(`${M}/deleted`);
    await handlers.get("discard_method_draft")!({ id: "m1" });
    expect(client.post).toHaveBeenLastCalledWith(`${M}/m1/discard-draft`);
    await handlers.get("archive_method")!({ id: "m1" });
    expect(client.post).toHaveBeenLastCalledWith(`${M}/m1/archive`);
    await handlers.get("unarchive_method")!({ id: "m1" });
    expect(client.post).toHaveBeenLastCalledWith(`${M}/m1/unarchive`);
  });

  it("the version tools and the published read", async () => {
    const { handlers, client } = surface();
    await handlers.get("list_method_versions")!({ id: "m1" });
    expect(client.get).toHaveBeenLastCalledWith(`${M}/m1/versions`, expect.anything());
    await handlers.get("read_method_version")!({ id: "m1", version: 2 });
    expect(client.get).toHaveBeenLastCalledWith(`${M}/m1/versions/2`);
    await handlers.get("restore_method_version")!({ id: "m1", versionId: "v1", expectedVersion: 3 });
    expect(client.post).toHaveBeenLastCalledWith(`${M}/m1/versions/v1/restore`, { expectedVersion: 3 });
    await handlers.get("ensure_method_major_version")!({ id: "m1" });
    expect(client.post).toHaveBeenLastCalledWith(`${M}/m1/versions/ensure`);
    await handlers.get("name_method_major_version")!({ id: "m1", majorVersion: 2, name: "B" });
    expect(client.patch).toHaveBeenLastCalledWith(`${M}/m1/versions/major/2`, { name: "B" });
    await handlers.get("read_method_published")!({ id: "m1" });
    expect(client.get).toHaveBeenLastCalledWith(`${M}/m1/published`);
  });

  it("clone sends a body: the route requires one, and `name` reaches the wire", async () => {
    const { handlers, client } = surface();
    await handlers.get("clone_method")!({ methodId: "m1" });
    expect(client.post).toHaveBeenLastCalledWith(`${M}/m1/clone`, {});
    await handlers.get("clone_method")!({ methodId: "m1", name: "My copy" });
    expect(client.post).toHaveBeenLastCalledWith(`${M}/m1/clone`, { name: "My copy" });
  });

  it("who uses a method", async () => {
    const { handlers, client } = surface();
    await handlers.get("read_method_used_by")!({ id: "m1" });
    expect(client.get).toHaveBeenLastCalledWith(`${M}/m1/used-by`);
  });

  it("the prompt stack of a method step, every parameter on the wire", async () => {
    const { handlers, client } = surface();
    await handlers.get("list_method_step_prompts")!({ methodStepId: "ms1" });
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/method-steps/ms1/prompts");
    await handlers.get("attach_prompt_snippet_to_method_step")!({
      methodStepId: "ms1", snippetId: "s1", target: "user", displayOrder: 2,
    });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/method-steps/ms1/prompts", {
      snippetId: "s1", target: "user", displayOrder: 2,
    });
    await handlers.get("update_method_step_prompt")!({ linkId: "lk1", target: "user", displayOrder: 1 });
    expect(client.patch).toHaveBeenLastCalledWith("/api/v1/method-step-prompts/lk1", {
      target: "user", displayOrder: 1,
    });
    await handlers.get("reorder_method_step_prompts")!({ methodStepId: "ms1", snippetIds: ["a", "b"] });
    expect(client.put).toHaveBeenLastCalledWith("/api/v1/method-steps/ms1/prompts/order", {
      snippetIds: ["a", "b"],
    });
    await handlers.get("detach_prompt_snippet_from_method_step")!({ linkId: "lk1" });
    expect(client.del).toHaveBeenLastCalledWith("/api/v1/method-step-prompts/lk1");
    await handlers.get("read_method_prompt_stacks")!({ methodId: "m1" });
    expect(client.get).toHaveBeenLastCalledWith(`${M}/m1/prompt-stacks`);
  });

  it("every one of those routes is in the pinned schema, with that verb", () => {
    const has = (p: string, verb: string) => Boolean(snapshot.paths[p]?.[verb]);
    expect(has("/api/v1/methods/{method_id}/used-by", "get")).toBe(true);
    expect(has("/api/v1/methods/{method_id}/clone", "post")).toBe(true);
    expect(has("/api/v1/methods/{method_id}/prompt-stacks", "get")).toBe(true);
    expect(has("/api/v1/method-steps/{method_step_id}/prompts", "post")).toBe(true);
    expect(has("/api/v1/method-steps/{method_step_id}/prompts/order", "put")).toBe(true);
    expect(has("/api/v1/method-step-prompts/{link_id}", "patch")).toBe(true);
    expect(has("/api/v1/method-step-prompts/{link_id}", "delete")).toBe(true);
    expect(has("/api/v1/flows", "get")).toBe(false);
  });

  it("a publish request names the kind `method`; `flow` is still read the old way", async () => {
    const { handlers, client } = surface();
    await handlers.get("request_publish_method")!({ id: "m1", changeSummary: "go" });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/publish-approvals", {
      entityType: "method", entityId: "m1", changeSummary: "go",
    });
    await handlers.get("request_publish_flow")!({ id: "m1" });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/publish-approvals", {
      entityType: "method", entityId: "m1",
    });
    await handlers.get("request_publish_bulk")!({
      requests: [{ entityType: "flow", entityId: "m1" }, { entityType: "method", entityId: "m2" }],
    });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/publish-approvals/bulk", {
      requests: [
        { entityType: "method", entityId: "m1" },
        { entityType: "method", entityId: "m2" },
      ],
    });
    const kinds = snapshot.components.schemas.CreateApprovalRequest.properties as {
      entityType: { enum: string[] };
    };
    expect(kinds.entityType.enum).toContain("method");
    expect(kinds.entityType.enum).not.toContain("flow");
  });

  it("which workflows use a method: `method` and the old `flow` both ask for `method`", async () => {
    const { handlers, client } = surface();
    await handlers.get("list_workflows_using")!({ entityKind: "method", entityId: "m1" });
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/workflows/using/method/m1");
    await handlers.get("list_workflows_using")!({ entityKind: "flow", entityId: "m1" });
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/workflows/using/method/m1");
  });
});

describe("the old names still work for one release, as an alias that says so", () => {
  it("every old name is registered, beside its new one", () => {
    const { handlers } = surface();
    for (const [old, now] of Object.entries(RENAMED)) {
      expect(handlers.has(old), old).toBe(true);
      expect(handlers.has(now), now).toBe(true);
    }
  });

  it("no other tool is named `flow`: the aliases are exactly the list above", () => {
    const { handlers } = surface();
    const flowNamed = [...handlers.keys()].filter((n) => /(^|_)flows?(_|$)/.test(n));
    expect(flowNamed.sort()).toEqual(Object.keys(RENAMED).sort());
  });

  it("an alias says it is one, names its replacement, and an agent reads that first", () => {
    const { descriptions } = surface();
    for (const [old, now] of Object.entries(RENAMED)) {
      const text = descriptions.get(old)!;
      expect(text.startsWith("DEPRECATED"), old).toBe(true);
      expect(text, old).toContain(`\`${now}\``);
      expect(text, old).toContain("next release");
    }
  });

  it("a new tool does not carry that notice", () => {
    const { descriptions } = surface();
    for (const now of Object.values(RENAMED)) {
      expect(descriptions.get(now)!.startsWith("DEPRECATED"), now).toBe(false);
    }
  });

  it("an old name makes the same call as the new one, on the new routes", async () => {
    const a = surface();
    const b = surface();
    for (const [old, now] of Object.entries(RENAMED)) {
      await a.handlers.get(old)!(OLD_ARGS[old] ?? ARGS[now]);
      await b.handlers.get(now)!(ARGS[now]);
    }
    for (const f of ["get", "post", "put", "patch", "del"] as const) {
      expect(a.client[f].mock.calls, f).toEqual(b.client[f].mock.calls);
    }
    expect(paths(a.client).filter((p) => /\/flows|\/flow-step/.test(p))).toEqual([]);
  });

  it("an old argument name works on an old tool, and only there", () => {
    const { shapes } = surface();
    expect(Object.keys(shapes.get("clone_flow")!)).toContain("flowId");
    expect(Object.keys(shapes.get("clone_flow")!)).not.toContain("methodId");
    expect(Object.keys(shapes.get("clone_method")!)).toContain("methodId");
    expect(Object.keys(shapes.get("clone_method")!)).not.toContain("flowId");
    expect(Object.keys(shapes.get("list_flow_step_prompts")!)).toEqual(["flowStepId"]);
    expect(Object.keys(shapes.get("list_method_step_prompts")!)).toEqual(["methodStepId"]);
    expect(Object.keys(shapes.get("read_flow_prompt_stacks")!)).toEqual(["flowId"]);
    expect(Object.keys(shapes.get("read_method_prompt_stacks")!)).toEqual(["methodId"]);
  });
});

describe("the old spelling of a field is still read: `flowSteps` is `methodSteps`", () => {
  const steps = [{ name: "a", displayOrder: 0, exitTool: { name: "done", jsonSchema: {} } }];

  it.each(["create_method", "create_flow"])("%s", async (tool) => {
    const { handlers, client } = surface();
    await handlers.get(tool)!({ fields: { name: "n", flowSteps: steps } });
    expect(client.post).toHaveBeenLastCalledWith(M, { name: "n", methodSteps: steps });
  });

  it.each(["update_method", "update_flow"])("%s", async (tool) => {
    const { handlers, client } = surface();
    await handlers.get(tool)!({ id: "m1", expectedVersion: 2, fields: { flowSteps: steps } });
    expect(client.patch).toHaveBeenLastCalledWith(`${M}/m1`, {
      expectedVersion: 2, methodSteps: steps,
    });
  });

  it("both spellings in one call is an error, never a silent pick", async () => {
    const { handlers, client } = surface();
    const result = await handlers.get("update_method")!({
      id: "m1", expectedVersion: 2, fields: { flowSteps: steps, methodSteps: steps },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("flowSteps");
    expect(result.content[0].text).toContain("methodSteps");
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("a method with no old spelling in it is sent as it is", async () => {
    const { handlers, client } = surface();
    await handlers.get("update_method")!({
      id: "m1", expectedVersion: 2, fields: { methodSteps: steps, firstStepName: "a" },
    });
    expect(client.patch).toHaveBeenLastCalledWith(`${M}/m1`, {
      expectedVersion: 2, methodSteps: steps, firstStepName: "a",
    });
  });
});

describe("what the descriptions promise is what the backend does", () => {
  const props = (name: string) =>
    Object.keys(snapshot.components.schemas[name].properties ?? {});

  it("create_method and update_method name the fields the request bodies have", () => {
    for (const f of ["methodSteps", "firstStepName", "description", "name"]) {
      expect(props("MethodCreateRequest")).toContain(f);
      expect(props("MethodUpdateRequest")).toContain(f);
    }
    expect(props("MethodStepSchema")).toEqual(
      expect.arrayContaining(["exitTool", "transitions", "displayOrder"]),
    );
    expect(props("TransitionSchema")).toEqual(
      expect.arrayContaining(["when", "next", "forkField", "routes", "default"]),
    );
  });

  it("create_method says how a route names its target and what a step with no route does", () => {
    const { descriptions } = surface();
    const t = descriptions.get("create_method")!;
    // method_service._check_transition_targets
    expect(t).toContain("does not match any step");
    // method_service._routes_by_name: a target may be a step name or the id a read gave
    expect(t).toMatch(/by name|its name/);
    expect(t).toMatch(/step id|by id|the id/);
    // DECISIONS.md 10: a step with no transition ends the method
    expect(t).toMatch(/no transition[^.]*ends the method/);
    // method_service._runner_start_name: lowest display order when none is named
    expect(t).toContain("firstStepName");
    expect(t).toContain("lowest `displayOrder`");
  });

  it("update_method says the step list is REPLACED, and the start stays where it was", () => {
    const { descriptions } = surface();
    const t = descriptions.get("update_method")!;
    // method_service.update_method -> _replace_steps(method, desired)
    expect(t).toMatch(/`methodSteps` replaces the WHOLE step list/);
    // DECISIONS.md 10 + update_method: every save pins the start
    expect(t).toMatch(/reordering never moves where it starts/);
    // update_method: ForbiddenError("Framework methods are immutable; clone one to customise it.")
    expect(t).toContain("clone_method");
    expect(t).toMatch(/provided by the platform/);
  });

  it("delete_method and archive_method say a published workflow that runs it refuses both", () => {
    const { descriptions } = surface();
    // method_service.refuse_if_in_use: "Cannot delete: method is referenced by published workflow(s): …"
    // — the one guard its delete and its archive share (archive_ops.GUARDS["method"]).
    expect(descriptions.get("archive_method")!).toContain("in the same words as delete_method");
    expect(descriptions.get("delete_method")!).toContain("referenced by published workflow");
    // …and a draft that names it does not (its docstring: "a draft that names the method does not run it")
    expect(descriptions.get("delete_method")!).toMatch(/draft[^.]*does not/);
  });

  it("read_method_used_by names the answer's fields, as MethodUsageResponse has them", () => {
    const { descriptions } = surface();
    const t = descriptions.get("read_method_used_by")!;
    expect(props("MethodUsageResponse")).toEqual(["agents", "workflows"]);
    expect(props("MethodUser")).toEqual(expect.arrayContaining(["id", "name"]));
    expect(props("DependentWorkflow")).toEqual(expect.arrayContaining(["state", "steps"]));
    for (const w of ["agents", "workflows", "state", "draft", "published"]) {
      expect(t).toContain(w);
    }
    // GET /methods/{id}/used-by: "For the platform's default method, the agent steps that name no method."
    expect(t).toMatch(/default method/);
  });

  it("list_methods says what a row carries, as MethodListItem has it", () => {
    const { descriptions } = surface();
    const t = descriptions.get("list_methods")!;
    for (const f of ["stepCount", "usedByCount", "publishedMajorVersion", "draftMajorVersion", "isPlatform"]) {
      expect(props("MethodListItem"), f).toContain(f);
      expect(t, f).toContain(f);
    }
  });

  it("the prompt-stack answer is described with the keys it has", () => {
    const { descriptions } = surface();
    expect(props("MethodPromptStacksResponse")).toEqual(
      expect.arrayContaining(["methodId", "methodSteps", "wildcardPrompts"]),
    );
    expect(props("WorkflowPromptStacksResponse")).toContain("methodSteps");
    expect(props("MethodStepPromptStack")).toEqual(
      expect.arrayContaining(["methodStepId", "flowStepName"]),
    );
    const t = descriptions.get("read_workflow_prompt_stacks")!;
    expect(t).toContain("methodStepId");
    expect(t).not.toContain("flowStepId");
    // the step's name is still spelled `flowStepName` in the answer; say so rather than hide it
    expect(t).toContain("flowStepName");
  });

  it("no new tool describes a method as a flow", () => {
    const { descriptions } = surface();
    for (const now of [...Object.values(RENAMED), "read_method_used_by"]) {
      const body = descriptions.get(now)!.replace(/`flow`|\bflowStepName\b/g, "");
      expect(/\bflows?\b/i.test(body), `${now}: ${body.slice(0, 200)}`).toBe(false);
    }
    expect(descriptions.get("list_methods")).not.toContain("reusable workflow fragments");
  });

  it("clone_method no longer says a platform method can be edited in place", () => {
    const { descriptions } = surface();
    const t = descriptions.get("clone_method")!;
    expect(t).not.toMatch(/NOT actually protected|backend gap/);
    expect(t).toContain("immutable");
  });
});

describe("the guide (axonity_conventions) speaks of methods", () => {
  async function guide() {
    const handlers = new Map<string, () => Promise<Result>>();
    registerConventions(
      { tool: (n: string, _d: string, _s: unknown, h: () => Promise<Result>) => handlers.set(n, h) } as never,
      placementClient(),
    );
    return (await handlers.get("axonity_conventions")!()).content[0].text;
  }

  it("has a method section, not a flow section, and the placement words are the new ones", async () => {
    const text = await guide();
    expect(text).toContain("### method");
    expect(text).not.toContain("### flow");
    expect(text).not.toContain("reusable workflow fragment");
    expect(text).toContain("read_method_published");
    expect(text).toContain("request_publish_method");
    expect(text).toContain("attach_prompt_snippet_to_method_step");
    expect(text).toContain("methodStepId");
    expect(text).not.toContain("flowStepId");
  });

  it("says once that the old names are an alias for this release", async () => {
    const text = await guide();
    expect(text).toMatch(/`create_flow`[^.]*alias/s);
  });
});
