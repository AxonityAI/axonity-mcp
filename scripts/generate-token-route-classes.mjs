#!/usr/bin/env node
/**
 * Generate the route-class table the hosted connector words its tools with.
 *
 * A personal token (`axp_…`) reads what its person reads, runs actions, builds
 * drafts and asks for publication — and every other route is closed to it.
 * axonity-flow decides that per route, in ONE table
 * (`backend/src/auth/token_route_classes.py`), and enforces it on every call.
 * This connector only SAYS it, before a call, so an agent does not walk into a
 * refusal it could have read. The words come from the table; nothing here
 * decides what a token may do.
 *
 * The table reaches this repository the way the OpenAPI schema does: the
 * backend renders it (`backend/scripts/dump_token_route_classes.py`), the
 * rendering is pinned as a fixture, and the module is generated from the
 * fixture. `test/routeClasses.test.ts` regenerates the module in memory and
 * fails if the two have parted, and fails if a tool calls a route the fixture
 * does not know.
 *
 * Usage:
 *   node scripts/generate-token-route-classes.mjs --flow <axonity-flow checkout>
 *       refresh the fixture from the backend, then write the module
 *   node scripts/generate-token-route-classes.mjs
 *       write the module from the pinned fixture
 *   node scripts/generate-token-route-classes.mjs --stdout
 *       print the module (used by a test)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(ROOT, "test/fixtures/token-route-classes.snapshot.json");
const OUTPUT = join(ROOT, "src/generated/tokenRouteClasses.ts");
const CLASSES = ["lezen", "actie", "actie_beheerder", "configuratie", "dicht"];

function fail(message) {
  console.error(`generate-token-route-classes: ${message}`);
  process.exit(2);
}

/** Run the backend's own dump against the backend's own code. */
function dumpFrom(given) {
  // Absolute: the dump runs with the backend as its working directory, and a
  // relative checkout path would then point somewhere else.
  const flowPath = resolve(given);
  const script = join(flowPath, "backend", "scripts", "dump_token_route_classes.py");
  if (!existsSync(script)) {
    fail(`no dump script at ${script}. Point --flow at an axonity-flow checkout.`);
  }
  const venv = join(flowPath, "backend", "venv", "bin", "python");
  const python = existsSync(venv) ? venv : "python3";
  try {
    return execFileSync(python, [script], {
      cwd: join(flowPath, "backend"),
      stdio: ["ignore", "pipe", "inherit"],
    }).toString();
  } catch (cause) {
    fail(`dump_token_route_classes.py failed with ${python} (${cause.message}).`);
  }
}

/** The module text for a parsed table. Throws on a row it cannot vouch for. */
export function renderModule(table) {
  const keys = Object.keys(table).sort();
  for (const key of keys) {
    const row = table[key];
    if (!CLASSES.includes(row.class)) {
      throw new Error(`${key}: unknown class ${JSON.stringify(row.class)}`);
    }
  }
  const lines = keys.map((key) => {
    const row = table[key];
    const why = row.why === undefined ? "" : `, why: ${JSON.stringify(row.why)}`;
    return `  ${JSON.stringify(key)}: { class: ${JSON.stringify(row.class)}${why} },`;
  });
  return [
    "/**",
    " * GENERATED — do not edit. Run `node scripts/generate-token-route-classes.mjs`.",
    " *",
    " * What a personal token may do on each route, as axonity-flow decides it",
    " * (`backend/src/auth/token_route_classes.py`), read from",
    " * `test/fixtures/token-route-classes.snapshot.json`. The backend enforces it;",
    " * the hosted connector only words its tools with it.",
    " */",
    "",
    'import type { TokenRoute } from "../routeClasses.js";',
    "",
    "export const TOKEN_ROUTE_CLASSES: Readonly<Record<string, TokenRoute>> = {",
    ...lines,
    "};",
    "",
  ].join("\n");
}

function main(argv) {
  let flow;
  let stdout = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--stdout") stdout = true;
    else if (argv[i] === "--flow" && argv[i + 1]) flow = argv[++i];
    else fail(`unknown argument ${argv[i]}`);
  }
  if (flow) {
    const fresh = dumpFrom(flow);
    JSON.parse(fresh);
    writeFileSync(FIXTURE, fresh);
  }
  const module = renderModule(JSON.parse(readFileSync(FIXTURE, "utf8")));
  if (stdout) process.stdout.write(module);
  else writeFileSync(OUTPUT, module);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
