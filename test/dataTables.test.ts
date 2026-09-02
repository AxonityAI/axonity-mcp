import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerConventions } from "../src/tools/conventions.js";
import { registerDataTableTools } from "../src/tools/dataTables.js";
import { registerAll } from "../src/index.js";
import { forbids } from "./denyList.js";

/**
 * axonity-mcp#63 — the connector knows tables exist.
 *
 * A table (axonity-flow#1217) is the same category of thing as an output
 * schema, and its routes were written in the same order and spelling, so most
 * of what is asserted here is that the GENERIC family arrived: eleven version
 * tools, the lifecycle verbs, the publish request. Those need pinning only
 * shallowly — the registrar is already covered by `register.test.ts`.
 *
 * What earns detail is the three places a table is NOT generic, because each
 * one is a way an agent could be quietly wrong:
 *
 *   1. the list is PAGED, and page one is not the library (#37);
 *   2. `rows` is a whole-collection field, so the generic update can destroy a
 *      table's content while looking like an append;
 *   3. a table's derived tools follow its PUBLISHED version, so a grant that
 *      was saved and not published has granted nothing.
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

function body(r: ToolResult): Record<string, unknown> {
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

describe("a table is an entity like the others", () => {
  it("registers the whole generic family", () => {
    const { handlers } = setup();
    for (const name of [
      "list_data_tables",
      "read_data_table",
      "create_data_table",
      "update_data_table",
      "delete_data_table",
      "restore_data_table",
      "list_deleted_data_tables",
      "discard_data_table_draft",
      "request_publish_data_table",
    ]) {
      expect(handlers.has(name), `${name} is not registered`).toBe(true);
    }
  });

  it("registers the version family — eleven routes that came free", () => {
    const { handlers } = setup();
    for (const name of [
      "list_data_table_versions",
      "read_data_table_version",
      "read_data_table_published",
      "restore_data_table_version",
      "delete_data_table_version",
      "list_deleted_data_table_versions",
      "restore_deleted_data_table_version",
      "create_data_table_major_version",
      "name_data_table_major_version",
      "ensure_data_table_major_version",
    ]) {
      expect(handlers.has(name), `${name} is not registered`).toBe(true);
    }
  });

  it("deletes with the snake_case lock the route declares", async () => {
    const { handlers, client } = setup();
    await handlers.get("delete_data_table")!({
      id: "t-1",
      expectedVersion: 3,
      confirm: true,
    });
    // Not `expectedVersion` — the two spellings are a real backend
    // inconsistency and a table is on the memory-entity side of it.
    expect(client.del).toHaveBeenCalledWith("/api/v1/data-tables/t-1", {
      expected_version: 3,
    });
  });

  it("asks the approval queue to publish, never the publish route", async () => {
    const { handlers, client } = setup();
    await handlers.get("request_publish_data_table")!({ id: "t-1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/publish-approvals", {
      entityType: "data_table",
      entityId: "t-1",
    });
  });

  it("has the two direct-publish routes already forbidden", () => {
    // Item 3 of #63 asked for an exclusion; the standing `direct version
    // publish` rule turned out to cover both routes the moment they existed,
    // because a table's version routes are spelled exactly like every other
    // entity's. That is the boundary working as designed rather than a gap —
    // and it is worth an assertion, because "no rule was added" and "no rule
    // applies" look identical in a diff.
    expect(
      forbids("POST", "/api/v1/data-tables/t-1/versions/publish/2"),
      "a table could be published directly",
    ).toBe(true);
    expect(
      forbids("POST", "/api/v1/data-tables/t-1/versions/unpublish"),
      "a table could be unpublished directly",
    ).toBe(true);
    // The row writes are NOT publishing and must stay reachable.
    expect(forbids("POST", "/api/v1/data-tables/t-1/rows")).toBe(false);
  });
});

describe("list_data_tables answers ONE PAGE and says so (#37)", () => {
  it("forwards limit and cursor to the backend", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_data_tables")!({
      limit: 200,
      cursor: "MjAyNi0wOS0wMlQxMTo0NDoyNSswMDowMHwxYzJk",
    });

    const [path, params] = client.get.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/api/v1/data-tables");
    expect(params.limit).toBe(200);
    expect(params.cursor).toBe("MjAyNi0wOS0wMlQxMTo0NDoyNSswMDowMHwxYzJk");
  });

  it("sends the three generated filters under the spelling the route declares", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_data_tables")!({
      name: "Pricing bands",
      status: "active",
      isDynamic: false,
    });

    const [, params] = client.get.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.name).toBe("Pricing bands");
    expect(params.status).toBe("active");
    // camelCase argument, snake_case wire — the inconsistency the generator
    // exists to keep out of the caller's head.
    expect(params.is_dynamic).toBe(false);
  });

  it("forwards the page envelope WHOLE — hasMore and nextCursor survive", async () => {
    const page = {
      items: [{ id: "t-1", name: "Pricing bands", rowCount: 42 }],
      nextCursor: "MjAyNi0wOS0wMlQxMTo0NDoyNSswMDowMHwxYzJk",
      pageSize: 20,
      hasMore: true,
    };
    const { handlers } = setup(async () => page);

    // Unwrapping to `items` would rebuild the silent truncation one layer up:
    // the agent would hold a one-row array with nothing saying more exist.
    const result = body(await handlers.get("list_data_tables")!({}));
    expect(result).toEqual(page);
    expect(result.hasMore).toBe(true);
  });

  it("states it is a page, the size, the cap, and how to get the rest", () => {
    const { descriptions } = setup();
    const d = descriptions.get("list_data_tables")!;

    expect(d).toMatch(/ONE PAGE/);
    expect(d).toMatch(/nextCursor/);
    expect(d).toMatch(/hasMore/);
    expect(d).toMatch(/\b20\b/);
    expect(d).toMatch(/200/);
    // The filters are the affordable way out of a walk, so the description
    // points at them rather than leaving paging as the only answer.
    expect(d).toMatch(/FILTER/);
  });

  it("leaves every OTHER entity list unpaged", async () => {
    // The registrar grew a paging branch for tables. Every sibling list is
    // `# paging-exempt` on the backend and must keep calling its route exactly
    // as before — a `limit`/`cursor` on a route that does not read them is a
    // filter an agent would trust.
    const { handlers, descriptions, client } = setup();
    await handlers.get("list_output_schemas")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/output-schemas");
    expect(descriptions.get("list_output_schemas")!).not.toMatch(/ONE PAGE/);

    // And one that DOES have filters still sends only those.
    client.get.mockClear();
    await handlers.get("list_agents")!({ includeSystem: true });
    const [, params] = client.get.mock.calls[0] as [string, Record<string, unknown>];
    expect(params).not.toHaveProperty("cursor");
    expect(params).not.toHaveProperty("limit");
  });
});

describe("row writes cannot destroy the table (#63 item 5)", () => {
  it("appends one row without resending the others", async () => {
    const { handlers, client } = setup();
    await handlers.get("add_data_table_row")!({
      id: "t-1",
      values: { region: "Benelux", owner: "Ines" },
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/data-tables/t-1/rows", {
      values: { region: "Benelux", owner: "Ines" },
    });
  });

  it("edits the one row a match addresses, match in the query", async () => {
    const { handlers, client } = setup();
    await handlers.get("update_data_table_row")!({
      id: "t-1",
      matchColumn: "region",
      matchValue: "Benelux",
      changes: { owner: "Ines" },
    });
    expect(client.patch).toHaveBeenCalledWith(
      "/api/v1/data-tables/t-1/rows",
      { changes: { owner: "Ines" } },
      { match_column: "region", match_value: "Benelux" },
    );
  });

  it("deletes the one row a match addresses", async () => {
    const { handlers, client } = setup();
    await handlers.get("delete_data_table_row")!({
      id: "t-1",
      matchColumn: "region",
      matchValue: "Benelux",
      confirm: true,
    });
    expect(client.del).toHaveBeenCalledWith("/api/v1/data-tables/t-1/rows", {
      match_column: "region",
      match_value: "Benelux",
    });
  });

  it("warns on update_data_table that `rows` replaces everything", () => {
    const { descriptions } = setup();
    const d = descriptions.get("update_data_table")!;

    // The generic `fields` bag is untyped by design, so nothing stops an agent
    // passing `rows` meaning "add this one". The warning is the minimum, and
    // it must name the tools that do the safe thing.
    expect(d).toMatch(/REPLACES/);
    expect(d).toMatch(/add_data_table_row/);
  });

  it("leaves the warning off entities that have no such field", () => {
    const { descriptions } = setup();
    expect(descriptions.get("update_output_schema")!).not.toMatch(/REPLACES/);
  });
});

describe("a table's tools follow its PUBLISHED version", () => {
  it("asks the table which tools it yields", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_data_table_tools")!({ id: "t-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/data-tables/t-1/tools");
  });

  it("keeps offered / toolId / isLive apart in its description", () => {
    const { descriptions } = setup();
    const d = descriptions.get("list_data_table_tools")!;

    // Collapsing the three is how "I ticked 'may add rows' and there is no
    // tool" becomes a mystery, so the description has to separate them.
    expect(d).toMatch(/offered/);
    expect(d).toMatch(/toolId/);
    expect(d).toMatch(/isLive/);
    expect(d).toMatch(/published/i);
  });

  it("says the same thing in the authoring guide", async () => {
    const handlers = new Map<string, () => Promise<ToolResult>>();
    registerConventions({
      tool: (name: string, _d: string, _s: unknown, h: () => Promise<ToolResult>) =>
        handlers.set(name, h),
    } as never);
    const guide = (await handlers.get("axonity_conventions")!()).content[0].text;

    expect(guide).toMatch(/## Tables/);
    // The four things an author gets wrong, in the guide rather than only in a
    // tool description an agent may never read.
    expect(guide).toMatch(/PUBLISHED table/);
    expect(guide).toMatch(/whole-collection fields/);
    expect(guide).toMatch(/OUTCOME KEY/);
    expect(guide).toMatch(/is PAGED/);
    // The vocabularies stay on the server — #48's rule.
    expect(guide).toMatch(/tableColumnKinds/);
    expect(guide).toMatch(/decisionEvaluators/);
  });
});

describe("the row tools are registered as a set", () => {
  it("registers all four", () => {
    const handlers = new Map<string, Handler>();
    registerDataTableTools(
      {
        tool: (name: string, _d: string, _s: unknown, h: (a: never) => Promise<ToolResult>) =>
          handlers.set(name, h as Handler),
      } as never,
      { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() } as unknown as AxonityClient,
    );
    expect([...handlers.keys()].sort()).toEqual([
      "add_data_table_row",
      "delete_data_table_row",
      "list_data_table_tools",
      "update_data_table_row",
    ]);
  });
});
