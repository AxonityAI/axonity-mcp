/**
 * Shared MCP tool-result helpers: turn API data into a text result, map errors
 * to a clean error result, and guard a handler so nothing throws out of a tool.
 */

import { AxonityApiError } from "../errors.js";

/**
 * The backend's 202 for a route a token may only PROPOSE: `{status:
 * "pending_approval", message, approval}`. Recognised by its body, which is the
 * one thing every such route shares, so one wording serves every tool.
 */
function pendingApproval(
  data: unknown,
): { id: string; summary?: string; action?: string } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { status, approval } = data as { status?: unknown; approval?: unknown };
  if (status !== "pending_approval" || typeof approval !== "object" || approval === null) {
    return undefined;
  }
  const { id, summary, action } = approval as Record<string, unknown>;
  if (typeof id !== "string") return undefined;
  return {
    id,
    ...(typeof summary === "string" ? { summary } : {}),
    ...(typeof action === "string" ? { action } : {}),
  };
}

/**
 * What an agent is told when a call was ASKED, not done. Deliberately not JSON
 * and not an error: a client that reads any 2xx as "done" must not be able to
 * read this as done, and an agent that retries a "failure" makes a second
 * request for nothing.
 */
export function notDoneYet(approval: { id: string; summary?: string; action?: string }): string {
  return (
    "NOT DONE YET — this waits for a person's approval in Axonity " +
    "(Approvals → Admin requests). " +
    `Approval id ${approval.id}; poll get_action_approval. ` +
    "Do not retry: a second identical request returns the same approval." +
    (approval.summary ? `\nAsked: ${approval.summary}` : "")
  );
}

/** A tool result carrying a JSON payload as pretty text. */
export function jsonResult(data: unknown) {
  const asked = pendingApproval(data);
  return {
    content: [
      { type: "text" as const, text: asked ? notDoneYet(asked) : JSON.stringify(data, null, 2) },
    ],
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
