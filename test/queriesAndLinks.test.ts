import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerAll } from "../src/index.js";

/**
 * axonity-mcp#91, #92 and #93 — the half of the semantic layer the connector
 * could not reach.
 *
 * #91: a table's rows come from a published query now, and the connector had
 * no query tools — a table could be made and never given its filler. #92: a
 * concept points at ONE thing; the links that let a word reach every column
 * that means it had no tool. #93: publishing a semantic layer in one request
 * needs its kinds in request_publish_bulk, and a dashboard's absence needs a
 * reason an agent can read.
 *
 * Pinned here: each tool reaches the route the platform declares, with the
 * body it expects, and the descriptions say what an agent would otherwise
 * learn from a 422.
 */

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

function setup() {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const schemas = new Map<string, Record<string, { description?: string }>>();
  const server = {
    tool: (
      name: string,
      description: string,
      schema: Record<string, { description?: string }>,
      handler: (a: never) => Promise<ToolResult>,
    ) => {
      handlers.set(name, handler as Handler);
      descriptions.set(name, description);
      schemas.set(name, schema);
    },
  };
  const client = {
    get: vi.fn(async () => ({ ok: true })),
    post: vi.fn(async () => ({ ok: true })),
    put: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
  };
  registerAll(server as never, client as unknown as AxonityClient);
  return { handlers, descriptions, schemas, client };
}

describe("a query is an entity of its own (#91)", () => {
  it("gets the whole family, publish request and versions included", () => {
    const { handlers } = setup();
    for (const name of [
      "list_queries",
      "read_query",
      "create_query",
      "update_query",
      "delete_query",
      "restore_query",
      "list_deleted_queries",
      "discard_query_draft",
      "request_publish_query",
      "list_query_versions",
      "read_query_published",
      "ensure_query_major_version",
      "create_query_major_version",
      "test_query",
      "read_query_usage",
      "list_query_live_versions",
    ]) {
      expect(handlers.has(name), name).toBe(true);
    }
  });

  it("list_queries pages and narrows by source", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_queries")!({ dataSourceId: "s1", limit: 5 });
    expect(client.get).toHaveBeenCalledWith("/api/v1/queries", {
      dataSourceId: "s1",
      limit: 5,
      cursor: undefined,
    });
  });

  it("create_query posts the fields as they are", async () => {
    const { handlers, client } = setup();
    const fields = {
      name: "plan_revenue",
      dataSourceId: "s1",
      sql: "select 2026 as year, 100 as amount",
      grain: "One row per year",
    };
    await handlers.get("create_query")!({ fields });
    expect(client.post).toHaveBeenCalledWith("/api/v1/queries", fields);
  });

  it("update_query sends the lock with the change", async () => {
    const { handlers, client } = setup();
    await handlers.get("update_query")!({
      id: "q1",
      expectedVersion: 4,
      fields: { grain: "One row per year per line" },
    });
    expect(client.put).toHaveBeenCalledWith("/api/v1/queries/q1", {
      expectedVersion: 4,
      grain: "One row per year per line",
    });
  });

  it("delete_query sends the lock in the camelCase spelling the route declares", async () => {
    const { handlers, client } = setup();
    await handlers.get("delete_query")!({ id: "q1", expectedVersion: 2 });
    expect(client.del).toHaveBeenCalledWith("/api/v1/queries/q1", {
      expectedVersion: 2,
    });
  });

  it("request_publish_query goes through the approval queue, never the publish route", async () => {
    const { handlers, client } = setup();
    await handlers.get("request_publish_query")!({ id: "q1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/publish-approvals", {
      entityType: "query",
      entityId: "q1",
    });
  });

  it("test_query posts the values, and an empty set when none are given", async () => {
    const { handlers, client } = setup();
    await handlers.get("test_query")!({ id: "q1", values: { land: "BE" }, maxRows: 10 });
    expect(client.post).toHaveBeenCalledWith("/api/v1/queries/q1/test", {
      values: { land: "BE" },
      maxRows: 10,
    });
    await handlers.get("test_query")!({ id: "q2" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/queries/q2/test", { values: {} });
  });

  it("read_query_usage and list_query_live_versions read the query's own routes", async () => {
    const { handlers, client } = setup();
    await handlers.get("read_query_usage")!({ id: "q1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/queries/q1/usage");
    await handlers.get("list_query_live_versions")!({ id: "q1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/queries/q1/live-versions");
  });

  it("create_query says what a query is made of and that it can carry its own figures", () => {
    const { descriptions } = setup();
    const text = descriptions.get("create_query")!;
    for (const field of ["dataSourceId", "sql", "grain", "parameters", "returns", "questions"]) {
      expect(text).toMatch(new RegExp(`\`${field}\``));
    }
    expect(text).toMatch(/test_query/);
    expect(text).toMatch(/fillingQueryId/);
    // Dog Chef's plan figures: a query with no table behind it.
    expect(text).toMatch(/union all/);
  });

  it("update_query warns that the lists are replaced whole", () => {
    const { descriptions } = setup();
    expect(descriptions.get("update_query")).toMatch(/replaced\s+WHOLE/);
  });
});

describe("a word reaches everything it means (#92)", () => {
  it("list_concept_links reads from either side", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_concept_links")!({ concept: "Net revenue" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/concept-links", {
      concept: "Net revenue",
      refersTo: undefined,
    });
    await handlers.get("list_concept_links")!({ refersTo: "column:orders.net" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/concept-links", {
      concept: undefined,
      refersTo: "column:orders.net",
    });
  });

  it("link_concept posts the word, the target and a note only when there is one", async () => {
    const { handlers, client } = setup();
    await handlers.get("link_concept")!({
      concept: "Net revenue",
      refersTo: "column:orders.net",
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/concept-links", {
      concept: "Net revenue",
      refersTo: "column:orders.net",
    });
    await handlers.get("link_concept")!({
      concept: "Net revenue",
      refersTo: "query:plan_revenue.amount",
      note: "the plan, not the actuals",
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/concept-links", {
      concept: "Net revenue",
      refersTo: "query:plan_revenue.amount",
      note: "the plan, not the actuals",
    });
  });

  it("unlink_concept deletes by word and target in the query string", async () => {
    const { handlers, client } = setup();
    await handlers.get("unlink_concept")!({
      concept: "Net revenue",
      refersTo: "column:orders.net",
    });
    expect(client.del).toHaveBeenCalledWith("/api/v1/concept-links", {
      concept: "Net revenue",
      refersTo: "column:orders.net",
    });
  });

  it("the descriptions say why links exist and how they go live", () => {
    const { descriptions, schemas } = setup();
    const link = descriptions.get("link_concept")!;
    expect(link).toMatch(/points at one thing/);
    expect(link).toMatch(/concept_links/);
    expect(link).toMatch(/request_publish_data_table/);
    // A concept's own reference now names the link tool and the query form.
    const refersTo = schemas.get("create_concept")!.refersTo.description;
    expect(refersTo).toMatch(/link_concept/);
    expect(refersTo).toMatch(/query:plan_revenue/);
  });
});

describe("a semantic layer goes live in one request (#93)", () => {
  it("request_publish_bulk says measures, tables and queries are in, and why a dashboard is not", () => {
    const { descriptions } = setup();
    const text = descriptions.get("request_publish_bulk")!;
    expect(text).toMatch(/measures, data tables and\s+queries/);
    expect(text).toMatch(/DASHBOARD IS NOT HERE/);
    expect(text).toMatch(/no draft/);
  });
});
