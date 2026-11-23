import { expect, it, vi } from "vitest";
import { z } from "zod";

import type { AxonityClient } from "../src/client.js";
import { registerAll } from "../src/index.js";

// axonity-flow#2576 part 7: an agent configures the new dashboard mechanics
// from the tool descriptions alone. The backend validates; this pins that the
// words for every new field reach create_dashboard and update_dashboard.
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

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
    get: vi.fn(async () => ({ ok: true })),
    post: vi.fn(async () => ({ ok: true })),
    put: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
  };
  registerAll(server as never, client as unknown as AxonityClient);
  const call = (name: string, args: Record<string, unknown>) =>
    handlers.get(name)!(z.object(schemas.get(name)!).parse(args));
  return { call, client, descriptions };
}

const TOOLS = ["create_dashboard", "update_dashboard"] as const;

it.each(TOOLS)("%s describes the statement tile (P&L)", (name) => {
  const text = setup().descriptions.get(name)!;
  for (const word of [
    "`statement`", "`config.rows`", "`style`", "subtotal", "total", "`indent`",
    "`config.statementColumns`", "period_change", "ytd_share_change", "`config.shareOf`",
    "20 lines", "L, XL or one of T, W, R",
  ]) {
    expect(text, word).toContain(word);
  }
});

it.each(TOOLS)("%s forwards a statement tile as given", async (name) => {
  const { call, client } = setup();
  const layout = {
    period: "last_month",
    sections: [{
      id: "s", title: "Finance",
      tiles: [{
        id: "pl", type: "statement", size: "XL",
        config: {
          shareOf: "Revenue",
          statementColumns: ["period", "period_change", "ytd", "ytd_change", "ytd_share", "ytd_share_change"],
          rows: [
            { label: "Revenue", measure: "revenue", style: "subtotal" },
            { label: "Logistics", measure: "logistics", indent: 1 },
            { label: "EBITDA", measure: "ebitda", style: "total" },
          ],
        },
      }],
    }],
  };
  await call(name, { ...(name === "update_dashboard" ? { id: "d1", expectedVersion: 2 } : {}), fields: { name: "Finance", layout } });
  const write = name === "create_dashboard" ? client.post : client.put;
  expect(write).toHaveBeenLastCalledWith(
    name === "create_dashboard" ? "/api/v1/dashboards" : "/api/v1/dashboards/d1",
    expect.objectContaining({ layout }),
  );
});

it.each(TOOLS)("%s describes the section mechanics and the arranging fields", (name) => {
  const text = setup().descriptions.get(name)!;
  for (const word of [
    "`layout.overview`", "`section.answer`", "400", "`section.collapse`", "open", "closed",
    "`section.phoneOrder`", "\"T\"", "\"W\"", "\"R\"", "worst status",
  ]) {
    expect(text, word).toContain(word);
  }
});

it.each(TOOLS)("%s describes the viewer's period per tile and the marker lines", (name) => {
  const text = setup().descriptions.get(name)!;
  for (const word of ["tile.<id>", "split=", "marker line", "not saved"]) {
    expect(text, word).toContain(word);
  }
});

it.each(TOOLS)("%s says what the backend and the screen actually do (review of axonity-flow#2587)", (name) => {
  const text = setup().descriptions.get(name)!;
  // A gap under a short tile beside a tall one stays: "never" was not true.
  expect(text).not.toContain("never sees holes");
  expect(text).toContain("a gap under a short tile beside a tall one stays");
  // A statement reads the dashboard's period; the backend refuses its own.
  expect(text).toContain("a statement sets no period, start, end, measure or statusMeasure");
  // The drill needs a table, named on the tile: a line's own table does not travel.
  expect(text).not.toContain("tableId?");
  expect(text).toContain("`config.tableId` on the tile");
  // Null is not "empty": the field is left out.
  expect(text).toContain("leave a field out to clear it; null is refused");
});
