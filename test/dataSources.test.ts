import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { ForbiddenError, errorForStatus } from "../src/errors.js";
import { registerAll } from "../src/index.js";

/**
 * axonity-mcp#78 — the connector knows data sources, syncs, table
 * relationships, dashboards and measures (axonity-flow#1849).
 *
 * The plain entity verbs come from the registrar, which `register.test.ts`
 * already covers; what is pinned here is what an agent would otherwise get
 * wrong:
 *
 *   1. none of the three new entities is versioned, so there must be no
 *      request_publish_* or discard_*_draft pretending there is a draft;
 *   2. a data source's `config` keys come from the driver, not from memory;
 *   3. an admin-only 403 says "administrator only", not "your token is
 *      read-only" — the opposite advice;
 *   4. each tool calls the route it claims to, with the body that route reads.
 */

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

function setup(postImpl?: () => Promise<unknown>) {
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
    get: vi.fn(async () => ({ ok: true })),
    post: vi.fn(postImpl ?? (async () => ({ ok: true }))),
    put: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
  };
  registerAll(server as never, client as unknown as AxonityClient);
  return { handlers, descriptions, client };
}

describe("the three new entities", () => {
  for (const [singular, plural] of [
    ["data_source", "data_sources"],
    ["table_relationship", "table_relationships"],
    ["dashboard", "dashboards"],
  ]) {
    it(`${singular}: the lifecycle verbs, and no draft or publish`, () => {
      const { handlers, descriptions } = setup();
      for (const name of [
        `list_${plural}`,
        `read_${singular}`,
        `create_${singular}`,
        `update_${singular}`,
        `delete_${singular}`,
        `restore_${singular}`,
        `list_deleted_${plural}`,
      ]) {
        expect(handlers.has(name), `${name} is not registered`).toBe(true);
      }
      // A change is live when saved: a publish request or a draft discard
      // would be a tool for a state that does not exist.
      expect(handlers.has(`request_publish_${singular}`)).toBe(false);
      expect(handlers.has(`discard_${singular}_draft`)).toBe(false);
      // The list is one page, and says so.
      expect(descriptions.get(`list_${plural}`)).toMatch(/ONE PAGE/);
    });
  }

  it("deletes with the snake_case version key the routes declare", async () => {
    const { handlers, client } = setup();
    await handlers.get("delete_data_source")!({ id: "s1", expectedVersion: 3, confirm: true });
    expect(client.del).toHaveBeenCalledWith("/api/v1/data-sources/s1", {
      expected_version: 3,
    });
  });

  it("create_data_source sends the agent to the drivers before it guesses", () => {
    const { descriptions } = setup();
    const text = descriptions.get("create_data_source")!;
    expect(text).toMatch(/list_data_source_drivers FIRST/);
    expect(text).toMatch(/ADMINISTRATOR ONLY/);
    expect(text).toMatch(/subjectSourceId/);
  });
});

describe("data source tools call the routes they name", () => {
  it("drivers, schema and syncs are reads", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_data_source_drivers")!({});
    await handlers.get("read_data_source_schema")!({ id: "s1" });
    await handlers.get("list_data_source_syncs")!({ id: "s1" });
    expect(client.get.mock.calls.map((c) => c[0])).toEqual([
      "/api/v1/data-sources/drivers",
      "/api/v1/data-sources/s1/schema",
      "/api/v1/data-sources/s1/syncs",
    ]);
  });

  it("test and query post to the source", async () => {
    const { handlers, client } = setup();
    await handlers.get("test_data_source")!({ id: "s1" });
    await handlers.get("query_data_source")!({ id: "s1", sql: "select 1", maxRows: 5 });
    await handlers.get("query_data_source")!({ id: "s1", sql: "select 2" });
    expect(client.post.mock.calls).toEqual([
      ["/api/v1/data-sources/s1/test"],
      ["/api/v1/data-sources/s1/query", { sql: "select 1", maxRows: 5 }],
      // No maxRows key at all when none was asked for — the platform's default.
      ["/api/v1/data-sources/s1/query", { sql: "select 2" }],
    ]);
  });

  it("a sync is created on its source, and run / stopped / restored by id", async () => {
    const { handlers, client } = setup();
    await handlers.get("create_data_source_sync")!({
      id: "s1",
      name: "orders",
      tableId: "t1",
      sql: "select * from shop.orders",
      mode: "upsert",
      keyColumns: ["order_id"],
      cronExpr: "0 6 * * *",
    });
    await handlers.get("run_data_source_sync")!({ id: "s1", syncId: "y1" });
    await handlers.get("restore_data_source_sync")!({ id: "s1", syncId: "y1" });
    await handlers.get("delete_data_source_sync")!({ id: "s1", syncId: "y1", confirm: true });

    expect(client.post.mock.calls).toEqual([
      [
        "/api/v1/data-sources/s1/syncs",
        {
          name: "orders",
          tableId: "t1",
          sql: "select * from shop.orders",
          mode: "upsert",
          keyColumns: ["order_id"],
          cronExpr: "0 6 * * *",
        },
      ],
      ["/api/v1/data-sources/s1/syncs/y1/run"],
      ["/api/v1/data-sources/s1/syncs/y1/restore"],
    ]);
    expect(client.del).toHaveBeenCalledWith("/api/v1/data-sources/s1/syncs/y1");
  });

  it("running a sync says it does not wait for the result", () => {
    const { descriptions } = setup();
    expect(descriptions.get("run_data_source_sync")).toMatch(/DOES NOT WAIT/);
  });
});

describe("measures and dashboards", () => {
  it("query_measures posts the questions as they came", async () => {
    const { handlers, client } = setup();
    const queries = [{ key: "a", tableId: "t1", measure: "revenue" }];
    await handlers.get("query_measures")!({ queries });
    expect(client.post).toHaveBeenCalledWith("/api/v1/measures/query", { queries });
  });

  it("read_measure_design reads the table's design, draft on request", async () => {
    const { handlers, client } = setup();
    await handlers.get("read_measure_design")!({ tableId: "t1", useDraft: true });
    expect(client.get).toHaveBeenCalledWith("/api/v1/measures/tables/t1", {
      useDraft: true,
    });
  });

  it("list_measure_rows and duplicate_dashboard post to their routes", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_measure_rows")!({ tableId: "t1", limit: 5 });
    await handlers.get("duplicate_dashboard")!({ id: "d1" });
    expect(client.post.mock.calls).toEqual([
      ["/api/v1/measures/rows", { tableId: "t1", limit: 5 }],
      ["/api/v1/dashboards/d1/duplicate", {}],
    ]);
  });
});

describe("an admin-only refusal is reported as one", () => {
  const body = {
    error: "forbidden",
    code: "forbidden",
    retryable: false,
    message: "Only administrators can perform this action",
  };

  it("says administrator only, not read-only token", () => {
    const err = errorForStatus(403, body);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toMatch(/ADMINISTRATOR ONLY/);
    expect(err.message).toMatch(/Only administrators can perform this action/);
    expect(err.message).not.toMatch(/read-only token/);
  });

  it("still gives the scope advice for an ordinary 403", () => {
    const err = errorForStatus(403, "This service token is read-only");
    expect(err.message).toMatch(/read-only token cannot/);
    expect(err.message).not.toMatch(/ADMINISTRATOR ONLY/);
  });

  it("reaches the agent as a tool error, not a crash", async () => {
    const { handlers } = setup(async () => {
      throw errorForStatus(403, body);
    });
    const result = await handlers.get("test_data_source")!({ id: "s1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/ADMINISTRATOR ONLY/);
  });
});

describe("create_connector names the shape headers must have", () => {
  it("lists of {key, value, enabled}, and body as {type, content}", () => {
    const { descriptions } = setup();
    for (const name of ["create_connector", "update_connector"]) {
      const text = descriptions.get(name)!;
      expect(text).toMatch(/LISTS of/);
      expect(text).toMatch(/"key"/);
      expect(text).toMatch(/"enabled"/);
      expect(text).toMatch(/"content"/);
    }
  });
});
