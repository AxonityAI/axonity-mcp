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
});
