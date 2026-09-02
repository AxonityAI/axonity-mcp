/**
 * #48 — the connector cannot fall behind the platform without someone finding
 * out.
 *
 * #45 caught the connector up to what the backend grew. This is the layer under
 * it: every drift guard in this repository reads the vendored snapshot, which
 * made them exactly as fresh as the last time a person remembered to run a
 * script. They did not remember — the snapshot sat nine operations behind
 * `axonity-flow@main`, `conformance.test.ts` was green throughout, and two of
 * those nine were the routes #45 M7 was built on.
 *
 * So these tests are about the MECHANISMS, not about any one route:
 *   M1  the drift script sees a stale snapshot, and says what moved
 *   M2  the startup contract check reports a gap before the first tool call,
 *       and degrades on every path where it cannot know
 *   M4  the list filters are generated from the schema, so the eleventh arrives
 *       without anyone editing this repository
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import {
  collectCalledRoutes,
  matchesRoute,
  missingFromContract,
  reportContractSkew,
} from "../src/contract.js";
import { NotFoundError, AxonityApiError } from "../src/errors.js";
import { LIST_FILTERS } from "../src/generated/listFilters.js";
import { registerAll } from "../src/index.js";
import { diffOperations, operationShape } from "../scripts/check-contract-drift.mjs";
import { buildTable, render, staleNotes, toArgName, toFilterType } from "../scripts/generate-list-filters.mjs";

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/openapi.snapshot.json", import.meta.url)),
    "utf8",
  ),
);

// ---------------------------------------------------------------------------
// M1 — the snapshot cannot go stale unnoticed
// ---------------------------------------------------------------------------

describe("the drift check sees what a person would not (M1)", () => {
  it("is quiet when the two schemas agree", () => {
    expect(diffOperations(snapshot, snapshot)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it("names an added route, which is the case that went unnoticed", () => {
    // The failure mode this exists for: a route the connector does NOT call yet.
    // Nothing in the test suite reacts to one, because no tool references it —
    // and #45 M7 was two such routes, available and invisible for weeks.
    const fresh = structuredClone(snapshot);
    fresh.paths["/api/v1/brand-new"] = { get: { responses: { 200: {} } } };

    const diff = diffOperations(snapshot, fresh);
    expect(diff.added).toEqual(["GET /api/v1/brand-new"]);
    expect(diff.removed).toEqual([]);
  });

  it("names a removed route", () => {
    const fresh = structuredClone(snapshot);
    delete fresh.paths["/api/v1/workflows/callable"];

    expect(diffOperations(snapshot, fresh).removed).toEqual([
      "GET /api/v1/workflows/callable",
    ]);
  });

  it("notices a route whose CONTRACT moved while its path did not", () => {
    // The shape change #45 M5 describes — `trigger-parameters` went from
    // array<object> to an object — renames nothing and removes nothing. The
    // issue says plainly that no test in either repository catches it.
    const fresh = structuredClone(snapshot);
    fresh.paths["/api/v1/workflows/{workflow_id}/trigger-parameters"].get.responses[
      "200"
    ].content["application/json"].schema = { $ref: "#/components/schemas/Something" };

    expect(diffOperations(snapshot, fresh).changed).toEqual([
      "GET /api/v1/workflows/{workflow_id}/trigger-parameters",
    ]);
  });

  it("ignores a changed description, so the job does not cry wolf", () => {
    // Backend docstrings change constantly. A watchdog that fires on prose gets
    // muted, and a muted watchdog is the thing this epic is replacing.
    const fresh = structuredClone(snapshot);
    fresh.paths["/api/v1/workflows/callable"].get.description = "totally new words";

    expect(diffOperations(snapshot, fresh)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it("compares what a caller can break against", () => {
    const base = { parameters: [{ name: "b", in: "query" }, { name: "a", in: "query" }] };
    // Query parameters are compared as a SET — declaration order is not contract.
    expect(operationShape(base)).toBe(
      operationShape({ parameters: [{ name: "a", in: "query" }, { name: "b", in: "query" }] }),
    );
    // A path parameter is not a caller's choice, so it is not part of the shape.
    expect(operationShape(base)).toBe(
      operationShape({ ...base, parameters: [...base.parameters, { name: "id", in: "path" }] }),
    );
    // A new query parameter is.
    expect(operationShape(base)).not.toBe(
      operationShape({ parameters: [...base.parameters, { name: "c", in: "query" }] }),
    );
  });
});

// ---------------------------------------------------------------------------
// M2 — the connector asks the deploy what it can do
// ---------------------------------------------------------------------------

/** A client whose only live route is /contract, answering what the test says. */
function contractClient(answer: unknown | (() => never)) {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/api/v1/contract") {
        if (typeof answer === "function") (answer as () => never)();
        return answer;
      }
      return {};
    }),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    del: vi.fn(async () => ({})),
  } as unknown as AxonityClient;
}

/** Every route this build calls, as contract-style "METHOD /template" entries. */
async function everyRouteThisBuildNeeds(): Promise<string[]> {
  const calls = await collectCalledRoutes((server, client) =>
    registerAll(server as never, client),
  );
  // The contract speaks in templates; the replay produces concrete paths. Using
  // the concrete paths AS templates is fine here — matchesRoute compares
  // segment by segment and a literal segment matches itself.
  return [...new Set(calls.map((c) => `${c.method} ${c.path}`))];
}

describe("the connector asks the deploy what it can do (M2)", () => {
  it("matches a concrete call against a templated contract entry", () => {
    const call = { method: "GET", path: "/api/v1/workflows/wf-1/runs" };
    expect(matchesRoute(call, "GET /api/v1/workflows/{workflow_id}/runs")).toBe(true);
    // Method must agree.
    expect(matchesRoute(call, "POST /api/v1/workflows/{workflow_id}/runs")).toBe(false);
    // Segment count must agree — a template is not a prefix.
    expect(matchesRoute(call, "GET /api/v1/workflows/{workflow_id}")).toBe(false);
    // A literal segment must match literally, or `/runs` would match `/cost`.
    expect(matchesRoute(call, "GET /api/v1/workflows/{workflow_id}/cost")).toBe(false);
  });

  it("reports nothing when the deploy mounts everything this build calls", async () => {
    const log = vi.fn();
    const result = await reportContractSkew(
      contractClient({
        buildVersion: "abc1234",
        environment: "staging",
        contractHash: "h1",
        routes: await everyRouteThisBuildNeeds(),
      }),
      (server, client) => registerAll(server as never, client),
      { apiUrl: "https://api.test", log, ignoreCache: true },
    );

    expect(result).toBe("ok");
    expect(log).not.toHaveBeenCalled();
  });

  it("names the missing route, and what added it, before any tool runs", async () => {
    const routes = (await everyRouteThisBuildNeeds()).filter(
      (route) => !route.includes("/workflows/operations"),
    );
    const log = vi.fn();

    const result = await reportContractSkew(
      contractClient({
        buildVersion: "old0000",
        environment: "production",
        contractHash: "h2",
        routes,
      }),
      (server, client) => registerAll(server as never, client),
      { apiUrl: "https://api.test", log, ignoreCache: true },
    );

    expect(result).toBe("missing");
    const message = log.mock.calls[0][0] as string;
    expect(message).toContain("/api/v1/workflows/operations");
    expect(message).toContain("old0000");
    expect(message).toContain("production");
    // ROUTES_ADDED_IN is annotation now — it enriches a verdict the contract
    // check already reached, rather than deciding whether a 404 counted.
    expect(message).toContain("axonity-flow#802");
    expect(message).toMatch(/OLDER than this connector/);
  });

  it("degrades silently on a backend too old to serve /contract", async () => {
    // The route landed in axonity-flow#806. An older backend 404s, and that is
    // not a problem to announce — it is the situation `BackendVersionSkewError`
    // still covers reactively.
    const log = vi.fn();
    const result = await reportContractSkew(
      contractClient(() => {
        throw new NotFoundError("no such route", {});
      }),
      (server, client) => registerAll(server as never, client),
      { apiUrl: "https://api.test", log, ignoreCache: true },
    );

    expect(result).toBe("unavailable");
    expect(log).not.toHaveBeenCalled();
  });

  it("says so, once, when the check itself fails for another reason", async () => {
    const log = vi.fn();
    const result = await reportContractSkew(
      contractClient(() => {
        throw new AxonityApiError("boom", 503);
      }),
      (server, client) => registerAll(server as never, client),
      { apiUrl: "https://api.test", log, ignoreCache: true },
    );

    expect(result).toBe("unavailable");
    expect(log).toHaveBeenCalledTimes(1);
    // A diagnostic that cannot run must not read as a verdict about the deploy.
    expect(log.mock.calls[0][0]).toMatch(/diagnostic, not a dependency/);
  });

  it("gives up rather than holding startup open", async () => {
    const log = vi.fn();
    const client = {
      get: vi.fn(() => new Promise(() => {})),
    } as unknown as AxonityClient;

    const result = await reportContractSkew(
      client,
      (server, c) => registerAll(server as never, c),
      { apiUrl: "https://api.test", log, ignoreCache: true, timeoutMs: 20 },
    );

    expect(result).toBe("timeout");
    expect(log).not.toHaveBeenCalled();
  });

  it("needs no write scope — the check issues GETs only", async () => {
    const client = contractClient({ contractHash: "h", routes: ["GET /api/v1/x"] });
    await reportContractSkew(
      client,
      (server, c) => registerAll(server as never, c),
      { apiUrl: "https://api.test", log: vi.fn(), ignoreCache: true },
    );
    // The REPLAY runs against its own recorder, so nothing a tool does can leave
    // the process. The real client sees exactly one request, and it is a GET.
    expect(client.post).not.toHaveBeenCalled();
    expect(client.put).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it("collects routes without letting a single tool reach the network", async () => {
    const calls = await collectCalledRoutes((server, client) =>
      registerAll(server as never, client),
    );
    // A lower bound is safe; an empty one means the probe stopped working.
    expect(calls.length).toBeGreaterThan(80);
    expect(calls.every((c) => c.path.startsWith("/api/v1/"))).toBe(true);
  });

  it("does not report the same absence twice for two tools on one route", () => {
    const calls = [
      { method: "GET", path: "/api/v1/workflows/x" },
      { method: "GET", path: "/api/v1/workflows/x" },
    ];
    expect(missingFromContract(calls, [])).toEqual(["GET /api/v1/workflows/x"]);
  });
});

// ---------------------------------------------------------------------------
// M4 — a list asks the server to filter
// ---------------------------------------------------------------------------

describe("list filters are generated, not kept (M4)", () => {
  it("is up to date with the pinned snapshot", () => {
    // The point of the whole story: refresh the snapshot, regenerate, and the
    // eleventh filter is exposed without anyone editing a list. This fails when
    // the two have parted, which is the only way that can go wrong quietly.
    const generated = readFileSync(
      fileURLToPath(new URL("../src/generated/listFilters.ts", import.meta.url)),
      "utf8",
    );
    expect(
      generated,
      "run `npm run generate:filters` — the snapshot moved and the table did not",
    ).toBe(render(snapshot));
  });

  it("exposes every query filter the schema declares, and no paging key", () => {
    const table = buildTable(snapshot);
    for (const [entity, filters] of Object.entries(table)) {
      expect(LIST_FILTERS[entity]).toEqual(filters);
      for (const filter of filters) {
        expect(["limit", "offset", "cursor"]).not.toContain(filter.query);
      }
    }
    // Sanity: the ten #45 M9(3) found by hand are in here, plus `deleted` on
    // prompt snippets, which that story deliberately skipped and the mechanism
    // picks up for free — which is the argument for the mechanism.
    //
    // `data_table` is that argument paying again (#63). Its three narrowings —
    // name, status, isDynamic — were declared on the backend and reached the
    // tools with no filter written here: `LIST_ROUTES` gained one line naming
    // the route, and the names, types and prose came out of the schema. On a
    // PAGED list they matter more than anywhere else, because the alternative
    // to "is there one called X?" in one call is a walk through every page.
    expect(Object.keys(table).sort()).toEqual([
      "agent",
      "data_table",
      "policy",
      "prompt_snippet",
      "reference_doc",
      "workflow",
    ]);
    expect(table.data_table.map((f) => f.query)).toEqual([
      "name",
      "status",
      "is_dynamic",
    ]);
    expect(table.prompt_snippet.map((f) => f.query)).toEqual(["deleted"]);
  });

  it("translates the route's spelling to a camelCase argument", () => {
    expect(toArgName("owner_id")).toBe("ownerId");
    expect(toArgName("capability_id")).toBe("capabilityId");
    // Already camelCase on the wire — a real inconsistency, left alone.
    expect(toArgName("includeSystem")).toBe("includeSystem");
  });

  it("reads a boolean out of the nullable shape FastAPI emits", () => {
    expect(toFilterType({ type: "boolean", default: false })).toBe("boolean");
    expect(toFilterType({ anyOf: [{ type: "boolean" }, { type: "null" }] })).toBe(
      "boolean",
    );
    expect(toFilterType({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe(
      "string",
    );
  });

  it("has no note describing a filter the schema no longer carries", () => {
    // A note is annotation, so it may be absent. It may not be WRONG: prose
    // about a filter that no longer exists is the drift this epic is about,
    // one level down.
    expect(staleNotes(snapshot)).toEqual([]);
  });
});
