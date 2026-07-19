/**
 * Shared MCP tool-result helpers: turn API data into a text result, map errors
 * to a clean error result, and guard a handler so nothing throws out of a tool.
 */

import { AxonityApiError } from "../errors.js";

/** A tool result carrying a JSON payload as pretty text. */
export function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** A tool result flagged as an error, with a clean message. */
export function errorResult(err: unknown) {
  const message =
    err instanceof AxonityApiError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** Wrap a handler so any thrown error becomes a clean tool error. */
export async function guard(
  fn: () => Promise<ReturnType<typeof jsonResult>>,
): Promise<ReturnType<typeof jsonResult> | ReturnType<typeof errorResult>> {
  try {
    return await fn();
  } catch (err) {
    return errorResult(err);
  }
}
