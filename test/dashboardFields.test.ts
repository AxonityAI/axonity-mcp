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

// axonity-flow#257 block 3: an agent sets up a dashboard of frames from the
// tool descriptions alone. The words follow the backend's validate_layout
// (frame, hero, coming, MAX_FRAME_FIGURES, sparkline bars).
it.each(TOOLS)("%s describes a section drawn as a frame", (name) => {
  const text = setup().descriptions.get(name)!;
  for (const word of [
    "`section.frame`", "`section.hero`", "`section.coming`",
    "at most 3 figures beside its hero", "200 characters", "short frame",
    "a number tile of that section", "only on a frame", "`sparkline` bars",
    "Coming to this pillar",
  ]) {
    expect(text, word).toContain(word);
  }
});

it.each(TOOLS)("%s says what the backend refuses on a frame", (name) => {
  const text = setup().descriptions.get(name)!;
  // Absent reads as "none" on screen, so null is refused (as in #2587).
  expect(text).toContain("null on frame, hero or coming is refused");
  // A section without frame looks as it does today; the limit holds only in a frame.
  expect(text).toContain("a section without `frame` looks as it does today");
  // A copy of the dashboard keeps its hero pointing at the copied tile.
  expect(text).toContain("a copy keeps its hero");
  // Bars set no grain: auto may open per week, so bars per month ask month (W1 5773d74c3).
  expect(text).toContain("grain_too_fine");
  expect(text).toContain("unless frame is true they are refused");
  expect(text).not.toContain("trend and bars for auto");
  // Review of axonity-flow#2644 S1: the hero's chart is per month unless
  // config.grain says otherwise (tileQueries heroChartQueryFor: grain ?? 'month').
  expect(text).toContain("PER MONTH unless the tile sets `config.grain`");
  expect(text).not.toContain("opens per week");
  // A short frame gets no card; without any hero the overview stays the list.
  expect(text).not.toContain("each frame becomes a card");
  expect(text).toContain("one card per frame WITH a hero; a short frame and a plain section get no card");
  expect(text).toContain("Without any hero the overview stays the list");
  // What a figure can be, and what a frame ignores.
  expect(text).toContain("A figure is a number tile");
  expect(text).toContain("or a note tile");
  expect(text).toContain("a frame ignores `collapse`, `card` and `phoneOrder`");
});

it.each(TOOLS)("%s forwards a dashboard of frames as given", async (name) => {
  const { call, client } = setup();
  const layout = {
    period: "this_year",
    overview: true,
    sections: [
      {
        id: "a", title: "Pillar A", frame: true, hero: "rev",
        coming: "Coming to this pillar: Revenue per market.",
        tiles: [
          { id: "rev", type: "number", size: "M", config: { measure: "revenue", sparkline: "bars", against: { measure: "revenue_plan", label: "Plan" } } },
          { id: "f1", type: "number", size: "S", config: { measure: "revenue_north" } },
          { id: "f2", type: "number", size: "S", config: { measure: "revenue_south" } },
          { id: "f3", type: "number", size: "S", config: { measure: "revenue_east" } },
        ],
      },
      {
        id: "d", title: "Pillar D", frame: true,
        tiles: [{ id: "o", type: "number", size: "S", config: { measure: "revenue_other" } }],
      },
    ],
  };
  await call(name, { ...(name === "update_dashboard" ? { id: "d1", expectedVersion: 2 } : {}), fields: { name: "Pillars", layout } });
  const write = name === "create_dashboard" ? client.post : client.put;
  expect(write).toHaveBeenLastCalledWith(
    name === "create_dashboard" ? "/api/v1/dashboards" : "/api/v1/dashboards/d1",
    expect.objectContaining({ layout }),
  );
});
