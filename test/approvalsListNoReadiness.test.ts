import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { buildServer } from "../src/index.js";
import { CONVENTIONS } from "../src/tools/conventions.js";

/**
 * platform-onderhoud (axonity-flow #2619): the publish queue no longer computes
 * readiness per row. A row of `GET /publish-approvals` carries `readiness: null`
 * and `readinessChanged: null`; the full readiness lives only on
 * `GET /publish-approvals/{id}` and is recomputed when a human approves. The tool
 * text must send a caller to get_publish_approval before deciding, and must not
 * promise readiness in the list.
 */
async function descriptions() {
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
  const tools = (await client.listTools()).tools;
  return new Map(tools.map((t) => [t.name, t.description ?? ""]));
}

describe("list_publish_approvals carries no readiness", () => {
  it("points to get_publish_approval for readiness and promises none in the list", async () => {
    const text = (await descriptions()).get("list_publish_approvals")!;
    expect(text).toContain("get_publish_approval");
    expect(text).toMatch(/`readiness` and `readinessChanged` are null/);
    expect(text).not.toMatch(/Readiness is recomputed WHEN YOU READ/);
    expect(text).not.toMatch(/`readiness` is the verdict right now/);
  });

  it("get_publish_approval still describes the live readiness", async () => {
    const text = (await descriptions()).get("get_publish_approval")!;
    expect(text).toMatch(/`readiness` is recomputed on this/);
  });

  it("the conventions send readiness questions to get_publish_approval", () => {
    expect(CONVENTIONS).toMatch(/the list carries no readiness/i);
    expect(CONVENTIONS).not.toMatch(/Readiness there is recomputed/);
  });
});
