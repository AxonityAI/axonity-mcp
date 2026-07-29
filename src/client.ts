/**
 * Thin HTTP client for the Axonity REST API.
 *
 * The connector talks to Axonity ONLY over the public REST API — no direct DB,
 * no backend internals. Every request carries the service token as a bearer;
 * the backend re-enforces tenant + scope, so this client is not a trust
 * boundary. Failures are mapped to typed errors (see errors.ts).
 */

import type { AxonityConfig } from "./config.js";
import { AxonityApiError, errorForStatus, skewErrorFor } from "./errors.js";

export type Json = Record<string, unknown>;

/** Query-string values a route may take. `undefined` entries are omitted. */
export type Query = Record<string, string | number | boolean | undefined>;

export class AxonityClient {
  constructor(private readonly config: AxonityConfig) {}

  private url(path: string, query?: Query): string {
    const base = `${this.config.apiUrl}${path.startsWith("/") ? path : `/${path}`}`;
    if (!query) return base;

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  /**
   * Issue a request and return the parsed JSON body. Non-2xx responses are
   * thrown as typed errors; a 204/empty body resolves to `undefined`.
   */
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: Query,
  ): Promise<T> {
    let resp: Response;
    try {
      resp = await fetch(this.url(path, query), {
        method,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (cause) {
      // Network-level failure (DNS, connection refused, TLS) — not an HTTP status.
      throw new AxonityApiError(
        `Could not reach the Axonity API at ${this.config.apiUrl}. ` +
          "Check AXONITY_API_URL and your network.",
        0,
        cause instanceof Error ? cause.message : String(cause),
      );
    }

    const text = await resp.text();
    const parsed = text ? safeJson(text) : undefined;

    if (!resp.ok) {
      // Before the generic mapping: a route this connector needs that the
      // deployed backend does not have. A bare 405 sends the reader hunting for
      // a bug in their own call, when the real answer is that the two are out of
      // step (#30). Checked first so it wins over the plain 404 mapping.
      const skew = skewErrorFor(method, path.split("?")[0], resp.status, parsed);
      if (skew) throw skew;

      // Pass the FULL body — errorForStatus reads `code`/`retryable`/`message`
      // off the structured error envelope when present, and falls back
      // gracefully for a bare `detail` string/array from older routes.
      throw errorForStatus(resp.status, parsed);
    }
    return parsed as T;
  }

  get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, undefined, query);
  }

  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  /**
   * DELETE. The optimistic lock travels as a QUERY parameter on these routes,
   * not in the body — and its spelling differs by entity family
   * (`expectedVersion` vs `expected_version`), so the caller passes it in.
   * A 204 with no body resolves to `undefined`.
   */
  del<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("DELETE", path, undefined, query);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
