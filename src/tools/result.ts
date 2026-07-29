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

/**
 * The result of a detach call — the SERVER's answer, never a local assertion.
 *
 * These tools used to return a hand-made `{ detached: true }` and throw the
 * response away. That is how 27 consecutive detach commands all reported
 * success against links that did not exist: the documents applied tenant-wide,
 * nothing was ever detached, and the client said otherwise every time (#24).
 *
 * Most detach routes do answer — `SkillLinkResponse` carries `linked`, the
 * policy and reference-doc routes have bodies of their own — so forwarding is
 * enough to make "removed something" distinguishable from "removed nothing".
 * Where a route is 204 by design (`DELETE /flow-step-prompts/{id}`) there is
 * nothing to forward, and the honest answer is to say the call completed and
 * name the read-back, not to invent a verdict.
 */
export function detachResult(
  body: unknown,
  options: { readBack?: string; request?: Record<string, string> } = {},
) {
  const empty = body === undefined || body === null || body === "";
  if (!empty) return jsonResult(body);

  return jsonResult({
    completed: true,
    ...(options.request ? { request: options.request } : {}),
    note:
      "The server accepted this and returned no content. That is NOT a " +
      "confirmation that a link existed or that anything was removed" +
      (options.readBack ? ` — check with ${options.readBack}.` : "."),
  });
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
