import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { AxonityApiError } from "../src/errors.js";
import { registerAll } from "../src/index.js";
import { MEASURE_FORMULA_SECTION } from "../src/tools/conventions.js";
import {
  FORMULA_SPEC_ROUTE,
  FORMULA_SYMBOLS_ROUTE,
  VALIDATE_ROUTE,
  assertFormulaShape,
} from "../src/tools/measureFormula.js";

/**
 * axonity-mcp#83, phase 1 — a measure is one formula (axonity-flow#1908).
 *
 * Pinned here: the words of the formula reach an agent from the platform's own
 * route and nowhere else; a formula is checked by the platform's route before
 * it is saved; a stored measure reads back as formula text; and a write in the
 * shape from before the formula is refused by name instead of being stored as
 * a definition nobody wrote.
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
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
};

function setup(
  overrides: Partial<Record<"get" | "post" | "put", (...a: never[]) => Promise<unknown>>> = {},
) {
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
    get: vi.fn(overrides.get ?? (async () => ({ ok: true }))),
    post: vi.fn(overrides.post ?? (async () => ({ ok: true }))),
    put: vi.fn(overrides.put ?? (async () => ({ ok: true }))),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
  };
  registerAll(server as never, client as unknown as AxonityClient);
  const call = async (name: string, args: Record<string, unknown>) =>
    handlers.get(name)!(args);
  return { call, descriptions, client };
}

const SPEC = {
  version: 1,
  sections: [{ words: [{ code: "sum", available: true }] }],
  codes: [{ code: "parse_error", when: "saving" }],
};

describe("get_measure_formula_spec forwards the platform's one list", () => {
  it("is the route's answer, untouched", async () => {
    const { call, client } = setup({ get: async () => SPEC });
    const result = await call("get_measure_formula_spec", {});
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith(FORMULA_SPEC_ROUTE);
    expect(JSON.parse(result.content[0].text)).toEqual(SPEC);
  });

  it("adds the workspace's vocabulary only when asked, from its own route", async () => {
    const symbols = { measures: [{ name: "net_revenue" }] };
    const { call, client } = setup({
      get: (async (path: string) => (path === FORMULA_SPEC_ROUTE ? SPEC : symbols)) as never,
    });
    const result = await call("get_measure_formula_spec", {
      includeWorkspace: true,
      useDraftChain: true,
    });
    expect(client.get).toHaveBeenCalledWith(FORMULA_SYMBOLS_ROUTE, { useDraftChain: true });
    expect(JSON.parse(result.content[0].text)).toEqual({ spec: SPEC, workspace: symbols });
  });

  it("calls routes the pinned platform declares", () => {
    expect(snapshot.paths["/api/v1/measures/formula-spec"]?.get).toBeDefined();
    expect(snapshot.paths["/api/v1/measures/formula-symbols"]?.get).toBeDefined();
    expect(snapshot.paths["/api/v1/measures/validate"]?.post).toBeDefined();
  });

  it("says to read it first, and names no word of its own", () => {
    const { descriptions } = setup();
    expect(descriptions.get("get_measure_formula_spec")).toMatch(/never write a function/i);
    expect(descriptions.get("create_measure")).toMatch(/READ get_measure_formula_spec FIRST/);
    // The connector's guide points at the spec; it does not list the language.
    expect(MEASURE_FORMULA_SECTION).toMatch(/get_measure_formula_spec/);
    for (const word of ["count_distinct", "coalesce", "to_date", "rolling"]) {
      expect(MEASURE_FORMULA_SECTION).not.toContain(word);
    }
  });
});

describe("validate_measure is the platform's check", () => {
  it("forwards the formula and its context to the validate route", async () => {
    const { call, client } = setup();
    const body = {
      expression: "divide([cm1], [net_revenue])",
      measureId: "m1",
      quantity: "EUR",
      useDraftChain: true,
    };
    await call("validate_measure", body);
    expect(client.post).toHaveBeenCalledWith(VALIDATE_ROUTE, body);
  });

  it("every field it sends is one the route declares", () => {
    const declared = Object.keys(
      snapshot.components.schemas.ValidateFormulaRequest.properties ?? {},
    );
    expect(declared.sort()).toEqual(
      ["expression", "format", "measureId", "quantity", "useDraftChain"].sort(),
    );
  });

  it("tells an agent to repair on the code before asking a person", () => {
    const { descriptions } = setup();
    const text = descriptions.get("validate_measure")!;
    expect(text).toMatch(/before you ask a person/);
    for (const code of ["parse_error", "unreachable_dimension", "quantity_mismatch", "cycle"]) {
      expect(text).toContain(code);
    }
  });
});

describe("read_measure reads back as a formula", () => {
  const TREE = { v: 1, root: { op: "ref", measure: "m2" } };
  const MEASURE = {
    id: "m1",
    name: "cm1",
    version: 3,
    definition: { expression: TREE, quantity: "EUR" },
  };

  it("asks the platform to write the stored tree back as text", async () => {
    const { call, client } = setup({
      get: async () => MEASURE,
      post: async () => ({
        ok: true,
        formula: "[net_revenue]",
        leaves: [{ table: "orders", tableId: "t1", aggregation: "sum" }],
        quantity: "EUR",
        problems: [],
      }),
    });
    const result = await call("read_measure", { id: "m1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/measures/m1");
    expect(client.post).toHaveBeenCalledWith(VALIDATE_ROUTE, {
      expression: TREE,
      measureId: "m1",
      quantity: "EUR",
      format: undefined,
      useDraftChain: false,
    });
    const read = JSON.parse(result.content[0].text);
    expect(read.version).toBe(3);
    expect(read.formula).toEqual({
      text: "[net_revenue]",
      tree: TREE,
      leaves: [{ table: "orders", tableId: "t1", aggregation: "sum" }],
      quantity: "EUR",
      problems: [],
      chain: "published",
    });
  });

  it("still answers when the text cannot be produced, and says why", async () => {
    const { call } = setup({
      get: async () => MEASURE,
      post: async () => {
        throw new AxonityApiError("Not found.", 404);
      },
    });
    const result = await call("read_measure", { id: "m1" });
    expect(result.isError).toBeUndefined();
    const read = JSON.parse(result.content[0].text);
    expect(read.formula).toEqual({ text: null, tree: TREE });
    expect(read.formulaNote).toMatch(/could not be read/);
  });

  it("says so for a measure that has no formula yet, without a second call", async () => {
    const { call, client } = setup({
      get: async () => ({ id: "m1", definition: { aggregation: "sum", column: "x" } }),
    });
    const read = JSON.parse((await call("read_measure", { id: "m1" })).content[0].text);
    expect(read.formula).toBeNull();
    expect(read.formulaNote).toMatch(/no formula yet/);
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe("a write in the shape from before the formula is refused", () => {
  it.each([
    [{ tableId: "t1", definition: { expression: "sum(orders.amount)" } }, "`tableId`"],
    [{ clearTable: true }, "`clearTable`"],
    [{ definition: { aggregation: "sum", column: "amount" } }, "`definition.aggregation`"],
    [
      { definition: { aggregation: "ratio", numerator: {}, denominator: {} } },
      "`definition.numerator`",
    ],
  ])("%j → legacy_field", async (fields, named) => {
    const { call, client } = setup();
    for (const [tool, args] of [
      ["create_measure", { fields }],
      ["update_measure", { id: "m1", expectedVersion: 1, fields }],
    ] as const) {
      const result = await call(tool, args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/^legacy_field:/);
      expect(result.content[0].text).toContain(named);
    }
    expect(client.post).not.toHaveBeenCalled();
    expect(client.put).not.toHaveBeenCalled();
  });

  it("refuses a definition with no expression rather than letting it become a sum", () => {
    expect(() => assertFormulaShape({ definition: { format: { unit: "currency" } } })).toThrow(
      /legacy_field: `definition` has no `expression`/,
    );
  });

  it("lets a formula through, and an edit that does not touch the definition", async () => {
    const { call, client } = setup();
    await call("create_measure", {
      fields: {
        label: "CM1",
        description: "Net revenue minus variable costs.",
        concept: "cm1",
        definition: { expression: "[net_revenue] - [variable_costs]", quantity: "EUR" },
      },
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/measures", expect.anything());
    await call("update_measure", {
      id: "m1",
      expectedVersion: 2,
      fields: { label: "CM 1", tableId: null, clearTable: false },
    });
    expect(client.put).toHaveBeenCalledWith("/api/v1/measures/m1", {
      expectedVersion: 2,
      label: "CM 1",
      tableId: null,
      clearTable: false,
    });
  });

  it("the fields it refuses are the ones the platform still declares", () => {
    // When the platform drops them (axonity-flow#1908 phase 4), this fails and
    // the guard can go: the platform then answers legacy_field itself.
    const create = snapshot.components.schemas.CreateMeasureRequest.properties ?? {};
    const update = snapshot.components.schemas.UpdateMeasureRequest.properties ?? {};
    const definition = snapshot.components.schemas.MeasureDefinitionPayload.properties ?? {};
    expect(create).toHaveProperty("tableId");
    expect(update).toHaveProperty("clearTable");
    for (const key of ["expression", "quantity", "aggregation", "numerator", "denominator"]) {
      expect(definition).toHaveProperty(key);
    }
  });
});

describe("a number made of parts is explained, not summed", () => {
  it("query_measures says the total is computed again, never added up", () => {
    const { descriptions } = setup();
    const text = descriptions.get("query_measures")!;
    expect(text).toMatch(/TOTAL is computed again/);
    expect(text).toMatch(/do not sum the series/);
  });

  it("the semantic guide keeps row logic in the source query", () => {
    expect(MEASURE_FORMULA_SECTION).toMatch(/Row logic belongs in the table's source query/);
    expect(MEASURE_FORMULA_SECTION).toMatch(/never joined/);
  });
});
