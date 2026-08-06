import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerRunTools } from "../src/tools/runs.js";

/**
 * #37 — the run lists must not answer a partial question as if it were whole.
 *
 * axonity-flow#822 (epic #811 S1) turned `GET /workflows/{id}/runs` into a
 * keyset-paged envelope: 20 launches by default, 200 max. Nothing here would
 * have crashed — the tool is a pass-through with no array access — so the
 * failure mode was an agent reporting on 20 launches and saying nothing about
 * the rest. That is the bug epic #811 exists to remove from the product, so
 * leaving it in the connector surface would be self-defeating.
 *
 * Two things are guarded here: the caller can REACH page 2 (limit + cursor go
 * through), and the caller can SEE that page 2 exists (the envelope is
 * forwarded whole rather than unwrapped to its items).
 */

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

/** A fake server that keeps tool descriptions — this suite asserts on them. */
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
    del: vi.fn(async () => ({ ok: true })),
  };
  registerRunTools(server as never, client as unknown as AxonityClient);
  return { handlers, descriptions, client };
}

function body(r: ToolResult): Record<string, unknown> {
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

describe("list_workflow_runs can reach every page (#37)", () => {
  it("forwards limit and cursor to the backend", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_workflow_runs")!({
      workflowId: "wf-1",
      archivedOnly: true,
      limit: 200,
      cursor: "MjAyNi0wOC0wNlQxMTo0NDoyNSswMDowMHwxYzJk",
    });

    expect(client.get).toHaveBeenCalledWith("/api/v1/workflows/wf-1/runs", {
      archived_only: true,
      limit: 200,
      cursor: "MjAyNi0wOC0wNlQxMTo0NDoyNSswMDowMHwxYzJk",
    });
  });

  it("sends no cursor on the first page, so the backend applies its own default", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_workflow_runs")!({ workflowId: "wf-1" });

    // The client drops undefined query entries, so an omitted limit/cursor is
    // an absent parameter — not `limit=undefined`, which the route would 422.
    expect(client.get).toHaveBeenCalledWith("/api/v1/workflows/wf-1/runs", {
      archived_only: undefined,
      limit: undefined,
      cursor: undefined,
    });
  });

  it("forwards the page envelope WHOLE — hasMore and nextCursor survive", async () => {
    const page = {
      items: [{ id: "run-1", status: "completed" }],
      nextCursor: "MjAyNi0wOC0wNlQxMTo0NDoyNSswMDowMHwxYzJk",
      pageSize: 20,
      hasMore: true,
    };
    const { handlers } = setup(async () => page);

    const result = body(await handlers.get("list_workflow_runs")!({ workflowId: "wf-1" }));

    // Unwrapping to `items` would rebuild the silent truncation one layer up:
    // the agent would hold a 1-row array with nothing saying more exist.
    expect(result).toEqual(page);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe(page.nextCursor);
  });

  it("passes the last page through unchanged too (nextCursor null)", async () => {
    const page = { items: [], nextCursor: null, pageSize: 20, hasMore: false };
    const { handlers } = setup(async () => page);

    expect(body(await handlers.get("list_workflow_runs")!({ workflowId: "wf-1" }))).toEqual(page);
  });
});

describe("the run lists say what kind of answer they are (#37)", () => {
  it("list_workflow_runs states it is one page and how to get the rest", () => {
    const { descriptions } = setup();
    const d = descriptions.get("list_workflow_runs")!;

    expect(d).toMatch(/ONE PAGE/);
    expect(d).toMatch(/nextCursor/);
    expect(d).toMatch(/hasMore/);
    expect(d).toMatch(/\b20\b/); // the default page size the agent is subject to
    expect(d).toMatch(/200/); // the cap
  });

  it("list_workflow_runs warns that a launch is not a run", () => {
    const { descriptions } = setup();
    const d = descriptions.get("list_workflow_runs")!;

    // The route filters to `parent_run_id IS NULL`, so a 4,415-item FOR EACH is
    // ONE row. An agent that counts rows to answer "how many runs?" is wrong by
    // three orders of magnitude, and pagination alone would not tell it so.
    expect(d).toMatch(/LAUNCH IS NOT A RUN/);
    expect(d).toMatch(/forEachProgress/);
  });

  it("list_runs discloses its bare array and silent clamp", () => {
    const { descriptions } = setup();
    const d = descriptions.get("list_runs")!;

    // This route was NOT converted by #822: no envelope, no cursor, and an
    // over-sized limit is clamped rather than refused. Nothing in its response
    // reveals that, so the description has to.
    expect(d).toMatch(/BARE ARRAY/);
    expect(d).toMatch(/MORE MAY EXIST/);
    expect(d).toMatch(/offset/);
  });
});
