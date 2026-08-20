#!/usr/bin/env node
/**
 * Is the vendored OpenAPI snapshot still what `axonity-flow@main` serves?
 *
 * Every drift guard in this repository reads `test/fixtures/openapi.snapshot.json`.
 * That makes them exactly as fresh as the last time a person remembered to run
 * `dump_openapi.py` — and they did not remember: the snapshot sat nine
 * operations behind `main`, `conformance.test.ts` was green throughout, and two
 * of those nine were the routes #45 M7 was built on (axonity-mcp#48).
 *
 * A snapshot that has not seen a route cannot report it missing. So the guard is
 * sound and its INPUT is manual, which is the actual bug this closes.
 *
 * WHY IT FAILS ON ANY DIFF, not only one that breaks a registered tool. A route
 * this connector does not call yet is precisely the signal it wants — that is
 * what #45's M7 turned out to be, available and invisible for weeks. The paging
 * guard makes the same point sharper: when `GET /agents` converts to a `Page_*`,
 * `list_agents` starts answering with page one of N and nothing says so. The
 * test written to catch that reads the snapshot, so it stays green until someone
 * refreshes it.
 *
 * Usage:
 *   node scripts/check-contract-drift.mjs --fresh <dumped.json> [--pinned <path>]
 *   node scripts/check-contract-drift.mjs --flow ../axonity-flow   (dumps first)
 *
 * `--flow` is the local form, and the one the release flow uses: publishing runs
 * from a maintainer's machine, so the gate against shipping a stale snapshot has
 * to run there too. CI uses `--fresh` because it dumps in a separate step.
 *
 * Exit 0 = identical. Exit 1 = drift, with the operations named. Exit 2 = the
 * check could not run (bad input, no checkout, dump failed) — distinguished
 * from drift on purpose, so a broken check is never read as a clean contract.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** `--flag value` pairs; unknown flags are an input error, not a silent default. */
function parseArgs(argv) {
  const args = { pinned: "test/fixtures/openapi.snapshot.json" };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!value) fail(`\`${flag}\` needs a value.`);
    if (flag === "--fresh") args.fresh = value;
    else if (flag === "--pinned") args.pinned = value;
    else if (flag === "--flow") args.flow = value;
    else
      fail(
        `Unknown flag \`${flag}\`.\n` +
          "Usage: --fresh <dumped.json> [--pinned <path>]\n" +
          "   or: --flow <axonity-flow checkout> [--pinned <path>]",
      );
  }
  if (!args.fresh && !args.flow) {
    fail("Pass either `--fresh <dumped.json>` or `--flow <axonity-flow checkout>`.");
  }
  if (args.fresh && args.flow) {
    fail("Pass `--fresh` or `--flow`, not both — they are two ways to get the same file.");
  }
  return args;
}

/**
 * Dump the schema from a local axonity-flow checkout and return the path.
 *
 * The dump is the backend's own script, run against the backend's own code:
 * this repository does not model the contract, it compares two renderings of
 * it. A failure here exits 2, not 1 — "I could not look" is not "nothing
 * changed", and conflating them is how a watchdog goes quiet.
 */
function dumpFrom(flowPath) {
  const script = join(flowPath, "backend", "scripts", "dump_openapi.py");
  if (!existsSync(script)) {
    fail(
      `no dump script at ${script}.\n` +
        "Point --flow at an axonity-flow checkout (or set AXONITY_FLOW_PATH).",
    );
  }

  // Prefer the checkout's own virtualenv: the backend needs Python >= 3.13 and
  // its own dependencies, and a system python that happens to be on PATH will
  // fail on an import in a way that reads like drift.
  const venv = join(flowPath, "backend", "venv", "bin", "python");
  const python = existsSync(venv) ? venv : "python3";
  const out = join(mkdtempSync(join(tmpdir(), "axonity-contract-")), "fresh.json");

  try {
    execFileSync(python, [script, "-o", out], { stdio: ["ignore", "ignore", "inherit"] });
  } catch (cause) {
    fail(
      `dump_openapi.py failed (${cause.message}).\n` +
        `Tried ${python}. If that is not the right interpreter, activate the\n` +
        "backend's environment first, or create backend/venv in the checkout.",
    );
  }
  return out;
}

function fail(message) {
  console.error(`check-contract-drift: ${message}`);
  process.exit(2);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    fail(`could not read ${path}: ${cause.message}`);
  }
}

/**
 * The contract surface of one operation, as a comparable string.
 *
 * Deliberately NOT the whole operation object: docstrings change on the backend
 * every week and a job that cries wolf gets muted. What is compared is what a
 * caller can break against — the query parameters it may send, the body shape it
 * must send, and the response shape it will read.
 */
export function operationShape(op) {
  const query = (op.parameters ?? [])
    .filter((p) => p.in === "query")
    .map((p) => p.name)
    .sort();
  const body =
    op.requestBody?.content?.["application/json"]?.schema?.$ref ??
    (op.requestBody ? "inline" : "");
  const response =
    op.responses?.["200"]?.content?.["application/json"]?.schema?.$ref ?? "";
  return JSON.stringify({ query, body, response });
}

/** Every operation in a schema, keyed "METHOD /path". */
export function operations(schema) {
  const found = new Map();
  for (const [path, methods] of Object.entries(schema.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      found.set(`${method.toUpperCase()} ${path}`, operationShape(op));
    }
  }
  return found;
}

/** Added / removed / changed operations between two schemas. */
export function diffOperations(pinned, fresh) {
  const before = operations(pinned);
  const after = operations(fresh);

  const added = [...after.keys()].filter((k) => !before.has(k)).sort();
  const removed = [...before.keys()].filter((k) => !after.has(k)).sort();
  const changed = [...after.keys()]
    .filter((k) => before.has(k) && before.get(k) !== after.get(k))
    .sort();

  return { added, removed, changed };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const freshPath = args.flow ? dumpFrom(args.flow) : args.fresh;
  const fresh = readJson(freshPath);
  const pinned = readJson(args.pinned);

  const { added, removed, changed } = diffOperations(pinned, fresh);
  // Byte equality is the real verdict. The operation diff explains it; a change
  // confined to a component schema (a renamed field, a widened enum) shows up
  // here with an empty operation diff, and is still drift worth refreshing for.
  const identical =
    JSON.stringify(pinned) === JSON.stringify(fresh);

  if (identical) {
    console.log(
      `The vendored snapshot matches axonity-flow. ${operations(fresh).size} operations, nothing to do.`,
    );
    return;
  }

  console.error("The vendored OpenAPI snapshot is STALE.\n");

  const report = (label, keys) => {
    if (keys.length === 0) return;
    console.error(`${label} (${keys.length}):`);
    for (const key of keys) console.error(`  ${key}`);
    console.error("");
  };

  report("Present on axonity-flow, missing from the snapshot", added);
  report("In the snapshot, gone from axonity-flow", removed);
  report("Same route, different contract (query / body / response)", changed);

  if (added.length + removed.length + changed.length === 0) {
    console.error(
      "No operation changed — the difference is inside a component schema\n" +
        "(a renamed field, a widened enum, a retyped property). Refresh anyway:\n" +
        "the conformance test pins enums to this file.\n",
    );
  }

  console.error(
    "Refresh it — from an axonity-flow checkout on the target commit:\n" +
      "  python backend/scripts/dump_openapi.py \\\n" +
      "    -o <axonity-mcp>/test/fixtures/openapi.snapshot.json\n" +
      "then run `npm test` here and reconcile whatever the drift guards report.\n" +
      "\n" +
      "A route this connector does not call yet still counts: an unnoticed one\n" +
      "is how axonity-mcp#45's M7 sat available and invisible. See #48.",
  );
  process.exit(1);
}

/**
 * True when this module is the process entry point — the same realpath-resolved
 * comparison `src/index.ts` uses, and for the same reason: a naive string match
 * breaks on symlinks and on paths containing spaces.
 */
function isEntryPoint() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

// Only run when executed directly, so the diff helpers can be unit-tested.
if (isEntryPoint()) main();
