import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { CONVENTIONS } from "../src/tools/conventions.js";
import { registerValidationTools } from "../src/tools/validation.js";

/**
 * What validate_workflow says about its two routes is what axonity-flow main
 * does (review of #107).
 *
 * The document route used to be stateless and skipped every cross-entity
 * check. It no longer does: `POST /workflows/validate` judges the document
 * against the caller's own catalog, the same one the stored route uses
 * (routes/workflows.py validate_document, "It used to be stateless, and that
 * was the bug"; workflow_service.validate_document builds the catalog with or
 * without a workflow id). What the document route still skips without a
 * workflow id is the checks about that ONE workflow's own wiring: its triggers
 * and the knowledge attached to it (workflow_service._build_catalog_context).
 *
 * Tokens: a read-only service token may POST to the document route, which is
 * on the allowlist; the stored route `POST /workflows/{id}/validate` is not,
 * so it needs a token with the author scope (auth/dependencies.py,
 * _READ_ONLY_SERVICE_TOKEN_POST_ALLOWLIST).
 */

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/openapi.snapshot.json", import.meta.url)),
    "utf8",
  ),
) as { components: { schemas: Record<string, { description?: string }> } };

function tool() {
  let description = "";
  const params: Record<string, { description?: string }> = {};
  registerValidationTools(
    {
      tool: (name: string, d: string, schema: Record<string, { description?: string }>) => {
        if (name !== "validate_workflow") return;
        description = d;
        Object.assign(params, schema);
      },
    } as never,
    {} as never,
  );
  return { description, params };
}

describe("validate_workflow describes both routes as main runs them", () => {
  it("the platform judges a document against the caller's own workspace", () => {
    expect(snapshot.components.schemas.ValidateDocumentRequest.description ?? "").toMatch(
      /judged against the CALLER'S OWN workspace/,
    );
  });

  it("does not call the document route stateless or catalog-free", () => {
    const { description, params } = tool();
    const all = [description, ...Object.values(params).map((p) => p.description ?? "")].join("\n");
    expect(all).not.toMatch(/stateless/i);
    expect(all).not.toMatch(/No database/);
    expect(all).not.toMatch(/Answers catalogChecked: false/);
  });

  it("says the document is judged against the same catalog, minus the workflow's own wiring", () => {
    const { description } = tool();
    expect(description).toMatch(/against the SAME catalog/);
    // The document bullet itself must say WHICH checks fall away without the
    // id — the workflowId bullet names the same two, so a regex that also
    // matches there would stay green with this sentence gone (review 10).
    const document = description.slice(description.indexOf("- document →"));
    expect(document).toMatch(
      /Without the workflow's id the checks about one workflow's own\s+wiring — its triggers and the knowledge attached to it — are skipped/,
    );
  });

  it("says catalogChecked false means only the structure was judged", () => {
    const { description } = tool();
    expect(description).toMatch(/`catalogChecked: false`[^.]*structurally\s+sound/);
  });

  it("says which token each route takes", () => {
    const { description } = tool();
    expect(description).toMatch(/document[^\n]*read-only token/);
    expect(description).toMatch(/workflowId[^\n]*`author` scope/);
  });

  it("the guide says the same, not that the document route is stateless", () => {
    expect(CONVENTIONS).not.toMatch(/`validate_workflow\(\{ document \}\)` is stateless/);
    expect(CONVENTIONS).not.toMatch(/without a catalog it can only judge STRUCTURE/);
    expect(CONVENTIONS).toMatch(/`validate_workflow\(\{ document \}\)` judges the document against the same\s+catalog/);
    expect(CONVENTIONS).not.toMatch(/These four are stateless and work with\s+read-only tokens/);
  });
});

describe("validate_workflow's refusal says the same as its description (review 11 of #107)", () => {
  it("a call with neither or both parameters is refused without calling 'document' structural", async () => {
    const handlers = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
    const client = { post: vi.fn() };
    registerValidationTools(
      {
        tool: (name: string, _d: string, _s: unknown, h: (a: never) => Promise<unknown>) =>
          handlers.set(name, h as (a: Record<string, unknown>) => Promise<unknown>),
      } as never,
      client as never,
    );
    for (const args of [{}, { workflowId: "wf-1", document: {} }]) {
      const result = (await handlers.get("validate_workflow")!(args)) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).not.toMatch(/structural/i);
      expect(text).toMatch(/against the same catalog/);
      expect(text).toMatch(/without the checks about that workflow's own wiring/);
    }
    expect(client.post).not.toHaveBeenCalled();
  });
});

