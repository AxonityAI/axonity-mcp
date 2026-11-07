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
    schemas: Record<
      string,
      { properties?: Record<string, { description?: string }>; required?: string[] }
    >;
  };
};

/**
 * The file reference, as the backend serves it (axonity-flow#2299): the
 * upload answer `RunInputFileResponse` is the reference a connector's file
 * answer, a start and a sub-workflow's file parameter carry. Every field is
 * required, so the shape the guidance names is its `required` list, in order.
 */
const FILE_REFERENCE = snapshot.components.schemas.RunInputFileResponse!;
const FILE_REFERENCE_SHAPE = `{ ${FILE_REFERENCE.required!.join(", ")} }`;

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
      expect(d, name).toContain(FILE_REFERENCE_SHAPE);
      expect(d, name).toMatch(/Digitize/);
      expect(d, name).toMatch(/sub-workflow/);
      expect(d, name).toContain("get_entity_authoring_contract");
    }
  });

  it("the guide's connector notes say the same", () => {
    expect(CONVENTIONS).toContain("`implementation.effect` is required to PUBLISH");
    expect(CONVENTIONS).toMatch(/"type": "file"/);
    expect(CONVENTIONS).toContain(FILE_REFERENCE_SHAPE);
  });
});

describe("a file reference carries the stored sha256 (axonity-flow#2299)", () => {
  it("the reference in the snapshot has no optional field the shape would miss", () => {
    expect(Object.keys(FILE_REFERENCE.properties!).sort()).toEqual(
      [...FILE_REFERENCE.required!].sort(),
    );
    expect(FILE_REFERENCE.required).toContain("sha256");
  });

  const guidance = (): [string, string][] => {
    const { descriptions } = all();
    return [
      ["axonity_conventions", CONVENTIONS],
      ["create_connector", descriptions.get("create_connector")!],
      ["update_connector", descriptions.get("update_connector")!],
    ];
  };

  it("says what the hash is and what it is for", () => {
    for (const [name, text] of guidance()) {
      expect(text, name).toMatch(/`sha256`[^.]*SHA-256 of the bytes/);
      expect(text, name).toMatch(/computed\s+once\s+when\s+the\s+file\s+was\s+stored/);
      expect(text, name).toMatch(/same\s+bytes\s+have\s+the\s+same\s+value\s+under\s+any\s+name/);
      expect(text, name).toMatch(/already\s+processed/);
    }
  });

  it("says the stored value is the only one, and where a run gets it", () => {
    for (const [name, text] of guidance()) {
      // Settled from storage where a reference enters a run — a caller
      // cannot write the hash a workflow compares.
      expect(text, name).toMatch(/settled\s+from\s+storage/);
      expect(text, name).toMatch(/sub-workflow\s+call/);
      // Digitize always answers the stored value per file it read.
      expect(text, name).toMatch(/Digitize[^.]*always\s+answers\s+the\s+stored\s+`sha256`/);
      // A reference the run may not read keeps the caller's other fields and
      // has no hash, and a webhook, cron or conditional start reads none.
      expect(text, name).toMatch(/keeps\s+what\s+the\s+caller\s+wrote\s+and\s+carries\s+no\s+`sha256`/);
      expect(text, name).toMatch(/webhook,\s+cron\s+or\s+conditional\s+start/);
    }
  });

  it("says only a declared file parameter is settled, nothing else", () => {
    // The backend settles the declared file parameters only
    // (`settle_file_references` walks `_declared_file_parameters`): a
    // reference in an `object` field or an undeclared key keeps whatever
    // `sha256` the caller wrote, at every kind of start.
    for (const [name, text] of guidance()) {
      expect(text, name).toMatch(
        /Only\s+a\s+reference\s+in\s+a\s+declared\s+file\s+parameter\s+\(`file`,\s+or\s+a\s+list\s+of\s+`file`\)\s+is\s+checked\s+against\s+storage/,
      );
      expect(text, name).toMatch(/anywhere\s+else[^.]*is\s+not\s+checked/);
      expect(text, name).toMatch(/compare\s+only[^.]*declared\s+file\s+parameter[^.]*Digitize/);
      // The old, too-broad claim is gone.
      expect(text, name).not.toMatch(/conditional\s+start[^.]*every\s+reference/);
    }
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
 * (`8fa04373f`, after axonity-flow#2356), through the ASGI app, with
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
 * lists secret kinds — anywhere in the document: any `components.*`, inline in
 * an operation, under `webhooks` — is found by content, not by a list of
 * names, so a ninth place that starts carrying it is checked too.
 */
describe("the secret kinds are one list across the snapshot and the live contract (axonity-flow#2349)", () => {
  const MARKER = "oauth2_client_credentials";

  type Doc = {
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> } & Record<string, unknown>;
    webhooks?: Record<string, unknown>;
  };

  /**
   * A closed list of values, in either spelling OpenAPI 3.1 allows: `enum`, or
   * an `anyOf`/`oneOf` whose every branch is a `const` — or `{ type: "null" }`,
   * which is how an optional field (`Literal[...] | None`) can come out.
   */
  const closedList = (record: Record<string, unknown>): string[] | undefined => {
    if (Array.isArray(record.enum)) return record.enum as string[];
    const isConst = (b: unknown) => b !== null && typeof b === "object" && "const" in b;
    const isNull = (b: unknown) =>
      b !== null && typeof b === "object" && (b as { type?: unknown }).type === "null";
    for (const keyword of ["anyOf", "oneOf"]) {
      const branches = record[keyword];
      if (
        Array.isArray(branches) &&
        branches.some(isConst) &&
        branches.every((b) => isConst(b) || isNull(b))
      ) {
        return branches.filter(isConst).map((b) => (b as { const: string }).const);
      }
    }
    return undefined;
  };

  const secretKindEnums = (doc: Doc = snapshot): { at: string; values: string[] }[] => {
    const found: { at: string; values: string[] }[] = [];
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, `${at}[${i}]`));
        return;
      }
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      const values = closedList(record);
      if (values?.includes(MARKER)) found.push({ at, values });
      for (const [key, value] of Object.entries(record)) {
        if (key !== "enum") walk(value, `${at}.${key}`);
      }
    };
    // The WHOLE document, from the top: a list can sit in any of
    // `components.*` (schemas, parameters, requestBodies, responses, headers,
    // callbacks), inline in an operation under `paths`, or under `webhooks`.
    // Walking the root rather than a list of those places means a place
    // nobody listed is not a blind spot either.
    for (const [key, value] of Object.entries(doc)) walk(value, key);
    return found;
  };

  const CONNECTOR_KINDS_AT = "components.schemas.ConnectorAuthConfig.properties.type";

  /** The connector's kinds, in whichever spelling the list is written. */
  const connectorKinds = (doc: Doc): string[] =>
    closedList(
      (doc.components.schemas.ConnectorAuthConfig as {
        properties: { type: Record<string, unknown> };
      }).properties.type,
    ) ?? [];

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

  /**
   * Every place OpenAPI 3.1 lets a schema sit, beyond components.schemas and
   * an operation (nice-to-have from the delta review on #106). FastAPI does not
   * generate these today; the check must still not go blind if it starts to.
   * Each puts a stale list (the six kinds before the refresh-token grant) in
   * one place, and the one comparison must name exactly that place.
   */
  const STALE = {
    type: "string",
    enum: [
      "api_key",
      "bearer",
      "basic",
      "oauth2_client_credentials",
      "google_service_account",
      "session_cookie",
    ],
  };
  const json = (schema: unknown) => ({ content: { "application/json": { schema } } });
  const operationWith = (schema: unknown) => ({
    post: { requestBody: json(schema), responses: { "200": { description: "ok" } } },
  });
  it.each<[string, (doc: Record<string, Record<string, unknown>>) => void, RegExp]>([
    [
      "components.parameters",
      (d) => (d.components.parameters = { AuthType: { in: "query", name: "authType", schema: STALE } }),
      /^components\.parameters\.AuthType\.schema$/,
    ],
    [
      "components.requestBodies",
      (d) => (d.components.requestBodies = { SecretBody: json({ properties: { authType: STALE } }) }),
      /^components\.requestBodies\.SecretBody\..*\.authType$/,
    ],
    [
      "components.responses",
      (d) => (d.components.responses = { SecretList: { description: "x", ...json({ items: STALE }) } }),
      /^components\.responses\.SecretList\..*\.items$/,
    ],
    [
      "components.headers",
      (d) => (d.components.headers = { "X-Auth-Type": { schema: STALE } }),
      /^components\.headers\.X-Auth-Type\.schema$/,
    ],
    [
      "components.callbacks",
      (d) => (d.components.callbacks = { OnRotate: { "{$request.body#/url}": operationWith(STALE) } }),
      /^components\.callbacks\.OnRotate\..*\.requestBody\..*schema$/,
    ],
    [
      "webhooks",
      (d) => (d.webhooks = { secretRotated: operationWith({ properties: { authType: STALE } }) }),
      /^webhooks\.secretRotated\.post\.requestBody\..*\.authType$/,
    ],
  ])("a stale list in %s is named", (_where, mutate, at) => {
    const probe = structuredClone(snapshot) as unknown as Record<string, Record<string, unknown>>;
    mutate(probe);
    expect(secretKindMismatches(probe as unknown as Doc)).toEqual([expect.stringMatching(at)]);
  });

  it.each<[string, (kinds: string[]) => string[]]>([
    ["`none` moved to the end", (kinds) => [...kinds.filter((k) => k !== "none"), "none"]],
    ["`none` missing", (kinds) => kinds.filter((k) => k !== "none")],
    // Pins the length half of the shape check: `none` first is not enough.
    ["`none` twice", (kinds) => [...kinds, "none"]],
  ])("a connector list with %s is named, and only it", (_what, reshape) => {
    // The connector's own shape is its own branch of the comparison: every
    // other list compares to it with `none` taken out, so only this branch
    // sees `none` in the wrong place or gone (delta review on #106).
    const probe = structuredClone(snapshot) as Doc;
    const type = (
      probe.components.schemas.ConnectorAuthConfig as { properties: { type: { enum: string[] } } }
    ).properties.type;
    type.enum = reshape(type.enum);
    expect(secretKindMismatches(probe)).toEqual([CONNECTOR_KINDS_AT]);
  });

  it.each(["anyOf", "oneOf"])(
    "a stale list written as %s of const values is found too",
    (keyword) => {
      // Pydantic writes a Literal as `enum` today, but OpenAPI 3.1 also lets a
      // closed list be an anyOf/oneOf of `const` values. Such a list must not
      // be invisible to the check.
      const probe = structuredClone(snapshot) as Doc;
      const item = probe.components.schemas.SecretListItem as {
        properties: Record<string, unknown>;
      };
      item.properties.kindAsConst = {
        [keyword]: STALE.enum.map((value) => ({ const: value })),
      };
      expect(secretKindMismatches(probe)).toEqual([
        "components.schemas.SecretListItem.properties.kindAsConst",
      ]);
    },
  );

  it.each(["anyOf", "oneOf"])(
    "a connector list written as %s of const values reads as its enum did",
    (keyword) => {
      // connectorKinds reads through closedList, so the connector's own list
      // may take either spelling without a TypeError or a false mismatch.
      const probe = structuredClone(snapshot) as Doc;
      const props = (
        probe.components.schemas.ConnectorAuthConfig as { properties: Record<string, unknown> }
      ).properties;
      const kinds = connectorKinds(snapshot);
      props.type = { [keyword]: kinds.map((value) => ({ const: value })) };
      expect(connectorKinds(probe)).toEqual(kinds);
      expect(secretKindMismatches(probe)).toEqual([]);
    },
  );

  it("a stale const list with a null branch (an optional field) is found too", () => {
    // `Literal[...] | None` can come out as anyOf: [{const}, …, {type: "null"}].
    const probe = structuredClone(snapshot) as Doc;
    const item = probe.components.schemas.SecretListItem as {
      properties: Record<string, unknown>;
    };
    item.properties.kindOrNull = {
      anyOf: [...STALE.enum.map((value) => ({ const: value })), { type: "null" }],
    };
    expect(secretKindMismatches(probe)).toEqual([
      "components.schemas.SecretListItem.properties.kindOrNull",
    ]);
  });

  it("a correct const list with a null branch is not named: the null branch is no kind", () => {
    // The other half of the case above: closedList must leave the null branch
    // out of the values, or an optional but correct list reads as stale.
    const probe = structuredClone(snapshot) as Doc;
    const item = probe.components.schemas.SecretListItem as {
      properties: Record<string, unknown>;
    };
    item.properties.kindOrNull = {
      anyOf: [...secretKinds(snapshot).map((value) => ({ const: value })), { type: "null" }],
    };
    expect(secretKindMismatches(probe)).toEqual([]);
  });

  it("the recorded contract names the same kinds for a connector's authConfig as the snapshot", () => {
    const tool = RECORDED.contracts.tool as {
      variants: { connector: { authConfig: { fields: { name: string; allowed?: string[] }[] } } };
    };
    const recorded = tool.variants.connector.authConfig.fields.find((f) => f.name === "type");
    expect(recorded?.allowed).toEqual(connectorKinds(snapshot));
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
