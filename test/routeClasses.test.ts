import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { TOKEN_ROUTE_CLASSES } from "../src/generated/tokenRouteClasses.js";
import { registerAll, registerHosted } from "../src/index.js";
import {
  BUILD_DRAFTS,
  NOT_IN_TABLE,
  RUN_ACTIONS,
  type TokenRoute,
  forPersonalTokens,
  personalTokenDescription,
  reachOf,
  recordTools,
  routeLookup,
  routesPerTool,
} from "../src/routeClasses.js";
// @ts-expect-error — a plain .mjs script, imported for its renderer
import { renderModule } from "../scripts/generate-token-route-classes.mjs";

/**
 * The hosted connector words every tool with what a personal token may do on
 * the routes it calls — from the backend's table, pinned as a fixture.
 */

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/token-route-classes.snapshot.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, TokenRoute>;

const routes = await routesPerTool(registerHosted);
const recorded = recordTools(registerHosted, {} as AxonityClient);
const hosted = forPersonalTokens(recorded, routes, TOKEN_ROUTE_CLASSES);
const byName = new Map(hosted.map((t) => [t.name, t]));
const lookup = routeLookup(TOKEN_ROUTE_CLASSES);

describe("the pinned table", () => {
  it("the generated module is the fixture, rendered (run the generator after a refresh)", () => {
    const committed = readFileSync(
      fileURLToPath(new URL("../src/generated/tokenRouteClasses.ts", import.meta.url)),
      "utf8",
    );
    expect(committed).toBe(renderModule(fixture));
  });

  it("every route a hosted tool calls has a row — a missing one means the table moved", () => {
    const missing = new Set<string>();
    for (const calls of routes.values()) {
      for (const call of calls) if (!lookup(call)) missing.add(`${call.method} ${call.path}`);
    }
    expect([...missing], "refresh with: node scripts/generate-token-route-classes.mjs --flow <axonity-flow>").toEqual([]);
  });

  it("the replay reaches most tools, so the texts are not built on an empty sweep", () => {
    const reached = [...routes.values()].filter((calls) => calls.length > 0).length;
    expect(reached).toBeGreaterThan(400);
  });
});

describe("every hosted tool says what a personal token needs, before the call", () => {
  it("no tool is dropped and no handler or shape changes: only the text", () => {
    expect(hosted.map((t) => t.name)).toEqual(recorded.map((t) => t.name));
    hosted.forEach((tool, i) => {
      expect(tool.handler).toBe(recorded[i].handler);
      expect(tool.shape).toBe(recorded[i].shape);
    });
  });

  it("the invariant over all tools: the text follows the classes of the routes it calls", () => {
    for (const tool of hosted) {
      const original = recorded.find((t) => t.name === tool.name)!.description;
      const reach = reachOf(routes.get(tool.name) ?? [], lookup);
      if (reach.closed.length > 0) {
        expect(tool.description, tool.name).toMatch(/^NOT AVAILABLE WITH A PERSONAL TOKEN: closed to tokens \(/);
        for (const why of reach.closed) expect(tool.description, tool.name).toContain(why);
      } else if (reach.actions || reach.change) {
        expect(tool.description, tool.name).toMatch(/^WITH A PERSONAL TOKEN this needs /);
        expect(tool.description.includes(`'${RUN_ACTIONS}'`), tool.name).toBe(reach.actions);
        expect(tool.description.includes(`'${BUILD_DRAFTS}'`), tool.name).toBe(reach.change);
        expect(tool.description.endsWith(original), tool.name).toBe(true);
      } else {
        expect(tool.description, tool.name).toBe(original);
      }
    }
  });

  it("a closed tool says why, in the table's own words", () => {
    expect(byName.get("delete_workflow")!.description).toContain("delete: configuration without an approval step");
    expect(byName.get("list_secrets")!.description).toMatch(/^NOT AVAILABLE WITH A PERSONAL TOKEN/);
    expect(byName.get("create_cron_schedule")!.description).toMatch(/^NOT AVAILABLE WITH A PERSONAL TOKEN/);
  });

  it("an action says 'Run actions', a draft says 'Build drafts…', a read is unchanged", () => {
    expect(byName.get("start_workflow_run")!.description).toContain(`'${RUN_ACTIONS}'`);
    expect(byName.get("create_workflow")!.description).toContain(`'${BUILD_DRAFTS}'`);
    const listWorkflows = recorded.find((t) => t.name === "list_workflows")!;
    expect(byName.get("list_workflows")!.description).toBe(listWorkflows.description);
  });

  it("the local connector's texts are untouched", () => {
    const local = recordTools((s, c) => registerAll(s as never, c), {} as AxonityClient);
    for (const tool of local) expect(tool.description, tool.name).not.toMatch(/PERSONAL TOKEN/);
  });
});

describe("the parts", () => {
  it("a literal segment wins over a parameter", () => {
    const table: Record<string, TokenRoute> = {
      "GET /api/v1/agents/{agent_id}": { class: "lezen" },
      "GET /api/v1/agents/deleted": { class: "dicht", why: "deleted list" },
    };
    const find = routeLookup(table);
    expect(find({ method: "GET", path: "/api/v1/agents/deleted" })!.key).toBe("GET /api/v1/agents/deleted");
    expect(find({ method: "GET", path: "/api/v1/agents/ag-1?x=1" })!.key).toBe("GET /api/v1/agents/{agent_id}");
    expect(find({ method: "POST", path: "/api/v1/agents/ag-1" })).toBeUndefined();
  });

  it("a route the table does not know is closed, as the backend treats it", () => {
    const reach = reachOf([{ method: "GET", path: "/api/v1/nowhere" }], routeLookup({}));
    expect(reach.closed).toEqual([NOT_IN_TABLE]);
  });

  it("an administrator-only action names the role as well", () => {
    const reach = reachOf(
      [{ method: "POST", path: "/api/v1/runs/r1/restart" }],
      routeLookup({ "POST /api/v1/runs/{run_id}/restart": { class: "actie_beheerder" } }),
    );
    expect(reach).toMatchObject({ actions: true, admin: true, change: false, closed: [] });
    expect(personalTokenDescription("Restart a run.", reach)).toBe(
      `WITH A PERSONAL TOKEN this needs '${RUN_ACTIONS}' switched on for the token and an ` +
        "administrator role in this workspace.\n\nRestart a run.",
    );
  });

  it("closed wins over everything else a tool calls, and keeps only the first sentence", () => {
    const text = personalTokenDescription("Delete it. Long manual follows.", {
      closed: ["b", "a"],
      actions: true,
      admin: false,
      change: true,
    });
    expect(text).toBe(
      "NOT AVAILABLE WITH A PERSONAL TOKEN: closed to tokens (b; a). A person does this in " +
        "Axonity in the browser; a call is refused. What it does: Delete it.",
    );
  });

  it("the renderer refuses a class it does not know", () => {
    expect(() => renderModule({ "GET /x": { class: "open" } })).toThrow(/unknown class/);
  });
});
