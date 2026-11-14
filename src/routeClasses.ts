/**
 * What a personal token may do with each tool, said BEFORE the call.
 *
 * A personal token (`axp_…`, axonity-flow `personal_access_tokens`) acts as one
 * person: it reads what that person reads, runs actions if its owner left "Run
 * actions" on, builds drafts and asks for publication if its owner left "Build
 * drafts and request publication" on, and every other route is closed to it.
 * The backend decides that per route and enforces it on every call
 * (`backend/src/auth/token_route_classes.py`). The hosted connector, which only
 * ever serves personal tokens, words each tool with it, so an agent reads up
 * front that a tool will be refused, and why, instead of finding out on the
 * call.
 *
 * NOTHING HERE DECIDES. The table is the backend's (generated into
 * `generated/tokenRouteClasses.ts`), and which routes a tool calls is found by
 * replaying the tool against a recording client — the same replay the startup
 * contract check uses (`contract.ts`), per tool. A tool keeps calling its
 * routes whatever its text says; the backend's answer is the authority, and a
 * route this replay does not reach is still refused there if it is closed.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { AxonityClient } from "./client.js";
import {
  type CalledRoute,
  PROBE_ARGS,
  PROBE_VARIANTS,
  type ProbeServer,
} from "./contract.js";

/** The five classes axonity-flow puts a route in for a personal token. */
export type RouteClass = "lezen" | "actie" | "actie_beheerder" | "configuratie" | "dicht";

/** One row of the backend's table. `why` is set on a closed route. */
export interface TokenRoute {
  class: RouteClass;
  why?: string;
}

/** The four arguments one `server.tool(...)` call registers. */
export interface RegisteredTool {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  handler: (args: never, extra: never) => Promise<unknown>;
}

/**
 * Every tool a registrar registers, as data, in registration order.
 *
 * Registering once and replaying the result is what keeps the hosted connector
 * cheap: building the 473 tools anew for every request cost ~15 MB per
 * request in flight (measured before the hosted mode was built).
 */
export function recordTools(
  register: (server: ProbeServer, client: AxonityClient) => void,
  client: AxonityClient,
): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  register(
    {
      tool: (name, description, shape, handler) =>
        tools.push({ name, description, shape, handler: handler as RegisteredTool["handler"] }),
    },
    client,
  );
  return tools;
}

/**
 * The routes each tool calls, by tool name, found by replaying every tool
 * with the probe arguments against a client that records and sends nothing.
 *
 * A lower bound, like `collectCalledRoutes`: a route a tool picks from an
 * argument the probes do not supply is not seen. That can only make a text
 * say less than the backend will enforce, never more.
 */
export async function routesPerTool(
  register: (server: ProbeServer, client: AxonityClient) => void,
): Promise<Map<string, CalledRoute[]>> {
  const current = new AsyncLocalStorage<string>();
  const seen = new Map<string, Map<string, CalledRoute>>();
  const record = (method: string) => async (path: string) => {
    const tool = current.getStore();
    if (tool !== undefined) {
      const calls = seen.get(tool) ?? new Map<string, CalledRoute>();
      calls.set(`${method} ${path}`, { method, path });
      seen.set(tool, calls);
    }
    return {} as never;
  };
  const recorder = {
    get: record("GET"),
    post: record("POST"),
    put: record("PUT"),
    patch: record("PATCH"),
    del: record("DELETE"),
  } as unknown as AxonityClient;

  const tools = recordTools(register, recorder);
  for (const overlay of PROBE_VARIANTS) {
    const args = { ...PROBE_ARGS, ...overlay } as never;
    for (const tool of tools) {
      try {
        await current.run(tool.name, () => tool.handler(args, {} as never));
      } catch {
        /* A handler that rejects the probe arguments contributes no route. */
      }
    }
  }
  const out = new Map<string, CalledRoute[]>();
  for (const tool of tools) out.set(tool.name, [...(seen.get(tool.name)?.values() ?? [])]);
  return out;
}

function segments(path: string): string[] {
  return path.split("?")[0].replace(/^\/+|\/+$/g, "").split("/");
}

/** A lookup from a concrete call to its row, templates split once. */
export function routeLookup(
  table: Readonly<Record<string, TokenRoute>>,
): (call: CalledRoute) => { key: string; row: TokenRoute } | undefined {
  const byMethod = new Map<string, { key: string; parts: string[]; row: TokenRoute }[]>();
  for (const [key, row] of Object.entries(table)) {
    const space = key.indexOf(" ");
    const method = key.slice(0, space).toUpperCase();
    const list = byMethod.get(method) ?? [];
    list.push({ key, parts: segments(key.slice(space + 1)), row });
    byMethod.set(method, list);
  }
  return (call) => {
    const actual = segments(call.path);
    // A literal segment beats a `{param}` one: `/agents/deleted` is its own
    // route, not `/agents/{agent_id}` with the id "deleted".
    let best: { key: string; row: TokenRoute; literals: number } | undefined;
    for (const entry of byMethod.get(call.method.toUpperCase()) ?? []) {
      if (entry.parts.length !== actual.length) continue;
      let literals = 0;
      const fits = entry.parts.every((part, i) => {
        if (part.startsWith("{") && part.endsWith("}")) return true;
        literals += 1;
        return part === actual[i];
      });
      if (fits && (!best || literals > best.literals)) {
        best = { key: entry.key, row: entry.row, literals };
      }
    }
    return best && { key: best.key, row: best.row };
  };
}

/** What a personal token needs to use a tool, from the routes it calls. */
export interface ToolReach {
  /** Why each closed route this tool calls is closed (deduplicated). */
  closed: string[];
  /** The owner's choice "Run actions" must be on. */
  actions: boolean;
  /** …and the person must be an administrator of the workspace. */
  admin: boolean;
  /** The owner's choice "Build drafts and request publication" must be on. */
  change: boolean;
}

/**
 * A route the table does not know is closed: that is the backend's own rule
 * ("a route that is not listed is closed, a GET included").
 */
export const NOT_IN_TABLE =
  "not in the route table this connector was built with, and a route the table does not list is closed";

export function reachOf(
  calls: CalledRoute[],
  lookup: ReturnType<typeof routeLookup>,
): ToolReach {
  const reach: ToolReach = { closed: [], actions: false, admin: false, change: false };
  const closed = new Set<string>();
  for (const call of calls) {
    const found = lookup(call);
    const row = found?.row ?? { class: "dicht", why: NOT_IN_TABLE };
    switch (row.class) {
      case "lezen":
        break;
      case "actie":
        reach.actions = true;
        break;
      case "actie_beheerder":
        reach.actions = true;
        reach.admin = true;
        break;
      case "configuratie":
        reach.change = true;
        break;
      case "dicht":
        closed.add(row.why ?? "closed to tokens");
        break;
    }
  }
  reach.closed = [...closed].sort();
  return reach;
}

/** The labels the token screen gives the owner's two choices. */
export const RUN_ACTIONS = "Run actions";
export const BUILD_DRAFTS = "Build drafts and request publication";

/** The first sentence of a description: enough to know what a closed tool is. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  return end < 0 ? flat : flat.slice(0, end + 1);
}

/**
 * The description a tool carries for a personal token.
 *
 * A tool on a closed route keeps only what it is, after why it is closed: the
 * rest of its text explains how to use something this token cannot use, and
 * every tool's text travels in every `tools/list`. A tool that needs a choice
 * says which, first. A read is unchanged.
 */
export function personalTokenDescription(description: string, reach: ToolReach): string {
  if (reach.closed.length > 0) {
    return (
      `NOT AVAILABLE WITH A PERSONAL TOKEN: closed to tokens (${reach.closed.join("; ")}). ` +
      "A person does this in Axonity in the browser; a call is refused. " +
      `What it does: ${firstSentence(description)}`
    );
  }
  const needs: string[] = [];
  if (reach.actions) needs.push(`'${RUN_ACTIONS}' switched on for the token`);
  if (reach.admin) needs.push("an administrator role in this workspace");
  if (reach.change) needs.push(`'${BUILD_DRAFTS}' switched on for the token`);
  if (needs.length === 0) return description;
  return `WITH A PERSONAL TOKEN this needs ${needs.join(" and ")}.\n\n${description}`;
}

/** The tools, worded for a personal token. Handlers and shapes are unchanged. */
export function forPersonalTokens(
  tools: RegisteredTool[],
  routes: Map<string, CalledRoute[]>,
  table: Readonly<Record<string, TokenRoute>>,
): RegisteredTool[] {
  const lookup = routeLookup(table);
  return tools.map((tool) => ({
    ...tool,
    description: personalTokenDescription(
      tool.description,
      reachOf(routes.get(tool.name) ?? [], lookup),
    ),
  }));
}
