import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import {
  assertPlaceholderCredentials,
  findCredentialViolations,
  isPlaceholder,
} from "../src/tools/credentials.js";
import { registerConnectorTools } from "../src/tools/extras.js";
import { registerEntityTools } from "../src/tools/register.js";

function fakeServer() {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: (a: never) => Promise<unknown>) => {
      handlers.set(name, handler as (args: Record<string, unknown>) => Promise<unknown>);
    },
  };
  return { server, handlers };
}

function fakeClient() {
  return {
    get: vi.fn(async () => ({ ok: true })),
    post: vi.fn(async () => ({ ok: true })),
    put: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(async () => ({ ok: true })),
  };
}

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0].text;
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

describe("isPlaceholder", () => {
  it("accepts empty and template forms", () => {
    expect(isPlaceholder("")).toBe(true);
    expect(isPlaceholder(null)).toBe(true);
    expect(isPlaceholder(undefined)).toBe(true);
    expect(isPlaceholder("{{ API_KEY }}")).toBe(true);
    expect(isPlaceholder("  {{API_KEY}}  ")).toBe(true);
  });

  it("rejects a literal value", () => {
    expect(isPlaceholder("hunter2")).toBe(false);
  });
});

describe("findCredentialViolations", () => {
  it("accepts a realistic nested connector config", () => {
    // This shape was REJECTED by the previous guard, which required every value
    // at depth 1 to be a placeholder.
    expect(
      findCredentialViolations({
        authType: "oauth2",
        tokenUrl: "https://api.example.com/oauth/token",
        headers: { Accept: "application/json" },
        config: { clientId: "my-app", clientSecret: "{{ CLIENT_SECRET }}" },
        scopes: ["read", "write"],
        timeoutMs: 3000,
      }),
    ).toEqual([]);
  });

  it("catches a real secret nested below the top level", () => {
    // The previous guard never recursed, so this passed straight through.
    const found = findCredentialViolations({
      config: { clientId: "my-app", clientSecret: "s3cr3t-value" },
    });
    expect(found).toEqual(["authConfig.config.clientSecret: must be a placeholder, not a real value"]);
  });

  it("finds credentials inside arrays", () => {
    const found = findCredentialViolations({
      headers: [{ name: "X-Api-Key", apiKey: "live-1234" }],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("authConfig.headers[0].apiKey");
  });

  it("recognises known secret shapes in fields that are not credential-named", () => {
    const found = findCredentialViolations({
      implementation: "curl -H 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789'",
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("github token");
  });

  it("never echoes the offending value", () => {
    const secret = "sk_live_abcdefghijklmnop1234";
    const found = findCredentialViolations({ config: { apiKey: secret } });
    expect(found.join(" ")).not.toContain(secret);
  });

  it("leaves non-credential neighbours alone", () => {
    expect(findCredentialViolations({ authType: "bearer", headerName: "Authorization" })).toEqual(
      [],
    );
  });

  it("treats credential-ish locator keys as locators, not secrets", () => {
    // `tokenUrl` is an OAuth endpoint and `apiKeyName` a header name — rejecting
    // these is what teaches an agent to route around the guard.
    expect(
      findCredentialViolations({
        tokenUrl: "https://api.example.com/oauth/token",
        apiKeyName: "X-Api-Key",
        secretId: "vault-entry-7",
      }),
    ).toEqual([]);
  });

  it("still catches a real secret parked in a locator-named field", () => {
    // The shape scan is the backstop for the exemption above.
    const found = findCredentialViolations({
      tokenUrl: "https://user:hunter2@api.example.com/oauth/token",
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("credentials in url");
  });

  it("matches credential keys regardless of case or separators", () => {
    expect(findCredentialViolations({ client_secret: "real" })).toHaveLength(1);
    expect(findCredentialViolations({ "API-KEY": "real" })).toHaveLength(1);
  });
});

describe("assertPlaceholderCredentials", () => {
  it("is a no-op when there is no authConfig", () => {
    expect(() => assertPlaceholderCredentials({ name: "A tool" })).not.toThrow();
  });

  it("names the offending path in the error", () => {
    expect(() =>
      assertPlaceholderCredentials({ authConfig: { config: { password: "real" } } }),
    ).toThrow(/authConfig\.config\.password/);
  });
});

describe("the guard is applied on every write path", () => {
  it("blocks create_connector", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerConnectorTools(server as never, client as unknown as AxonityClient);

    const result = await handlers.get("create_connector")!({
      fields: { authConfig: { config: { clientSecret: "real-secret" } } },
    });
    expect(isError(result)).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("blocks create_tool — the bypass that used to let secrets through", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(server as never, client as unknown as AxonityClient, {
      singular: "tool",
      basePath: "/api/v1/tools",
      updateMethod: "PUT",
      label: "tools",
      guardFields: assertPlaceholderCredentials,
    });

    const result = await handlers.get("create_tool")!({
      fields: { type: "connector", authConfig: { config: { clientSecret: "real-secret" } } },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain("authConfig.config.clientSecret");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("blocks update_tool too", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerEntityTools(server as never, client as unknown as AxonityClient, {
      singular: "tool",
      basePath: "/api/v1/tools",
      updateMethod: "PUT",
      label: "tools",
      guardFields: assertPlaceholderCredentials,
    });

    const result = await handlers.get("update_tool")!({
      id: "t-1",
      expectedVersion: 3,
      fields: { authConfig: { apiKey: "live-key" } },
    });
    expect(isError(result)).toBe(true);
    expect(client.put).not.toHaveBeenCalled();
  });

  it("still lets a correct connector through", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerConnectorTools(server as never, client as unknown as AxonityClient);

    await handlers.get("create_connector")!({
      fields: {
        name: "Stripe",
        authConfig: { authType: "bearer", config: { apiKey: "{{ STRIPE_KEY }}" } },
      },
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/tools", {
      type: "connector",
      name: "Stripe",
      authConfig: { authType: "bearer", config: { apiKey: "{{ STRIPE_KEY }}" } },
    });
  });
});
