import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import type { AxonityClient } from "../src/client.js";
import { errorForStatus } from "../src/errors.js";
import { registerAll } from "../src/index.js";
import { PERIOD_PRESETS } from "../src/tools/dataSources.js";

// S9 1c + #2324: transport and the public authoring contract, never a second
// implementation of the platform's arithmetic or dynamic formula vocabulary.
type Result = { isError?: boolean; content: { text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
const snapshot = JSON.parse(
  readFileSync(new URL("./fixtures/openapi.snapshot.json", import.meta.url), "utf8"),
);

function setup() {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const schemas = new Map<string, z.ZodRawShape>();
  const server = {
    tool(name: string, description: string, schema: z.ZodRawShape, handler: Handler) {
      handlers.set(name, handler);
      descriptions.set(name, description);
      schemas.set(name, schema);
    },
  };
  const client = {
    get: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true })),
    post: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true })),
    put: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true })),
    patch: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true })),
    del: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true })),
  };
  registerAll(server as never, client as unknown as AxonityClient);
  // Parse as the SDK does: a direct handler call would hide stripped fields.
  const call = (name: string, args: Record<string, unknown>) =>
    handlers.get(name)!(z.object(schemas.get(name)!).parse(args));
  return { call, client, schemas, descriptions };
}
const payload = (result: Result) => JSON.parse(result.content[0].text);

it("list_measure_rows accepts and forwards a selected month/quarter including null period", async () => {
  const { call, client } = setup();
  const body = { tableId: "t1", period: null, start: "2026-07-01", end: "2026-09-30", limit: 5, filters: [] };
  await call("list_measure_rows", body);
  expect(client.post).toHaveBeenCalledWith("/api/v1/measures/rows", body);
});

it("list_measure_rows preserves explicit dates with an omitted period and does not add defaults", async () => {
  const { call, client } = setup();
  const body = { tableId: "t1", start: "2026-10-01", end: "2026-10-31" };
  await call("list_measure_rows", body);
  expect(client.post).toHaveBeenLastCalledWith("/api/v1/measures/rows", body);
  await call("list_measure_rows", { tableId: "t1" });
  expect(client.post).toHaveBeenLastCalledWith("/api/v1/measures/rows", { tableId: "t1" });
});

it("query_measures forwards expected, against and custom dates without inventing defaults", async () => {
  const { call, client } = setup();
  const queries = [
    { key: "r", measure: "revenue", against: "revenue_plan", expected: true, period: null, start: "2026-10-01", end: "2026-10-31", compare: "previous_year", statusMeasure: "revenue_vs_plan", useDraft: true, useDraftChain: true },
    { key: "old", measure: "revenue" },
    { key: "q", measure: "revenue", period: "last_quarter", expected: false, against: null },
  ];
  await call("query_measures", { queries });
  expect(client.post).toHaveBeenCalledWith("/api/v1/measures/query", { queries });
});

it("query answers keep server ranges, scoped warnings, comparison units and partial failures intact", async () => {
  const { call, client } = setup();
  const basis = { from: "2026-04-01", to: "2026-09-30", values: 6, spread: 2 };
  const response = {
    results: [
      {
        key: "r", ok: true, measure: { quantity: "ratio" },
        total: 0.129, delta: 0.029, change: 0.29, changeKind: "points",
        against: {
          measure: "plan", label: "Plan", total: 0,
          delta: 0.129, change: null, changeKind: "points",
        },
        expected: {
          method: "natural_limits", label: "Natural limits", grain: "month", periods: 6,
          low: 0.1, high: 0.2, center: 0.15, basis, outside: null,
        },
        series: [
          {
            bucket: "2026-10-01", value: 0.129, expectedLow: 0.1, expectedHigh: 0.2,
            partial: false, expectedBasis: basis,
          },
          {
            bucket: "2026-11-01", value: null, expectedLow: null, expectedHigh: null,
            partial: true, expectedReason: "partial",
          },
        ],
        groups: [{ group: "online", value: 0.129, delta: 0.029, change: 0.29, changeKind: "points" }],
        warnings: ["total", "groups", "series"].map(scope => ({
          code: "power_undefined", message: "No real value", severity: "warning",
          where: {
            path: "root", scope,
            ...(scope !== "total" ? { group: "online" } : {}),
            ...(scope === "series" ? { bucket: "2026-11-01" } : {}),
          },
        })),
      },
      {
        key: "missing", ok: true, total: 1,
        against: { measure: "missing_plan", error: "Measure not found" },
        expected: {
          method: null, low: null, high: null,
          reason: "no_range_method", detail: "No method chosen",
        },
      },
      { key: "bad", ok: false, code: "grain_too_fine", error: "Use month" },
    ],
  };
  client.post.mockResolvedValueOnce(response);
  expect(payload(await call("query_measures", {
    queries: [
      { key: "r", measure: "margin", expected: true, against: "plan" },
      { key: "missing", measure: "revenue", expected: true, against: "missing_plan" },
      { key: "bad", measure: "revenue", grain: "day" },
    ],
  }))).toEqual(response);
});

it.each(["create_measure", "update_measure"])("%s forwards rangeMethod including explicit clearing", async name => {
  const { call, client } = setup();
  const args = name === "update_measure" ? { id: "m1", expectedVersion: 2 } : {};
  for (const rangeMethod of [{ method: "same_period_last_year", grain: "month", periods: 6 }, null]) {
    const definition = { expression: "sum(orders.amount)", quantity: "EUR", rangeMethod };
    await call(name, { ...args, fields: { definition } });
    const write = name === "create_measure" ? client.post : client.put;
    expect(write).toHaveBeenLastCalledWith(name === "create_measure" ? "/api/v1/measures" : "/api/v1/measures/m1", expect.objectContaining({ definition }));
  }
});

it.each([
  ["read_measure", { id: "m1" }, "/api/v1/measures/m1"],
  ["read_measure_published", { id: "m1" }, "/api/v1/measures/m1/versions/published"],
  ["read_measure_version", { id: "m1", version: 2 }, "/api/v1/measures/m1/versions/2"],
] as const)("%s preserves stored range settings", async (name, args, route) => {
  const { call, client } = setup();
  const definition = {
    expression: "sum(orders.amount)",
    rangeMethod: { method: "natural_limits", grain: "month", periods: 6 },
  };
  client.get.mockResolvedValueOnce({ id: "m1", definition });
  const answer = payload(await call(name, args));
  expect(answer.definition).toEqual(definition);
  expect(client.get).toHaveBeenCalledWith(route);
});

it.each(["create_dashboard", "update_dashboard"])("%s forwards periodPicker, expected bands and number configuration as given", async name => {
  const { call, client } = setup();
  const layout = {
    period: "last_quarter", periodPicker: "full_periods",
    sections: [{
      id: "s", title: "Figures",
      tiles: [{
        id: "n", type: "number", size: "M",
        config: {
          measure: "revenue", against: { measure: "revenue_plan", label: "Plan" },
          statusMeasure: "revenue_vs_plan", compare: "none", sparkline: "bullet", showExpected: true,
        },
      }],
    }],
  };
  await call(name, { ...(name === "update_dashboard" ? { id: "d1", expectedVersion: 2 } : {}), fields: { name: "Figures", layout } });
  const write = name === "create_dashboard" ? client.post : client.put;
  expect(write).toHaveBeenLastCalledWith(name === "create_dashboard" ? "/api/v1/dashboards" : "/api/v1/dashboards/d1", expect.objectContaining({ layout }));
});

it("formula-spec forwards power and rangeMethods from the server, with or without workspace", async () => {
  const { call, client } = setup();
  const spec = {
    version: 1,
    sections: [{ key: "calculating", words: [{ code: "power", signature: "power(base, exponent)" }] }],
    // An unknown server method proves this connector keeps no private register.
    rangeMethods: [{ method: "server_method", settings: { periods: { minimum: 7 } } }],
    recipes: [{ key: "growth_to_a_plan" }],
    codes: [{ code: "bad_power" }, { code: "power_undefined" }],
  };
  client.get.mockResolvedValueOnce(spec);
  expect(payload(await call("get_measure_formula_spec", {}))).toEqual(spec);
  client.get.mockResolvedValueOnce(spec).mockResolvedValueOnce({ measures: [] });
  expect(payload(await call("get_measure_formula_spec", { includeWorkspace: true }))).toEqual({ spec, workspace: { measures: [] } });
  const expression = "power(4, 0.5)";
  const checked = {
    ok: true,
    expression: { v: 1, root: { op: "fn", name: "power", args: [{ op: "const", value: 4 }, { op: "const", value: 0.5 }] } },
    problems: [],
  };
  client.post.mockResolvedValueOnce(checked);
  expect(payload(await call("validate_measure", { expression }))).toEqual(checked);
  expect(client.post).toHaveBeenLastCalledWith("/api/v1/measures/validate", { expression });
});

it.each([
  ["create_measure", { fields: { definition: { expression: "[revenue]", rangeMethod: { grain: "day" } } } }, "post", "bad_range_method"],
  ["update_measure", { id: "m1", expectedVersion: 2, fields: { definition: { expression: "[revenue]", rangeMethod: {} } } }, "put", "bad_range_method"],
  ["create_dashboard", { fields: { layout: { periodPicker: "wrong" } } }, "post", "Unknown period picker"],
  ["update_dashboard", { id: "d1", expectedVersion: 2, fields: { layout: {} } }, "put", "A bullet needs a measure"],
  ["list_measure_rows", { tableId: "t1", period: "bad" }, "post", "Invalid period"],
  ["query_measures", { queries: [{ expected: "wrong" }] }, "post", "Invalid expected"],
  ["validate_measure", { expression: "power([revenue], [revenue])" }, "post", "bad_power"],
] as const)("%s preserves backend refusals", async (name, args, method, reason) => {
  const { call, client } = setup();
  const error = errorForStatus(422, { detail: reason });
  client[method].mockRejectedValueOnce(error);
  const result = await call(name, args);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toBe(error.message);
});

it("range authoring describes explicit choices, whole-definition replacement and save validation", () => {
  const { descriptions } = setup();
  for (const tool of ["create_measure", "update_measure"]) {
    const text = descriptions.get(tool)!;
    for (const word of ["rangeMethod", "{method, grain, periods}", "rangeMethods", "bad_range_method", "no default"]) expect(text).toContain(word);
  }
  expect(descriptions.get("update_measure")).toMatch(/without.*rangeMethod.*removes.*range/);
  expect(descriptions.get("read_measure")).toContain("definition.rangeMethod");
  expect(descriptions.get("validate_measure")).toContain("bad_range_method");
  expect(descriptions.get("get_measure_formula_spec")).toContain("rangeMethods");
});

it("query explains range absence, historical basis and the scope of undefined powers", () => {
  const text = setup().descriptions.get("query_measures")!;
  for (const word of ["expected?", "expectedLow", "expectedHigh", "expectedReason", "expectedBasis", "basis.values", "not_enough_history", "no_range_method", "not_with_split", "period_is_not_one_full_", "partial", "power_undefined", "where.scope", "where.group", "where.bucket"]) expect(text).toContain(word);
});

it("query explains named comparison, points versus relative change and partial failures", () => {
  const text = setup().descriptions.get("query_measures")!;
  for (const word of ["against?", "changeKind", "measure.quantity", "delta", "percentage points", "against.error", "useDraftChain", "published", "0.029", "2.9 pp"]) expect(text).toContain(word);
  expect(text).toMatch(/against.*never.*status/s);
  expect(text).toMatch(/end.*inclusive/);
});

it.each(["create_dashboard", "update_dashboard"])("%s explains number options and period-picker limits", name => {
  const text = setup().descriptions.get(name)!;
  for (const word of ["showExpected", "number", "trend", "config.against", "{measure, label?}", "config.sparkline", "bullet", "none", "layout.periodPicker", "full_periods", "hidden", "free", "last_quarter", 'compare: "none"']) expect(text).toContain(word);
});

it("the pinned schema declares only the actual wire additions and shared period enum", () => {
  const schemas = snapshot.components.schemas;
  expect(schemas.MeasureDefinitionPayload.properties).toHaveProperty("rangeMethod");
  expect(Object.keys(schemas.MeasureRangeMethodPayload.properties).sort()).toEqual(["grain", "method", "periods"]);
  for (const field of ["expected", "against"]) expect(schemas.MeasureQueryItem.properties).toHaveProperty(field);
  for (const field of ["expected", "against", "delta", "changeKind"]) expect(schemas.MeasureQueryResult.properties).toHaveProperty(field);
  expect(schemas.MeasureQueryResult.properties.series.description).toContain("expectedBasis");
  expect(schemas.MeasureQueryResult.properties.warnings.description).toContain("where.scope");
  expect(PERIOD_PRESETS).toContain("last_quarter");
  for (const model of ["MeasureQueryItem", "TopRowsRequest"]) {
    const periods = schemas[model].properties.period.anyOf.find((part: { enum?: string[] }) => part.enum).enum;
    expect(PERIOD_PRESETS).toEqual(periods);
  }
  // Layout remains a free object, validated by the domain on save.
  expect(schemas.CreateDashboardRequest.properties.layout.anyOf[0].type).toBe("object");
});
