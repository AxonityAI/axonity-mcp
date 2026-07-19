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
