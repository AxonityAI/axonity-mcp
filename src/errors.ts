/**
 * Typed errors for the Axonity MCP connector.
 *
 * Every REST failure is mapped to one of these so tool handlers can return a
 * clean, actionable message to the agent — never a raw stack trace or an
 * opaque status code.
 */

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
      "Version conflict: the entity changed since you read it. Read it again to " +
        "get the current version, then re-apply your change.",
      409,
      detail,
    );
    this.name = "VersionConflictError";
  }
}

/** 401 — the service token is missing, unknown, or revoked. */
export class AuthError extends AxonityApiError {
  constructor(detail?: unknown) {
    super(
      "Authentication failed (401): the service token is missing, invalid, or revoked. " +
        "Check AXONITY_TOKEN, or mint a new token in Axonity → Settings → API tokens.",
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
      "Forbidden (403): this service token is not allowed to perform that action. " +
        "A read-only token cannot create, update, or request-publish.",
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
    case 409:
      return new VersionConflictError(detail);
    default:
      return new AxonityApiError(
        `Axonity API request failed (${status}).`,
        status,
        detail,
      );
  }
}
