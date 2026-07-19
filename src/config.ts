/**
 * Runtime configuration for the Axonity MCP connector.
 *
 * The connector authenticates to Axonity with a per-tenant SERVICE TOKEN
 * (minted in Axonity → Settings → API tokens). The token fixes the tenant; the
 * connector never chooses one. Values come from the environment so the token
 * never lands in a config file the agent can read.
 */

export interface AxonityConfig {
  /** Base URL of the Axonity API, e.g. https://app.axonity.ai (no trailing slash). */
  apiUrl: string;
  /** The service token (`axs_…`) presented as a bearer on every request. */
  token: string;
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
      "AXONITY_TOKEN is not set. Mint a service token in Axonity " +
        "(Settings → API tokens) and pass it as the AXONITY_TOKEN environment variable.",
    );
  }
  const apiUrl = (env.AXONITY_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
  return { apiUrl, token };
}
