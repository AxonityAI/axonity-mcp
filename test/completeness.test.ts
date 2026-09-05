import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { collectCalledRoutes, matchesRoute } from "../src/contract.js";
import { registerAll } from "../src/index.js";
import { FORBIDDEN, type Rule, forbids } from "./denyList.js";

/**
 * axonity-mcp#59 — "is the MCP finished?" is a build status, not an opinion.
 *
 * Every operation the backend mounts must be in exactly one of two states:
 *
 *   COVERED  — some registered tool calls it.
 *   EXCLUDED — a rule in `test/exclusions.test.ts` forbids it, and that rule
 *              carries a written reason.
 *
 * A route in NEITHER is an open question nobody has answered. That third state
 * is what this test abolishes. It is where every audit of this repository has
 * spent its time: an operation nobody decided about looks exactly like one
 * somebody is still working on, so the question gets re-derived from scratch
 * every few months, by hand, and each time it produces work that turns out to
 * be already done.
 *
 * From here a new backend route arrives as a RED BUILD asking one question:
 * cover it, or exclude it with a reason. Both answers are cheap. Leaving it
 * unanswered is the only thing that is not.
 *
 * Note what this does NOT assert: that every route is covered. Most of the
 * surface is deliberately out of bounds — deployment, publishing decisions,
 * secret writes, another person's notifications. "Finished" means every route
 * has been DECIDED, which is the only sense in which a connector to a growing
 * platform can ever be finished.
 */

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/openapi.snapshot.json", import.meta.url)),
    "utf8",
  ),
) as { paths: Record<string, Record<string, unknown>> };

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

/** Every operation the pinned backend mounts, as "METHOD /path/{template}". */
function allOperations(): string[] {
  const out: string[] = [];
  for (const [template, operations] of Object.entries(snapshot.paths)) {
    for (const method of Object.keys(operations)) {
      if (HTTP_METHODS.includes(method)) out.push(`${method.toUpperCase()} ${template}`);
    }
  }
  return out.sort();
}

/**
 * Routes that are not the connector's business in a way no rule should have to
 * state, because they are not part of the tenant API at all: the liveness
 * probes and the login flow a service token never walks.
 */
const NOT_THE_API = [/^(GET) \/(health)?$/, /^\w+ \/api\/v1\/auth\//];

function isOutsideTheApi(operation: string): boolean {
  return NOT_THE_API.some((pattern) => pattern.test(operation));
}

/**
 * Which operations the registered tools actually call.
 *
 * The sweep is a cross product — every observed call against every operation —
 * and both sides grow with the platform, so it is quadratic in the thing that
 * only ever gets bigger. It had reached ~2.2M comparisons and five seconds,
 * which is the default per-test timeout: the check that tells you the surface
 * is decided was about to start failing for being slow, which is the worst way
 * for a build guard to go.
 *
 * DEDUPLICATING THE CALLS is the whole fix, and it now lives in
 * `collectCalledRoutes` itself (axonity-mcp#66) rather than here: the same
 * repetition was making the contract-skew sweep flaky at the same timeout, and
 * that one also runs at connector startup. Every consumer of that list asks a
 * set question, so folding the duplicates changes nothing but the cost.
 *
 * Memoised as well: both tests below ask the same question, and computing it
 * twice doubled a bill nobody was reading.
 */
let coveredCache: Promise<Set<string>> | undefined;

async function coveredOperations(): Promise<Set<string>> {
  coveredCache ??= (async () => {
    const calls = await collectCalledRoutes(registerAll as never);
    const operations = allOperations();
    const covered = new Set<string>();
    for (const call of calls) {
      for (const operation of operations) {
        if (matchesRoute(call, operation)) covered.add(operation);
      }
    }
    return covered;
  })();
  return coveredCache;
}

/** Does a deny rule forbid this operation? */
function isExcluded(operation: string): boolean {
  const space = operation.indexOf(" ");
  return forbids(operation.slice(0, space), operation.slice(space + 1));
}

describe("the route surface is fully decided (#59)", () => {
  it("every backend operation is covered by a tool or excluded by a rule", async () => {
    const covered = await coveredOperations();

    const undecided = allOperations().filter(
      (operation) =>
        !covered.has(operation) && !isExcluded(operation) && !isOutsideTheApi(operation),
    );

    expect(
      undecided,
      undecided.length === 0
        ? ""
        : `${undecided.length} backend operation(s) are neither covered by a tool ` +
          `nor excluded with a reason:\n\n` +
          undecided.map((o) => `  ${o}`).join("\n") +
          `\n\nDecide each one. To COVER it, register a tool. To EXCLUDE it, add ` +
          `a rule to FORBIDDEN in test/exclusions.test.ts with a comment saying ` +
          `WHY — "we have not got to it yet" is not a reason, it is the absence ` +
          `of one. See #59.`,
    ).toEqual([]);
  });

  /**
   * The test above passes vacuously if the sweep stops reaching anything, or if
   * the deny list grows so broad it swallows the surface. Both failure modes
   * are silent, so both are pinned.
   */
  it("the partition is real, not vacuous", async () => {
    const operations = allOperations();
    const covered = await coveredOperations();
    const excluded = operations.filter(isExcluded);

    expect(operations.length).toBeGreaterThan(400);
    // The tools reach a substantial majority of what is not deny-listed.
    expect(covered.size).toBeGreaterThan(250);
    // And the deny list is a boundary, not a blanket.
    expect(excluded.length).toBeLessThan(operations.length / 2);
    // A covered route must never also be excluded — that is a rule that has
    // grown over something a tool depends on, and it would go unnoticed here
    // because the operation is decided either way.
    const both = [...covered].filter(isExcluded);
    expect(
      both,
      `a deny rule now covers routes a tool calls:\n${both.join("\n")}`,
    ).toEqual([]);
  });

  /**
   * A rule with no comment above it is a boundary nobody can review: the next
   * reader cannot tell a considered decision from a line someone added to make
   * this suite green. The reason is the artefact; the regex is just how it is
   * enforced.
   *
   * It reads `denyList.ts`, which is where `FORBIDDEN` lives. It used to read
   * `exclusions.test.ts`, where the list ALSO used to live — and when the list
   * moved, this kept pointing at the old file, found no `const FORBIDDEN` in
   * it, and `continue`d past every rule. So the check that every boundary is
   * explained had itself been passing on an empty search: exactly the silent
   * vacuity the test above this one exists to prevent, one file across. Hence
   * the assertion that it found the list at all.
   */
  it("every deny rule carries a written reason", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./denyList.ts", import.meta.url)),
      "utf8",
    );
    const start = source.indexOf("const FORBIDDEN");
    expect(
      start,
      "denyList.ts no longer declares `const FORBIDDEN` — this check would " +
        "silently inspect nothing. Point it at wherever the list moved to.",
    ).toBeGreaterThan(-1);
    const body = source.slice(start);

    const unexplained: string[] = [];
    let checked = 0;
    for (const rule of FORBIDDEN as Rule[]) {
      const at = body.indexOf(`label: "${rule.label}"`);
      if (at < 0) continue;
      checked += 1;
      // Walk back over this rule's own lines to the nearest comment.
      const before = body.slice(0, at).split("\n").slice(-6).join("\n");
      if (!/\/\/|\*/.test(before)) unexplained.push(rule.label);
    }

    // Every rule must have been FOUND in the source, not merely not-failed.
    expect(
      checked,
      "some deny rules were not located in denyList.ts, so their reasons went " +
        "unchecked",
    ).toBe(FORBIDDEN.length);

    expect(
      unexplained,
      `deny rules with no comment saying why:\n${unexplained.join("\n")}`,
    ).toEqual([]);
  });
});
