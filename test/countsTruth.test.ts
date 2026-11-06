import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { ENTITIES, registerAll } from "../src/index.js";
import { CONVENTIONS, MEASURE_FORMULA_SECTION } from "../src/tools/conventions.js";

/**
 * Every count and every enumeration of tools, entities or lists that the
 * README, the guide or a tool description states, held against the thing it
 * counts (review 12 of #107). A count kept by hand went wrong twice in this
 * PR alone ("these ten entities" after persona left; "Twelve entities"
 * without query). So each sentence below is either derived from the
 * registration (ENTITIES, the registered tools) or from the pinned schema,
 * or it names its members and its number word must equal how many it names.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const README = read("../README.md");
const snapshot = JSON.parse(read("./fixtures/openapi.snapshot.json")) as {
  paths: Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
  components: {
    schemas: Record<string, { properties?: Record<string, { enum?: string[] }> }>;
  };
};

const WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
];
const word = (n: number) => WORDS[n];

function tools() {
  const descriptions = new Map<string, string>();
  const shapes = new Map<string, Record<string, { options?: string[] }>>();
  const client = { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() };
  registerAll(
    {
      tool: (name: string, d: string, s: Record<string, { options?: string[] }>) => {
        descriptions.set(name, d);
        shapes.set(name, s);
      },
    } as never,
    client as never,
  );
  return { descriptions, shapes };
}

const pluralOf = (e: { singular: string; plural?: string }) => e.plural ?? `${e.singular}s`;
const family = ENTITIES.filter((e) => e.publishable !== false);
const withoutDrafts = ENTITIES.filter((e) => e.publishable === false);

/** The paragraph of `text` that starts at `marker`, up to the next blank line. */
function paragraph(text: string, marker: string): string {
  const start = text.indexOf(marker);
  expect(start, `"${marker}" is in the text`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n\n", start);
  return text.slice(start, end < 0 ? undefined : end);
}

describe("README: the entity families come from ENTITIES", () => {
  it("names every paged list of the family in the one-page exception, and only those", () => {
    const paged = family.filter((e) => e.listPaging).map((e) => `list_${pluralOf(e)}`);
    expect(paged.length).toBeGreaterThan(0);
    const exception = paragraph(README, "Exception:");
    const named = [...exception.matchAll(/`(list_[a-z_]+)`/g)].map((m) => m[1]);
    expect(named.sort()).toEqual([...paged].sort());
  });

  it("names the entities without drafts, with the right number word", () => {
    const m = README.match(/([A-Z][a-z]+) more entities use the same verbs \*\*without\*\* the draft ones —\s*\*\*([^*]+)\*\*/);
    expect(m).not.toBeNull();
    const listed = m![2].split(/,\s*/).map((x) => x.trim()).sort();
    expect(listed).toEqual(withoutDrafts.map((e) => e.singular).sort());
    expect(m![1].toLowerCase()).toBe(word(listed.length));
  });
});

describe("the guide's delete section counts nothing it would have to keep", () => {
  it("states the rule for every entity with delete and restore, without a list or a number", () => {
    const start = CONVENTIONS.indexOf("## Delete is recoverable");
    const end = CONVENTIONS.indexOf("\n## ", start + 1);
    const section = CONVENTIONS.slice(start, end);
    expect(section).not.toMatch(/these (ten|nine|\w+) entities/);
    expect(section).not.toMatch(/applies uniformly to workflow, agent/);
    // Every entity whose delete it describes really has delete and restore.
    const names = new Set(tools().descriptions.keys());
    for (const e of ENTITIES.filter((x) => x.deleteVersionParam)) {
      expect(names.has(`delete_${e.singular}`), e.singular).toBe(true);
      expect(names.has(`restore_${e.singular}`), e.singular).toBe(true);
    }
  });
});

describe("the authoring spec's lists are the response's lists", () => {
  const lists = Object.keys(
    snapshot.components.schemas.WorkflowOperationsResponse.properties ?? {},
  ).filter((k) => k !== "rulesVersion");

  it("get_workflow_authoring_spec names every list, with the right number word", () => {
    const d = tools().descriptions.get("get_workflow_authoring_spec")!;
    for (const list of lists) expect(d, list).toContain(`\`${list}\``);
    const m = d.match(/([A-Z][a-z]+) lists come back/);
    expect(m).not.toBeNull();
    expect(m![1].toLowerCase()).toBe(word(lists.length));
    expect(d).not.toMatch(/The other (\w+) lists/);
  });

  it("the guide names every list, and the hash covers the whole answer", () => {
    const spec = paragraph(CONVENTIONS, "- **Start by reading the spec.**");
    for (const list of lists) expect(spec, list).toContain(`\\\`${list}\\\``.replace(/\\/g, ""));
    expect(CONVENTIONS).not.toMatch(/returns FOUR\s+lists/);
    expect(CONVENTIONS).not.toMatch(/content hash over all four lists/);
    expect(CONVENTIONS).toMatch(/content hash over the whole\s+answer/);
  });

  it("the README names every list, and the hash covers all of them", () => {
    const spec = paragraph(README, "- `get_workflow_authoring_spec`");
    for (const list of lists) expect(spec, list).toContain(`\`${list}\``);
    expect(spec).not.toMatch(/content hash over all (four|seven|\w+) —/);
    expect(spec).toMatch(/content hash over\s+all of them/);
  });

  it("the value vocabularies the guide counts are lists the response carries", () => {
    for (const list of ["parameterTypes", "outputKinds", "schemaFieldKinds", "tableColumnKinds"]) {
      expect(lists).toContain(list);
    }
    expect(CONVENTIONS).toMatch(/FOURTH vocabulary beside the three for\s+parameters, outputs and schema fields/);
  });
});

describe("sentences that name their members carry the right number", () => {
  it("the four analysis tools (README and guide) are registered, and four", () => {
    const names = new Set(tools().descriptions.keys());
    const readme = paragraph(README, "- **The four analysis tools are the exception:**");
    const guide = paragraph(CONVENTIONS, "3. Validate before publish:");
    for (const text of [readme, guide]) {
      const listed = [...new Set([...text.matchAll(/`(validate_tool_code|format_tool_code|validate_workflow|analyze_workflow_reachable_outputs)/g)].map((m) => m[1]))];
      expect(listed.length).toBe(4);
      for (const t of listed) expect(names.has(t), t).toBe(true);
    }
    expect(readme).toMatch(/The four analysis tools/);
    expect(guide).toMatch(/These four save nothing/);
  });

  it("the three agent read-backs are the agent link routes that take a workflow", () => {
    const readBacks = Object.entries(snapshot.paths).filter(
      ([path, ops]) =>
        path.startsWith("/api/v1/agents/{agent_id}/") &&
        (ops.get?.parameters ?? []).some((p) => p.in === "query" && p.name === "workflow_id"),
    );
    expect(word(readBacks.length)).toBe("three");
    expect(README).toMatch(/The three agent read-backs take an/);
    expect(CONVENTIONS).toMatch(/The three agent read-backs also take/);
    const names = new Set(tools().descriptions.keys());
    for (const t of ["list_agent_skills", "list_agent_policies", "list_agent_reference_docs"]) {
      expect(names.has(t), t).toBe(true);
    }
  });

  it("the two policy gates are the activation fields the platform takes", () => {
    const gate = Object.keys(
      snapshot.components.schemas.ActivationGateRequest.properties ?? {},
    ).sort();
    expect(gate).toEqual(["delegation", "tools"]);
    expect(CONVENTIONS).toMatch(/The two\s+surviving gates, \\`activation\.tools\\` and \\`activation\.delegation\\`|The two\s+surviving gates, `activation\.tools` and `activation\.delegation`/);
  });

  it("write_application_knowledge's 'all three' kinds are the schema's kinds", () => {
    const kinds =
      snapshot.components.schemas.WriteKnowledgeRequest.properties?.kind?.enum ?? [];
    expect(word(kinds.length)).toBe("three");
    const { shapes } = tools();
    const found = [...shapes.values()]
      .map((s) => s.kind as unknown as { _def?: { innerType?: { options?: string[] } } })
      .map((k) => k?._def?.innerType?.options)
      .filter((o): o is string[] => Array.isArray(o) && o.includes("lesson"));
    expect(found.length).toBeGreaterThan(0);
    for (const options of found) expect([...options].sort()).toEqual([...kinds].sort());
    const described = [...shapes.values()]
      .map((s) => (s.kind as unknown as { description?: string } | undefined)?.description ?? "")
      .filter((d) => d.includes("Omit for all"));
    for (const d of described) expect(d).toMatch(new RegExp(`Omit for all ${word(kinds.length)}`));
  });

  it("a concept's 'five forms' are the five prefixes it lists", () => {
    const d = [...tools().shapes.values()]
      .map((s) => (s.refersTo as unknown as { description?: string } | undefined)?.description)
      .find((x) => x?.includes("in one of"));
    expect(d).toBeDefined();
    const prefixes = new Set([...d!.matchAll(/`([a-z]+):/g)].map((m) => m[1]));
    const m = d!.match(/in one of (\w+) forms/);
    expect(m![1]).toBe(word(prefixes.size));
  });

  it("list_data_table_tools' three flags are fields of the answer", () => {
    const fields = Object.keys(
      snapshot.components.schemas.DataTableToolSummary.properties ?? {},
    );
    for (const f of ["offered", "toolId", "isLive"]) expect(fields).toContain(f);
    expect(tools().descriptions.get("list_data_table_tools")).toMatch(/READ THE THREE FLAGS/);
  });

  it("the measure kinds are counted from the kinds the text names", () => {
    const start = MEASURE_FORMULA_SECTION.indexOf("**Four kinds, one grammar.**");
    expect(start).toBeGreaterThanOrEqual(0);
    const named = MEASURE_FORMULA_SECTION.slice(
      start,
      MEASURE_FORMULA_SECTION.indexOf("**Time runs over one date table.**"),
    );
    const kinds = [...named.matchAll(/\*\*(Base|Derived|Time|cumulative)\*\*/g)].map((m) => m[1]);
    expect(kinds.length).toBe(4);
  });
});

describe("review 13 of #107: the guide's paged lists, the plan's count, the generator's pointer", () => {
  it("the guide names every paged library list where it calls list_data_tables paged", () => {
    const paged = family.filter((e) => e.listPaging).map((e) => `list_${pluralOf(e)}`)
      .filter((t) => t !== "list_data_tables");
    const from = CONVENTIONS.indexOf("is PAGED**");
    expect(from).toBeGreaterThanOrEqual(0);
    const sentence = CONVENTIONS.slice(from, CONVENTIONS.indexOf("Page one", from));
    expect(sentence).not.toMatch(/alone among the library lists/);
    for (const t of paged) expect(sentence, t).toContain(t);
  });

  it("the plan's correction counts the facts it lists", () => {
    const plan = read("../docs/epic-1-plan.md");
    const start = plan.indexOf("## Correction — 2026-11-06");
    const section = plan.slice(start, plan.indexOf("\n## ", start + 1));
    const bullets = section.split("\n").filter((l) => l.startsWith("- **")).length;
    const m = section.match(/([A-Z][a-z]+) facts below were true when written/);
    expect(m).not.toBeNull();
    expect(m![1].toLowerCase()).toBe(word(bullets));
  });

  it("the generated list filters point at the test that really regenerates them", () => {
    const generated = read("../src/generated/listFilters.ts");
    const pointed = [...generated.matchAll(/`(test\/[A-Za-z]+\.test\.ts)`/g)].map((m) => m[1]);
    expect(pointed.length).toBeGreaterThan(0);
    for (const file of pointed) {
      const body = read(`../${file}`);
      expect(body, file).toMatch(/list filters are generated, not kept/);
    }
  });
});

describe("review 14 of #107: archive state and the contract's kinds, from the schema and the recording", () => {
  /** Entities whose update body takes a `status` that can be `archived`. */
  const archivable = (): string[] => {
    const schemas = snapshot.components.schemas as Record<
      string,
      { properties?: Record<string, { enum?: string[]; anyOf?: { enum?: string[] }[]; description?: string }> }
    >;
    const pascal = (e: string) => e.split("_").map((x) => x[0].toUpperCase() + x.slice(1)).join("");
    return ENTITIES.map((e) => e.singular)
      .filter((e) => {
        const body = schemas[`Update${pascal(e)}Request`] ?? schemas[`Update${pascal(e)}V2Request`];
        const status = body?.properties?.status;
        if (!status) return false;
        const values = [...(status.enum ?? []), ...(status.anyOf ?? []).flatMap((a) => a.enum ?? [])];
        return values.includes("archived") || /`archived`/.test(status.description ?? "");
      })
      .sort();
  };

  it("the delete section names exactly the entities that also have an archived status", () => {
    const start = CONVENTIONS.indexOf("## Delete is recoverable");
    const section = CONVENTIONS.slice(start, CONVENTIONS.indexOf("\n## ", start + 1));
    expect(section).not.toMatch(/There is no "archive" state/);
    const bullet = section.slice(section.indexOf("- Deleting is not archiving."));
    const named = [...bullet.slice(0, bullet.indexOf("\n- ") > 0 ? bullet.indexOf("\n- ") : undefined)
      .matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((x) => ENTITIES.some((e) => e.singular === x));
    expect(named.sort()).toEqual(archivable());
  });

  it("does not call runs the only thing with an archive state", () => {
    expect(CONVENTIONS).not.toMatch(/Runs are the only thing with a real archive state/);
    expect(CONVENTIONS).not.toMatch(/Runs are the one exception with a true archive/);
  });

  it("get_entity_authoring_contract and the README name exactly the kinds the route serves", () => {
    const recorded = JSON.parse(read("./fixtures/entity-contracts.tool-conditional_trigger.json")) as {
      kinds: string[];
    };
    const kinds = [...recorded.kinds].sort();
    const d = tools().descriptions.get("get_entity_authoring_contract")!;
    const inTool = d.slice(0, d.indexOf("Answers `{ kinds"));
    const fromTool = [...new Set([...inTool.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]))]
      .filter((k) => !["implementation"].includes(k)).sort();
    expect(fromTool).toEqual(kinds);
    const readme = paragraph(README, "- `get_entity_authoring_contract`");
    const head = readme.slice(0, readme.indexOf("read live from"));
    const fromReadme = [...new Set([...head.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]))]
      .filter((k) => k !== "get_entity_authoring_contract").sort();
    expect(fromReadme).toEqual(kinds);
  });

  it("the guide's field-shape exception names every place a spec lives", () => {
    const shape = paragraph(CONVENTIONS, "## Field shape");
    for (const place of ["schemaBody", "contract.output_validators", "answerContract.validators"]) {
      expect(shape, place).toContain(place);
    }
  });
});

describe("the create_<entity> example fields are fields of that create body (review 14 of #107)", () => {
  it("every key in a create tool's `fields` example is a property of the route's request schema", () => {
    const paths = snapshot.paths as Record<
      string,
      { post?: { requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> } } }
    >;
    const schemas = snapshot.components.schemas;
    const { shapes } = tools();
    const checked: string[] = [];
    for (const e of ENTITIES.filter((x) => x.creatable !== false)) {
      const shape = shapes.get(`create_${e.singular}`);
      if (!shape) continue;
      const described =
        (shape.fields as unknown as { description?: string } | undefined)?.description ?? "";
      const example = described.match(/e\.g\. (\{[^}]*\})/)?.[1];
      expect(example, e.singular).toBeDefined();
      const keys = [...example!.matchAll(/"([A-Za-z]+)":/g)].map((m) => m[1]);
      const ref = paths[e.basePath]?.post?.requestBody?.content?.["application/json"]?.schema?.$ref;
      expect(ref, `${e.singular}: POST ${e.basePath} has a body schema`).toBeDefined();
      const props = Object.keys(schemas[ref!.split("/").pop()!]?.properties ?? {});
      for (const k of keys) expect(props, `${e.singular}.${k}`).toContain(k);
      checked.push(e.singular);
    }
    expect(checked).toContain("agent");
    expect(checked.length).toBeGreaterThan(10);
  });
});

