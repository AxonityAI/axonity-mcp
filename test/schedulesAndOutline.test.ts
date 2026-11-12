import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AxonityClient } from "../src/client.js";
import { registerConventions } from "../src/tools/conventions.js";
import { placementClient } from "./placementStub.js";
import { registerRunTools } from "../src/tools/runs.js";
import { registerTriggerTools } from "../src/tools/triggers.js";

/**
 * axonity-mcp#57 — a schedule is checkable, and a run is readable in outline.
 *
 * Two properties are worth a test rather than a review comment, because both
 * are the kind of thing that reads as fine and is wrong:
 *
 *   - `run_cron_schedule_now` must not be confused with "start the workflow".
 *     It is the only way to prove a schedule fires at all, and the backend
 *     deliberately leaves `nextFireAt` alone so testing does not consume the
 *     run the schedule was going to make.
 *   - `read_run_outline` must forward `itemCap` and must not become the place
 *     where truncation goes quiet. The route counts what it left out; a tool
 *     that unwrapped the envelope would drop that count.
 */

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

function setup(response: unknown = { ok: true }) {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const schemas = new Map<string, z.ZodRawShape>();
  const client = {
    get: vi.fn(async () => response),
    post: vi.fn(async () => response),
    put: vi.fn(async () => response),
    patch: vi.fn(async () => response),
    del: vi.fn(async () => response),
  };
  const server = {
    tool: (
      name: string,
      description: string,
      shape: z.ZodRawShape,
      handler: (a: never) => Promise<ToolResult>,
    ) => {
      handlers.set(name, handler as Handler);
      descriptions.set(name, description);
      schemas.set(name, shape);
    },
  };
  registerTriggerTools(server as never, client as unknown as AxonityClient);
  registerRunTools(server as never, client as unknown as AxonityClient);
  return { handlers, descriptions, client, schemas };
}

function body(r: ToolResult): Record<string, unknown> {
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

describe("a schedule can be checked instead of waited for", () => {
  it("list_all_cron_schedules is tenant-wide and takes no id", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_all_cron_schedules")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/cron-schedules");
  });

  it("run_cron_schedule_now fires one schedule", async () => {
    const { handlers, client } = setup();
    await handlers.get("run_cron_schedule_now")!({ scheduleId: "cs-1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/cron-schedules/cs-1/run-now");
  });

  it("run_cron_schedule_now says it executes AND that it does not consume the next fire", () => {
    const { descriptions } = setup();
    const text = descriptions.get("run_cron_schedule_now")!;
    // It runs for real — the same warning start_workflow_run carries.
    expect(text).toMatch(/EXECUTES/);
    expect(text).toMatch(/cost and side effects/);
    // And the property that makes it safe to use as a test.
    expect(text).toMatch(/nextFireAt/);
  });

  it("set_cron_schedule_enabled PATCHes the flag", async () => {
    const { handlers, client } = setup();
    await handlers.get("set_cron_schedule_enabled")!({
      scheduleId: "cs-1",
      enabled: false,
    });
    expect(client.patch).toHaveBeenCalledWith("/api/v1/cron-schedules/cs-1", {
      enabled: false,
    });
  });

  it("reconcile_cron_schedules needs nothing and reports", async () => {
    const { handlers, client } = setup();
    await handlers.get("reconcile_cron_schedules")!({});
    expect(client.post).toHaveBeenCalledWith("/api/v1/cron-schedules/reconcile");
  });

  /**
   * The whole point of the disarm route: before it existed, "pause this" and
   * "we are done with this" were the same call. A delete description that does
   * not name the alternative recreates that.
   */
  it("delete_cron_schedule points at disarming rather than being the pause button", () => {
    const { descriptions } = setup();
    expect(descriptions.get("delete_cron_schedule")).toContain(
      "set_cron_schedule_enabled",
    );
  });
});

describe("create_cron_schedule can write the richer rule form", () => {
  it("sends rules when given them, and omits cronExpr entirely", async () => {
    const { handlers, client } = setup();
    const rules = [{ kind: "weekly", days: ["mon"], at: "07:00" }];
    await handlers.get("create_cron_schedule")!({
      workflowId: "wf-1",
      triggerId: "t-1",
      rules,
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/wf-1/cron-schedules", {
      triggerId: "t-1",
      rules,
    });
  });

  it("still sends a bare cronExpr", async () => {
    const { handlers, client } = setup();
    await handlers.get("create_cron_schedule")!({
      workflowId: "wf-1",
      triggerId: "t-1",
      cronExpr: "0 9 * * 1-5",
      timezone: "Europe/Brussels",
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/wf-1/cron-schedules", {
      triggerId: "t-1",
      cronExpr: "0 9 * * 1-5",
      timezone: "Europe/Brussels",
    });
  });

  it("names no rule shape of its own — the spec is the authority", () => {
    const { descriptions } = setup();
    const text = descriptions.get("create_cron_schedule")!;
    expect(text).toContain("scheduleRuleKinds");
    expect(text).toContain("get_workflow_authoring_spec");
  });
});

describe("a run is readable in outline before it is read in full", () => {
  it("read_run_outline forwards itemCap as the route's item_cap", async () => {
    const { handlers, client } = setup();
    await handlers.get("read_run_outline")!({ runId: "r-1", itemCap: 25 });
    expect(client.get).toHaveBeenCalledWith("/api/v1/runs/r-1/outline", {
      item_cap: 25,
    });
  });

  it("omitting itemCap leaves the route's own default alone", async () => {
    const { handlers, client } = setup();
    await handlers.get("read_run_outline")!({ runId: "r-1" });
    // `undefined` is dropped by the client's query builder, so no `item_cap=`
    // is sent — the connector does not get to pick the default.
    expect(client.get).toHaveBeenCalledWith("/api/v1/runs/r-1/outline", {
      item_cap: undefined,
    });
  });

  it("forwards the envelope whole, so counts.truncated survives", async () => {
    const envelope = {
      rows: [{ id: "s-1", counts: { total: 4000, truncated: 3950 } }],
    };
    const { handlers } = setup(envelope);
    const result = await handlers.get("read_run_outline")!({ runId: "r-1", itemCap: 50 });
    expect(body(result)).toEqual(envelope);
  });

  it("read_run_value fetches one body by digest, scoped to the run", async () => {
    const { handlers, client } = setup();
    await handlers.get("read_run_value")!({ runId: "r-1", digest: "abc123" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/runs/r-1/values/abc123");
  });

  it("read_run_invocation_messages fetches one transcript", async () => {
    const { handlers, client } = setup();
    await handlers.get("read_run_invocation_messages")!({
      runId: "r-1",
      invocationId: "inv-1",
    });
    expect(client.get).toHaveBeenCalledWith(
      "/api/v1/runs/r-1/invocations/inv-1/messages",
    );
  });

  it("the outline points at the two reads that let it stay small", () => {
    const { descriptions } = setup();
    const text = descriptions.get("read_run_outline")!;
    expect(text).toContain("read_run_value");
    expect(text).toContain("read_run_invocation_messages");
    expect(text).toMatch(/counts\.truncated/);
  });
});

describe("what a run left behind, and what is waiting on a human", () => {
  it("list_run_session_memory lists metadata only", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_run_session_memory")!({ runId: "r-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/runs/r-1/session-memory");
  });

  it("read_run_session_memory_file fetches one body by id", async () => {
    const { handlers, client } = setup();
    await handlers.get("read_run_session_memory_file")!({ runId: "r-1", fileId: "f-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/runs/r-1/session-memory/f-1");
  });

  it("list_todo_steps forwards limit and cursor", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_todo_steps")!({ limit: 50, cursor: "abc" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/runs/todo", {
      limit: 50,
      cursor: "abc",
    });
  });

  /**
   * This list is paged over the waiting RUNS, not over the to-do items, so a
   * caller who checks `items.length <= pageSize` to decide whether they have
   * everything gets a wrong answer on any run parked on several steps. The tool
   * has to say so — nothing in the envelope reveals it.
   */
  it("says that items may outnumber pageSize, and why", () => {
    const { descriptions } = setup();
    const text = descriptions.get("list_todo_steps")!;
    expect(text).toMatch(/LONGER than\s+pageSize/);
    expect(text).toMatch(/nextCursor/);
    expect(text).toMatch(/hasMore/);
  });

  it("forwards the page envelope whole", async () => {
    const page = { items: [{ runId: "r-1" }], nextCursor: "c2", pageSize: 20, hasMore: true };
    const { handlers } = setup(page);
    const result = await handlers.get("list_todo_steps")!({});
    expect(body(result)).toEqual(page);
  });
});

/**
 * `GET /runs/todo?agentId=` (axonity-flow, `waiting_on_a_person`, 11 Nov 2026)
 * answers only the items of one agent. The parameter has to ARRIVE: Zod drops
 * a key the tool does not declare without a word, and a handler that forgot to
 * forward it would answer the whole tenant's list as if it were one agent's.
 */
describe("list_todo_steps narrows to one agent with agentId", () => {
  const snapshot = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./fixtures/openapi.snapshot.json", import.meta.url)),
      "utf8",
    ),
  ) as {
    paths: Record<
      string,
      { get: { parameters?: { name: string; in: string; schema?: unknown }[] } }
    >;
    components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
  };

  it("declares agentId, so Zod keeps it", () => {
    const input = z.object(setup().schemas.get("list_todo_steps")!);
    const parsed = input.parse({ agentId: "a-1" }) as Record<string, unknown>;
    expect(parsed.agentId).toBe("a-1");
    expect(input.safeParse({}).success).toBe(true);
  });

  it("forwards agentId under the route's own name", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_todo_steps")!({ agentId: "a-1", limit: 20, cursor: "c" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/runs/todo", {
      limit: 20,
      cursor: "c",
      agentId: "a-1",
    });
  });

  it("sends no agentId when none is given, so the list is the whole tenant's", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_todo_steps")!({});
    const [, params] = client.get.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(params.agentId).toBeUndefined();
  });

  it("the name it sends is a query parameter of the route, a uuid", () => {
    const param = snapshot.paths["/api/v1/runs/todo"].get.parameters!.find(
      (p) => p.name === "agentId",
    );
    expect(param?.in).toBe("query");
    expect(JSON.stringify(param?.schema)).toContain('"format":"uuid"');
  });

  it("names the three fields each item carries, as the item schema has them", () => {
    const fields = Object.keys(snapshot.components.schemas.TodoItem.properties ?? {});
    expect(fields).toEqual(expect.arrayContaining(["agentId", "askedAt", "groupKey"]));
    const d = setup().descriptions.get("list_todo_steps")!;
    for (const f of ["agentId", "askedAt", "groupKey"]) expect(d, f).toContain(`\`${f}\``);
  });

  it("says what is an item, what is not, and whose it is", () => {
    const d = setup().descriptions.get("list_todo_steps")!;
    // The four kinds (`todoType`).
    for (const kind of ["ask_user", "plan_approval", "manual_step", "decision"]) {
      expect(d, kind).toContain(kind);
    }
    // What waits but is not an item.
    expect(d).toMatch(/archived/);
    expect(d).toMatch(/phase_control/);
    expect(d).toMatch(/already answered/);
    // Whose it is.
    expect(d).toMatch(/agent that asked/);
    expect(d).toMatch(/workflow's owner/);
    expect(d).toMatch(/budget question/);
    // It is NOT "every parked run, whatever it is parked on".
    expect(d).not.toMatch(/whatever it is parked on/);
  });

  it("does not call read_run_waiting_on the same question: that is a run's wake-tasks", () => {
    const d = setup().descriptions.get("list_todo_steps")!;
    expect(d).not.toMatch(/same question/);
    expect(d).toMatch(/read_run_waiting_on[^.]*wake-task/);
  });

  it("the guide says the same, at the guide's width", async () => {
    const { CONVENTIONS } = await import("../src/tools/conventions.js");
    const start = CONVENTIONS.indexOf("- **`list_todo_steps`**");
    expect(start).toBeGreaterThanOrEqual(0);
    // The two bullets on the to-do list, up to the next subject (archiving).
    const paragraph = CONVENTIONS.slice(start, CONVENTIONS.indexOf("- A run's archive", start));
    expect(paragraph).toContain("`agentId`");
    expect(paragraph).toContain("`groupKey`");
    expect(paragraph).toMatch(/agent\s+that asked/);
    expect(paragraph).toMatch(/workflow's\s+owner/);
    expect(paragraph).toMatch(/phase_control/);
    expect(paragraph).not.toMatch(/same question/);
    expect(paragraph).toMatch(/nextCursor/);
    for (const line of paragraph.split("\n")) expect(line.length, line).toBeLessThanOrEqual(84);
  });
});

describe("the guide says both, where an agent will meet them", () => {
  it("tells an agent to start from the outline and to disarm rather than delete", async () => {
    const handlers = new Map<string, Handler>();
    registerConventions({
      tool: (name: string, _d: string, _s: unknown, h: (a: never) => Promise<ToolResult>) =>
        handlers.set(name, h as Handler),
    } as never, placementClient());
    const text = (await handlers.get("axonity_conventions")!({})).content[0].text;

    expect(text).toContain("read_run_outline");
    expect(text).toContain("set_cron_schedule_enabled");
    expect(text).toContain("run_cron_schedule_now");
    expect(text).toContain("scheduleRuleKinds");
  });
});

/**
 * Review of 4347f84 (must): `GET /runs/{id}/waiting-on` lists a run's PENDING
 * WAKE-TASKS. A step that waits on a person — an open question, a plan, a
 * manual or decision step — has none: the `user_answer` task is planted only
 * once a person answers (axonity-flow `RunService.plant_ask_user_wake_task`).
 * The kinds that do sit there are time, user_answer, user_message, callback
 * and batch_complete (`wake_task_describer.py`). So no description may send an
 * agent there to find an open question or the step to complete.
 */
describe("read_run_waiting_on is where a run's wake-tasks are, not its open questions", () => {
  it("read_run_waiting_on names what a wake-task is, and where the person-steps are", () => {
    const d = setup().descriptions.get("read_run_waiting_on")!;
    expect(d).not.toMatch(/a question asked of a person/);
    expect(d).toMatch(/on its way/);
    expect(d).toMatch(/timer/);
    expect(d).toMatch(/callback/);
    expect(d).toMatch(/batch/);
    expect(d).toMatch(/list_todo_steps/);
  });

  it("list_todo_steps describes those wake-tasks the same way", () => {
    const d = setup().descriptions.get("list_todo_steps")!;
    expect(d).not.toMatch(/\(a question, a timer, a callback\)/);
    expect(d).toMatch(/read_run_waiting_on[^.]*on its way/);
  });

  it("the tools that unpark a step find it in list_todo_steps or read_run, not in the wake-tasks", () => {
    const { descriptions, schemas } = setup();
    for (const tool of ["start_workflow_run", "answer_run_question", "complete_run_step"]) {
      const d = descriptions.get(tool)!;
      expect(d, tool).not.toMatch(/read_run_waiting_on says what it is parked on/);
      expect(d, tool).not.toMatch(/Find the parked step with read_run_waiting_on/);
      expect(d, tool).toMatch(/list_todo_steps/);
    }
    for (const tool of ["answer_run_question", "complete_run_step"]) {
      const stepId = schemas.get(tool)!.stepId as z.ZodTypeAny;
      expect(stepId.description, tool).not.toMatch(/read_run_waiting_on/);
      expect(stepId.description, tool).toMatch(/list_todo_steps/);
    }
  });

  it("the guide's 'a run can park' bullet points at list_todo_steps", async () => {
    const { CONVENTIONS } = await import("../src/tools/conventions.js");
    const start = CONVENTIONS.indexOf("**A run can park instead of finishing.**");
    expect(start).toBeGreaterThanOrEqual(0);
    const bullet = CONVENTIONS.slice(start, CONVENTIONS.indexOf("\n  - ", start));
    expect(bullet).not.toMatch(/`read_run_waiting_on` says what for/);
    expect(bullet).toMatch(/list_todo_steps/);
  });
});

describe("whose an item is, as the SQL decides it (review of 4347f84)", () => {
  it("the budget item is the budget_pause flag, not a date", () => {
    const d = setup().descriptions.get("list_todo_steps")!;
    expect(d).not.toMatch(/before 11 Nov/);
    expect(d).toContain("`budget_pause`");
  });

  it("a manual step is nobody's when the workflow has no live owner, not only when deleted", () => {
    const d = setup().descriptions.get("list_todo_steps")!;
    expect(d).toMatch(/no live owner/);
  });

  it("the guide's paging bullet names its tool and does not promise a full page", async () => {
    const { CONVENTIONS } = await import("../src/tools/conventions.js");
    expect(CONVENTIONS).not.toMatch(/\n- It is PAGED over the waiting RUNS/);
    expect(CONVENTIONS).not.toMatch(/or, without `agentId`,\s+shorter/);
  });
});
