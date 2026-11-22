import { describe, expect, it, vi } from "vitest";

import {
  REDACTION,
  assertPlaceholderCredentials,
  findCredentialViolations,
  isPlaceholder,
  redactCredentials,
} from "../src/tools/credentials.js";
import { registerApplicationTools } from "../src/tools/applications.js";
import { registerConnectorTools } from "../src/tools/extras.js";
import { redactSecretMetadata, registerSecretTools } from "../src/tools/secrets.js";

/**
 * The credential guard, closed where it leaked: a real value must not reach
 * the backend through a connector's headers or query parameters, a nested
 * credential object, a list of key/value pairs, a "placeholder" with text
 * around it, an application's knowledge, or the secret catalogue's list. The
 * write check and the read redaction follow one walk, so they cannot drift.
 */

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function fakeServer() {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, _d: string, ...rest: unknown[]) => {
      handlers.set(name, rest[rest.length - 1] as Handler);
    },
  };
  return { server, handlers };
}

function fakeClient(answer: unknown = { ok: true }) {
  return {
    get: vi.fn(async () => answer),
    post: vi.fn(async () => answer),
    put: vi.fn(async () => answer),
    patch: vi.fn(async () => answer),
    del: vi.fn(async () => answer),
  };
}

const isError = (result: unknown) => (result as { isError?: boolean }).isError === true;
const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0].text;

describe("inside authConfig, a credential cannot hide", () => {
  it("keeps the credential flag on a nested object", () => {
    expect(findCredentialViolations({ password: { value: "hunter2" } })).toEqual([
      "authConfig.password.value: must be a placeholder, not a real value",
    ]);
  });

  it("lets a locator through below a credential-named object", () => {
    expect(
      findCredentialViolations({ credentials: { secretId: "s-7", type: "bearer" } }),
    ).toEqual([]);
  });

  it("recognises a list of key/value pairs", () => {
    const found = findCredentialViolations({
      headers: [
        { key: "Accept", value: "application/json" },
        { key: "Authorization", value: "Basic dXNlcjpwYXNz" },
      ],
    });
    expect(found).toEqual(["authConfig.headers[1].value: must be a placeholder, not a real value"]);
  });

  it("accepts a pair whose value is a placeholder", () => {
    expect(
      findCredentialViolations({ headers: [{ name: "X-Api-Key", value: "{{ API_KEY }}" }] }),
    ).toEqual([]);
  });

  it("knows the shorter credential names", () => {
    for (const key of ["pwd", "pass", "cookie", "sessionCookie", "accountKey", "subscriptionKey"]) {
      expect(findCredentialViolations({ [key]: "real" }), key).toHaveLength(1);
    }
  });
});

describe("a placeholder is a placeholder and nothing else", () => {
  it("refuses text around or between templates", () => {
    expect(isPlaceholder("{{a}} hunter2 {{b}}")).toBe(false);
    expect(isPlaceholder("hunter2 {{ A }}")).toBe(false);
    expect(isPlaceholder("{{ A }}{{ B }}")).toBe(false);
  });

  it("still accepts one template, with spacing", () => {
    expect(isPlaceholder("{{ API_KEY }}")).toBe(true);
    expect(isPlaceholder("  {{API_KEY}}  ")).toBe(true);
  });
});

describe("the whole of a connector's fields is checked, not only authConfig", () => {
  const cases: [string, Record<string, unknown>][] = [
    [
      "a credential header pair",
      { implementation: { headers: [{ key: "Authorization", value: "Bearer abc123def456" }] } },
    ],
    [
      "a credential query parameter pair",
      { implementation: { queryParams: [{ key: "api_key", value: "abc123def456" }] } },
    ],
    ["a user and password in the base URL", { implementation: { baseUrl: "https://u:p@api.example.com" } }],
    [
      "a known secret shape anywhere",
      { description: "uses ghp_012345678901234567890123456789012345" },
    ],
  ];

  for (const [what, fields] of cases) {
    it(`refuses ${what} before calling the API`, async () => {
      const { server, handlers } = fakeServer();
      const client = fakeClient();
      registerConnectorTools(server as never, client as never);
      const result = await handlers.get("create_connector")!({ fields: { name: "x", ...fields } });
      expect(isError(result)).toBe(true);
      expect(client.post).not.toHaveBeenCalled();
    });
  }

  it("lets a placeholder header and an ordinary header through", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerConnectorTools(server as never, client as never);
    const result = await handlers.get("create_connector")!({
      fields: {
        name: "x",
        implementation: {
          baseUrl: "https://api.example.com",
          headers: [
            { key: "Accept", value: "application/json" },
            { key: "Authorization", value: "{{ API_TOKEN }}" },
          ],
          queryParams: [{ key: "limit", value: "10" }],
        },
      },
    });
    expect(isError(result)).toBe(false);
    expect(client.post).toHaveBeenCalledOnce();
  });

  it("does not treat a parameter schema as a credential", () => {
    expect(() =>
      assertPlaceholderCredentials({
        inputSchema: { properties: { password: { type: "string", description: "The user's" } } },
      }),
    ).not.toThrow();
  });
});

describe("an application's knowledge carries no secret", () => {
  it("refuses a step that types a real password", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerApplicationTools(server as never, client as never);
    const result = await handlers.get("write_application_knowledge")!({
      id: "app1",
      kind: "instruction",
      entry: {
        instruction: "Log in",
        steps: [
          { action: "type", target: "Username", value: "jan" },
          { action: "type", target: "Password", value: "hunter2" },
        ],
      },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).not.toContain("hunter2");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("lets a step type a secret by its name", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerApplicationTools(server as never, client as never);
    const result = await handlers.get("write_application_knowledge")!({
      id: "app1",
      kind: "instruction",
      entry: {
        instruction: "Log in",
        steps: [{ action: "type_secret", target: "Password", value: "crm-login" }],
      },
    });
    expect(isError(result)).toBe(false);
    expect(client.post).toHaveBeenCalledOnce();
  });

  it("refuses a known secret shape in a lesson", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient();
    registerApplicationTools(server as never, client as never);
    const result = await handlers.get("write_application_knowledge")!({
      id: "app1",
      kind: "lesson",
      entry: { text: "the key is AKIAABCDEFGHIJKLMNOP" },
    });
    expect(isError(result)).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe("reading back follows the same walk as writing", () => {
  it("redacts a nested credential and a credential pair", () => {
    const { value, redactedPaths } = redactCredentials({
      password: { value: "hunter2" },
      headers: [
        { key: "Authorization", value: "Basic dXNlcjpwYXNz" },
        { key: "Accept", value: "*/*" },
      ],
    });
    expect(redactedPaths).toEqual(["metadata.password.value", "metadata.headers[0].value"]);
    expect(value).toEqual({
      password: { value: REDACTION },
      headers: [
        { key: "Authorization", value: REDACTION },
        { key: "Accept", value: "*/*" },
      ],
    });
  });

  it("finds the same places on both sides", () => {
    const sample = {
      token: "abc",
      nested: { clientSecret: { inner: "x" } },
      headers: [{ name: "Cookie", value: "SID=1" }],
      note: "ghp_012345678901234567890123456789012345",
      fine: { tokenUrl: "https://a.test", secretId: "s1", apiKey: "{{ K }}" },
    };
    const written = findCredentialViolations(sample, "x").map((f) => f.split(":")[0]);
    expect(redactCredentials(sample, "x").redactedPaths).toEqual(written);
  });
});

describe("list_secrets redacts each row's metadata", () => {
  const rows = [
    {
      id: "s1",
      name: "CRM",
      metadata: { handshakeHeaders: { Authorization: "Basic aGVsbG86d29ybGQ=", Accept: "*/*" } },
    },
    { id: "s2", name: "Plain", metadata: { ttlSeconds: 900 } },
  ];

  it("withholds a credential in a row and says where", async () => {
    const { server, handlers } = fakeServer();
    registerSecretTools(server as never, fakeClient(rows) as never);
    const text = textOf(await handlers.get("list_secrets")!({}));
    expect(text).not.toContain("aGVsbG86d29ybGQ=");
    const out = JSON.parse(text) as Record<string, unknown>[];
    expect((out[0].metadata as { handshakeHeaders: Record<string, unknown> }).handshakeHeaders).toEqual({
      Authorization: REDACTION,
      Accept: "*/*",
    });
    expect(out[0].metadataRedacted).toMatchObject({
      paths: ["metadata.handshakeHeaders.Authorization"],
    });
    expect(out[1]).toEqual(rows[1]);
  });

  it("redactSecretMetadata maps a list row by row", () => {
    const out = redactSecretMetadata(rows) as Record<string, unknown>[];
    expect(out[0].metadataRedacted).toBeDefined();
    expect(out[1]).toBe(rows[1]);
  });
});
