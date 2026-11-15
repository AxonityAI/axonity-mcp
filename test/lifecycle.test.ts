/**
 * Levenscyclus (R3 of agent-first): archive as its own act, one Trash, and a
 * restore that can take a new name.
 *
 * What is held here, and against what:
 *   - WHICH kinds can be archived, and which restore with a `name`, is read from
 *     the pinned OpenAPI schema (the routes the backend really mounts), never
 *     from a list kept in this file. A kind the backend adds arrives as a red
 *     test, not as a silent gap.
 *   - Every parameter reaches the wire (Zod drops an unknown key without a
 *     word, so each one is asserted to arrive).
 *   - The sentences an agent reads say what the backend validates; each one is
 *     pinned by a phrase from the backend's own message, with its source in
 *     `af-levenscyclus.md` (R3 stap j).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { ENTITIES, registerAll } from "../src/index.js";
import { forbids } from "./denyList.js";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

type Operation = {
  requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
  parameters?: { name: string; in: string }[];
};
const snapshot = JSON.parse(read("./fixtures/openapi.snapshot.json")) as {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<
      string,
      { properties?: Record<string, unknown>; additionalProperties?: unknown }
    >;
  };
};

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

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

const paths = Object.keys(snapshot.paths);

/** The kinds whose collection has `POST {base}/{entity_id}/archive` on the backend. */
const archiveKinds = ENTITIES.filter((e) =>
  paths.includes(`${e.basePath}/{entity_id}/archive`),
);

/** The kinds whose restore route takes a body (`name`) on the backend. */
const takesRestoreBody = (op: Operation): boolean =>
  JSON.stringify(op.requestBody ?? null).includes("#/components/schemas/RestoreEntityRequest");
const renamingKinds = ENTITIES.filter((e) =>
  paths.some(
    (p) =>
      p.startsWith(`${e.basePath}/{`) &&
      p.endsWith("}/restore") &&
      takesRestoreBody(snapshot.paths[p].post),
  ),
);

const pluralOf = (e: { singular: string; plural?: string }) => e.plural ?? `${e.singular}s`;

describe("which kinds are archivable is what the backend mounts", () => {
  it("every archive route of the schema belongs to a kind the connector covers", () => {
    const routes = paths.filter((p) => p.endsWith("/{entity_id}/archive"));
    const covered = archiveKinds.map((e) => `${e.basePath}/{entity_id}/archive`);
    expect(routes.sort()).toEqual(covered.sort());
    expect(archiveKinds.length).toBe(15);
  });

  it("each of them has archive_ and unarchive_, and no other kind has", () => {
    const { handlers } = surface();
    for (const e of ENTITIES) {
      const expected = archiveKinds.includes(e);
      expect(handlers.has(`archive_${e.singular}`), `archive_${e.singular}`).toBe(expected);
      expect(handlers.has(`unarchive_${e.singular}`), `unarchive_${e.singular}`).toBe(expected);
    }
  });

  it("archive and unarchive POST the item's own route with no body", async () => {
    const { handlers, client } = surface();
    for (const e of archiveKinds) {
      client.post.mockClear();
      await handlers.get(`archive_${e.singular}`)!({ id: "id-1" });
      expect(client.post).toHaveBeenCalledWith(`${e.basePath}/id-1/archive`);
      client.post.mockClear();
      await handlers.get(`unarchive_${e.singular}`)!({ id: "id-1" });
      expect(client.post).toHaveBeenCalledWith(`${e.basePath}/id-1/unarchive`);
    }
  });

  it("a person's id is never turned into a path segment of something else", async () => {
    const { handlers, shapes } = surface();
    for (const e of archiveKinds) {
      expect(Object.keys(shapes.get(`archive_${e.singular}`)!)).toEqual(["id"]);
      expect(Object.keys(shapes.get(`unarchive_${e.singular}`)!)).toEqual(["id"]);
    }
    expect(handlers.size).toBeGreaterThan(0);
  });
});

describe("every list of an archivable kind takes `archived`", () => {
  it("the schema declares it on each list route, and the tool sends it", async () => {
    const { handlers, shapes, client } = surface();
    for (const e of archiveKinds) {
      const declared = (snapshot.paths[e.basePath].get.parameters ?? []).map((p) => p.name);
      expect(declared, e.singular).toContain("archived");
      const tool = `list_${pluralOf(e)}`;
      expect(Object.keys(shapes.get(tool)!), tool).toContain("archived");
      client.get.mockClear();
      await handlers.get(tool)!({ archived: "only" });
      const call = client.get.mock.calls[0] as unknown as [string, Record<string, unknown>];
      expect(call[0]).toBe(e.basePath);
      expect(call[1].archived, tool).toBe("only");
    }
  });

  it("the list description says what is left out by default, and where an archived row shows", () => {
    const { descriptions } = surface();
    for (const e of archiveKinds) {
      const d = descriptions.get(`list_${pluralOf(e)}`)!;
      expect(d, e.singular).toMatch(/Archived items are left out/);
      expect(d, e.singular).toMatch(/`archivedAt`/);
      // `status` is gone from the rows of these lists, so it cannot be promised.
      expect(d, e.singular).not.toMatch(/\bstatus\b/);
    }
  });

  it("list_data_tables no longer offers the retired `status` filter", () => {
    const { shapes } = surface();
    expect(Object.keys(shapes.get("list_data_tables")!)).not.toContain("status");
  });
});

describe("restore takes a new name on exactly the kinds whose name is unique", () => {
  it("the nine kinds are read from the routes that take a body", () => {
    expect(renamingKinds.map((e) => e.singular).sort()).toEqual([
      "application",
      "data_source",
      "data_table",
      "measure",
      "output_schema",
      "policy",
      "query",
      "reference_doc",
      "skill",
    ]);
  });

  it("only those restore tools have a `name`", () => {
    const { shapes } = surface();
    for (const e of ENTITIES.filter((x) => x.deleteVersionParam)) {
      const keys = Object.keys(shapes.get(`restore_${e.singular}`)!);
      expect(keys.includes("name"), e.singular).toBe(renamingKinds.includes(e));
    }
  });

  it("a name arrives in the body; without one there is no body at all", async () => {
    const { handlers, client } = surface();
    for (const e of renamingKinds) {
      client.post.mockClear();
      await handlers.get(`restore_${e.singular}`)!({ id: "i-1", name: "New name" });
      expect(client.post).toHaveBeenCalledWith(`${e.basePath}/i-1/restore`, { name: "New name" });
      client.post.mockClear();
      await handlers.get(`restore_${e.singular}`)!({ id: "i-1" });
      expect(client.post).toHaveBeenCalledWith(`${e.basePath}/i-1/restore`);
    }
  });

  it("the body the backend takes is `name` alone and refuses anything else", () => {
    const op = snapshot.paths["/api/v1/skills/{skill_id}/restore"].post;
    expect(takesRestoreBody(op)).toBe(true);
    const schema = snapshot.components.schemas.RestoreEntityRequest;
    expect(Object.keys(schema.properties!)).toEqual(["name"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("the sentence for it names the backend's refusal and does not promise it everywhere", () => {
    const { descriptions } = surface();
    for (const e of renamingKinds) {
      const d = descriptions.get(`restore_${e.singular}`)!;
      expect(d, e.singular).toMatch(/Restore it again with a new name/);
      expect(d, e.singular).toMatch(/`name`/);
    }
    for (const e of ENTITIES.filter((x) => x.deleteVersionParam && !renamingKinds.includes(x))) {
      const d = descriptions.get(`restore_${e.singular}`)!;
      expect(d, e.singular).not.toMatch(/`name`/);
    }
  });
});

describe("a restored item that was archived is still archived", () => {
  it("every restore says so, once", () => {
    const { descriptions } = surface();
    for (const e of archiveKinds.filter((x) => x.deleteVersionParam)) {
      const d = descriptions.get(`restore_${e.singular}`)!;
      expect(d.match(/still archived/g)?.length, e.singular).toBe(1);
    }
  });
});

describe("update: an archived item is not edited, and `status` is not written", () => {
  /** The ten kinds whose update body had a writable `status` (the plan's list). */
  const TEN = [
    "agent", "application", "data_table", "measure", "output_schema",
    "policy", "query", "reference_doc", "skill", "tool",
  ];

  /** An update body that refuses unknown keys and has no `status`. */
  const refusesStatus = (e: { singular: string }): boolean => {
    const pascal = e.singular
      .split("_")
      .map((x) => x[0].toUpperCase() + x.slice(1))
      .join("");
    const schemas = snapshot.components.schemas;
    const body = schemas[`Update${pascal}Request`] ?? schemas[`Update${pascal}V2Request`];
    return (
      body !== undefined && body.additionalProperties === false && !("status" in (body.properties ?? {}))
    );
  };

  it("each of the ten has a strict update body without a status", () => {
    for (const k of TEN) {
      const e = ENTITIES.find((x) => x.singular === k)!;
      expect(refusesStatus(e), k).toBe(true);
    }
  });

  it("the registration flags exactly those ten", () => {
    expect(ENTITIES.filter((e) => e.statusRetired).map((e) => e.singular).sort()).toEqual(TEN);
  });

  it("every archivable kind's update says an archived item is refused", () => {
    const { descriptions } = surface();
    for (const e of archiveKinds) {
      const d = descriptions.get(`update_${e.singular}`)!;
      expect(d, e.singular).toMatch(/is archived\. Unarchive it first/);
      expect(d, e.singular).toContain(`unarchive_${e.singular}`);
    }
  });

  it("the ten say where the status went", () => {
    const { descriptions } = surface();
    for (const k of TEN) {
      const d = descriptions.get(`update_${k}`)!;
      expect(d, k).toMatch(/`status` is refused/);
      expect(d, k).toContain(`archive_${k}`);
    }
  });

  it("the others never mention a status", () => {
    const { descriptions } = surface();
    for (const e of ENTITIES.filter((x) => !TEN.includes(x.singular))) {
      expect(descriptions.get(`update_${e.singular}`)!, e.singular).not.toMatch(
        /`status` is refused/,
      );
    }
  });
});

describe("archive: what the backend refuses, said before the call", () => {
  it("archive_ names the three refusals and that it is idempotent", () => {
    const { descriptions } = surface();
    for (const e of archiveKinds) {
      const d = descriptions.get(`archive_${e.singular}`)!;
      expect(d, e.singular).toMatch(/Only a draft can be archived/);
      expect(d, e.singular).toMatch(/a person unpublishes it in Axonity/);
      expect(d, e.singular).toMatch(/changed: false/);
      expect(d, e.singular).toContain(`unarchive_${e.singular}`);
    }
  });

  it("only the kinds whose delete has a guard promise the in-use refusal", () => {
    const { descriptions } = surface();
    const inUse = ["agent", "workflow", "tool", "output_schema", "data_table", "measure", "data_source"];
    for (const e of archiveKinds) {
      const d = descriptions.get(`archive_${e.singular}`)!;
      expect(/same words as delete_/.test(d), e.singular).toBe(inUse.includes(e.singular));
      expect(/A locked/.test(d), e.singular).toBe(e.singular === "prompt_snippet");
    }
  });

  it("unarchive is never refused for what is in use", () => {
    const { descriptions } = surface();
    for (const e of archiveKinds) {
      expect(descriptions.get(`unarchive_${e.singular}`)!, e.singular).toMatch(
        /back in use, in the state it had/,
      );
    }
  });

  it("archiving touches the marker only, not the version history", () => {
    const { descriptions } = surface();
    for (const e of archiveKinds) {
      expect(descriptions.get(`archive_${e.singular}`)!, e.singular).toMatch(
        /versions and the publication are not touched/,
      );
    }
  });
});

describe("the Trash", () => {
  it("list_trash reads GET /trash and sends kind, limit and cursor", async () => {
    const { handlers, client, shapes } = surface();
    expect(Object.keys(shapes.get("list_trash")!).sort()).toEqual(["cursor", "kind", "limit"]);
    await handlers.get("list_trash")!({ kind: "skill", limit: 5, cursor: "c-1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/trash", {
      kind: "skill",
      limit: 5,
      cursor: "c-1",
    });
  });

  it("list_trash carries the paging contract: a page, not the whole Trash", () => {
    const { descriptions } = surface();
    const d = descriptions.get("list_trash")!;
    expect(d).toMatch(/ONE PAGE/);
    expect(d).toMatch(/nextCursor/);
    expect(d).toMatch(/restorePath/);
    expect(d).toMatch(/carriedBy/);
  });

  it("trash_summary reads GET /trash/summary", async () => {
    const { handlers, client } = surface();
    await handlers.get("trash_summary")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/trash/summary");
  });

  it("there is no tool that deletes permanently, and the rule says why", () => {
    const { handlers } = surface();
    expect([...handlers.keys()].filter((n) => /permanent|purge|empty_trash/i.test(n))).toEqual([]);
    expect(forbids("DELETE", "/api/v1/trash/{kind}/{item_id}")).toBe(true);
    expect(forbids("GET", "/api/v1/trash")).toBe(false);
    expect(forbids("GET", "/api/v1/trash/summary")).toBe(false);
  });

  it("the retention setting is a platform route and stays closed", () => {
    expect(forbids("PATCH", "/api/v1/platform/trash-retention")).toBe(true);
    expect(forbids("GET", "/api/v1/platform/trash-retention")).toBe(true);
  });

  it("the schema has the shape the description names", () => {
    const { schemas } = snapshot.components as unknown as {
      schemas: Record<string, { properties?: Record<string, unknown> }>;
    };
    expect(Object.keys(schemas.TrashItem.properties!)).toEqual(
      expect.arrayContaining(["kind", "id", "name", "deletedAt", "deletedBy", "restorePath", "carriedBy"]),
    );
    expect(Object.keys(schemas.TrashSummaryResponse.properties!)).toEqual(
      expect.arrayContaining(["kinds", "total", "retentionDays", "canDeletePermanently"]),
    );
  });
});

describe("the guide's sentence about archiving", () => {
  it("no longer says `status` is set with update_*", () => {
    const conventions = read("../src/tools/conventions.ts");
    expect(conventions).not.toMatch(/set with[\s\\`]*update_/);
    expect(conventions).toMatch(/archive_\*/);
  });
});
