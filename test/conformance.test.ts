import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerAll } from "../src/index.js";
import { projectCatalog } from "../src/tools/authoringSpec.js";

/**
 * Drift guard (axonity-mcp#17, contract from axonity-flow#722, Option 1).
 *
 * The backend's OpenAPI schema is the single source of truth for the authoring
 * surface. This test pins the MCP to a vendored snapshot of it and fails if:
 *   1. any route path+method a tool calls no longer exists in the schema
 *      (a renamed/removed/retyped backend route), or
 *   2. an enum the operability guide documents diverges from the schema.
 *
 * Regenerate the snapshot from axonity-flow with:
 *   python backend/scripts/dump_openapi.py -o <this-repo>/test/fixtures/openapi.snapshot.json
 * (deterministic, no DB needed — see docs/MCP-AUTHORING-CONTRACT.md there).
 */

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/openapi.snapshot.json", import.meta.url)),
    "utf8",
  ),
) as {
  paths: Record<string, Record<string, PathOperation>>;
  components: { schemas: Record<string, { properties?: Record<string, { enum?: string[] }> }> };
};

interface PathOperation {
  parameters?: { name: string; in?: string }[];
  responses?: Record<
    string,
    { content?: { "application/json"?: { schema?: { $ref?: string } } } }
  >;
}

/** Split a path into segments, dropping any query string. */
function segs(path: string): string[] {
  return path.split("?")[0].replace(/^\/+|\/+$/g, "").split("/");
}

/** OpenAPI templates for a given method, pre-split, cached. */
const templatesByMethod = new Map<string, string[][]>();
for (const [tmpl, ops] of Object.entries(snapshot.paths)) {
  for (const method of Object.keys(ops)) {
    const m = method.toUpperCase();
    if (!templatesByMethod.has(m)) templatesByMethod.set(m, []);
    templatesByMethod.get(m)!.push(segs(tmpl));
  }
}

/** Does a concrete path match an OpenAPI template for this method? */
function schemaHas(method: string, path: string): boolean {
  const parts = segs(path);
  const templates = templatesByMethod.get(method.toUpperCase()) ?? [];
  return templates.some(
    (t) =>
      t.length === parts.length &&
      t.every((seg, i) => (seg.startsWith("{") && seg.endsWith("}")) || seg === parts[i]),
  );
}

/**
 * One filled-in argument per name any tool takes, so a blind sweep reaches as
 * much of the route surface as possible. A handler that rejects these is simply
 * skipped — only the routes that actually fired are asserted on.
 */
const ARGS: Record<string, unknown> = {
  id: "x", workflowId: "x", agentId: "x", toolId: "x", runId: "x", approvalId: "x",
  flowId: "x", snippetId: "x", flowStepId: "x", linkId: "x", webhookId: "x",
  scheduleId: "x", triggerId: "x", secretId: "x", versionId: "x", version: 1, majorVersion: 1,
  expectedVersion: 1, displayOrder: 0, name: "x", cronExpr: "0 0 * * *",
  conditionText: "x", repeatIntervalMinutes: 5, target: "system", confirm: true,
  document: {}, fields: {}, mutations: [{ type: "add_step", payload: {} }],
  snippetIds: ["a"], runIds: ["a"], workflows: [{ id: "x", expectedVersion: 1 }],
  functions: [{ name: "f", code: "def f(): pass" }], code: "x",
  requests: [{ entityType: "tool", entityId: "x" }],
  // The reverse-dependency, run-inspection and release surfaces (#45 M7/M9).
  // `entityKind` picks a real branch: the tool maps it to a base path, so an
  // absent one would sweep a route made of the word "undefined" and the guard
  // would flag the fixture rather than the connector.
  entityKind: "skill", entityId: "x", batchId: "x", stepId: "x", answer: "x",
  message: "x", templateId: "x", releaseId: "x", payload: {},
};

describe("MCP route surface conforms to the backend OpenAPI snapshot", () => {
  it("every route a tool calls exists in the schema (path + method)", async () => {
    const calls: { method: string; path: string }[] = [];
    const rec = (method: string) =>
      vi.fn(async (path: string) => {
        calls.push({ method, path });
        return { ok: true };
      });
    const client = { get: rec("GET"), post: rec("POST"), put: rec("PUT"), patch: rec("PATCH"), del: rec("DELETE") };
    const handlers = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      tool: (name: string, _d: string, _s: unknown, h: (a: never) => Promise<unknown>) =>
        handlers.set(name, h as (a: Record<string, unknown>) => Promise<unknown>),
    };
    registerAll(server as never, client as unknown as AxonityClient);

    for (const handler of handlers.values()) {
      try {
        await handler(ARGS);
      } catch {
        /* arg-shape mismatch is fine — only paths that fired are checked */
      }
    }

    const unknown = calls.filter((c) => !schemaHas(c.method, c.path));
    expect(unknown, `routes not found in OpenAPI:\n${JSON.stringify(unknown, null, 2)}`).toEqual(
      [],
    );
    // Sanity: the harness actually exercised a broad surface.
    expect(calls.length).toBeGreaterThan(80);
  });

  it("documented enums match the schema", () => {
    const enumOf = (model: string, prop: string): string[] | undefined =>
      snapshot.components.schemas[model]?.properties?.[prop]?.enum;

    expect(enumOf("CreateAgentRequest", "capabilityTier")).toEqual([
      "economy",
      "standard",
      "smart",
      "reasoning",
    ]);
    expect(enumOf("CreateAgentRequest", "creativityTier")).toEqual(["low", "medium", "high"]);
    expect(enumOf("CreateAgentRequest", "learningMode")).toEqual(["none", "adaptive", "strict"]);
    expect(enumOf("CreateToolRequest", "type")).toEqual([
      "function",
      "connector",
      "validator",
      "evaluator",
    ]);
    expect(enumOf("AttachSnippetRequest", "target")).toEqual(["system", "user"]);
  });

  /**
   * The gap that let axonity-flow#802 ship: apply_workflow_mutations named every
   * valid command type in its description, the backend's boundary enum was
   * hand-maintained and three narrower, and no test compared the two. So the
   * tool advertised add_decision_condition, attach_output_schema and
   * detach_output_schema while the route answered 422 for all three.
   *
   * That was guarded by pinning the prose to the schema enum. It is now closed
   * one level down instead: the connector states no vocabulary at all and reads
   * `GET /workflows/operations` (#8, axonity-flow#802 B4). A list you do not keep
   * cannot drift, so the pin has nothing left to compare — and this test guards
   * the property that replaced it. Re-introducing a hand-kept list would
   * silently re-open #32, so the absence is asserted rather than assumed.
   */
  it("the connector states no mutation vocabulary of its own", () => {
    const descriptions = new Map<string, string>();
    const server = {
      tool: (name: string, description: string) => descriptions.set(name, description),
    };
    registerAll(server as never, {} as unknown as AxonityClient);

    const description = descriptions.get("apply_workflow_mutations");
    expect(description, "apply_workflow_mutations is not registered").toBeDefined();
    expect(description).toContain("get_workflow_authoring_spec");
    expect(description, "a hand-kept type list is back — see #32").not.toMatch(
      /Valid types:/,
    );

    // Naming a command to state its BEHAVIOUR is guidance the schemas do not
    // carry ("add_step builds a complete step in one call") and must stay. What
    // must not come back is an ENUMERATION — commands strung together by commas,
    // which is a claim about what exists and the exact thing that went stale.
    // So the guard is on the shape, not on a count of mentions.
    const schemaTypes =
      snapshot.components.schemas.WorkflowMutationRequest?.properties?.type?.enum ?? [];
    expect(schemaTypes.length, "the enum vanished — check the snapshot").toBeGreaterThan(
      10,
    );

    const alternation = schemaTypes.join("|");
    const enumeration = new RegExp(`(${alternation})(,\\s*(${alternation})){2,}`);

    // The guard bites: this is the shape the old description had.
    expect(
      "Valid types: update_workflow, add_trigger, add_step, add_edge.".match(enumeration),
    ).not.toBeNull();

    for (const [name, text] of descriptions) {
      const found = text.match(enumeration)?.[0];
      expect(
        found,
        `${name} lists the mutation vocabulary ("${found}") — read it from ` +
          "get_workflow_authoring_spec instead (#32)",
      ).toBeUndefined();
    }
  });

  /**
   * The same property, three vocabularies further (#45 M3, axonity-flow#961 S1).
   *
   * `axonity_conventions` used to name nine step types. SEVEN validate: `loop`
   * and `for_each` both come back `step_invalid_type`, so an agent following
   * the guide got a rejection on a value the guide had just handed it. That is
   * #32 again — a hand-kept list, wrong in the direction that costs a call —
   * and it went unnoticed for the same reason: nothing compared the prose to
   * anything.
   *
   * `GET /workflows/operations` now serves `stepTypes`, `triggerTypes` and
   * `scheduleRuleKinds` beside `operations`, each generated from the registry
   * that ENFORCES it. So the fix is the same as #44's: state nothing, and guard
   * the absence.
   *
   * WHAT IS BANNED IS AN ENUMERATION, not a mention — the line #44 drew and the
   * one this holds. "Give it a trigger with `typeId: subprocess-invocation`" is
   * behaviour no catalogue carries: the catalogue can say the id exists, not
   * that it is the one that makes a workflow callable. A comma-run of ids is a
   * different claim — it says "these are the ones there are" — and that is the
   * claim that went stale.
   *
   * axonity-flow#964 adds three more (`parameterTypes`, `outputKinds`,
   * `schemaFieldKinds`) and they are the sharpest case yet, because getting
   * them wrong is SILENT: `kind` on a trigger parameter is not a 422, it is a
   * key nothing reads. This connector shipped exactly that in #46 and had to
   * correct it in #47 — so the absence is guarded here too.
   *
   * Alphabets: the step-type one is read from the SNAPSHOT and is deliberately
   * the wider of the two lists on the backend. `StepSchema.type` still enums
   * all nine while the validator accepts seven — the transport schema is
   * permissive and the validator is the authority, which is precisely why the
   * old drift guard could not see this. A wider alphabet only makes this guard
   * catch more. The other two alphabets are written out here because no route
   * in the snapshot carries them; a value added on the backend is invisible to
   * them, which weakens the guard but can never make it lie.
   */
  it("the connector states none of the deploy's vocabularies of its own", async () => {
    const descriptions = new Map<string, string>();
    const handlers = new Map<string, () => Promise<{ content: { text: string }[] }>>();
    const server = {
      tool: (
        name: string,
        description: string,
        _s: unknown,
        h: () => Promise<{ content: { text: string }[] }>,
      ) => {
        descriptions.set(name, description);
        handlers.set(name, h);
      },
    };
    registerAll(server as never, {} as unknown as AxonityClient);

    const stepTypes =
      snapshot.components.schemas.StepSchema?.properties?.type?.enum ?? [];
    expect(stepTypes.length, "the step-type enum vanished — check the snapshot").toBe(
      9,
    );

    const triggerTypes = [
      "manual-start", "manual-button", "conditional-data", "conditional-poll",
      "webhook-http", "mailhook-email", "subprocess-invocation",
      "scheduled-interval", "scheduled-cron",
      "manual", "conditional", "webhook", "subprocess", "scheduled",
    ];
    const ruleKinds = [
      "every", "at", "every_weeks", "nth_weekday", "day_of_month", "yearly", "once",
    ];

    /** Three or more of these ids strung together by commas — a claim about what exists. */
    const enumerationOf = (values: string[]): RegExp => {
      const alt = values.map((v) => v.replace(/[-]/g, "\\-")).join("|");
      return new RegExp(`\\b(${alt})\\b[^\\n]{0,12}?,[^\\n]{0,12}?\\b(${alt})\\b[^\\n]{0,12}?,[^\\n]{0,12}?\\b(${alt})\\b`);
    };

    // axonity-flow#964's three value vocabularies. Their alphabets overlap
    // ordinary English (`text`, `number`, `date`, `list`, `object`), so the
    // guard uses only the DISTINCTIVE members: no useful enumeration of these
    // omits all of them, and none of them reads as prose. A guard that cried
    // wolf on the word "list" would be turned off within a week.
    const valueVocabulary = [
      "long-text", "yes-no", "multi-choice", "datetime", "constant", "boolean",
    ];

    const vocabularies: [string, RegExp][] = [
      ["step types", enumerationOf(stepTypes)],
      ["trigger types", enumerationOf(triggerTypes)],
      ["schedule-rule kinds", enumerationOf(ruleKinds)],
      ["value types/kinds", enumerationOf(valueVocabulary)],
    ];

    // The guard bites: this is the sentence conventions.ts actually carried.
    expect(
      "Step `type` is one of: `manual`, `agent`, `automation`, `subprocess`, `end`.".match(
        vocabularies[0][1],
      ),
      "the step-type guard does not fire on the list it was written for",
    ).not.toBeNull();

    // Every tool description, PLUS the guide's own body — which is served by
    // its handler, not its description, and is where the nine-value list lived.
    const sources = new Map<string, string>(descriptions);
    const guide = await handlers.get("axonity_conventions")!();
    const guideText = guide.content[0].text;
    // Without this the whole sweep can pass on an empty string — the guide's
    // body is the one place all three lists actually lived.
    expect(guideText.length, "the guide body did not come through").toBeGreaterThan(
      10_000,
    );
    sources.set("axonity_conventions (guide body)", guideText);

    for (const [where, text] of sources) {
      for (const [label, pattern] of vocabularies) {
        const found = text.match(pattern)?.[0];
        expect(
          found,
          `${where} enumerates ${label} ("${found}") — read them from ` +
            "get_workflow_authoring_spec instead (#45 M3)",
        ).toBeUndefined();
      }
    }
  });

  /**
   * The four lists must SURVIVE the projection, or the guard above just makes
   * the connector silent instead of accurate. `projectCatalog` trims the
   * payload schemas off `operations`; everything beside it rides through.
   */
  it("the authoring spec forwards every vocabulary the server sends", async () => {
    const catalog = {
      operations: [{ type: "add_step", description: "d", payloadSchema: { a: 1 } }],
      rulesVersion: "v1",
      triggerTypes: [{ id: "manual-start", category: false }],
      stepTypes: [{ id: "for_each", authorable: false, reason: "use config.iteration" }],
      scheduleRuleKinds: [{ kind: "every", example: {}, describes: "every day" }],
      // The three value vocabularies (axonity-flow#964). Plain string lists,
      // and the ONE place the connector must not conflate them: `constant`
      // exists in the first and nowhere else, and the yes/no idea is spelled
      // differently between the first and the other two.
      parameterTypes: ["text", "boolean", "constant"],
      outputKinds: ["text", "yes-no"],
      schemaFieldKinds: ["text", "yes-no", "datetime"],
      // A list this connector has never heard of must ride along too.
      somethingNew: [{ id: "x" }],
    };

    const index = projectCatalog(catalog) as Record<string, unknown>;
    const filtered = projectCatalog(catalog, ["add_step"]) as Record<string, unknown>;

    for (const answer of [index, filtered]) {
      expect(answer.triggerTypes).toEqual(catalog.triggerTypes);
      expect(answer.stepTypes).toEqual(catalog.stepTypes);
      expect(answer.scheduleRuleKinds).toEqual(catalog.scheduleRuleKinds);
      expect(answer.parameterTypes).toEqual(catalog.parameterTypes);
      expect(answer.outputKinds).toEqual(catalog.outputKinds);
      expect(answer.schemaFieldKinds).toEqual(catalog.schemaFieldKinds);
      expect(answer.somethingNew).toEqual(catalog.somethingNew);
      expect(answer.rulesVersion).toBe("v1");
    }

    // Only the schemas are dropped, and only from the index.
    expect(index.operations).toEqual([{ type: "add_step", description: "d" }]);
    expect((filtered.operations as { payloadSchema?: unknown }[])[0].payloadSchema)
      .toEqual({ a: 1 });
  });

  /**
   * axonity-flow#811/#816 — no paged route may be consumed as if it were a list.
   *
   * #822 converted `GET /workflows/{id}/runs` to the `Page` envelope and #816
   * is bringing the same treatment to the remaining list endpoints, one at a
   * time. Each conversion is invisible to a pass-through tool: nothing crashes,
   * the tool just starts answering with page 1 of N and no way to say so (#37).
   *
   * So the guard is on the SNAPSHOT, not on a list we maintain: whenever a
   * route the MCP calls starts returning a `Page_*`, the tool that calls it
   * must expose a cursor. A converted endpoint we have not caught up with
   * fails here, at snapshot-refresh time, instead of in a tenant.
   */
  it("every paged route the MCP calls is called by a cursor-aware tool", async () => {
    // Which routes each tool touches, recorded per tool rather than in bulk.
    const perTool = new Map<string, { method: string; path: string }[]>();
    const descriptions = new Map<string, string>();
    const schemas = new Map<string, Record<string, unknown>>();
    let current = "";

    const rec = (method: string) =>
      vi.fn(async (path: string) => {
        perTool.get(current)?.push({ method, path });
        return { ok: true };
      });
    const client = { get: rec("GET"), post: rec("POST"), put: rec("PUT"), patch: rec("PATCH"), del: rec("DELETE") };
    const handlers = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      tool: (name: string, d: string, s: Record<string, unknown>, h: (a: never) => Promise<unknown>) => {
        handlers.set(name, h as (a: Record<string, unknown>) => Promise<unknown>);
        descriptions.set(name, d);
        schemas.set(name, s);
      },
    };
    registerAll(server as never, client as unknown as AxonityClient);

    for (const [name, handler] of handlers) {
      current = name;
      perTool.set(name, []);
      try {
        await handler(ARGS);
      } catch {
        /* arg-shape mismatch is fine — only the routes that fired are checked */
      }
    }

    /** The OpenAPI operation for a concrete path, if the snapshot has one. */
    const operationFor = (method: string, path: string): PathOperation | undefined => {
      const parts = segs(path);
      for (const [tmpl, ops] of Object.entries(snapshot.paths)) {
        const t = segs(tmpl);
        const matches =
          t.length === parts.length &&
          t.every((seg, i) => (seg.startsWith("{") && seg.endsWith("}")) || seg === parts[i]);
        if (matches && ops[method.toLowerCase()]) return ops[method.toLowerCase()];
      }
      return undefined;
    };

    const offenders: string[] = [];
    let pagedRoutesSeen = 0;

    for (const [name, calls] of perTool) {
      for (const { method, path } of calls) {
        const op = operationFor(method, path);
        const ref = op?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref ?? "";
        if (!ref.includes("/Page_")) continue;
        pagedRoutesSeen++;

        // The route is paged. The tool must let a caller ask for the next page
        // AND tell them there is one.
        const takesCursor = "cursor" in (schemas.get(name) ?? {});
        const saysSo = /nextCursor/.test(descriptions.get(name) ?? "");
        if (!takesCursor || !saysSo) {
          offenders.push(
            `${name} calls paged ${method} ${path} (${ref.split("/").pop()}) but ` +
              `${!takesCursor ? "takes no cursor argument" : "never mentions nextCursor"}`,
          );
        }
      }
    }

    expect(offenders, offenders.join("\n")).toEqual([]);
    // The sweep must actually have reached a paged route, or this passes vacuously.
    expect(pagedRoutesSeen).toBeGreaterThan(0);
  });

  it("both validation routes resolve (the harness cannot reach them)", () => {
    // validate_workflow takes EXACTLY ONE of workflowId/document, and the shared
    // ARGS fixture supplies both — so the handler rejects the call and neither
    // route fires in the sweep above. Assert them directly rather than let two
    // routes quietly drop out of the drift guard.
    expect(schemaHas("POST", "/api/v1/workflows/validate")).toBe(true);
    expect(schemaHas("POST", "/api/v1/workflows/wf-1/validate")).toBe(true);
  });

  it("the matcher is sound (rejects a made-up route, accepts a real one)", () => {
    expect(schemaHas("GET", "/api/v1/agents/x/skills-v2")).toBe(true);
    expect(schemaHas("POST", "/api/v1/publish-approvals")).toBe(true);
    expect(schemaHas("GET", "/api/v1/does-not-exist")).toBe(false);
    expect(schemaHas("DELETE", "/api/v1/agents")).toBe(false); // no such method on collection
  });
});
