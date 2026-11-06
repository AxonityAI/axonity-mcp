import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerAll } from "../src/index.js";
import { CONVENTIONS } from "../src/tools/conventions.js";

/**
 * What fills a table is an enum on the platform (`filledBy`), and the
 * connector quotes it in prose in three places: create/update_data_table,
 * refresh_data_table's refusal, and the guide's Tables section. The refresh
 * after axonity-flow#2176 brought a fourth value (`source`, with `external`)
 * that none of the three named, while the generated list filter did — one
 * build, two lists. These tests pin every quoted list to the schema's enum, so
 * the next value cannot be missed in one place and not the other.
 */

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/openapi.snapshot.json", import.meta.url)),
    "utf8",
  ),
) as {
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<
      string,
      {
        properties?: Record<
          string,
          { enum?: string[]; anyOf?: { enum?: string[] }[] }
        >;
        required?: string[];
      }
    >;
  };
};

const create = snapshot.components.schemas.CreateDataTableRequest;
const fields = new Set(Object.keys(create.properties ?? {}));
const enumOf = (prop: string): string[] => {
  const p = create.properties?.[prop];
  return p?.enum ?? p?.anyOf?.find((a) => a.enum)?.enum ?? [];
};
const FILLERS = enumOf("filledBy");

function descriptions(): Map<string, string> {
  const found = new Map<string, string>();
  const server = { tool: (name: string, d: string) => found.set(name, d) };
  const client = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
  };
  registerAll(server as never, client as unknown as AxonityClient);
  return found;
}

/**
 * Backticked values in `text` that are not field names of the create body.
 * A value that is ALSO a field name (`source` is both a filler and the field
 * saying who authored the table) still counts as a value.
 */
const quotedValues = (text: string): string[] =>
  [...new Set([...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]))].filter(
    (token) => !fields.has(token) || FILLERS.includes(token),
  );

/** The paragraph of `text` that starts at `marker`, up to the next blank line. */
const paragraph = (text: string, marker: string): string => {
  const start = text.indexOf(marker);
  expect(start, `"${marker}" is in the text`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n\n", start);
  return text.slice(start, end < 0 ? undefined : end);
};

describe("every list of what fills a table is the schema's filledBy (S1, review of #107)", () => {
  it("the schema's list has the source filler, and external with it", () => {
    expect(FILLERS).toEqual(["author", "workflow", "query", "source"]);
    expect(fields.has("external")).toBe(true);
  });

  it.each(["create_data_table", "update_data_table"])(
    "%s quotes every filler, and no other value, where it says what fills it",
    (tool) => {
      const d = descriptions().get(tool)!;
      const fills = paragraph(d, "WHAT FILLS IT");
      expect(quotedValues(fills).sort()).toEqual([...FILLERS].sort());
    },
  );

  it.each(["create_data_table", "update_data_table"])(
    "%s says what a source table needs: external with its three keys, and grain",
    (tool) => {
      const d = descriptions().get(tool)!;
      const place = snapshot.components.schemas.ExternalPlacePayload;
      expect(d).toContain("`external`");
      for (const key of place.required ?? []) expect(d, key).toContain(`\`${key}\``);
      expect(d).toContain("`grain`");
    },
  );

  it.each(["create_data_table", "update_data_table"])(
    "%s quotes every value of versioning",
    (tool) => {
      const d = descriptions().get(tool)!;
      const versioning = enumOf("versioning");
      expect(versioning.length).toBeGreaterThan(1);
      // The paragraph that defines it ("`versioning` — …"), not a mention of it.
      const line = paragraph(d, "`versioning` — ");
      expect(quotedValues(line).filter((v) => !FILLERS.includes(v)).sort()).toEqual(
        [...versioning].sort(),
      );
    },
  );

  it("refresh_data_table's refusal names every filler but query", () => {
    const d = descriptions().get("refresh_data_table")!;
    const refusal = paragraph(d, "Refused with a 422");
    expect(quotedValues(refusal).sort()).toEqual(FILLERS.filter((f) => f !== "query").sort());
  });

  it("the guide's Tables section quotes every filler and no longer names isDynamic", () => {
    const start = CONVENTIONS.indexOf("## Tables");
    const end = CONVENTIONS.indexOf("\n## ", start + 1);
    const tables = CONVENTIONS.slice(start, end);
    expect(tables).not.toContain("isDynamic");
    const who = paragraph(tables, "**Who fills it");
    expect(quotedValues(who).filter((v) => FILLERS.includes(v)).sort()).toEqual(
      [...FILLERS].sort(),
    );
  });
});

describe("what is read live follows from versioning, not from filledBy (K1, final review of #107)", () => {
  const sentences = (text: string): string[] =>
    text.split(/(?<=\.)\s+/).map((x) => x.trim()).filter(Boolean);

  it("the schema lets an author's table be live", () => {
    const description =
      (create.properties?.versioning as { description?: string } | undefined)?.description ?? "";
    expect(description).toMatch(/Only `author` may be `config` or `live`/);
  });

  it.each(["create_data_table", "update_data_table"])(
    "%s ties isDynamic and how a measure reads to versioning",
    (tool) => {
      const all = sentences(descriptions().get(tool)!);
      const dynamic = all.filter((x) => x.includes("isDynamic"));
      expect(dynamic.length, "it still says what isDynamic became").toBeGreaterThan(0);
      for (const x of dynamic) {
        expect(x, "isDynamic follows from versioning").toContain("`versioning`");
        expect(x).not.toMatch(/follows from\s+`filledBy`/);
      }
      const published = all.filter((x) => x.includes("AS PUBLISHED"));
      expect(published.length).toBeGreaterThan(0);
      for (const x of published) expect(x, "read as published = config").toContain("`config`");
      const now = all.filter((x) => /read as they are now/.test(x) && !x.startsWith("`versioning`"));
      expect(now.length).toBeGreaterThan(0);
      for (const x of now) expect(x, "read as they are now = live").toContain("`live`");
    },
  );
});

describe("update_data_table names every clear* field the platform takes (review of #107)", () => {
  const update = snapshot.components.schemas.UpdateDataTableRequest;
  const clears = Object.keys(update.properties ?? {}).filter((k) => k.startsWith("clear"));

  it("the schema has the clear fields this guards", () => {
    expect(clears).toEqual(
      expect.arrayContaining(["clearExternal", "clearGrain", "clearFillingQuery", "clearRhythm"]),
    );
  });

  it.each(clears)("%s is named, with what it takes away", (field) => {
    const d = descriptions().get("update_data_table")!;
    expect(d).toMatch(new RegExp("`" + field + ": true` takes"));
  });
});

describe("the clear fields say where the platform takes them (review of #107)", () => {
  const update = snapshot.components.schemas.UpdateDataTableRequest as {
    properties?: Record<string, { description?: string }>;
  };
  const sentence = (text: string, needle: string): string => {
    const all = text.split(/(?<=\.)\s+|,\s+(?=`clear)|\s+and\s+(?=`clear)/);
    const found = all.find((x) => x.includes(needle));
    expect(found, `a sentence with ${needle}`).toBeDefined();
    return found!;
  };

  it("the schema requires a place and a grain on a source table", () => {
    // source_tables.external_errors / grain_errors on axonity-flow main.
    expect(create.properties?.external).toBeDefined();
    expect((update.properties?.grain?.description ?? "")).toMatch(/Required when filledBy is `source`/);
    expect(
      (snapshot.components.schemas.CreateDataTableRequest.properties?.external as { description?: string })
        ?.description ?? "",
    ).toMatch(/Required when filledBy is `source`, refused otherwise/);
  });

  it("clearExternal works only together with a filler other than source", () => {
    const d = descriptions().get("update_data_table")!;
    const x = sentence(d, "`clearExternal: true`");
    expect(x).toContain("`filledBy`");
    expect(x).toMatch(/other than `source`/);
  });

  it("clearGrain is refused on a source table", () => {
    const d = descriptions().get("update_data_table")!;
    const x = sentence(d, "`clearGrain: true`");
    expect(x).toMatch(/refused on a source table/);
  });

  it("clearTimeAxis on the date table goes with its calendars (review 7 of #107)", () => {
    // data_table_service.update_table runs calendar_errors whenever time_axis
    // is in the save; a date table with calendars and no time axis is refused
    // ("The date table needs a date on its rows", domain/measures.py). It is
    // not "any table".
    const d = descriptions().get("update_data_table")!;
    const x = sentence(d, "`clearTimeAxis: true`");
    expect(x).not.toMatch(/any table/);
    expect(x).toMatch(/date table/);
    expect(x).toMatch(/`calendars: \[\]`/);
    // Unmarking the date table takes its calendars with it
    // (data_table_service.update_table), so `dateTable: false` works too.
    expect(x).toMatch(/`dateTable: false`/);
  });
});

describe("the guide's Who fills it heading lists exactly the schema's fillers (review of #107)", () => {
  it("names the four, and no other value", () => {
    const start = CONVENTIONS.indexOf("**Who fills it");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = CONVENTIONS.indexOf("\n-", start);
    const heading = CONVENTIONS.slice(start, end);
    const named = [...heading.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((v) => v !== "filledBy");
    expect(named.sort()).toEqual([...FILLERS].sort());
  });
});

describe("fillingQueryId says what the backend enforces, not what the schema text says", () => {
  // The schema's description says "Required when filledBy is `query`", but no
  // validator enforces it: on axonity-flow main a query table WITHOUT a query
  // is allowed on purpose (domain/warehouse_sync.py, filled_by_errors: "A query
  // table with NO query yet is allowed"). What is refused is a query on a table
  // another filler fills (same function), a rhythm with no query to run
  // (rhythm_errors), and a fill or refresh with none (data_table_service
  // refresh_now, warehouse_sync_service). The strictest rule is the source.
  const queryParagraph = (tool: string) =>
    paragraph(descriptions().get(tool)!, "FILLED BY A QUERY");

  it.each(["create_data_table", "update_data_table"])(
    "%s does not call fillingQueryId required, and says what needs it",
    (tool) => {
      const text = queryParagraph(tool);
      expect(text).not.toMatch(/required with `filledBy: "query"`/);
      expect(text).toMatch(/may be saved without one/);
      expect(text).toMatch(/`rhythm` without one is refused/);
      expect(text).toMatch(/refused on a table another filler fills/);
    },
  );
});

describe("the defaults FILL_NOTE states are the backend's (review 8 of #107)", () => {
  // Sources on axonity-flow main: domain/table_versioning.py
  // default_versioning_for (only an author's table defaults to config) and
  // domain/source_tables.py grain_errors (required for source, refused for
  // query). The schema's descriptions say the same; they are the anchor here.
  const describedAs = (prop: string) =>
    (create.properties?.[prop] as { description?: string } | undefined)?.description ?? "";

  it("the schema states both rules", () => {
    expect(describedAs("versioning")).toMatch(
      /Left out: `config` for an author's table, `live` for every other/,
    );
    expect(describedAs("grain")).toMatch(
      /Required when filledBy is `source`; refused when a query fills the table/,
    );
  });

  it.each(["create_data_table", "update_data_table"])(
    "%s states the versioning default on create: config for an author's table, live otherwise",
    (tool) => {
      const d = descriptions().get(tool)!;
      const line = paragraph(d, "`versioning` — ");
      expect(line).toMatch(/Left out on create: `config` for an author's table, `live` otherwise/);
    },
  );

  it("update_data_table: left out, versioning stays, unless filledBy changes (review 9 of #107)", () => {
    // data_table_service.update_table applies default_versioning_for only when
    // `versioning` is not sent AND the filler changes; otherwise the table
    // keeps what it has. The update schema says the same.
    const updateVersioning =
      (snapshot.components.schemas.UpdateDataTableRequest.properties?.versioning as
        | { description?: string }
        | undefined)?.description ?? "";
    expect(updateVersioning).toMatch(/Left out while filledBy changes: what the new filler defaults to/);
    const line = paragraph(descriptions().get("update_data_table")!, "`versioning` — ");
    expect(line).toMatch(/on an update the table keeps its versioning unless `filledBy` changes/);
    expect(line).toMatch(/then it gets the new filler's default/);
  });

  it.each(["create_data_table", "update_data_table"])(
    "%s states the grain rule: required for a source table, refused when a query fills it",
    (tool) => {
      const d = descriptions().get(tool)!;
      const line = paragraph(d, "`grain` says what one row is");
      expect(line).toMatch(/required\s+for a source table/);
      expect(line).toMatch(/refused when a query fills the table/);
    },
  );
});

