import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerConventions } from "../src/tools/conventions.js";
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
      _s: unknown,
      handler: (a: never) => Promise<ToolResult>,
    ) => {
      handlers.set(name, handler as Handler);
      descriptions.set(name, description);
    },
  };
  registerTriggerTools(server as never, client as unknown as AxonityClient);
  registerRunTools(server as never, client as unknown as AxonityClient);
  return { handlers, descriptions, client };
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

describe("the guide says both, where an agent will meet them", () => {
  it("tells an agent to start from the outline and to disarm rather than delete", async () => {
    const handlers = new Map<string, Handler>();
    registerConventions({
      tool: (name: string, _d: string, _s: unknown, h: (a: never) => Promise<ToolResult>) =>
        handlers.set(name, h as Handler),
    } as never);
    const text = (await handlers.get("axonity_conventions")!({})).content[0].text;

    expect(text).toContain("read_run_outline");
    expect(text).toContain("set_cron_schedule_enabled");
    expect(text).toContain("run_cron_schedule_now");
    expect(text).toContain("scheduleRuleKinds");
  });
});
