import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerConventions } from "../src/tools/conventions.js";
import { REDACTION, redactCredentials } from "../src/tools/credentials.js";
import { redactSecretMetadata, registerSecretTools } from "../src/tools/secrets.js";

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

function fakeServer() {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const server = {
    tool: (
      name: string,
      description: string,
      _s: unknown,
      handler: (a: never) => Promise<ToolResult>,
    ) => {
      handlers.set(name, handler as Handler);
      descriptions.set(name, description);
    },
  };
  return { server, handlers, descriptions };
}

function fakeClient(response: unknown = { ok: true }) {
  return {
    get: vi.fn(async () => response),
    post: vi.fn(async () => response),
    put: vi.fn(async () => response),
    patch: vi.fn(async () => response),
    del: vi.fn(async () => response),
  };
}

function body(r: ToolResult): Record<string, unknown> {
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

describe("the secret catalogue is readable", () => {
  it("list_secrets reads the collection", async () => {
    const { server, handlers } = fakeServer();
    const client = fakeClient([{ id: "s1", name: "Minggo", authType: "session_cookie" }]);
    registerSecretTools(server as never, client as unknown as AxonityClient);

    await handlers.get("list_secrets")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/secrets");
  });

  it("read_secret reads one by id and keeps the backend's shape", async () => {
    const { server, handlers } = fakeServer();
    const secret = {
      id: "s1",
      name: "Carerix",
      authType: "api_key",
      valueKeys: ["apiKey"],
      metadata: { baseUrl: "https://example.test", ttlSeconds: 900 },
      version: 3,
    };
    const client = fakeClient(secret);
    registerSecretTools(server as never, client as unknown as AxonityClient);

    const result = await handlers.get("read_secret")!({ secretId: "s1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/secrets/s1");
    // Nothing credential-shaped in this metadata — it must come back untouched,
    // redaction note included in what is NOT added.
    expect(body(result)).toEqual(secret);
  });

  it("registers no way to write a secret", () => {
    const { server, handlers } = fakeServer();
    registerSecretTools(server as never, fakeClient() as unknown as AxonityClient);

    expect([...handlers.keys()].sort()).toEqual(["list_secrets", "read_secret"]);
  });

  it("says values are unreadable and unwritable, so an agent stops looking", () => {
    const { server, descriptions } = fakeServer();
    registerSecretTools(server as never, fakeClient() as unknown as AxonityClient);

    expect(descriptions.get("list_secrets")).toMatch(/ever returns a secret's value/);
    expect(descriptions.get("list_secrets")).toMatch(/cannot create, change or delete/);
    // valueKeys is the "has a human filled this in yet?" signal — the one thing
    // a reader must know to avoid wiring a connector to an empty secret.
    expect(descriptions.get("read_secret")).toMatch(/valueKeys/);
  });
});

describe("the authoring guide agrees with what the tools do", () => {
  it("tells an agent to read the catalogue and to check valueKeys", async () => {
    const handlers = new Map<string, () => Promise<ToolResult>>();
    const server = {
      tool: (name: string, _d: string, _s: unknown, h: () => Promise<ToolResult>) =>
        handlers.set(name, h),
    };
    registerConventions(server as never);
    const guide = handlers.get("axonity_conventions")!;
    const text = (await guide()).content[0].text;

    for (const needle of [
      "list_secrets",
      "read_secret",
      // The trap this closes: a connector wired to a secret nobody filled in
      // authors clean and fails at run time.
      "valueKeys",
      "cannot create, change or delete a secret",
      "metadataRedacted",
    ]) {
      expect(text, needle).toContain(needle);
    }
  });
});

describe("a secret's metadata never carries a credential into the agent", () => {
  it("redacts a handshake Authorization header and says where", () => {
    const response = {
      id: "s1",
      authType: "session_cookie",
      valueKeys: [],
      metadata: {
        cookieName: "SESSIONID",
        handshakeUrl: "https://example.test/login",
        handshakeHeaders: { Authorization: "Basic aGVsbG86d29ybGQ=", Accept: "*/*" },
      },
    };

    const out = redactSecretMetadata(response) as Record<string, unknown>;
    const metadata = out.metadata as Record<string, unknown>;
    const headers = metadata.handshakeHeaders as Record<string, unknown>;

    expect(headers.Authorization).toBe(REDACTION);
    // The SHAPE survives — an agent still sees which fields a handshake has.
    expect(headers.Accept).toBe("*/*");
    expect(metadata.cookieName).toBe("SESSIONID");
    expect(metadata.handshakeUrl).toBe("https://example.test/login");
    expect(out.metadataRedacted).toMatchObject({
      paths: ["metadata.handshakeHeaders.Authorization"],
    });
  });

  it("catches a credential parked in a field nobody thought to name", () => {
    const out = redactSecretMetadata({
      metadata: { handshakeBody: '{"t":"ghp_012345678901234567890123456789012345"}' },
    }) as Record<string, unknown>;

    expect((out.metadata as Record<string, unknown>).handshakeBody).toBe(REDACTION);
  });

  it("leaves an empty or placeholder credential field visible", () => {
    // Blanking these would hide the very thing a reader is checking for: that
    // the field is not filled in yet.
    const { value, redactedPaths } = redactCredentials({
      apiKey: "",
      clientSecret: "{{ MY_SECRET }}",
    });

    expect(redactedPaths).toEqual([]);
    expect(value).toEqual({ apiKey: "", clientSecret: "{{ MY_SECRET }}" });
  });

  it("does not touch a response without metadata, or a non-object", () => {
    const list = [{ id: "s1" }];
    expect(redactSecretMetadata(list)).toBe(list);

    const noMetadata = { id: "s1", valueKeys: ["apiKey"] };
    expect(redactSecretMetadata(noMetadata)).toBe(noMetadata);

    expect(redactSecretMetadata(null)).toBe(null);
  });

  it("adds no note when there was nothing to redact", () => {
    const clean = { id: "s1", metadata: { ttlSeconds: 900 } };
    expect(redactSecretMetadata(clean)).toBe(clean);
  });
});
