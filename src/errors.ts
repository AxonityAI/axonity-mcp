/**
 * Typed errors for the Axonity MCP connector.
 *
 * Every REST failure is mapped to one of these so tool handlers can return a
 * clean, actionable message to the agent — never a raw stack trace or an
 * opaque status code.
 */

/**
 * Mirrors the backend's `ErrorCode` enum (`src/error_codes.py`) — the stable,
 * machine-readable vocabulary every structured error response carries as
 * `code`. An external agent has no access to the backend repository, so this
 * is the one field worth branching on; `message` is human-readable prose that
 * can be reworded without notice.
 */
export type ErrorCode =
  | "internal_error"
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "gone"
  | "payload_too_large"
  | "service_unavailable"
  | "upstream_error"
  | "validation_error"
  | "config_secret_leak"
  | "config_import_error"
  | "conflict"
  | "version_conflict"
  | "reference_conflict"
  | "idempotency_conflict"
  | "already_terminal"
  | "concurrency_error"
  | "admin_session_required"
  | "rate_limited"
  | "trigger_concurrency_exceeded"
  | "config_deploy_disabled"
  | "git_provider_error";

/** Codes where re-issuing the SAME request can succeed later. Mirrors `RETRYABLE_CODES`. */
export const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  "version_conflict",
  "rate_limited",
  "trigger_concurrency_exceeded",
]);

interface ErrorEnvelope {
  message?: string;
  code?: string;
  retryable?: boolean;
  detail?: unknown;
  affectedEntities?: unknown;
}

/** Recognise the structured `{error, code, retryable, message, detail?}` shape. */
function asEnvelope(body: unknown): ErrorEnvelope | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;
  return {
    message: typeof b.message === "string" ? b.message : undefined,
    code: typeof b.code === "string" ? b.code : undefined,
    retryable: typeof b.retryable === "boolean" ? b.retryable : undefined,
    detail: "detail" in b ? b.detail : undefined,
    affectedEntities: "affectedEntities" in b ? b.affectedEntities : undefined,
  };
}

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

/**
 * Render a response body for a human, whether it's the new structured
 * envelope, a bare FastAPI `detail` array/string, or something else entirely.
 * Falls back to `describeDetail` when the body doesn't look like the envelope,
 * so older/simpler error bodies still render exactly as before.
 */
function describeBody(body: unknown): string | undefined {
  const env = asEnvelope(body);
  if (!env) return describeDetail(body);

  const parts: string[] = [];
  if (env.message) parts.push(env.message);

  const detailText = describeDetail(env.detail);
  if (detailText && detailText !== env.message) parts.push(detailText);

  if (Array.isArray(env.affectedEntities) && env.affectedEntities.length > 0) {
    parts.push(`Affects: ${env.affectedEntities.map(String).join(", ")}`);
  }

  return parts.length ? parts.join(" ") : describeDetail(body);
}

/** Append the server's rendered body to a base message, when there is one. */
function withDetail(base: string, body: unknown): string {
  const described = describeBody(body);
  return described ? `${base} ${described}` : base;
}

export class AxonityApiError extends Error {
  constructor(
    message: string,
    /** HTTP status that produced this error. */
    readonly status: number,
    /** The server's response body, when present (may be the structured envelope). */
    readonly detail?: unknown,
    /** The envelope's `code`, when the server sent one — branch on this, not on `message`. */
    readonly code?: string,
    /** Whether re-issuing the same request could succeed. `undefined` = unknown. */
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "AxonityApiError";
  }
}

/** 409 — the entity was modified since the agent read it. Re-read and retry. */
export class VersionConflictError extends AxonityApiError {
  constructor(body?: unknown) {
    const env = asEnvelope(body);
    super(
      withDetail(
        "Version conflict: the entity changed since you read it. Read it again to " +
          "get the current version, then re-apply your change.",
        body,
      ),
      409,
      body,
      env?.code ?? "version_conflict",
      env?.retryable ?? true,
    );
    this.name = "VersionConflictError";
  }
}

/**
 * 409 — the entity is referenced by something published or live. Both this and
 * `VersionConflictError` are HTTP 409; the `code` is what tells them apart, and
 * it matters: retrying THIS one can never succeed on its own.
 */
export class ReferenceConflictError extends AxonityApiError {
  constructor(body?: unknown) {
    const env = asEnvelope(body);
    super(
      withDetail(
        "Reference conflict: this entity is referenced by something published or " +
          "live. This is NOT a stale-read problem — re-reading and retrying will " +
          "never succeed. Detach the reference, or unpublish the referencing " +
          "entity, then try again.",
        body,
      ),
      409,
      body,
      env?.code ?? "reference_conflict",
      env?.retryable ?? false,
    );
    this.name = "ReferenceConflictError";
  }
}

/** 404 — no such entity in this tenant (or it was deleted). */
export class NotFoundError extends AxonityApiError {
  constructor(body?: unknown) {
    const env = asEnvelope(body);
    super(
      withDetail(
        "Not found (404): no such entity in this tenant. Check the id, or list " +
          "the collection to find it. A deleted entity also reads as not found — " +
          "list_deleted_* first if you suspect that.",
        body,
      ),
      404,
      body,
      env?.code ?? "not_found",
      env?.retryable ?? false,
    );
    this.name = "NotFoundError";
  }
}

/** 401 — the service token is missing, unknown, expired, or revoked. */
export class AuthError extends AxonityApiError {
  constructor(body?: unknown) {
    const env = asEnvelope(body);
    super(
      withDetail(
        "Authentication failed (401): the service token is missing, invalid, expired, " +
          "or revoked. The backend deliberately returns the same message for all four " +
          "causes, so do not guess which one it is and do not retry — tell your human " +
          "the token is dead and a new one must be minted in Axonity → Settings → API tokens.",
        body,
      ),
      401,
      body,
      env?.code ?? "unauthorized",
      env?.retryable ?? false,
    );
    this.name = "AuthError";
  }
}

/** 403 — the token lacks the scope for this action (e.g. read-only on a write). */
export class ForbiddenError extends AxonityApiError {
  constructor(body?: unknown) {
    const env = asEnvelope(body);
    super(
      withDetail(
        "Forbidden (403): this service token is not allowed to perform that action. " +
          "A read-only token cannot create, update, delete, or request-publish, and no " +
          "token may publish directly — use request_publish_* and let a human approve.",
        body,
      ),
      403,
      body,
      env?.code ?? "forbidden",
      env?.retryable ?? false,
    );
    this.name = "ForbiddenError";
  }
}

/**
 * Map an HTTP response to the right error type. `body` is the parsed response
 * body — ideally the structured `{error, code, retryable, message, detail?}`
 * envelope, but may be a bare FastAPI `detail` string/array for routes that
 * predate it. When a recognised `code` is present it takes priority over the
 * HTTP status, because the status alone cannot distinguish e.g. a retryable
 * version conflict from a non-retryable reference conflict — both are 409.
 */
export function errorForStatus(status: number, body?: unknown): AxonityApiError {
  const env = asEnvelope(body);

  switch (env?.code) {
    case "version_conflict":
      return new VersionConflictError(body);
    case "reference_conflict":
      return new ReferenceConflictError(body);
    case "not_found":
      return new NotFoundError(body);
    case "unauthorized":
      return new AuthError(body);
    case "forbidden":
    case "admin_session_required":
      return new ForbiddenError(body);
  }

  switch (status) {
    case 401:
      return new AuthError(body);
    case 403:
      return new ForbiddenError(body);
    case 404:
      return new NotFoundError(body);
    case 409:
      return new VersionConflictError(body);
    default:
      return new AxonityApiError(
        withDetail(`Axonity API request failed (${status}).`, body),
        status,
        body,
        env?.code,
        env?.retryable,
      );
  }
}

/**
 * 405/404 on a route this connector version depends on — the deployed backend
 * is older than the client (#30).
 *
 * 0.3.4 shipped `validate_workflow`'s `workflowId` form. Against a sandbox
 * running a branch 15 commits behind, it answered a bare 405 on every attempt.
 * The client was right and the backend was old, but nothing said so: the reader
 * goes looking for a bug in their own call, and the most valuable check in the
 * release is silently unavailable to anyone who installed it.
 *
 * A 405 is the strong signal — the path exists, the method does not, which on an
 * API this client is written against means the two are out of step. A 404 is
 * weaker (an unknown id looks the same), so it is only reported as skew for the
 * routes listed in `ROUTES_ADDED_IN`, and even then it says "if the id is right".
 */
export class BackendVersionSkewError extends AxonityApiError {
  constructor(
    method: string,
    path: string,
    status: number,
    /** What added this route on the backend, so a human can check a deploy. */
    addedBy?: string,
    body?: unknown,
  ) {
    const ambiguous =
      status === 404
        ? " (a 404 also means 'no such id', so check the id first)"
        : "";
    super(
      `The Axonity backend does not have \`${method} ${path}\`, which this ` +
        `version of the connector needs${ambiguous}. The backend is OLDER than ` +
        `this connector — this is a deployment mismatch, not a mistake in your ` +
        `call.` +
        (addedBy ? ` That route was added by ${addedBy}.` : "") +
        " Tell your human which Axonity environment this token points at, and " +
        "do not retry: the same call will keep failing until that backend is " +
        "updated (or you pin an older connector).",
      status,
      body,
      "backend_version_skew",
      false,
    );
    this.name = "BackendVersionSkewError";
  }
}

/**
 * Routes newer than the oldest backend this connector still works against, and
 * what added them. Only these turn a 404 into a skew report; a 405 does so on
 * any path. Add an entry whenever a tool starts calling a route that a
 * previously-supported backend would not have.
 */
export const ROUTES_ADDED_IN: { pattern: RegExp; addedBy: string }[] = [
  {
    pattern: /^\/api\/v1\/workflows\/[^/]+\/validate$/,
    addedBy: "axonity-flow#770 (catalog-aware validation)",
  },
  {
    pattern: /^\/api\/v1\/tools\/[^/]+\/dry-run$/,
    addedBy: "axonity-flow#792 (dry-run that satisfies the publish gate)",
  },
  {
    pattern: /^\/api\/v1\/publish-approvals\/bulk$/,
    addedBy: "axonity-flow#795 (bulk publish requests)",
  },
];

/** The skew error for this call, or undefined when the status says nothing. */
export function skewErrorFor(
  method: string,
  path: string,
  status: number,
  body?: unknown,
): BackendVersionSkewError | undefined {
  const known = ROUTES_ADDED_IN.find((r) => r.pattern.test(path));
  if (status === 405) {
    return new BackendVersionSkewError(method, path, status, known?.addedBy, body);
  }
  if (status === 404 && known) {
    return new BackendVersionSkewError(method, path, status, known.addedBy, body);
  }
  return undefined;
}
