/**
 * Typed errors for the Axonity MCP connector.
 *
 * Every REST failure is mapped to one of these so tool handlers can return a
 * clean, actionable message to the agent — never a raw stack trace or an
 * opaque status code.
 */

/**
 * Render the server's `detail` as a compact, readable line.
 *
 * FastAPI returns a bare string for a raised error and a list of
 * `{loc, msg, type}` objects for a 422 schema rejection. The list form is what
 * names the offending field, so it is flattened to `body.fieldName: message`
 * rather than dumped as JSON — the agent has to act on it, not read it.
 */
export function describeDetail(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail === "string") return detail.trim() || undefined;

  if (Array.isArray(detail)) {
    const lines = detail
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item !== "object" || item === null) return String(item);
        const { loc, msg, message } = item as {
          loc?: unknown;
          msg?: unknown;
          message?: unknown;
        };
        const where = Array.isArray(loc) ? loc.join(".") : undefined;
        const what = typeof msg === "string" ? msg : typeof message === "string" ? message : undefined;
        if (where && what) return `${where}: ${what}`;
        return what ?? where ?? JSON.stringify(item);
      })
      .filter(Boolean);
    return lines.length ? lines.join("; ") : undefined;
  }

  if (typeof detail === "object") {
    const { detail: nested, message } = detail as { detail?: unknown; message?: unknown };
    if (typeof nested === "string") return nested;
    if (typeof message === "string") return message;
    return JSON.stringify(detail);
  }

  return String(detail);
}

/** Append the server's detail to a base message, when there is one. */
function withDetail(base: string, detail: unknown): string {
  const described = describeDetail(detail);
  return described ? `${base} ${described}` : base;
}

export class AxonityApiError extends Error {
  constructor(
    message: string,
    /** HTTP status that produced this error. */
    readonly status: number,
    /** Server-provided detail, when present. */
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "AxonityApiError";
  }
}

/** 409 — the entity was modified since the agent read it. Re-read and retry. */
export class VersionConflictError extends AxonityApiError {
  constructor(detail?: unknown) {
    super(
      withDetail(
        "Version conflict: the entity changed since you read it. Read it again to " +
          "get the current version, then re-apply your change.",
        detail,
      ),
      409,
      detail,
    );
    this.name = "VersionConflictError";
  }
}

/** 404 — no such entity in this tenant (or it was deleted). */
export class NotFoundError extends AxonityApiError {
  constructor(detail?: unknown) {
    super(
      withDetail(
        "Not found (404): no such entity in this tenant. Check the id, or list " +
          "the collection to find it. A deleted entity also reads as not found.",
        detail,
      ),
      404,
      detail,
    );
    this.name = "NotFoundError";
  }
}

/** 401 — the service token is missing, unknown, or revoked. */
export class AuthError extends AxonityApiError {
  constructor(detail?: unknown) {
    super(
      withDetail(
        "Authentication failed (401): the service token is missing, invalid, or revoked. " +
          "Check AXONITY_TOKEN, or mint a new token in Axonity → Settings → API tokens.",
        detail,
      ),
      401,
      detail,
    );
    this.name = "AuthError";
  }
}

/** 403 — the token lacks the scope for this action (e.g. read-only on a write). */
export class ForbiddenError extends AxonityApiError {
  constructor(detail?: unknown) {
    super(
      withDetail(
        "Forbidden (403): this service token is not allowed to perform that action. " +
          "A read-only token cannot create, update, delete, or request-publish, and no " +
          "token may publish directly — use request_publish_* and let a human approve.",
        detail,
      ),
      403,
      detail,
    );
    this.name = "ForbiddenError";
  }
}

/**
 * Map an HTTP response to the right error type. `detail` is the parsed body
 * (FastAPI returns `{ detail: … }`), passed through for context.
 */
export function errorForStatus(status: number, detail?: unknown): AxonityApiError {
  switch (status) {
    case 401:
      return new AuthError(detail);
    case 403:
      return new ForbiddenError(detail);
    case 404:
      return new NotFoundError(detail);
    case 409:
      return new VersionConflictError(detail);
    default:
      return new AxonityApiError(
        withDetail(`Axonity API request failed (${status}).`, detail),
        status,
        detail,
      );
  }
}
