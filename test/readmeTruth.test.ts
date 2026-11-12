import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The README says what the tools and the guide say (review 10 of #107). The
 * corrections #107 made in src/ — the persona as a field of the agent
 * (axonity-flow#2176), the four fillers of a table and what versioning
 * decides, the document route of validate_workflow judging against the
 * catalog and the stored route needing the `author` scope — must not survive
 * in their old form here, where a person reads them first.
 */
const README = readFileSync(
  fileURLToPath(new URL("../README.md", import.meta.url)),
  "utf8",
);

describe("the README carries no claim #107 corrected", () => {
  it("has no persona entity and no generic persona tools", () => {
    expect(README).not.toMatch(/persona, output_schema, prompt_snippet/);
    expect(README).not.toMatch(/`persona` has no `create_persona`/);
    expect(README).not.toMatch(/Everything else about\s+a persona \(list, read, update/);
    expect(README).toMatch(/the agent's `persona` field/);
  });

  it("names the four fillers, and ties dynamic to versioning", () => {
    expect(README).toMatch(/`author`, `workflow`, `query` or `source`/);
    expect(README).not.toMatch(/Only a table filled by\s+a query or a workflow is dynamic/);
    expect(README).toMatch(/`versioning`/);
  });

  it("does not call validate_workflow stateless or catalog-free, and names the scope", () => {
    const row = README.split("\n").find((l) => l.startsWith("| `validate_workflow` |")) ?? "";
    expect(row).not.toMatch(/Stateless/i);
    expect(row).not.toMatch(/does not verify referenced agents\/tools exist/);
    expect(README).not.toMatch(/four stateless analysis tools are the exception/);
    expect(README).toMatch(/`validate_workflow\(\{ workflowId \}\)`[^.]*`author` scope/);
  });

  // One pin per corrected place (review 11 of #107): each turns red when only
  // that place goes back to its old wording.
  it("intro: the agent carries its persona; personas are not a listed entity", () => {
    expect(README).toMatch(/\*\*workflows, agents \(with their persona\), tools,/);
    expect(README).not.toMatch(/reference docs,\s+personas, output schemas/);
  });

  it("contract kinds: agents with their persona, not personas", () => {
    expect(README).toMatch(/entity kind\*\* \(`tool` with each type's implementation, `agent` with its\s+persona,/);
    expect(README).not.toMatch(/agents, personas,\s+knowledge/);
  });

  it("tables: a measure reads every table whose rows Flow holds", () => {
    expect(README).toMatch(/a measure reads every table whose\s+rows Flow holds/);
    expect(README).not.toMatch(/only a dynamic table can be read by\s+a measure/);
  });

  it("the validate_workflow row itself names the author scope", () => {
    const row = README.split("\n").find((l) => l.startsWith("| `validate_workflow` |")) ?? "";
    expect(row).toMatch(/By `workflowId`:[^|]*needs a token with the `author` scope/);
  });

  it("release: the agents it runs, each with its persona", () => {
    expect(README).toMatch(/the agents it runs \(each with its\s+persona\), their tools, the flows it pins/);
    expect(README).not.toMatch(/their tools and\s+personas, the flows it pins/);
  });

  it("the generic entity family is exactly the entities registered with drafts and publication", async () => {
    // Derived from the registration, not kept by hand (review 11 of #107):
    // every `request_publish_<entity>` the registrar mints, minus the three
    // that are not an entity of the family (bulk, release, company).
    const { registerAll } = await import("../src/index.js");
    const names: string[] = [];
    registerAll({ tool: (n: string) => names.push(n) } as never, {} as never);
    const family = names
      .filter((n) => n.startsWith("request_publish_"))
      .map((n) => n.slice("request_publish_".length))
      .filter((n) => !["bulk", "release", "company"].includes(n))
      .sort();

    const match = README.match(/([A-Z][a-z]+) entities — \*\*([^*]+)\*\* —/);
    expect(match, "the README names the family").not.toBeNull();
    const listed = match![2].split(/,\s*/).map((x) => x.trim()).sort();
    expect(listed).toEqual(family);
    const words = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
      "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen"];
    expect(match![1]).toBe(words[family.length]);
  });

  // Review 13 of #107: every README sentence about a tool this PR changed.
  it("list_conversations: one dashboard takes status, the dates and q; includeArchived is the one refusal", () => {
    const para = README.slice(README.indexOf("**Testing the Dashboard Analyst.**"));
    const text = para.slice(0, para.indexOf("`start_conversation`"));
    expect(text).not.toMatch(/no\s+other filter/);
    expect(text).not.toMatch(/No route combines a dashboard with those\s+filters/);
    expect(text).not.toMatch(/text of its question cannot be filtered on/);
    expect(text).toMatch(/for one dashboard \(`dashboardId`, with `status`,\s+`createdAfter`\/`createdBefore` and `q`/);
    expect(text).toMatch(/`includeArchived` with a dashboard, and `q` without one/);
  });

  it("the read-only guardrail names the scopes the backend checks", () => {
    expect(README).not.toMatch(/without the `write` scope is refused/);
    expect(README).toMatch(/without the `author` scope is refused with a 403/);
  });

  it("the narrowing list is the generated list filters, tool by tool", async () => {
    const { LIST_FILTERS } = await import("../src/generated/listFilters.js");
    const { ENTITIES } = await import("../src/index.js");
    const plural = new Map(ENTITIES.map((e) => [e.singular, e.plural ?? `${e.singular}s`]));
    const block = README.slice(
      README.indexOf("Some list routes narrow in the query"),
      README.indexOf("That table is **generated**"),
    );
    const listed = new Map(
      [...block.matchAll(/`(list_[a-z_]+)\(\{ ([^}]*) \}\)`/g)].map((m) => [
        m[1],
        m[2].split(",").map((a) => a.trim().replace(/\?$/, "")).sort(),
      ]),
    );
    const expected = new Map(
      Object.entries(LIST_FILTERS).map(([entity, filters]) => [
        `list_${plural.get(entity) ?? `${entity}s`}`,
        [...new Set(filters.map((f) => f.arg))].sort(),
      ]),
    );
    expect(Object.fromEntries(listed)).toEqual(Object.fromEntries(expected));
  });

  it("the paged library lists are named where the README calls list_data_tables paged", async () => {
    const { ENTITIES } = await import("../src/index.js");
    const paged = ENTITIES.filter((e) => e.publishable !== false && e.listPaging)
      .map((e) => `list_${e.plural ?? `${e.singular}s`}`)
      .filter((t) => t !== "list_data_tables");
    const line = README.slice(README.indexOf("- `list_data_tables` is **paged**"));
    const sentence = line.slice(0, line.indexOf("Page one"));
    expect(sentence).not.toMatch(/alone among the/);
    for (const t of paged) expect(sentence, t).toContain(`\`${t}\``);
  });
});


/**
 * Review of 4347f84: the README says of the to-do list and the wake-tasks what
 * the tools now say — list_todo_steps is not "the same question" as
 * read_run_waiting_on, it takes `agentId`, and an open question is found on
 * the to-do list, not among a run's wake-tasks.
 */
describe("the README says what list_todo_steps and read_run_waiting_on are", () => {
  it("does not call list_todo_steps the same question, and names agentId", () => {
    expect(README).not.toMatch(/`list_todo_steps`\*\* is the same question/);
    const start = README.indexOf("**`list_todo_steps`**");
    expect(start).toBeGreaterThanOrEqual(0);
    const paragraph = README.slice(start, README.indexOf("\n\n", start));
    expect(paragraph).toContain("`agentId`");
    expect(paragraph).toMatch(/wake-tasks/);
  });

  it("finds a parked step on the to-do list, not among the wake-tasks", () => {
    const start = README.indexOf("**A run can park rather than finish.**");
    expect(start).toBeGreaterThanOrEqual(0);
    const paragraph = README.slice(start, README.indexOf("\n\n", start));
    expect(paragraph).not.toMatch(/`read_run_waiting_on` says what it is\s+waiting for/);
    expect(paragraph).toMatch(/`list_todo_steps`/);
  });
});
