/**
 * axonity-mcp#73 — the routes the refreshed snapshot brought, decided.
 *
 * A snapshot refresh is a dump, not a selection: five operations arrived that
 * `completeness.test.ts` had never been shown. Each one is COVERED rather than
 * excluded, because none of them touches a boundary this connector keeps shut —
 * no `require_admin`, no publish gate, no fact about a person, no operator act
 * on the queue. `denyList.ts` states those reasons and none of them applied.
 *
 * What these tests pin is the WIRING (a tool reaches the route it claims) and
 * the handful of description facts an agent cannot recover on its own — the
 * ones where getting it wrong is silent rather than an error.
 */
import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerComponentTools } from "../src/tools/components.js";
import { registerCompanyTools } from "../src/tools/company.js";
import { registerDataTableTools } from "../src/tools/dataTables.js";
import { registerTriggerTools } from "../src/tools/triggers.js";

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

function fakeServer() {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
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
  return { server, handlers, descriptions };
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

describe("what a workflow is made of (axonity-flow#1369)", () => {
  function setup() {
    const { server, handlers, descriptions } = fakeServer();
    const client = fakeClient();
    registerComponentTools(server as never, client as unknown as AxonityClient);
    return { handlers, descriptions, client };
  }

  it("reads one workflow's components", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_workflow_components")!({ workflowId: "w1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/workflows/w1/components");
  });

  it("says what publicationState means, because 'live' is the whole question", () => {
    // A workflow whose components are `edited` or `not_published` runs on
    // something other than what the reader just read. That is the failure this
    // field exists to expose, and a row is useless to an agent that reads the
    // word without knowing it means the runtime cannot see it.
    const d = setup().descriptions.get("list_workflow_components")!;
    for (const state of ["live", "edited", "not_published", "missing"]) {
      expect(d, state).toContain(state);
    }
    expect(d).toMatch(/runtime/i);
  });

  it("says reach counts this workflow too", () => {
    // Off by one here is the difference between "mine alone" and "shared", and
    // it is the number the duplicate tool exists to act on.
    const d = setup().descriptions.get("list_workflow_components")!;
    expect(d).toContain("INCLUDING this one");
  });

  it("does not promise an empty list for an unknown workflow", () => {
    // A workflow that names nothing and a workflow that does not exist are
    // different answers; a caller that cannot tell them apart reports success
    // for a typo.
    expect(setup().descriptions.get("list_workflow_components")!).toContain("404");
  });

  it("duplicates a shared component and repoints this workflow at the copy", async () => {
    const { handlers, client } = setup();
    await handlers.get("duplicate_workflow_component")!({
      workflowId: "w1",
      kind: "agent",
      entityId: "a1",
    });
    expect(client.post).toHaveBeenCalledWith(
      "/api/v1/workflows/w1/components/duplicate",
      { kind: "agent", entityId: "a1" },
    );
  });

  it("says the answer is the whole document, not a patch", () => {
    // The repoint rewrites every site the component was named in. A caller
    // that applied a partial answer would keep a stale reference on the sites
    // it did not hear about — silent, and only visible at run time.
    const d = setup().descriptions.get("duplicate_workflow_component")!;
    expect(d).toMatch(/WHOLE DOCUMENT, NOT A PATCH/);
  });
});

describe("every conditional start in the tenant (axonity-flow#1278)", () => {
  function setup() {
    const { server, handlers, descriptions } = fakeServer();
    const client = fakeClient();
    registerTriggerTools(server as never, client as unknown as AxonityClient);
    return { handlers, descriptions, client };
  }

  it("reads the tenant-wide list, not a workflow's", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_tenant_conditional_triggers")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/conditional-triggers");
  });

  it("keeps the per-workflow list, which answers a different question", async () => {
    // Two routes, two shapes. One tool that sometimes answers one and
    // sometimes the other would be lying about itself.
    const { handlers, client } = setup();
    await handlers.get("list_conditional_triggers")!({ workflowId: "w1" });
    expect(client.get).toHaveBeenCalledWith(
      "/api/v1/workflows/w1/conditional-triggers",
    );
  });

  it("says pendingTasks should be 1, and what more than 1 means", () => {
    // The fork (#1278) is the reason this list is worth having. Without the
    // sentence it is a number nobody reads; with it, a workflow starting three
    // times an interval is visible before somebody reports odd runs.
    const d = setup().descriptions.get("list_tenant_conditional_triggers")!;
    expect(d).toContain("pendingTasks");
    expect(d).toMatch(/FORKED/);
  });

  it("says disabled triggers are included", () => {
    // A schedule somebody switched off is the one you go looking for.
    expect(
      setup().descriptions.get("list_tenant_conditional_triggers")!,
    ).toMatch(/DISABLED/);
  });
});

describe("a table's rows, one page at a time (axonity-flow#1372)", () => {
  function setup() {
    const { server, handlers, descriptions } = fakeServer();
    const client = fakeClient();
    registerDataTableTools(server as never, client as unknown as AxonityClient);
    return { handlers, descriptions, client };
  }

  it("pages and filters through the route's own arguments", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_data_table_rows")!({
      tableId: "t1",
      q: "benelux",
      limit: 50,
      cursor: "abc",
    });
    expect(client.get).toHaveBeenCalledWith("/api/v1/data-tables/t1/rows", {
      q: "benelux",
      limit: 50,
      cursor: "abc",
    });
  });

  it("omits what the caller did not ask for", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_data_table_rows")!({ tableId: "t1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/data-tables/t1/rows", {
      q: undefined,
      limit: undefined,
      cursor: undefined,
    });
  });

  it("warns that this is a page and how to reach the rest", () => {
    // #37 exactly: nothing crashes, the agent just answers about twenty rows
    // and says nothing about the other four hundred.
    const d = setup().descriptions.get("list_data_table_rows")!;
    expect(d).toContain("ONE PAGE");
    expect(d).toContain("nextCursor");
    expect(d).toMatch(/hasMore/);
  });

  it("says a stale cursor is refused rather than silently wrong", () => {
    // The cursor carries a fingerprint of the table version and the filter, so
    // a table edited mid-scroll gets a 422 instead of a different set of rows.
    // Without this line a 422 reads as a fault in the tool.
    const d = setup().descriptions.get("list_data_table_rows")!;
    expect(d).toMatch(/422/);
    expect(d).toMatch(/STALE ON PURPOSE/);
  });

  it("points at itself rather than read_data_table for content", () => {
    // read_data_table answers with every row there is. That is the shape this
    // tool exists to stop being the only option.
    expect(setup().descriptions.get("list_data_table_rows")!).toContain(
      "PREFER THIS OVER read_data_table",
    );
  });
});

describe("the company draft can be walked back (axonity-flow#1388)", () => {
  it("discards without a version, because a discard is a recovery", async () => {
    const { server, handlers, descriptions } = fakeServer();
    const client = fakeClient();
    registerCompanyTools(server as never, client as unknown as AxonityClient);

    await handlers.get("discard_company_draft")!({});
    expect(client.post).toHaveBeenCalledWith("/api/v1/company/discard-draft");

    // The refusal an author will actually meet: nothing published means the
    // draft is the only copy of that work, and resetting it would destroy it.
    const d = descriptions.get("discard_company_draft")!;
    expect(d).toMatch(/422/);
    expect(d).toMatch(/NEVER BEEN PUBLISHED/);
  });
});
