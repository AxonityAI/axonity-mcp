import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { buildServer } from "../src/index.js";

/**
 * The real MCP layer refuses the calls axonity-flow#2176 made obsolete — not
 * only the zod shapes in isolation. A probe from the review of #107, kept as a
 * regression test: the connector's own McpServer, an in-memory transport and
 * an SDK client, with a backend client that records every request.
 */

async function connected() {
  const backend = {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    del: vi.fn(async () => ({})),
  };
  const server = buildServer(backend as unknown as AxonityClient);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "probe", version: "0.0.0" });
  await client.connect(clientSide);
  return { client, backend };
}

/** The refusal as text, whether the SDK throws it or returns it as an error result. */
async function refusal(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
    };
    expect(result.isError, `${name} should be refused`).toBe(true);
    return result.content.map((c) => c.text ?? "").join("\n");
  } catch (error) {
    return (error as Error).message;
  }
}

const nothingSent = (backend: Awaited<ReturnType<typeof connected>>["backend"]) => {
  for (const method of ["get", "post", "put", "patch", "del"] as const) {
    expect(backend[method], method).not.toHaveBeenCalled();
  }
};

describe("the MCP layer refuses what axonity-flow#2176 retired", () => {
  it("an old create_agent_persona call (fields: name, characterText) is refused, nothing sent", async () => {
    const { client, backend } = await connected();
    const text = await refusal(client, "create_agent_persona", {
      agentId: "ag-1",
      fields: { name: "Writer", characterText: "I write plainly." },
    });
    expect(text).toMatch(/expectedVersion/);
    expect(text).toMatch(/persona/);
    nothingSent(backend);
  });

  it("read_persona is not a tool any more", async () => {
    const { client, backend } = await connected();
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).not.toContain("read_persona");
    expect(tools).toContain("read_agent_persona");
    const text = await refusal(client, "read_persona", { id: "p-1" });
    expect(text).toMatch(/read_persona/);
    expect(text).toMatch(/not found/i);
    nothingSent(backend);
  });

  it("a bulk publish with a persona entry is refused before anything is sent", async () => {
    const { client, backend } = await connected();
    const text = await refusal(client, "request_publish_bulk", {
      requests: [{ entityType: "persona", entityId: "p-1" }],
    });
    expect(text).toMatch(/entityType/);
    nothingSent(backend);
  });
});
