/**
 * The Database entity (axonity-flow #2444, R0b, epic #2429) and the two reads
 * over the model: `GET /model/gaps` and `GET /model/overview`.
 *
 * Covered by Jonathan on 16/11 ("Dekken in deze PR"), because the snapshot of
 * Flow `main` after Levenscyclus R3 holds twenty routes of them and
 * `completeness.test.ts` allows no route without a decision.
 *
 * A database is the one versioned kind that Levenscyclus did NOT bring onto the
 * archive of §7 (`ENTITY-LIFECYCLE-CONTRACT.md` §4.9): it has no `archivedAt`,
 * no archive or unarchive route and no door to the Trash; it is archived with
 * its own `status`. So these tests read the pinned schema and say the same: the
 * family comes from the registrar (one `EntityDef`), no `archive_*` tool exists
 * for it, and its sentences do not borrow the archive's.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ENTITIES, registerAll } from "../src/index.js";

const snapshot = JSON.parse(
  readFileSync(new URL("./fixtures/openapi.snapshot.json", import.meta.url), "utf8"),
) as {
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<
      string,
      {
        properties?: Record<string, { enum?: string[]; description?: string }>;
        enum?: string[];
      }
    >;
  };
};
const schemas = snapshot.components.schemas;

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function surface() {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const shapes = new Map<string, Record<string, z.ZodTypeAny>>();
  const client = {
    get: vi.fn(async () => ({ ok: true })),
    post: vi.fn(async () => ({ ok: true })),
    put: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
  };
  registerAll(
    {
      tool: (
        name: string,
        d: string,
        s: Record<string, z.ZodTypeAny>,
        h: Handler,
      ) => {
        handlers.set(name, h);
        descriptions.set(name, d);
        shapes.set(name, s);
      },
    } as never,
    client as never,
  );
  return { handlers, descriptions, shapes, client };
}

const BASE = "/api/v1/table-databases";
const def = () => ENTITIES.find((e) => e.singular === "table_database");

describe("the Database entity comes from the registrar", () => {
  it("is one EntityDef on the routes the schema has, with no archive of its own", () => {
    const e = def();
    expect(e, "table_database in ENTITIES").toBeDefined();
    expect(e!.basePath).toBe(BASE);
    // §4.9: no marker, no archive route, no Trash door — and the test says so
    // from the schema, so the day the backend adds them this fails loudly.
    expect(`${BASE}/{entity_id}/archive` in snapshot.paths).toBe(false);
    expect(`${BASE}/{database_id}/archive` in snapshot.paths).toBe(false);
    expect(e!.archivable).toBeFalsy();
    expect(e!.statusRetired).toBeFalsy();
    expect(e!.restoreRename).toBeFalsy();
  });

  it("registers the whole family and no archive tool", () => {
    const { descriptions } = surface();
    for (const name of [
      "list_table_databases",
      "read_table_database",
      "create_table_database",
      "update_table_database",
      "delete_table_database",
      "restore_table_database",
      "list_deleted_table_databases",
      "discard_table_database_draft",
      "request_publish_table_database",
    ]) {
      expect(descriptions.has(name), name).toBe(true);
    }
    expect(descriptions.has("archive_table_database")).toBe(false);
    expect(descriptions.has("unarchive_table_database")).toBe(false);
  });

  it("has version tools on the published path the schema has", () => {
    const { descriptions } = surface();
    expect(`${BASE}/{database_id}/versions/published` in snapshot.paths).toBe(true);
    expect(descriptions.has("list_table_database_versions")).toBe(true);
    expect(descriptions.has("read_table_database_published")).toBe(true);
  });
});

describe("the list is a page, and every parameter arrives", () => {
  it("forwards kind, limit and cursor to the route", async () => {
    const { handlers, client, shapes } = surface();
    expect(Object.keys(shapes.get("list_table_databases")!).sort()).toEqual([
      "cursor",
      "kind",
      "limit",
    ]);
    await handlers.get("list_table_databases")!({ kind: "shared", limit: 5, cursor: "c1" });
    expect(client.get).toHaveBeenCalledWith(BASE, { kind: "shared", limit: 5, cursor: "c1" });
  });

  it("takes the filters the route declares and no other", () => {
    const op = snapshot.paths[BASE].get as { parameters: { name: string }[] };
    expect(op.parameters.map((p) => p.name).sort()).toEqual(["cursor", "kind", "limit"]);
  });

  it("says it is a page, that archived databases are in it and that each row has a status", () => {
    const d = surface().descriptions.get("list_table_databases")!;
    expect(d).toMatch(/ONE PAGE/);
    expect(d).toMatch(/hasMore/);
    expect(d).toMatch(/archived/i);
    expect(d).toMatch(/`status`/);
    // Not the archive's sentence: there is no `archivedAt` on a database.
    expect(d).not.toMatch(/archivedAt/);
    expect(d).not.toMatch(/`archived` is `include`/);
  });
});

describe("writes", () => {
  it("update is a PUT with the expected version in the body", async () => {
    const { handlers, client } = surface();
    await handlers.get("update_table_database")!({
      id: "d-1",
      expectedVersion: 3,
      fields: { owner: "Finance" },
    });
    expect(client.put).toHaveBeenCalledWith(`${BASE}/d-1`, {
      expectedVersion: 3,
      owner: "Finance",
    });
  });

  it("delete sends the version as `expectedVersion`, the spelling the route has", async () => {
    const op = snapshot.paths[`${BASE}/{database_id}`].delete as {
      parameters: { name: string }[];
    };
    expect(op.parameters.map((p) => p.name)).toContain("expectedVersion");
    const { handlers, client } = surface();
    await handlers.get("delete_table_database")!({ id: "d-1", expectedVersion: 2, confirm: true });
    expect(client.del).toHaveBeenCalledWith(`${BASE}/d-1`, { expectedVersion: 2 });
  });

  it("create and update name the kinds, and `status` as the way to archive", () => {
    const { descriptions } = surface();
    const kinds = schemas.CreateTableDatabaseRequest.properties!.kind.enum!;
    expect(kinds).toEqual(["data_model", "shared", "workspace"]);
    for (const tool of ["create_table_database", "update_table_database"]) {
      const d = descriptions.get(tool)!;
      for (const k of kinds) expect(d, `${tool} names ${k}`).toContain(k);
      expect(d, tool).toMatch(/`status`/);
      expect(d, tool).toMatch(/`archived`/);
    }
    const statuses = schemas.UpdateTableDatabaseRequest.properties!.status as unknown as {
      anyOf: { enum?: string[] }[];
    };
    expect(statuses.anyOf.find((x) => x.enum)!.enum).toEqual(["active", "archived"]);
  });

  it("says a database holds no list of tables: a table moves on the table", () => {
    const d = surface().descriptions.get("update_table_database")!;
    expect(d).toMatch(/update_data_table/);
    expect(d).toMatch(/`databaseId`/);
  });

  it("says what the backend refuses: a name or slug taken, a system database", () => {
    const d = surface().descriptions.get("create_table_database")!;
    expect(d).toMatch(/unique/i);
    expect(d).toMatch(/slug/);
    expect(surface().descriptions.get("update_table_database")!).toMatch(/system database/i);
  });

  it("delete says only an empty database goes, and is not the Trash", () => {
    const d = surface().descriptions.get("delete_table_database")!;
    expect(d).toMatch(/empty/i);
    expect(d).toMatch(/409/);
    expect(d).toMatch(/update_data_table/);
    // §4.9: not a Trash kind, so no promise that list_trash shows it.
    expect(d).not.toMatch(/goes to the Trash/);
    expect(d).toMatch(/not in the Trash/);
    expect(d).toMatch(/list_deleted_table_databases/);
    expect(d).toMatch(/restore_table_database/);
  });

  it("the other kinds still say their delete goes to the Trash", () => {
    const { descriptions } = surface();
    expect(descriptions.get("delete_skill")!).toMatch(/Trash, see list_trash/);
    expect(descriptions.get("delete_data_table")!).toMatch(/Trash, see list_trash/);
  });
});

describe("the model reads", () => {
  it("read_model_gaps calls GET /model/gaps", async () => {
    const { handlers, client, shapes } = surface();
    expect(Object.keys(shapes.get("read_model_gaps")!)).toEqual([]);
    await handlers.get("read_model_gaps")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/model/gaps");
  });

  it("read_model_overview calls GET /model/overview", async () => {
    const { handlers, client, shapes } = surface();
    expect(Object.keys(shapes.get("read_model_overview")!)).toEqual([]);
    await handlers.get("read_model_overview")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/model/overview");
  });

  it("the gaps description names every check the schema has, and what each answer carries", () => {
    const d = surface().descriptions.get("read_model_gaps")!;
    const codes = schemas.GapCheck.properties!.code.enum!;
    expect(codes).toHaveLength(5);
    for (const c of codes) expect(d, c).toContain(c);
    for (const key of Object.keys(schemas.GapCheck.properties!)) {
      expect(d, `GapCheck.${key}`).toContain(key);
    }
    expect(d).toContain("firing");
  });

  it("the overview description names every layer the schema counts", () => {
    const d = surface().descriptions.get("read_model_overview")!;
    for (const key of Object.keys(schemas.OverviewResponse.properties!)) {
      expect(d, `OverviewResponse.${key}`).toContain(key);
    }
  });

  it("both say they need the Insights module", () => {
    const { descriptions } = surface();
    for (const t of ["read_model_gaps", "read_model_overview"]) {
      expect(descriptions.get(t)!, t).toMatch(/Insights/);
    }
  });
});
