import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AxonityClient } from "../src/client.js";
import { errorForStatus } from "../src/errors.js";
import { registerAll } from "../src/index.js";
import { MEASURE_FORMULA_SECTION } from "../src/tools/conventions.js";
import { PERIOD_PRESETS } from "../src/tools/dataSources.js";

/**
 * axonity-flow#1783 A2 (S9, release 1b) — what moves a number.
 *
 * Pinned here: each influence tool reaches the route the platform declares,
 * with the body its strict schema takes (nothing it did not get); a refusal
 * comes back with the backend's own reasons; the descriptions carry the rules
 * an agent would otherwise learn from a 422 (loop, planned, basis, owner as
 * text, published as a table, travels with the deploy); and every tool that
 * takes a period names the three that end at the last full month.
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
  components: { schemas: Record<string, { properties?: Record<string, any> }> };
};

function setup() {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const schemas = new Map<string, Record<string, { description?: string }>>();
  const server = {
    tool: (
      name: string,
      description: string,
      schema: Record<string, { description?: string }>,
      handler: (a: never) => Promise<ToolResult>,
    ) => {
      handlers.set(name, handler as Handler);
      descriptions.set(name, description);
      schemas.set(name, schema);
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
  return { handlers, descriptions, schemas, client };
}

const ROW = {
  fromMeasure: "complaints",
  toMeasure: "lost_customers",
  effect: "same",
  why: "More complaints mean more customers who stop.",
  owner: "Head of Customer Care",
};

describe("the influence tools reach the platform's routes", () => {
  it("list_measure_influences reads one measure or all, draft or published", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_measure_influences")!({ measure: "lost_customers" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/measure-influences", {
      measure: "lost_customers",
      useDraft: undefined,
    });
    await handlers.get("list_measure_influences")!({ useDraft: false });
    expect(client.get).toHaveBeenCalledWith("/api/v1/measure-influences", {
      measure: undefined,
      useDraft: false,
    });
  });

  it("link_measures posts only the fields it was given (the body is strict)", async () => {
    const { handlers, client } = setup();
    await handlers.get("link_measures")!({ ...ROW });
    expect(client.post).toHaveBeenCalledWith("/api/v1/measure-influences", ROW);

    await handlers.get("link_measures")!({
      fromMeasure: "cm1",
      toMeasure: "cash_position",
      kind: "formula",
      effect: "same",
      why: "Cash must be computed from the margin; it is not yet.",
      owner: "CFO",
      basis: "Budget 2027",
      planned: true,
    });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/measure-influences", {
      fromMeasure: "cm1",
      toMeasure: "cash_position",
      kind: "formula",
      effect: "same",
      why: "Cash must be computed from the margin; it is not yet.",
      owner: "CFO",
      basis: "Budget 2027",
      planned: true,
    });
  });

  it("update_measure_influence puts the same row shape", async () => {
    const { handlers, client } = setup();
    await handlers.get("update_measure_influence")!({ ...ROW, effect: "opposite" });
    expect(client.put).toHaveBeenCalledWith("/api/v1/measure-influences", {
      ...ROW,
      effect: "opposite",
    });
  });

  it("unlink_measures deletes by from, to and kind in the query string, never the confirm", async () => {
    const { handlers, client } = setup();
    await handlers.get("unlink_measures")!({
      fromMeasure: "complaints",
      toMeasure: "lost_customers",
      confirm: true,
    });
    expect(client.del).toHaveBeenCalledWith("/api/v1/measure-influences", {
      fromMeasure: "complaints",
      toMeasure: "lost_customers",
      kind: undefined,
    });
  });

  it("unlink_measures demands confirm: true, like the other removals", () => {
    const { schemas } = setup();
    const confirm = schemas.get("unlink_measures")!.confirm as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(confirm.safeParse(true).success).toBe(true);
    expect(confirm.safeParse(false).success).toBe(false);
    expect(confirm.safeParse(undefined).success).toBe(false);
  });

  it("read_measure_tree reads from one measure or the whole workspace", async () => {
    const { handlers, client } = setup();
    await handlers.get("read_measure_tree")!({ measure: "net_revenue" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/measures/tree", {
      measure: "net_revenue",
      useDraft: undefined,
    });
    await handlers.get("read_measure_tree")!({});
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/measures/tree", {
      measure: undefined,
      useDraft: undefined,
    });
  });

  it("every route these tools call is in the pinned contract", () => {
    const influences = snapshot.paths["/api/v1/measure-influences"];
    expect(Object.keys(influences ?? {}).sort()).toEqual(["delete", "get", "post", "put"]);
    expect(Object.keys(snapshot.paths["/api/v1/measures/tree"] ?? {})).toEqual(["get"]);
  });

  it("the row fields are the ones the backend's strict write takes", () => {
    const { schemas } = setup();
    const write = snapshot.components.schemas.MeasureInfluenceWrite.properties!;
    const fields = Object.keys(schemas.get("link_measures")!).sort();
    expect(fields).toEqual(Object.keys(write).sort());
    expect(Object.keys(schemas.get("update_measure_influence")!).sort()).toEqual(fields);
  });
});

describe("a refusal comes back as the backend wrote it", () => {
  it("a loop is reported with its path, unchanged", async () => {
    const { handlers, client } = setup();
    // The envelope a ValidationError renders: a message and its reasons.
    client.post.mockRejectedValueOnce(
      errorForStatus(422, {
        error: "validation_error",
        code: "validation_error",
        retryable: false,
        message: "This influence cannot be written.",
        detail: [
          "This would make a loop: `margin` → `complaints` → `revenue` → `margin`. " +
            '"Why did this move?" would go round in a circle; leave one of these links out.',
        ],
      }),
    );
    const result = await handlers.get("link_measures")!({ ...ROW });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/cannot be written/);
    expect(result.content[0].text).toContain(
      "`margin` → `complaints` → `revenue` → `margin`",
    );
  });
});

describe("every tool hands the backend's refusal back unchanged", () => {
  const cases: [string, "get" | "post" | "put" | "del", Record<string, unknown>, number, string][] = [
    ["list_measure_influences", "get", {}, 403, "The module Insights is switched off for this workspace."],
    [
      "update_measure_influence",
      "put",
      { ...ROW },
      404,
      "There is no `complaints` → `lost_customers` (influence) to change.",
    ],
    [
      "unlink_measures",
      "del",
      { fromMeasure: "complaints", toMeasure: "lost_customers", confirm: true },
      403,
      "The module Insights is switched off for this workspace.",
    ],
    ["read_measure_tree", "get", { measure: "nope" }, 404, "There is no measure called `nope`."],
  ];

  for (const [tool, method, args, status, message] of cases) {
    it(`${tool}: ${status}`, async () => {
      const { handlers, client } = setup();
      client[method].mockRejectedValueOnce(
        errorForStatus(status, { error: "x", code: "x", retryable: false, message }),
      );
      const result = await handlers.get(tool)!(args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(message);
    });
  }

  it("publishing the table can be refused, and the descriptions say so", () => {
    const { descriptions } = setup();
    for (const tool of ["link_measures", "update_measure_influence"]) {
      const text = descriptions.get(tool)!;
      expect(text, tool).toMatch(/PUBLISHING ITSELF CAN BE REFUSED/);
      expect(text, tool).toMatch(/what goes\s+LIVE/);
      expect(text, tool).toMatch(/REMOVES it first/);
    }
    expect(MEASURE_FORMULA_SECTION).toMatch(/publish the side that removes it first/);
  });
});

describe("the input is checked before anything is sent", () => {
  const schemaOf = (tool: string) => {
    const { schemas } = setup();
    return z.object(schemas.get(tool) as unknown as z.ZodRawShape);
  };

  for (const tool of ["link_measures", "update_measure_influence"]) {
    it(`${tool}: a whole row passes, a wrong effect or kind or a missing why/owner does not`, () => {
      const row = schemaOf(tool);
      expect(row.safeParse(ROW).success).toBe(true);
      expect(row.safeParse({ ...ROW, kind: "formula", planned: true }).success).toBe(true);
      expect(row.safeParse({ ...ROW, effect: "up" }).success).toBe(false);
      expect(row.safeParse({ ...ROW, kind: "cause" }).success).toBe(false);
      const { why: _why, ...noWhy } = ROW;
      expect(row.safeParse(noWhy).success).toBe(false);
      const { owner: _owner, ...noOwner } = ROW;
      expect(row.safeParse(noOwner).success).toBe(false);
      expect(row.safeParse({ ...ROW, planned: "yes" }).success).toBe(false);
    });
  }

  it("unlink_measures: from and to are required, kind is one of two", () => {
    const unlink = schemaOf("unlink_measures");
    const ok = { fromMeasure: "a", toMeasure: "b", confirm: true };
    expect(unlink.safeParse(ok).success).toBe(true);
    expect(unlink.safeParse({ ...ok, kind: "cause" }).success).toBe(false);
    expect(unlink.safeParse({ toMeasure: "b", confirm: true }).success).toBe(false);
  });

  it("list and tree: optional names, a boolean useDraft", () => {
    for (const tool of ["list_measure_influences", "read_measure_tree"]) {
      const schema = schemaOf(tool);
      expect(schema.safeParse({}).success, tool).toBe(true);
      expect(schema.safeParse({ measure: "x", useDraft: true }).success, tool).toBe(true);
      expect(schema.safeParse({ useDraft: "no" }).success, tool).toBe(false);
    }
  });
});

describe("the descriptions carry the rules", () => {
  it("link_measures says what is refused, how it goes live and that it travels", () => {
    const { descriptions } = setup();
    const link = descriptions.get("link_measures")!;
    expect(link).toMatch(/LOOP/);
    expect(link).toMatch(/already rests on/);
    expect(link).toMatch(/`formula` without `planned`/);
    expect(link).toMatch(/measure_influences/);
    expect(link).toMatch(/ensure_data_table_major_version/);
    expect(link).toMatch(/request_publish_data_table/);
    expect(link).toMatch(/TRAVEL WITH THE DEPLOY/);
    expect(link).toMatch(/Never write them by\s+hand in production/);
    expect(link).toMatch(/AN INFLUENCE IS NOT A FORMULA/);
  });

  it("owner is a role as text, basis is optional, planned marks a missing link", () => {
    const { schemas } = setup();
    const row = schemas.get("link_measures")!;
    expect(row.owner.description).toMatch(/role/);
    expect(row.owner.description).toMatch(/Not a user account/);
    expect(row.basis.description).toMatch(/Optional/);
    expect(row.planned.description).toMatch(/MISSING/);
    expect(row.planned.description).toMatch(/not\s+built yet/);
  });

  it("update says what finds the row and that the whole row is sent", () => {
    const { descriptions } = setup();
    const update = descriptions.get("update_measure_influence")!;
    expect(update).toMatch(/`fromMeasure` \+ `toMeasure` \+\s+"?`kind`/);
    expect(update).toMatch(/WHOLE row/);
  });

  it("read_measure_tree names its shape, its gaps, and that it carries no values", () => {
    const { descriptions } = setup();
    const tree = descriptions.get("read_measure_tree")!;
    expect(tree).toMatch(/\{ root, nodes, edges, missing \}/);
    for (const reason of ["not_built", "not_published", "planned", "points_nowhere"]) {
      expect(tree).toContain(reason);
    }
    expect(tree).toMatch(/NO VALUES/);
    expect(tree).toMatch(/PUBLISHED/);
  });

  it("read_measure says what influencedBy and influences are", () => {
    const { descriptions } = setup();
    const read = descriptions.get("read_measure")!;
    expect(read).toMatch(/`influencedBy`/);
    expect(read).toMatch(/`influences`/);
    expect(read).toMatch(/DRAFT of the influences/);
    // and the field is really there on the pinned contract
    const detail = snapshot.components.schemas.MeasureDetail.properties!;
    expect(detail.influencedBy).toBeDefined();
    expect(detail.influences).toBeDefined();
  });

  it("the semantic conventions say when a formula and when an influence", () => {
    expect(MEASURE_FORMULA_SECTION).toMatch(/\*\*A formula or an influence\.\*\*/);
    expect(MEASURE_FORMULA_SECTION).toMatch(/link_measures/);
    expect(MEASURE_FORMULA_SECTION).toMatch(/a link the formula already makes is refused/);
  });
});

describe("periods that end at the last full month", () => {
  const FULL = ["last_3_full_months", "last_12_full_months", "year_to_last_full_month"];

  it("the list is the backend's, on every request that takes a period", () => {
    for (const model of ["MeasureQueryItem", "TopRowsRequest"]) {
      const period = snapshot.components.schemas[model].properties!.period;
      const enumeration = period.anyOf.find((o: { enum?: string[] }) => o.enum).enum;
      expect(enumeration, model).toEqual([...PERIOD_PRESETS]);
    }
  });

  it("every tool that takes a period names the three new ones and what sets them apart", () => {
    const { descriptions, schemas } = setup();
    const texts: [string, string][] = [
      ["query_measures", descriptions.get("query_measures")!],
      ["list_measure_rows.period", schemas.get("list_measure_rows")!.period.description!],
      ["create_dashboard", descriptions.get("create_dashboard")!],
      ["update_dashboard", descriptions.get("update_dashboard")!],
    ];
    for (const [where, text] of texts) {
      for (const name of FULL) expect(text, where).toContain(name);
      expect(text, where).toMatch(/LAST FULL MONTH/);
    }
  });
});
