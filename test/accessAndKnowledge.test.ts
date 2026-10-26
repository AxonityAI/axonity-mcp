import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { ForbiddenError, errorForStatus } from "../src/errors.js";
import { registerAll } from "../src/index.js";
import { searchKnowledge } from "../src/tools/knowledgeGraph.js";
import { CONVENTIONS } from "../src/tools/conventions.js";
import { forbids } from "./denyList.js";

/**
 * axonity-mcp#88 — who may read what, through the connector (axonity-flow#1918).
 *
 *   S1  the vocabulary of access is readable: audiences, roles, who holds which;
 *   S2  the label and clearance fields are described where they are written,
 *       and a refused widening says why instead of "your token may not";
 *   S5  the knowledge graph is readable with the token's own clearance, and a
 *       switched-off module reads as such.
 *
 * S3 and S4 (managing audiences, roles and the graph's settings) wait on a
 * decision about tokens, and are deliberately absent.
 */

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

function setup(getImpl?: () => Promise<unknown>) {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const server = {
    tool: (
      name: string,
      description: string,
      _schema: unknown,
      handler: (a: never) => Promise<ToolResult>,
    ) => {
      handlers.set(name, handler as Handler);
      descriptions.set(name, description);
    },
  };
  const client = {
    get: vi.fn(getImpl ?? (async () => ({ ok: true }))),
    post: vi.fn(async () => ({ ok: true })),
    put: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
  };
  registerAll(server as never, client as unknown as AxonityClient);
  return { handlers, descriptions, client };
}

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/openapi.snapshot.json", import.meta.url)),
    "utf8",
  ),
) as { components: { schemas: Record<string, { properties?: Record<string, unknown> }> } };

describe("S1 — the vocabulary of access is readable", () => {
  const cases: [string, Record<string, unknown>, string, Record<string, unknown> | undefined][] = [
    ["list_audiences", { limit: 5, cursor: "c1" }, "/api/v1/audiences", { limit: 5, cursor: "c1" }],
    ["read_audience", { id: "a1" }, "/api/v1/audiences/a1", undefined],
    ["list_roles", { cursor: "c2" }, "/api/v1/roles", { limit: undefined, cursor: "c2" }],
    ["read_role", { id: "r1" }, "/api/v1/roles/r1", undefined],
    ["read_member_roles", { userId: "u1" }, "/api/v1/users/u1/roles", undefined],
  ];

  for (const [name, args, path, query] of cases) {
    it(`${name} reads ${path}`, async () => {
      const { handlers, client } = setup();
      const result = await handlers.get(name)!(args);
      expect(result.isError).toBeUndefined();
      expect(client.get).toHaveBeenCalledTimes(1);
      const call = client.get.mock.calls[0] as unknown[];
      expect(call[0]).toBe(path);
      if (query) expect(call[1]).toEqual(query);
      // Reading only: nothing here writes.
      expect(client.post).not.toHaveBeenCalled();
      expect(client.put).not.toHaveBeenCalled();
    });
  }

  it("says what an audience and a role are, in plain words", () => {
    const { descriptions } = setup();
    expect(descriptions.get("list_audiences")).toMatch(/WHOM KNOWLEDGE IS MEANT FOR/);
    expect(descriptions.get("list_audiences")).toMatch(/never match on a name/);
    expect(descriptions.get("list_roles")).toMatch(/WHAT A COLLEAGUE MAY READ AND MAINTAIN/);
  });

  it("offers no way to change an audience, a role or who holds one (S3 waits)", () => {
    const { handlers } = setup();
    for (const name of [
      "create_audience",
      "update_audience",
      "delete_audience",
      "create_role",
      "update_role",
      "delete_role",
      "set_member_roles",
    ]) {
      expect(handlers.has(name), name).toBe(false);
    }
  });
});

describe("S2 — labels and clearances are described where they are written", () => {
  for (const singular of ["policy", "skill", "reference_doc", "data_table"]) {
    it(`${singular}: default, null and widening are said`, () => {
      const { descriptions } = setup();
      const create = descriptions.get(`create_${singular}`)!;
      expect(create).toMatch(/`audienceIds`/);
      expect(create).toMatch(/internal, for Staff/);
      expect(create).toMatch(/`level: null` means NO label: nobody can read it/);
      expect(create).toMatch(/list_audiences/);
      const update = descriptions.get(`update_${singular}`)!;
      expect(update).toMatch(/WIDENING/);
      expect(update).toMatch(/A token never can/);
      expect(update).toMatch(/replaces the whole set/);
    });
  }

  it("agent: clearance is an administrator's, so a token leaves it out", () => {
    const { descriptions } = setup();
    for (const name of ["create_agent", "update_agent"]) {
      expect(descriptions.get(name)).toMatch(/`clearance` is `\{ maxLevel, audienceIds \}`/);
      expect(descriptions.get(name)).toMatch(/Only an ADMINISTRATOR sets it/);
    }
  });

  it("workflow: clearance is the author's and travels through the approval", () => {
    const { descriptions } = setup();
    expect(descriptions.get("update_workflow")).toMatch(/`clearance` is `\{ maxLevel, audienceIds \}`/);
    expect(descriptions.get("update_workflow")).toMatch(/publish approval/);
  });

  it("passes the label through untouched — the backend validates it", async () => {
    const { handlers, client } = setup();
    await handlers.get("create_policy")!({
      fields: { name: "p", level: "confidential", audienceIds: ["aud-1"] },
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/policies", {
      name: "p",
      level: "confidential",
      audienceIds: ["aud-1"],
    });
  });

  it("the pinned contract carries every field the notes describe", () => {
    const props = (model: string) => Object.keys(snapshot.components.schemas[model]?.properties ?? {});
    for (const model of [
      "CreatePolicyRequest",
      "UpdatePolicyRequest",
      "CreateSkillV2Request",
      "UpdateSkillV2Request",
      "CreateReferenceDocRequest",
      "UpdateReferenceDocRequest",
      "CreateDataTableRequest",
      "UpdateDataTableRequest",
    ]) {
      expect(props(model), model).toEqual(expect.arrayContaining(["level", "audienceIds"]));
    }
    for (const model of ["CreateAgentRequest", "UpdateAgentRequest", "PatchWorkflowRequest"]) {
      expect(props(model), model).toContain("clearance");
    }
    expect(props("ClearanceSchema")).toEqual(expect.arrayContaining(["maxLevel", "audienceIds"]));
  });

  it("the conventions say: look ids up, never guess, compare on id", () => {
    expect(CONVENTIONS).toMatch(/## Who may read what/);
    expect(CONVENTIONS).toMatch(/list_audiences/);
    expect(CONVENTIONS).toMatch(/never guess one/);
    expect(CONVENTIONS).toMatch(/compare on id, never on name/);
  });

  it("a refused widening says why, not 'your token is read-only'", () => {
    const err = errorForStatus(403, {
      error: "forbidden",
      code: "forbidden",
      retryable: false,
      message:
        "Only a colleague with maintain rights may widen a label; an agent, a " +
        "process or a token never can.",
    });
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toMatch(/WIDENING A LABEL/);
    // The backend's own sentence comes through as well.
    expect(err.message).toMatch(/may widen a label/);
    expect(err.message).not.toMatch(/read-only token/);
  });

  it("a refused agent clearance reads as administrator only", () => {
    const err = errorForStatus(403, {
      error: "forbidden",
      code: "forbidden",
      message: "Only an administrator sets what an agent may read.",
    });
    expect(err.message).toMatch(/ADMINISTRATOR ONLY/);
  });
});

describe("S5 — the knowledge graph is readable", () => {
  const cases: [string, Record<string, unknown>, string, Record<string, unknown> | undefined][] = [
    ["list_knowledge_topics", { limit: 3 }, "/api/v1/knowledge/topics", { limit: 3, cursor: undefined }],
    [
      "list_topic_facts",
      { topicId: "t1", cursor: "c" },
      "/api/v1/knowledge/topics/t1/facts",
      { limit: undefined, cursor: "c" },
    ],
    ["read_fact", { id: "f1" }, "/api/v1/knowledge/facts/f1", undefined],
    ["read_source", { id: "s1" }, "/api/v1/knowledge/sources/s1", undefined],
    [
      "list_knowledge_tree",
      { parent: "n1" },
      "/api/v1/knowledge/tree",
      { parent: "n1", limit: undefined, cursor: undefined },
    ],
    ["list_related_topics", { nodeId: "n1" }, "/api/v1/knowledge/tree/n1/related", undefined],
    ["list_archived_facts", {}, "/api/v1/knowledge/archived", { limit: undefined, cursor: undefined }],
  ];

  for (const [name, args, path, query] of cases) {
    it(`${name} reads ${path}`, async () => {
      const { handlers, client } = setup();
      const result = await handlers.get(name)!(args);
      expect(result.isError).toBeUndefined();
      const call = client.get.mock.calls[0] as unknown[];
      expect(call[0]).toBe(path);
      if (query) expect(call[1]).toEqual(query);
      expect(client.post).not.toHaveBeenCalled();
    });
  }

  it("search_knowledge_graph is not in the one-call table: it polls a run", () => {
    expect(cases.map(([name]) => name)).not.toContain("search_knowledge_graph");
  });

  it("every tool says it reads with the token's clearance", () => {
    const { descriptions } = setup();
    for (const [name] of cases) {
      expect(descriptions.get(name), name).toMatch(/YOUR TOKEN'S CLEARANCE/);
    }
  });

  it("a switched-off module reads as such, not as a token limit", async () => {
    const body = {
      error: "forbidden",
      code: "forbidden",
      retryable: false,
      message:
        "Cortex is switched off in this workspace. A platform administrator " +
        "can switch it on under Installation › Modules.",
    };
    const { handlers } = setup(async () => {
      throw errorForStatus(403, body);
    });
    const result = await handlers.get("search_knowledge_graph")!({ q: "x" });
    // A refusal, never an empty list.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MODULE SWITCHED OFF/);
    expect(result.content[0].text).toMatch(/Cortex is switched off in this workspace/);
    expect(result.content[0].text).not.toMatch(/read-only token/);
  });

  it("erasing, decisions, learning, screens and a colleague's work lists stay out", () => {
    const { handlers } = setup();
    for (const name of ["erase_node", "list_doubtful_cases", "list_expiring_facts"]) {
      expect(handlers.has(name), name).toBe(false);
    }
    for (const [method, path] of [
      ["POST", "/api/v1/knowledge/nodes/n1/erase"],
      ["GET", "/api/v1/knowledge/decisions"],
      ["POST", "/api/v1/knowledge/decisions/d1"],
      ["POST", "/api/v1/knowledge/learning/round"],
      ["GET", "/api/v1/knowledge/learning/measure"],
      ["POST", "/api/v1/knowledge/oversight/cases/c1/assign"],
      ["POST", "/api/v1/knowledge/tips/shown"],
      ["GET", "/api/v1/knowledge/map"],
      ["GET", "/api/v1/knowledge/network/n1"],
      ["GET", "/api/v1/knowledge/attention"],
      ["GET", "/api/v1/knowledge/oversight/doubtful"],
      ["GET", "/api/v1/knowledge/oversight/expiring"],
    ]) {
      expect(forbids(method, path), `${method} ${path}`).toBe(true);
    }
    // And the reads stay open: a rule must not grow over them.
    for (const path of [
      "/api/v1/knowledge/facts/f1",
      "/api/v1/knowledge/search",
      "/api/v1/knowledge/archived",
      "/api/v1/knowledge/sources/s1",
    ]) {
      expect(forbids("GET", path), path).toBe(false);
    }
  });
});

describe("maintaining a fact, as the person who made the token (axonity-flow#2202)", () => {
  const cases: [string, Record<string, unknown>, string, unknown][] = [
    ["archive_fact", { id: "f1", reason: "a duplicate" }, "/api/v1/knowledge/facts/f1/archive", { reason: "a duplicate" }],
    ["restore_fact", { id: "f1" }, "/api/v1/knowledge/facts/f1/restore", undefined],
    ["confirm_fact", { id: "f1" }, "/api/v1/knowledge/facts/f1/confirm", undefined],
    ["reject_fact", { id: "f1", reason: "wrong" }, "/api/v1/knowledge/facts/f1/reject", { reason: "wrong" }],
    ["reject_fact", { id: "f1" }, "/api/v1/knowledge/facts/f1/reject", { reason: "" }],
    [
      "correct_fact",
      { id: "f1", kind: "changed", value: "June", since: "2026-06-01" },
      "/api/v1/knowledge/facts/f1/correct",
      { kind: "changed", value: "June", since: "2026-06-01" },
    ],
    [
      "relabel_fact",
      { id: "f1", level: "internal", audienceIds: ["a1"] },
      "/api/v1/knowledge/facts/f1/relabel",
      { level: "internal", audienceIds: ["a1"] },
    ],
    [
      "give_right_version",
      { id: "f1", value: "June" },
      "/api/v1/knowledge/facts/f1/right-version",
      { value: "June" },
    ],
  ];

  for (const [name, args, path, body] of cases) {
    it(`${name} posts ${path}`, async () => {
      const { handlers, client } = setup();
      const result = await handlers.get(name)!(args);
      expect(result.isError).toBeUndefined();
      const call = client.post.mock.calls[0] as unknown[];
      expect(call[0]).toBe(path);
      expect(call[1]).toEqual(body);
    });
  }

  it("the fact routes are no longer excluded, and every tool says whose rights it uses", () => {
    const { descriptions } = setup();
    for (const action of ["archive", "restore", "confirm", "reject", "correct", "relabel", "right-version"]) {
      expect(forbids("POST", `/api/v1/knowledge/facts/f1/${action}`), action).toBe(false);
    }
    for (const name of cases.map(([n]) => n)) {
      expect(descriptions.get(name), name).toMatch(/person who made this token/i);
    }
  });
});

describe("search_knowledge_graph starts the search run and waits for its answer", () => {
  const START = { id: "run-1", workflowId: "wf-1", status: "queued" };

  /** A clock the poll can read, and a sleep that moves it forward. */
  function fakeClock() {
    let t = 0;
    return {
      now: () => t,
      sleep: vi.fn(async (ms: number) => {
        t += ms;
      }),
    };
  }

  /** Serves the start handle, then each run state in turn (the last repeats). */
  function serveRuns(states: unknown[]) {
    const { handlers, client } = setup();
    let i = 0;
    client.get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/knowledge/search") return START;
      if (path.startsWith("/api/v1/runs/run-1/values/")) return "digest body";
      const state = states[Math.min(i, states.length - 1)];
      i += 1;
      return state;
    });
    return { handlers, client };
  }

  /** A completed run whose search step wrote ``answer`` as its output, beside ``text``. */
  function answered(answer: unknown, text: unknown = "") {
    return {
      id: "run-1",
      status: "completed",
      stepStates: { "search-knowledge": { output: text, structuredOutputs: { answer } } },
    };
  }

  it("starts the run with the question and reads the answer the search step wrote", async () => {
    const { client } = serveRuns([answered("Ann signs.")]);
    const out = await searchKnowledge(client as unknown as AxonityClient, "who signs", fakeClock());
    expect(client.get.mock.calls[0]).toEqual(["/api/v1/knowledge/search", { q: "who signs" }]);
    expect(client.get.mock.calls[1]).toEqual(["/api/v1/runs/run-1"]);
    expect(out).toEqual({ runId: "run-1", status: "completed", finished: true, answer: "Ann signs." });
  });

  it("keeps polling while the run is in progress, and stops at an end state", async () => {
    const clock = fakeClock();
    const { client } = serveRuns([
      { id: "run-1", status: "queued" },
      { id: "run-1", status: "running" },
      answered("done"),
    ]);
    const out = await searchKnowledge(client as unknown as AxonityClient, "q", clock);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ finished: true, answer: "done" });
  });

  it("returns a still-running answer after about 90 seconds, not an error", async () => {
    const clock = fakeClock();
    const { client } = serveRuns([{ id: "run-1", status: "running" }]);
    const out = await searchKnowledge(client as unknown as AxonityClient, "q", clock);
    expect(out).toMatchObject({ runId: "run-1", status: "running", finished: false });
    expect(out.note).toMatch(/read_run/);
    // Waited no longer than the limit: the last sleep started before 90 s.
    expect(clock.now()).toBeGreaterThanOrEqual(90_000);
    expect(clock.now()).toBeLessThan(90_000 + 1500);
  });

  it.each(["failed", "cancelled", "expired"])("a %s run is an error that says why", async (status) => {
    const { client } = serveRuns([
      { id: "run-1", status, stepStates: { "search-knowledge": { error: "model timed out" } } },
    ]);
    await expect(
      searchKnowledge(client as unknown as AxonityClient, "q", fakeClock()),
    ).rejects.toThrow(`The search run ended as ${status}: model timed out`);
  });

  it("never takes the step's free text for the answer", async () => {
    // The answer is the output the gate held to 'knowledge-answer-v1'; the
    // step's text is a closing remark (sandbox run ea925576: text "").
    const { client } = serveRuns([
      { id: "run-1", status: "completed", stepStates: { "search-knowledge": { output: "Done." } } },
    ]);
    await expect(
      searchKnowledge(client as unknown as AxonityClient, "q", fakeClock()),
    ).rejects.toThrow(/completed without an answer/);
  });

  it("reads a large answer from its value marker", async () => {
    const { client } = serveRuns([
      answered({ $run_value: "a".repeat(32), $bytes: 9000, $shape: "str" }),
    ]);
    const out = await searchKnowledge(client as unknown as AxonityClient, "q", fakeClock());
    expect(client.get).toHaveBeenCalledWith(`/api/v1/runs/run-1/values/${"a".repeat(32)}`);
    expect(out).toMatchObject({ answer: "digest body" });
  });

  it("a run state with no status is an error, never an endless wait", async () => {
    const { client } = serveRuns([{ id: "run-1" }]);
    await expect(
      searchKnowledge(client as unknown as AxonityClient, "q", fakeClock()),
    ).rejects.toThrow(/without a status/);
  });

  it("a completed run with no answer is an error, not an empty answer", async () => {
    const { client } = serveRuns([{ id: "run-1", status: "completed", stepStates: {} }]);
    await expect(
      searchKnowledge(client as unknown as AxonityClient, "q", fakeClock()),
    ).rejects.toThrow(/completed without an answer/);
  });

  it("the tool description says it waits, and no longer mentions landings or passages", () => {
    const { descriptions } = setup();
    const d = descriptions.get("search_knowledge_graph")!;
    expect(d).toMatch(/90 seconds/);
    expect(d).toMatch(/read_run/);
    expect(d).not.toMatch(/landing|passages/);
  });
});
