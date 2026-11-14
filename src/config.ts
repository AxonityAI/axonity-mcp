/**
 * Runtime configuration for the Axonity MCP connector.
 *
 * The connector authenticates to Axonity with one token for one workspace (a
 * personal token, or a service token made before they stopped being issued).
 * The token fixes the tenant; the connector never chooses one. Values come
 * from the environment so the token never lands in a config file the agent
 * can read.
 */

export interface AxonityConfig {
  /** Base URL of the Axonity API, e.g. https://app.axonity.ai (no trailing slash). */
  apiUrl: string;
  /** The service token (`axs_…`) presented as a bearer on every request. */
  token: string;
  /**
   * The longest one API call may take, request and answer, in milliseconds.
   * Unset: no limit of its own (the local connector, as before). The hosted
   * connector sets it, so a call that hangs never holds a seat for ever.
   */
  timeoutMs?: number;
}

const DEFAULT_API_URL = "https://app.axonity.ai";

/**
 * Read configuration from the environment.
 *
 * - `AXONITY_TOKEN` (required): the `axs_…` service token.
 * - `AXONITY_API_URL` (optional): defaults to the Axonity SaaS URL.
 *
 * Throws if the token is missing so the process fails fast at startup with a
 * clear message rather than 401-ing on the first tool call.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AxonityConfig {
  const token = env.AXONITY_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "AXONITY_TOKEN is not set. Pass an Axonity token (a personal token, or a " +
        "service token you still have) as the AXONITY_TOKEN environment variable.",
    );
  }
  const apiUrl = (env.AXONITY_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
  return { apiUrl, token };
}

/** How the connector is reached: a local process on stdio, or Axonity's own `/mcp`. */
export type Transport = "stdio" | "http";

export function transportOf(env: NodeJS.ProcessEnv = process.env): Transport {
  const value = env.AXONITY_MCP_TRANSPORT?.trim() || "stdio";
  if (value !== "stdio" && value !== "http") {
    throw new Error(
      `AXONITY_MCP_TRANSPORT must be "stdio" (the default) or "http"; got "${value}".`,
    );
  }
  return value;
}

/**
 * The hosted connector (HTTP mode), started by Axonity next to its API.
 *
 * It serves many people, so it holds no token of its own: each request brings
 * its caller's personal token as a bearer, and that token — only that one —
 * goes to the API for that request. It listens on loopback only; Axonity's
 * `/mcp` resolves the token first and forwards what it accepts.
 */
export interface HttpConfig {
  /** Axonity's own API, on loopback (e.g. http://127.0.0.1:8000). */
  apiUrl: string;
  /** The loopback port to listen on. */
  port: number;
  /** Requests handled at once; the rest wait. Bounds the memory a burst takes. */
  maxInFlight: number;
  /** Requests that may wait; one more is answered 503. */
  maxQueued: number;
  /** The largest request body read, in bytes; a larger one is answered 413. */
  maxBodyBytes: number;
  /** The longest one API call may take, in milliseconds. */
  apiTimeoutMs: number;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback?: number): number {
  const raw = env[name]?.trim();
  if (!raw) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} is not set. The hosted connector needs it.`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a whole number of at least 1; got "${raw}".`);
  }
  return value;
}

/**
 * The longest delay a Node timer takes (a signed 32-bit number of
 * milliseconds). `AbortSignal.timeout` turns anything larger into 1 ms, which
 * would fail every API call at once.
 */
const MAX_TIMER_MS = 2_147_483_647;

function atMost(value: number, limit: number, name: string): number {
  if (value > limit) throw new Error(`${name} must be at most ${limit}; got ${value}.`);
  return value;
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  if (env.AXONITY_TOKEN?.trim()) {
    throw new Error(
      "AXONITY_TOKEN is set, but the hosted connector (AXONITY_MCP_TRANSPORT=http) " +
        "holds no token of its own: every request brings its caller's. Unset it.",
    );
  }
  const apiUrl = env.AXONITY_API_URL?.trim().replace(/\/+$/, "");
  if (!apiUrl) {
    throw new Error(
      "AXONITY_API_URL is not set. The hosted connector calls the Axonity API it " +
        "runs beside; there is no default.",
    );
  }
  const port = positiveInt(env, "AXONITY_MCP_PORT");
  if (port > 65535) throw new Error(`AXONITY_MCP_PORT must be at most 65535; got ${port}.`);
  return {
    apiUrl,
    port,
    maxInFlight: positiveInt(env, "AXONITY_MCP_MAX_IN_FLIGHT", 4),
    maxQueued: positiveInt(env, "AXONITY_MCP_MAX_QUEUED", 32),
    maxBodyBytes: positiveInt(env, "AXONITY_MCP_MAX_BODY_BYTES", 25 * 1024 * 1024),
    apiTimeoutMs: atMost(
      positiveInt(env, "AXONITY_MCP_API_TIMEOUT_MS", 300_000),
      MAX_TIMER_MS,
      "AXONITY_MCP_API_TIMEOUT_MS",
    ),
  };
}
