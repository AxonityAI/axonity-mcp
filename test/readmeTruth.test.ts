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
    expect(README).toMatch(/entity kind\*\* \(tools with each type's implementation, agents with their\s+persona,/);
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
});

