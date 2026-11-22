/**
 * An id is ONE path segment.
 *
 * Every id a tool puts into a URL comes from the agent, and an agent copies
 * ids out of run output, table rows and documents. Unencoded, a `/`, `?`, `#`
 * or `..` in such an "id" makes the tool call a different route than the one
 * the person approved. Two rules close that:
 *
 * - `pathId` is the input schema of every id argument: not empty, not a dot
 *   segment. Encoding cannot help there — `encodeURIComponent("..")` is still
 *   `..`, and the URL parser resolves it as a step back.
 * - `seg()` encodes a value into its segment, and refuses the same values, for
 *   an id that did not come through a schema (a value read from an answer).
 *
 * `AxonityClient` checks the finished path once more, so a template that
 * forgets `seg()` still cannot leave its route.
 */

import { z } from "zod";

const DOT_SEGMENT = /^\.{1,2}$/;

function problem(value: string): string | undefined {
  if (value === "") return "An id cannot be empty.";
  if (DOT_SEGMENT.test(value)) return "An id cannot be '.' or '..'.";
  return undefined;
}

/**
 * The schema of every id argument. Add `.describe(...)` per tool. A plain
 * `ZodString` (not a refinement), so a tool can still chain `.min`/`.max`.
 */
export const pathId = z
  .string()
  .min(1, "An id cannot be empty.")
  .regex(/^(?!\.{1,2}$)/, "An id cannot be '.' or '..'.");

/** One value, encoded as one path segment. Throws on an empty or dot value. */
export function seg(value: string | number): string {
  const text = String(value);
  const message = problem(text);
  if (message) throw new Error(`${message} Pass the id exactly as a read or list returned it.`);
  return encodeURIComponent(text);
}
