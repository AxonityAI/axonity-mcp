import { afterEach, describe, expect, it, vi } from "vitest";

import { AxonityClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import {
  AuthError,
  AxonityApiError,
  ForbiddenError,
  VersionConflictError,
} from "../src/errors.js";

const CONFIG = { apiUrl: "https://api.test", token: "axs_secret" };

function mockFetch(status: number, body: unknown, ok = status < 400) {
  return vi.fn(async () =>
    ({
      ok,
      status,
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
    }) as unknown as Response,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadConfig", () => {
  it("throws a clear error when the token is missing", () => {
    expect(() => loadConfig({})).toThrow(/AXONITY_TOKEN/);
  });

  it("defaults the API URL and strips a trailing slash", () => {
    const c = loadConfig({ AXONITY_TOKEN: "axs_x" });
    expect(c.apiUrl).toBe("https://app.axonity.ai");
    const c2 = loadConfig({ AXONITY_TOKEN: "axs_x", AXONITY_API_URL: "https://h/" });
    expect(c2.apiUrl).toBe("https://h");
  });
});

describe("AxonityClient.request", () => {
  it("sends the bearer token and parses JSON on success", async () => {
    const fetchMock = mockFetch(200, [{ id: "wf-1" }]);
    vi.stubGlobal("fetch", fetchMock);
    const client = new AxonityClient(CONFIG);

    const data = await client.get("/api/v1/workflows");

    expect(data).toEqual([{ id: "wf-1" }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.test/api/v1/workflows");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer axs_secret",
    });
  });

  it("serialises a JSON body and sets Content-Type on writes", async () => {
    const fetchMock = mockFetch(200, { id: "wf-1", version: 2 });
    vi.stubGlobal("fetch", fetchMock);
    const client = new AxonityClient(CONFIG);

    await client.put("/api/v1/agents/a-1", { expectedVersion: 1, name: "X" });

    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe("PUT");
    expect((init as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json",
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      expectedVersion: 1,
      name: "X",
    });
  });

  it.each([
    [401, AuthError],
    [403, ForbiddenError],
    [409, VersionConflictError],
    [500, AxonityApiError],
  ])("maps HTTP %s to the right error", async (status, ErrType) => {
    vi.stubGlobal("fetch", mockFetch(status, { detail: "nope" }, false));
    const client = new AxonityClient(CONFIG);
    await expect(client.get("/api/v1/workflows")).rejects.toBeInstanceOf(ErrType);
  });

  it("wraps a network failure as a status-0 AxonityApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const client = new AxonityClient(CONFIG);
    const err = await client.get("/x").catch((e) => e);
    expect(err).toBeInstanceOf(AxonityApiError);
    expect(err.status).toBe(0);
  });
});

/**
 * #30 — an older backend must say so, not answer a bare 405.
 *
 * 0.3.4 shipped validate_workflow's workflowId form. Against a sandbox running
 * a branch 15 commits behind it answered 405 on every attempt: the client was
 * right, the backend was old, and nothing said so. The reader goes hunting for
 * a bug in their own call while the most valuable check in the release is
 * silently unavailable.
 */
describe("backend/connector version skew", () => {
  function clientAnswering(status: number, body: unknown = { detail: "Method Not Allowed" }) {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status,
      text: async () => JSON.stringify(body),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return new AxonityClient({ apiUrl: "https://api.test", token: "axs_x" });
  }

  it("names skew — not the caller's call — on a 405", async () => {
    const client = clientAnswering(405);
    await expect(client.post("/api/v1/workflows/wf-1/validate")).rejects.toThrow(
      /backend is OLDER than this connector/,
    );
  });

  it("names the route and what added it, so a human can check the deploy", async () => {
    const client = clientAnswering(405);
    const err = await client
      .post("/api/v1/workflows/wf-1/validate")
      .catch((e: Error) => e);
    expect(err.message).toContain("POST /api/v1/workflows/wf-1/validate");
    expect(err.message).toMatch(/axonity-flow#770/);
    expect((err as { code?: string }).code).toBe("backend_version_skew");
    // Retrying cannot help until the backend moves.
    expect((err as { retryable?: boolean }).retryable).toBe(false);
  });

  it("reports a 404 as possible skew only for routes this version added", async () => {
    const newRoute = clientAnswering(404, { detail: "Not Found" });
    const err = await newRoute
      .post("/api/v1/tools/tl-1/dry-run")
      .catch((e: Error) => e);
    expect(err.message).toMatch(/axonity-flow#792/);
    // A 404 is ambiguous, so it says so rather than blaming the deploy outright.
    expect(err.message).toMatch(/no such id/);
  });

  it("leaves an ordinary 404 alone — an unknown id is not a deployment problem", async () => {
    const client = clientAnswering(404, { detail: "Not Found" });
    const err = await client.get("/api/v1/agents/ag-1").catch((e: Error) => e);
    expect(err.message).not.toMatch(/OLDER than this connector/);
    expect(err.message).toMatch(/Not found/);
  });

  it("ignores the query string when matching a route", async () => {
    const client = clientAnswering(405);
    const err = await client
      .del("/api/v1/workflows/wf-1/validate", { expectedVersion: 2 })
      .catch((e: Error) => e);
    expect(err.message).toMatch(/backend is OLDER/);
  });
});
