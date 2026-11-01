import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerAll } from "../src/index.js";
import { assertFormulaShape } from "../src/tools/measureFormula.js";

/**
 * axonity-flow#1783 A1a — a status is a measure and its limits.
 *
 * Pinned here: `target` and `watchMargin` are refused with `legacy_field` and a
 * pointer to `limits`; `limits` reach the platform as sent; a question and a
 * tile can read their status from another measure (`statusMeasure`), and the
 * answer says how it was reached (`statusFrom`); every word the tools name is
 * one the platform declares.
 */

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/openapi.snapshot.json", import.meta.url)),
    "utf8",
  ),
) as {
  components: {
    schemas: Record<
      string,
      { properties?: Record<string, { description?: string }>; required?: string[] }
    >;
  };
};

function setup() {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const server = {
    tool: (
      name: string,
      description: string,
      _schema: unknown,
      handler: (a: never) => Promise<ToolResult>,
    ) => {
      handlers.set(name, handler as Handler);
      descriptions.set(name, description);
    },
  };
  const client = {
    get: vi.fn(async () => ({ ok: true })),
    post: vi.fn(async () => ({ ok: true })),
    put: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(async () => ({ ok: true })),
    delete: vi.fn(async () => ({ ok: true })),
  };
  registerAll(server as never, client as unknown as AxonityClient);
  const call = (name: string, args: Record<string, unknown>) => handlers.get(name)!(args);
  return { call, descriptions, client };
}

const LIMITS = [
  { status: "off_track", upTo: -0.05, includesUpTo: false },
  { status: "watch", upTo: 0, includesUpTo: false },
  { status: "on_track" },
];

describe("a target and a watch margin are refused, with the way to limits", () => {
  it.each([
    [{ definition: { expression: "sum(orders.amount)", target: 100 } }, ["`definition.target`"]],
    [
      { definition: { expression: "sum(orders.amount)", watchMargin: 5 } },
      ["`definition.watchMargin`"],
    ],
    [
      { definition: { expression: "sum(orders.amount)", target: 0, watchMargin: 2 } },
      ["`definition.target`", "`definition.watchMargin`"],
    ],
  ])("%j → legacy_field", async (fields, named) => {
    const { call, client } = setup();
    for (const [tool, args] of [
      ["create_measure", { fields }],
      ["update_measure", { id: "m1", expectedVersion: 1, fields }],
    ] as const) {
      const result = await call(tool, args);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toMatch(/^legacy_field:/);
      for (const field of named) expect(text).toContain(field);
      expect(text).toContain("definition.limits");
      expect(text).toContain("statusMeasure");
    }
    expect(client.post).not.toHaveBeenCalled();
    expect(client.put).not.toHaveBeenCalled();
  });

  it("names the formula fields and the status fields together, each with its repair", () => {
    expect(() =>
      assertFormulaShape({ tableId: "t1", definition: { aggregation: "sum", target: 1 } }),
    ).toThrow(/`tableId`, `definition.aggregation` are the shape from before the formula\..*`definition.target` is gone: a status is a measure and its limits/s);
  });

  it("a target without an expression is refused for the target, not for a missing formula", () => {
    expect(() => assertFormulaShape({ definition: { target: 1 } })).toThrow(
      /legacy_field: `definition.target` is gone/,
    );
  });

  it("a cleared target is not a target: null passes", () => {
    expect(() =>
      assertFormulaShape({ definition: { expression: "sum(orders.amount)", target: null } }),
    ).not.toThrow();
  });
});

describe("limits reach the platform as sent", () => {
  it("create_measure and update_measure forward the bands untouched", async () => {
    const { call, client } = setup();
    const definition = { expression: "[revenue_vs_plan]", limits: LIMITS };
    await call("create_measure", {
      fields: { label: "Against plan", description: "d", concept: "c", definition },
    });
    expect(client.post).toHaveBeenCalledWith(
      "/api/v1/measures",
      expect.objectContaining({ definition }),
    );
    await call("update_measure", { id: "m1", expectedVersion: 3, fields: { definition } });
    expect(client.put).toHaveBeenCalledWith(
      "/api/v1/measures/m1",
      expect.objectContaining({ expectedVersion: 3, definition }),
    );
  });

  it("query_measures forwards statusMeasure untouched", async () => {
    const { call, client } = setup();
    const queries = [{ key: "rev", measure: "revenue", statusMeasure: "revenue_vs_plan" }];
    await call("query_measures", { queries });
    expect(client.post).toHaveBeenCalledWith("/api/v1/measures/query", { queries });
  });
});

describe("the words the tools name are the platform's", () => {
  const schemas = snapshot.components.schemas;

  it("a measure's definition declares limits, and the old fields only as removed", () => {
    const definition = schemas.MeasureDefinitionPayload.properties!;
    expect(definition).toHaveProperty("limits");
    expect(definition.target.description).toMatch(/Removed.*legacy_field/);
    expect(definition.watchMargin.description).toMatch(/Removed.*legacy_field/);
    expect(Object.keys(schemas.MeasureLimitPayload.properties!).sort()).toEqual([
      "includesUpTo",
      "status",
      "upTo",
    ]);
  });

  it("a question declares statusMeasure, an answer status and statusFrom", () => {
    expect(schemas.MeasureQueryItem.properties).toHaveProperty("statusMeasure");
    expect(schemas.MeasureQueryResult.properties).toHaveProperty("status");
    expect(schemas.MeasureQueryResult.properties).toHaveProperty("statusFrom");
  });
});

describe("the tools say how a status is reached", () => {
  it("create_measure and update_measure describe limits instead of a target", () => {
    const { descriptions } = setup();
    for (const tool of ["create_measure", "update_measure"]) {
      const text = descriptions.get(tool)!;
      expect(text).toContain("direction?, limits? }");
      expect(text).not.toMatch(/target\?|watchMargin\?/);
      for (const word of [
        "on_track",
        "watch",
        "off_track",
        "upTo",
        "includesUpTo",
        "bad_limits",
        "there is no default",
        "against_plan_with_limits",
        "statusMeasure",
        "never invent them",
      ]) {
        expect(text).toContain(word);
      }
    }
  });

  it("query_measures offers statusMeasure and explains statusFrom", () => {
    const text = setup().descriptions.get("query_measures")!;
    for (const word of ["statusMeasure?", "statusFrom", "{ measure, value, band }", "{ measure, error }"]) {
      expect(text).toContain(word);
    }
  });

  it("a dashboard tile may read its status from another measure", () => {
    const { descriptions } = setup();
    expect(descriptions.get("create_dashboard")).toContain("config.statusMeasure");
    expect(descriptions.get("update_dashboard")).toContain("config.statusMeasure");
  });

  it("validate_measure says limits are checked on save, not here", () => {
    const text = setup().descriptions.get("validate_measure")!;
    expect(text).toContain("bad_limits");
    expect(text).toMatch(/NOT checked here/);
  });

  it("a measure may read a table its author fills, as published", () => {
    const text = setup().descriptions.get("create_data_table")!;
    expect(text).not.toContain("ONLY A DYNAMIC TABLE CAN BE READ BY A MEASURE");
    expect(text).toMatch(/AS PUBLISHED/);
  });
});
