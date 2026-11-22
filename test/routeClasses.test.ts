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
  SERVICE_TOKEN_WORDING,
  type TokenRoute,
  forPersonalTokens,
  personalTokenDescription,
  reachOf,
  recordTools,
  routeLookup,
  routesPerTool,
  withoutServiceTokenWording,
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
      // Apart from the service-token wording (below), a text is what the tool wrote.
      const original = withoutServiceTokenWording(
        recorded.find((t) => t.name === tool.name)!.description,
      );
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

/**
 * A personal token has no scopes and is not a service token. The local texts
 * say what a service token needs ("Needs a token with the `author` scope"),
 * and those sentences stay there; the hosted text says what the table says,
 * once, in the prefix. Backend: a personal token has two switches ("Run
 * actions", "Build drafts…"), carries its person's live role
 * (`auth/dependencies.py` resolve_personal_token, role=identity.role) and may
 * only continue a Dashboard Analyst conversation it started itself
 * (`run_service.py` _refuse_a_token_a_conversation).
 */
describe("a hosted text never talks of scopes or service tokens the backend does not apply", () => {
  const flat = (name: string) => byName.get(name)!.description.replace(/\s+/g, " ");
  // Written apart from the rules, so a rule that rots does not hide its own gap.
  const WRONG =
    /needs a token with the `\w+` scope|service token (lacks|is read-only)|other write scopes|any token they minted|refused for every token|always counts as a member/i;

  it("the invariant over every tool: none says what only a service token would meet", () => {
    const offenders = hosted.filter((t) => WRONG.test(t.description)).map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  it("each rule is still needed: some local text carries the wording it removes", () => {
    for (const rule of SERVICE_TOKEN_WORDING) {
      expect(
        recorded.some((t) => rule.match.test(t.description)),
        String(rule.match),
      ).toBe(true);
    }
  });

  it("what the table says stays: the choice a tool needs is named first", () => {
    expect(byName.get("send_run_message")!.description).toMatch(/^WITH A PERSONAL TOKEN this needs 'Run actions'/);
    expect(byName.get("upload_run_input_file")!.description).toMatch(/^WITH A PERSONAL TOKEN this needs 'Run actions'/);
    expect(byName.get("start_conversation")!.description).toMatch(/^WITH A PERSONAL TOKEN this needs 'Run actions'/);
  });

  it("start_conversation: the true rule for continuing, the refusals that still hold", () => {
    const d = flat("start_conversation");
    expect(d).toMatch(/through the token that started it/);
    expect(d).toMatch(/any other token of theirs is refused/);
    expect(d).toContain("404 when the dashboard does not exist");
    expect(d).toContain("403 with the module's own sentence");
    expect(d).toMatch(/; 422 for an oversized focus\.$/);
  });

  it("send_run_message, upload_run_input_file, validate_workflow: the scope sentence is gone, the rest is not", () => {
    expect(flat("send_run_message")).toMatch(/the person who opened it\.$/);
    expect(flat("upload_run_input_file")).toContain("Nothing runs; the file is only stored. USE THE REFERENCE");
    const validate = byName.get("validate_workflow")!.description;
    expect(validate).toContain("This is the real 'can this run?'.\n- document");
  });

  it("read_application_executors: administrator only, by the person's role", () => {
    const d = flat("read_application_executors");
    expect(d).toContain("ADMINISTRATOR ONLY on the platform: a token acts with the role of the person who created it");
    expect(d).toContain("Do not retry");
  });

  it("the local connector keeps its service-token sentences", () => {
    const local = recordTools((s, c) => registerAll(s as never, c), {} as AxonityClient);
    const text = (n: string) => local.find((t) => t.name === n)!.description;
    expect(text("send_run_message")).toMatch(/Needs a token with the `operate` scope/);
    expect(text("start_conversation")).toMatch(/any token they minted/);
  });

  it("the parts: units are dropped or replaced, separators survive, nothing else moves", () => {
    const rules = [
      { match: /DROP/, why: "" },
      { match: /SWAP/, becomes: "Swapped.", why: "" },
    ];
    expect(withoutServiceTokenWording("A. DROP this. B.\n- C; D.", rules)).toBe("A. B.\n- C; D.");
    expect(withoutServiceTokenWording("A. DROP this.\n- B", rules)).toBe("A.\n- B");
    expect(withoutServiceTokenWording("A. SWAP this; B.", rules)).toBe("A. Swapped. B.");
    expect(withoutServiceTokenWording("DROP first. B.", rules)).toBe("B.");
    expect(withoutServiceTokenWording("A. e.g. DROP x; B.", rules)).toBe("A. B.");
    expect(withoutServiceTokenWording("Nothing here.", rules)).toBe("Nothing here.");
  });
});
