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

