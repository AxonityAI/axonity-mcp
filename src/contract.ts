/**
 * Asking the deploy what it can do, once, at startup (axonity-mcp#48 M2).
 *
 * `src/errors.ts` already turns a 404/405 into a "backend version skew" message
 * — but only AFTER the call has failed, which means a user is mid-task on the
 * one call that mattered. And it decides which 404s count from `ROUTES_ADDED_IN`,
 * a list this repository keeps by hand about routes the server owns. That is the
 * shape of #32 and #44, and it has the same failure mode: a route added here
 * without an entry there reports as "no such id" forever.
 *
 * `GET /api/v1/contract` (axonity-flow#806) is the proactive replacement. It
 * returns every mounted route, derived from the running app so it cannot drift,
 * plus a hash to cache on. It is authenticated but TENANT-AGNOSTIC — a
 * read-only service token is enough, so this check never needs write scope.
 *
 * WHAT THIS DOES NOT DO: fail. A connector that refuses to start because it
 * could not reach a diagnostic endpoint is worse than the drift it reports —
 * every path here degrades to today's behaviour, including a backend too old to
 * serve `/contract` at all. Everything it says goes to STDERR, because stdout is
 * the MCP channel and a stray byte there breaks the protocol.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AxonityClient } from "./client.js";
import { AxonityApiError, ROUTES_ADDED_IN } from "./errors.js";

/** `GET /api/v1/contract`. `routes` are "METHOD /path/{template}" strings. */
export interface ContractResponse {
  buildVersion?: unknown;
  environment?: unknown;
  routes?: unknown;
  contractHash?: unknown;
}

/** The minimal `.tool()` surface the registrar needs — same shape as index.ts. */
export interface ProbeServer {
  tool: (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (args: never) => Promise<unknown>,
  ) => void;
}

/**
 * One filled-in value per argument name any tool takes, so a blind replay
 * reaches as much of the route surface as possible.
 *
 * This is how the connector knows which routes it needs WITHOUT keeping a list
 * of them: it runs its own tools against a recording client and watches. A
 * hand-written route list would be the very thing #48 M2 exists to delete.
 *
 * Shared with `conformance.test.ts` and `exclusions.test.ts` deliberately. They
 * each carried their own copy, the copies had to be edited in lockstep, and a
 * probe fixture that has drifted silently narrows what the sweep reaches.
 */
export const PROBE_ARGS: Record<string, unknown> = {
  id: "x", workflowId: "x", agentId: "x", toolId: "x", runId: "x", approvalId: "x",
  flowId: "x", snippetId: "x", flowStepId: "x", linkId: "x", webhookId: "x",
  scheduleId: "x", triggerId: "x", secretId: "x", versionId: "x", version: 1,
  majorVersion: 1, expectedVersion: 1, displayOrder: 0, name: "x",
  cronExpr: "0 0 * * *", conditionText: "x", repeatIntervalMinutes: 5,
  target: "system", confirm: true, document: {}, fields: {},
  mutations: [{ type: "add_step", payload: {} }], snippetIds: ["a"], runIds: ["a"],
  workflows: [{ id: "x", expectedVersion: 1 }],
  functions: [{ name: "f", code: "def f(): pass" }], code: "x",
  requests: [{ entityType: "tool", entityId: "x" }],
  entityKind: "skill", entityId: "x", batchId: "x", stepId: "x", answer: "x",
  message: "x", templateId: "x", releaseId: "x", payload: {},
  toolboxId: "x", toolIds: ["t-1"], authConfig: null, description: "x",
};

/** A route a tool actually called, as observed by the recording client. */
export interface CalledRoute {
  method: string;
  path: string;
}

/**
 * Every route this build's tools call, found by replaying them.
 *
 * Nothing leaves the process: the client is a recorder. A handler that rejects
 * the probe arguments is simply skipped — it contributes no route, which makes
 * this a LOWER bound on what the connector needs and therefore safe: the check
 * can miss a route, but it cannot invent one.
 */
export async function collectCalledRoutes(
  register: (server: ProbeServer, client: AxonityClient) => void,
): Promise<CalledRoute[]> {
  const calls: CalledRoute[] = [];
  const record = (method: string) => async (path: string) => {
    calls.push({ method, path });
    return {} as never;
  };
  const recorder = {
    get: record("GET"),
    post: record("POST"),
    put: record("PUT"),
    patch: record("PATCH"),
    del: record("DELETE"),
  } as unknown as AxonityClient;

  const handlers: ((args: never) => Promise<unknown>)[] = [];
  register({ tool: (_n, _d, _s, handler) => handlers.push(handler) }, recorder);

  for (const handler of handlers) {
    try {
      await handler(PROBE_ARGS as never);
    } catch {
      /* Arg-shape mismatch is fine — only routes that fired are collected. */
    }
  }
  return calls;
}

/** Split a path into segments, dropping any query string. */
function segments(path: string): string[] {
  return path.split("?")[0].replace(/^\/+|\/+$/g, "").split("/");
}

/** Does a concrete path match a "METHOD /a/{b}/c" contract entry? */
export function matchesRoute(call: CalledRoute, entry: string): boolean {
  const space = entry.indexOf(" ");
  if (space < 0) return false;
  if (entry.slice(0, space).toUpperCase() !== call.method.toUpperCase()) return false;

  const template = segments(entry.slice(space + 1));
  const actual = segments(call.path);
  return (
    template.length === actual.length &&
    template.every(
      (part, i) => (part.startsWith("{") && part.endsWith("}")) || part === actual[i],
    )
  );
}

/**
 * Routes this build needs that the deploy does not mount, as "METHOD /path".
 *
 * Deduplicated by template rather than by concrete path: `read_workflow` and
 * `update_workflow` both hit `/workflows/{id}`, and reporting one absence twice
 * makes a short list look like an emergency.
 */
export function missingFromContract(
  calls: CalledRoute[],
  routes: string[],
): string[] {
  const missing = new Set<string>();
  for (const call of calls) {
    if (routes.some((entry) => matchesRoute(call, entry))) continue;
    missing.add(`${call.method} ${call.path}`);
  }
  return [...missing].sort();
}

/**
 * What added a route, when this repository happens to know.
 *
 * `ROUTES_ADDED_IN` stops being a source of truth here and becomes ANNOTATION:
 * the contract check has already established that a route is missing, and this
 * only enriches the sentence. An entry that is absent costs a clause, not a
 * wrong answer — which is the whole difference from using it to DECIDE whether
 * a 404 counts.
 */
function attribute(route: string): string {
  const path = route.slice(route.indexOf(" ") + 1);
  const known = ROUTES_ADDED_IN.find((entry) => entry.pattern.test(path));
  return known ? `${route}  — added by ${known.addedBy}` : route;
}

/** Where the "already checked this contract" marker lives, per API URL. */
function cachePath(apiUrl: string): string {
  // Not a security boundary and not precious: a lost cache costs one replay.
  const key = Buffer.from(apiUrl).toString("base64url").slice(0, 40);
  return join(tmpdir(), `axonity-mcp-contract-${key}.json`);
}

function readCachedHash(apiUrl: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(cachePath(apiUrl), "utf8")) as {
      contractHash?: unknown;
    };
    return typeof raw.contractHash === "string" ? raw.contractHash : undefined;
  } catch {
    return undefined;
  }
}

function writeCachedHash(apiUrl: string, contractHash: string): void {
  try {
    writeFileSync(cachePath(apiUrl), JSON.stringify({ contractHash }));
  } catch {
    /* A cache that cannot be written is a slower startup, not a failure. */
  }
}

/** Resolve `promise`, or `undefined` if it takes longer than `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
        // Do not hold the process open for a check that is already too late.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ContractCheckOptions {
  /** Base URL, used to key the cache so two tenants do not share a verdict. */
  apiUrl: string;
  /** Where to write the report. Defaults to stderr — stdout is the MCP channel. */
  log?: (message: string) => void;
  /** How long to wait before giving up on the check. Defaults to 5s. */
  timeoutMs?: number;
  /** Skip the cache. Used by tests, and by a caller that wants a fresh verdict. */
  ignoreCache?: boolean;
}

/**
 * Ask the deploy what it mounts, and say — once, at startup — whether this
 * build needs anything it does not have.
 *
 * Returns what it concluded, so a caller (and a test) can tell "checked, all
 * present" from "could not check". Never throws.
 */
export async function reportContractSkew(
  client: AxonityClient,
  register: (server: ProbeServer, client: AxonityClient) => void,
  options: ContractCheckOptions,
): Promise<"ok" | "missing" | "unavailable" | "cached" | "timeout"> {
  const log = options.log ?? ((message: string) => console.error(message));

  let contract: ContractResponse | undefined;
  try {
    contract = await withTimeout(
      client.get<ContractResponse>("/api/v1/contract"),
      options.timeoutMs ?? 5_000,
    );
  } catch (cause) {
    // A backend too old to serve /contract must degrade to today's behaviour,
    // not announce a problem it cannot substantiate. 404/405 is exactly that
    // backend; anything else (401, network) will surface on the first real call
    // with a better message than this check could write.
    const status = cause instanceof AxonityApiError ? cause.status : 0;
    if (status !== 404 && status !== 405 && status !== 0) {
      log(
        `Axonity: could not read the backend contract (${status}). ` +
          "Continuing — this is a diagnostic, not a dependency.",
      );
    }
    return "unavailable";
  }

  if (contract === undefined) return "timeout";

  const routes = Array.isArray(contract.routes)
    ? contract.routes.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (routes.length === 0) return "unavailable";

  const hash = typeof contract.contractHash === "string" ? contract.contractHash : "";
  if (!options.ignoreCache && hash && readCachedHash(options.apiUrl) === hash) {
    return "cached";
  }

  const missing = missingFromContract(await collectCalledRoutes(register), routes);

  if (missing.length === 0) {
    // Only a CLEAN result is cached. Caching a problem would report it once and
    // then go quiet, which is worse than never having checked.
    if (hash) writeCachedHash(options.apiUrl, hash);
    return "ok";
  }

  const build =
    typeof contract.buildVersion === "string" ? contract.buildVersion : "unknown";
  const environment =
    typeof contract.environment === "string" ? contract.environment : "unknown";

  log(
    `Axonity: this backend does not have ${missing.length} route(s) this ` +
      `connector needs.\n` +
      `  Backend: ${build} (${environment}) at ${options.apiUrl}\n` +
      missing.map((route) => `  - ${attribute(route)}`).join("\n") +
      `\nThe backend is OLDER than this connector. Tools that use those routes ` +
      `will fail; everything else works. Tell your human which Axonity ` +
      `environment this token points at, or pin an older connector.`,
  );
  return "missing";
}
