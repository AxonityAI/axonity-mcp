/**
 * Thin HTTP client for the Axonity REST API.
 *
 * The connector talks to Axonity ONLY over the public REST API — no direct DB,
 * no backend internals. Every request carries the service token as a bearer;
 * the backend re-enforces tenant + scope, so this client is not a trust
 * boundary. Failures are mapped to typed errors (see errors.ts).
 */

import type { AxonityConfig } from "./config.js";
import { AxonityApiError, errorForStatus } from "./errors.js";

export type Json = Record<string, unknown>;

export class AxonityClient {
  constructor(private readonly config: AxonityConfig) {}

  private url(path: string): string {
    return `${this.config.apiUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  /**
   * Issue a request and return the parsed JSON body. Non-2xx responses are
   * thrown as typed errors; a 204/empty body resolves to `undefined`.
   */
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let resp: Response;
    try {
      resp = await fetch(this.url(path), {
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
      const detail =
        parsed && typeof parsed === "object" && "detail" in parsed
          ? (parsed as { detail: unknown }).detail
          : parsed;
      throw errorForStatus(resp.status, detail);
    }
    return parsed as T;
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>("GET", path);
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
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
