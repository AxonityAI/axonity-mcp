import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { AxonityApiError, BackendVersionSkewError, errorForStatus } from "../src/errors.js";
import { registerAll } from "../src/index.js";
import { CONVENTIONS } from "../src/tools/conventions.js";
import {
  ENTITY_CONTRACT_ROUTE,
  ENTITY_CONTRACT_UNAVAILABLE,
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

/**
 * A response recorded from the REAL route on axonity-flow `main`
 * (`76d04404d`, after axonity-flow#2352), through the ASGI app, with
 * `?kinds=tool,conditional_trigger`. Re-record it when the route changes.
 */
const RECORDED = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("./fixtures/entity-contracts.tool-conditional_trigger.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  kinds: string[];
  rulesVersion: string;
  contracts: Record<string, Record<string, unknown>>;
};

/** The platform's 422 for an unknown kind, as the route answered it. */
const UNKNOWN_KIND_422 = {
  error: "validation_error",
  code: "validation_error",
  retryable: false,
  message:
    "Unknown entity kind: nonsense. Known kinds: agent, application, " +
    "conditional_trigger, data_table, measure, output_schema, policy, " +
    "prompt_snippet, query, reference_doc, secret, skill, tool, toolbox, " +
    "trigger_element.",
};

describe("get_entity_authoring_contract reads the platform live (#95, axonity-flow#2103)", () => {
  const client = (get: (path: string, query?: unknown) => Promise<unknown>) =>
    ({ get: vi.fn(get) }) as unknown as AxonityClient & { get: ReturnType<typeof vi.fn> };

  it("is registered and reads the route with no query when no kinds are asked", async () => {
    const { handlers, client: c } = all();
    expect(handlers.has("get_entity_authoring_contract")).toBe(true);
    await handlers.get("get_entity_authoring_contract")!({});
    expect(c.get).toHaveBeenCalledWith(ENTITY_CONTRACT_ROUTE);
    expect(ENTITY_CONTRACT_ROUTE).toBe("/api/v1/authoring/entity-contracts");
  });

  it("sends kinds as ONE comma-separated query parameter, as the route reads it", async () => {
    const c = client(async () => RECORDED);
    await readEntityContract(c, ["tool", " conditional_trigger "]);
    expect(c.get).toHaveBeenCalledWith(ENTITY_CONTRACT_ROUTE, {
      kinds: "tool,conditional_trigger",
    });
  });

  it("passes the recorded real response through unchanged", async () => {
    const result = (await readEntityContract(client(async () => RECORDED), [
      "tool",
      "conditional_trigger",
    ])) as ToolResult;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(RECORDED);
  });

  it("the recorded response carries what this connector's prose points at", () => {
    // If the platform renames these, the guide's pointers are wrong: re-record
    // the fixture and this test says what moved.
    expect(Object.keys(RECORDED).sort()).toEqual(["contracts", "kinds", "rulesVersion"]);
    expect(Object.keys(RECORDED.contracts).sort()).toEqual(["conditional_trigger", "tool"]);
    expect(RECORDED.kinds).toContain("output_schema");

    const tool = RECORDED.contracts.tool as {
      publish: { rules: { code: string; allowed?: string[] }[] };
      variants: { connector: { implementation: { fields: Record<string, unknown>[] } } };
    };
    const effect = tool.publish.rules.find((r) => r.code === "connector_effect_missing");
    expect(effect?.allowed).toEqual(["reads", "acts"]);
    const mapping = tool.variants.connector.implementation.fields.find(
      (f) => f.name === "responseMapping",
    ) as { shape: { fields: { name: string; allowed?: string[] }[] } };
    expect(mapping.shape.fields.find((f) => f.name === "type")?.allowed).toEqual([
      "jmespath",
      "full",
      "file",
    ]);
    expect(mapping.shape.fields.map((f) => f.name)).toContain("filename");

    const trigger = RECORDED.contracts.conditional_trigger as {
      create: { fields: { name: string; required?: boolean; refused?: unknown }[] };
    };
    const byName = new Map(trigger.create.fields.map((f) => [f.name, f]));
    expect(byName.get("workflowId")?.required).toBe(true);
    expect(byName.get("checkKind")?.refused).toBeDefined();
    expect(byName.get("checkConfig")?.refused).toBeDefined();
  });

  it("matches the route in the snapshot (dumped from main)", () => {
    const op = (snapshot.paths[ENTITY_CONTRACT_ROUTE] as {
      get: { parameters: { name: string; in: string }[] };
    }).get;
    expect(op.parameters.map((p) => `${p.in}:${p.name}`)).toEqual(["query:kinds"]);
    const schema = snapshot.components.schemas.EntityContractsResponse as {
      properties?: Record<string, unknown>;
      description?: string;
    };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "contracts",
      "kinds",
      "rulesVersion",
    ]);
    expect(JSON.stringify(schema)).not.toMatch(/PROVISIONAL/);
  });

  it("passes the platform's 422 for an unknown kind on as an error", async () => {
    const result = (await readEntityContract(
      client(async () => {
        throw errorForStatus(422, UNKNOWN_KIND_422);
      }),
      ["tool", "nonsense"],
    )) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Known kinds: agent/);
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
});

/**
 * axonity-flow#2349 — one vocabulary of secret kinds.
 *
 * A secret's `authType` and a connector's `authConfig.type` are the same list
 * on the platform (pinned to each other there). This connector carries no copy
 * of it: an agent reads the kinds from the live contract. What can go wrong
 * HERE is a partial refresh — a new kind spliced into some of the schemas that
 * carry the list and not the others, or the snapshot and the recorded contract
 * response taken from different backends. Every enum in the snapshot that
 * lists secret kinds — in a component schema or inline in an operation's
 * parameters, request body or responses — is found by content, not by a list
 * of names, so a ninth place that starts carrying it is checked too.
 */
describe("the secret kinds are one list across the snapshot and the live contract (axonity-flow#2349)", () => {
  const MARKER = "oauth2_client_credentials";

  type Doc = { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };

  const secretKindEnums = (doc: Doc = snapshot): { at: string; values: string[] }[] => {
    const found: { at: string; values: string[] }[] = [];
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, `${at}[${i}]`));
        return;
      }
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      const values = record.enum;
      if (Array.isArray(values) && values.includes(MARKER)) {
        found.push({ at, values: values as string[] });
      }
      for (const [key, value] of Object.entries(record)) {
        if (key !== "enum") walk(value, `${at}.${key}`);
      }
    };
    // Both halves of the document: a list can sit in a component schema or
    // inline in an operation (a parameter, a request body, a response).
    walk(doc.components.schemas, "components.schemas");
    walk(doc.paths, "paths");
    return found;
  };

  const CONNECTOR_KINDS_AT = "components.schemas.ConnectorAuthConfig.properties.type";

  const connectorKinds = (doc: Doc): string[] =>
    (doc.components.schemas.ConnectorAuthConfig as { properties: { type: { enum: string[] } } })
      .properties.type.enum;

  /** The secret kinds: a connector's kinds without `none`. */
  const secretKinds = (doc: Doc = snapshot): string[] =>
    connectorKinds(doc).filter((v) => v !== "none");

  /**
   * THE comparison, in one place: where the snapshot breaks the platform's
   * invariant. A connector's kinds are `none` first and then the secret kinds;
   * every other list of secret kinds, wherever it sits, is exactly those
   * secret kinds in the same order (`none` aside). Returns the paths that
   * break it; empty means one vocabulary.
   */
  const secretKindMismatches = (doc: Doc = snapshot): string[] => {
    const connector = connectorKinds(doc);
    const kinds = secretKinds(doc);
    const wrong: string[] = [];
    if (connector[0] !== "none" || connector.length !== kinds.length + 1) {
      wrong.push(CONNECTOR_KINDS_AT);
    }
    for (const { at, values } of secretKindEnums(doc)) {
      if (JSON.stringify(values.filter((v) => v !== "none")) !== JSON.stringify(kinds)) {
        wrong.push(at);
      }
    }
    return wrong;
  };

  it("every schema that lists secret kinds lists the same ones, the refresh-token grant included", () => {
    // The secret routes' requests and responses plus ConnectorAuthConfig.
    expect(secretKindEnums().length).toBeGreaterThanOrEqual(8);
    // The platform's invariant: a connector's kinds are `none` (a connector
    // without a secret) and then the secret kinds, and nothing else.
    expect(secretKindMismatches()).toEqual([]);
    expect(secretKinds()).toContain("oauth2_refresh_token");
  });

  it("finds a list of secret kinds inline in an operation too, not only in a component schema", () => {
    // Review K1 on #106: the walker read components.schemas only, so a stale
    // list inline in a route (here a query parameter with the six old kinds)
    // passed. The probe, kept as a regression test.
    const probe = structuredClone(snapshot) as Doc;
    const op = (probe.paths["/api/v1/secrets"] as { get: { parameters?: unknown[] } }).get;
    (op.parameters ??= []).push({
      in: "query",
      name: "authType",
      required: false,
      schema: {
        type: "string",
        enum: [
          "api_key",
          "bearer",
          "basic",
          "oauth2_client_credentials",
          "google_service_account",
          "session_cookie",
        ],
      },
    });
    expect(secretKindMismatches(snapshot)).toEqual([]);
    expect(secretKindMismatches(probe)).toEqual([
      expect.stringMatching(/^paths\.\/api\/v1\/secrets\.get\.parameters\[\d+\]\.schema$/),
    ]);
  });

  it("the recorded contract names the same kinds for a connector's authConfig as the snapshot", () => {
    const tool = RECORDED.contracts.tool as {
      variants: { connector: { authConfig: { fields: { name: string; allowed?: string[] }[] } } };
    };
    const recorded = tool.variants.connector.authConfig.fields.find((f) => f.name === "type");
    const pinned = (
      snapshot.components.schemas.ConnectorAuthConfig.properties?.type as { enum?: string[] }
    ).enum;
    expect(recorded?.allowed).toEqual(pinned);
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
