import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { AxonityApiError, BackendVersionSkewError } from "../src/errors.js";
import { registerAll } from "../src/index.js";
import { CONVENTIONS } from "../src/tools/conventions.js";
import {
  ENTITY_CONTRACT_ROUTE,
  ENTITY_CONTRACT_UNAVAILABLE,
  projectContract,
  readEntityContract,
} from "../src/tools/entityContract.js";
import { registerWorkflowMutations } from "../src/tools/workflowMutations.js";

/**
 * axonity-mcp#95 (and #65, #71) — what the connector says must be what the
 * platform does, and what it cannot keep in step it reads live.
 */

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function all() {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const server = {
    tool: (name: string, description: string, _s: unknown, h: (a: never) => Promise<unknown>) => {
      handlers.set(name, h as Handler);
      descriptions.set(name, description);
    },
  };
  const client = {
    get: vi.fn(async () => ({ ok: true })),
    post: vi.fn(async () => ({ ok: true })),
    put: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
  };
  registerAll(server as never, client as unknown as AxonityClient);
  return { handlers, descriptions, client };
}

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/openapi.snapshot.json", import.meta.url)),
    "utf8",
  ),
) as {
  paths: Record<string, unknown>;
  components: {
    schemas: Record<string, { properties?: Record<string, { description?: string }> }>;
  };
};

describe("a connector must declare its effect, and may answer with a file (#95)", () => {
  it("create_ and update_connector say effect is required to publish", () => {
    const { descriptions } = all();
    for (const name of ["create_connector", "update_connector"]) {
      const d = descriptions.get(name)!;
      expect(d, name).toContain("implementation.effect");
      expect(d, name).toMatch(/"reads"/);
      expect(d, name).toMatch(/"acts"/);
      expect(d, name).toMatch(/CANNOT BE\s+PUBLISHED/);
    }
  });

  it("create_ and update_connector document responseMapping type file", () => {
    const { descriptions } = all();
    for (const name of ["create_connector", "update_connector"]) {
      const d = descriptions.get(name)!;
      expect(d, name).toMatch(/"type": "file"/);
      expect(d, name).toContain("filename");
      expect(d, name).toContain("{ fileId, filename, contentType, sizeBytes }");
      expect(d, name).toMatch(/Digitize/);
      expect(d, name).toMatch(/sub-workflow/);
      expect(d, name).toContain("get_entity_authoring_contract");
    }
  });

  it("the guide's connector notes say the same", () => {
    expect(CONVENTIONS).toContain("`implementation.effect` is required to PUBLISH");
    expect(CONVENTIONS).toMatch(/"type": "file"/);
    expect(CONVENTIONS).toContain("{ fileId, filename, contentType, sizeBytes }");
  });
});

describe("the hand-kept per-entity notes are subordinate to the live contract", () => {
  it("says the live contract wins and names the tool", () => {
    expect(CONVENTIONS).toMatch(/The platform's live create contract wins/);
    expect(CONVENTIONS).toMatch(/SUBORDINATE/);
    expect(CONVENTIONS).toContain("get_entity_authoring_contract");
  });

  it("the validator section is marked subordinate too (#71)", () => {
    const at = CONVENTIONS.indexOf("## Validators — one shape, one call");
    const section = CONVENTIONS.slice(at, at + 800);
    expect(section).toContain("get_entity_authoring_contract");
    expect(section).toMatch(/SUBORDINATE/);
  });
});

describe("the validator contract in the guide is the platform's (#71)", () => {
  // The platform's OpenAPI description of `schemaBody` carries the full
  // contract. Every name the guide relies on must be in it, so a name the
  // platform drops fails here instead of going stale in the guide.
  const description =
    snapshot.components.schemas.CreateOutputSchemaRequest?.properties?.schemaBody?.description ??
    "";

  it.each([
    "`data`",
    "`slots`",
    "`binding`",
    "`field`",
    "`tool`",
    "`function`",
    "`target`",
    "`args`",
    "`inputs`",
    "`error_message`",
    "{value}",
  ])("%s is in both the guide and the platform's schemaBody description", (name) => {
    expect(description, "schemaBody lost its description — check the snapshot").not.toBe("");
    expect(description).toContain(name);
    expect(CONVENTIONS).toContain(name);
  });

  it("the standard call is spelled the same", () => {
    expect(CONVENTIONS).toContain("run(data, slots, binding)");
    expect(description).toMatch(/STANDARD CALL/);
  });
});

describe("get_entity_authoring_contract reads the platform live (#95, axonity-flow#2103)", () => {
  const client = (get: (path: string) => Promise<unknown>) =>
    ({ get: vi.fn(get) }) as unknown as AxonityClient & { get: ReturnType<typeof vi.fn> };

  it("is registered and reads the route", async () => {
    const { handlers, client: c } = all();
    expect(handlers.has("get_entity_authoring_contract")).toBe(true);
    await handlers.get("get_entity_authoring_contract")!({});
    expect(c.get).toHaveBeenCalledWith(ENTITY_CONTRACT_ROUTE);
    expect(ENTITY_CONTRACT_ROUTE).toBe("/api/v1/authoring/entity-contracts");
  });

  it("serves markdown under its rulesVersion on a 200", async () => {
    const result = (await readEntityContract(
      client(async () => ({ markdown: "## connector\n- effect required", rulesVersion: "ec-1" })),
    )) as ToolResult;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("rulesVersion `ec-1`");
    expect(result.content[0].text).toContain("## connector");
  });

  it("passes JSON through on a 200, narrowed when asked", async () => {
    const body = {
      rulesVersion: "ec-2",
      entities: { connector: { required: ["implementation.effect"] }, agent: { required: ["name"] } },
    };
    const whole = JSON.parse(
      ((await readEntityContract(client(async () => body))) as ToolResult).content[0].text,
    );
    expect(whole).toEqual(body);

    const narrowed = JSON.parse(
      ((await readEntityContract(client(async () => body), ["connector", "nope"])) as ToolResult)
        .content[0].text,
    );
    expect(narrowed.rulesVersion).toBe("ec-2");
    expect(Object.keys(narrowed.entities)).toEqual(["connector"]);
    expect(narrowed.unknownEntityTypes).toEqual(["nope"]);
  });

  it("narrows a list-shaped contract by its type key", () => {
    const out = projectContract(
      { rulesVersion: "x", entities: [{ entityType: "tool" }, { entityType: "agent" }] },
      ["agent"],
    ) as { entities: unknown[] };
    expect(out.entities).toEqual([{ entityType: "agent" }]);
  });

  it.each([
    ["404", new AxonityApiError("Not found.", 404)],
    ["404 as skew", new BackendVersionSkewError("GET", ENTITY_CONTRACT_ROUTE, 404, "axonity-flow#2103")],
    ["405", new AxonityApiError("Method not allowed.", 405)],
  ])("says plainly that this deploy does not serve it on a %s", async (_l, err) => {
    const result = (await readEntityContract(
      client(async () => {
        throw err;
      }),
    )) as ToolResult;
    expect(result.content[0].text).toBe(ENTITY_CONTRACT_UNAVAILABLE);
    expect(result.content[0].text).toMatch(/NOT AVAILABLE on this deploy/);
    expect(result.content[0].text).toMatch(/carries no copy/);
  });

  it("reports any other failure as the error it is, not as 'not served'", async () => {
    const result = (await readEntityContract(
      client(async () => {
        throw new AxonityApiError("Could not reach the Axonity API.", 0);
      }),
    )) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toMatch(/NOT AVAILABLE/);
  });

  it("the route is in the (provisionally spliced) snapshot", () => {
    expect(snapshot.paths).toHaveProperty(ENTITY_CONTRACT_ROUTE);
  });
});

describe("a workflow write ends with the platform's catalog-checked verdict (#65)", () => {
  function tools(post: (path: string) => Promise<unknown>) {
    const handlers = new Map<string, Handler>();
    const server = {
      tool: (n: string, _d: string, _s: unknown, h: (a: never) => Promise<unknown>) =>
        handlers.set(n, h as Handler),
    };
    const c = {
      post: vi.fn(post),
      put: vi.fn(async () => ({ version: 4, launchable: true, validationIssues: [] })),
    };
    registerWorkflowMutations(server as never, c as unknown as AxonityClient);
    return { handlers, c };
  }

  const ISSUE = { code: "step_no_goal", message: "Step A: no goal defined", severity: "warning" };

  it("apply_workflow_mutations validates the stored workflow after the last command", async () => {
    const { handlers, c } = tools(async (path) =>
      path.endsWith("/validate")
        ? { launchable: false, catalogChecked: true, issues: [ISSUE] }
        : { version: 2, launchable: true, validationIssues: [] },
    );
    const result = await handlers.get("apply_workflow_mutations")!({
      id: "wf-1",
      expectedVersion: 1,
      mutations: [{ type: "add_step", payload: {} }],
    });
    const summary = JSON.parse(result.content[0].text);

    expect(c.post).toHaveBeenLastCalledWith("/api/v1/workflows/wf-1/validate");
    // The mutation said launchable; the catalog check did not. Both are shown,
    // verbatim, and nothing re-words the second into the first.
    expect(summary.launchable).toBe(true);
    expect(summary.validation).toMatchObject({
      catalogChecked: true,
      launchable: false,
      issues: [ISSUE],
      issueCount: 1,
    });
  });

  it("replace_workflow_document does the same", async () => {
    const { handlers, c } = tools(async () => ({ launchable: true, catalogChecked: true, issues: [] }));
    const result = await handlers.get("replace_workflow_document")!({
      id: "wf-1",
      expectedVersion: 3,
      document: {},
    });
    const summary = JSON.parse(result.content[0].text);
    expect(c.post).toHaveBeenCalledWith("/api/v1/workflows/wf-1/validate");
    expect(summary.validation).toMatchObject({ catalogChecked: true, launchable: true, issueCount: 0 });
    expect(summary.validation.source).toMatch(/editor/);
  });

  it("a failed validation does not turn a landed write into an error", async () => {
    const { handlers } = tools(async (path) => {
      if (path.endsWith("/validate")) throw new AxonityApiError("boom", 500);
      return { version: 2 };
    });
    const result = await handlers.get("apply_workflow_mutations")!({
      id: "wf-1",
      expectedVersion: 1,
      mutations: [{ type: "add_step", payload: {} }],
    });
    expect(result.isError).toBeUndefined();
    const summary = JSON.parse(result.content[0].text);
    expect(summary.version).toBe(2);
    expect(summary.validation.catalogChecked).toBe(false);
    expect(summary.validation.note).toMatch(/Do not retry the write/);
  });
});
