import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AxonityClient } from "../src/client.js";
import { type HostedServer, startHostedServer } from "../src/http.js";
import { HOSTED_SURFACE, SERVER_INFO, buildServer, registerHosted } from "../src/index.js";

/**
 * The Flow-App entry surface (instructions, one prompt, three resources) is
 * the same on the local connector and the hosted one: one fake Flow API, both
 * connectors in front of it, the same client asks both.
 */

let answer: Record<string, unknown>;
const STARTER = (n: number) => ({
  buildVersion: `build-${n}`, surface: "v1", kitVersion: `${n}.0.0`, contractHash: "c".repeat(64),
  downloadUrl: `https://flow.example.test/api/v1/apps/starter/download/ticket-${n}`,
  expiresAt: "2030-01-01T00:00:00Z",
});
const AUTHORING = {
  surface: { surface: "v1", prefix: "flow-app", operations: [{ name: "tables.rows.read" }], errorCodes: ["invalid"] },
  manifestSchema: { title: "FlowAppManifest", properties: { slug: { type: "string" } } },
  results: { "tables.rows.read": { items: [] } },
  contractHash: "c".repeat(64),
};
const bearersSeen: (string | undefined)[] = [];

let api: Server;
let apiUrl: string;
let hosted: HostedServer;

beforeAll(async () => {
  answer = STARTER(0);
  api = createServer(async (req: IncomingMessage, res) => {
    for await (const _ of req) {
      /* drain */
    }
    bearersSeen.push(req.headers.authorization);
    const path = (req.url ?? "").split("?")[0];
    const payload =
      path === "/api/v1/apps/starter" ? answer : path === "/api/v1/apps/authoring" ? AUTHORING : { items: [] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  hosted = await startHostedServer({
    apiUrl, port: 0, maxInFlight: 4, maxQueued: 8, maxInFlightPerToken: 4, maxQueuedPerToken: 8,
    maxLargeBodies: 2, largeBodyBytes: 512 * 1024, maxBodyBytes: 1024 * 1024, maxStructure: 100_000,
    maxStructureInFlight: 1_000_000, apiTimeoutMs: 10_000,
    serverInfo: SERVER_INFO, register: registerHosted, ...HOSTED_SURFACE, log: () => {},
  });
});
afterAll(async () => {
  await hosted.close();
  await new Promise<void>((r) => api.close(() => r()));
});

async function localClient(): Promise<Client> {
  const server = buildServer(new AxonityClient({ apiUrl, token: "axs_local" }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(clientSide);
  return client;
}
async function hostedClient(): Promise<Client> {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hosted.port}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer axp_hosted" } },
    }),
  );
  return client;
}

describe("local and hosted offer the same Flow-App entry", () => {
  it("the same instructions, the entry in the first sentence, within 4096 characters", async () => {
    const [local, remote] = [await localClient(), await hostedClient()];
    const text = local.getInstructions();
    expect(text).toBeTruthy();
    expect(remote.getInstructions()).toBe(text);
    expect(text!.length).toBeLessThanOrEqual(4096);
    expect(text!.split(/(?<=\.)\s/)[0]).toContain("get_flow_app_starter");
    await local.close();
    await remote.close();
  });

  it("the same prompt new-flow-app, with the same text, built from the starter route", async () => {
    answer = STARTER(1);
    const [local, remote] = [await localClient(), await hostedClient()];
    const [a, b] = [await local.listPrompts(), await remote.listPrompts()];
    expect(a.prompts.map((p) => p.name)).toEqual(["new-flow-app"]);
    expect(b).toEqual(a);
    const [pa, pb] = [
      await local.getPrompt({ name: "new-flow-app", arguments: { slug: "notes" } }),
      await remote.getPrompt({ name: "new-flow-app", arguments: { slug: "notes" } }),
    ];
    expect(pb).toEqual(pa);
    const text = JSON.stringify(pa.messages);
    expect(text).toContain("ticket-1");
    expect(text).toContain("notes");
    // A changed route answer is a changed prompt: nothing of it is a constant.
    answer = STARTER(2);
    const again = JSON.stringify((await remote.getPrompt({ name: "new-flow-app", arguments: {} })).messages);
    expect(again).toContain("ticket-2");
    expect(again).not.toContain("ticket-1");
    await local.close();
    await remote.close();
  });

  it("the same three resources, each reading the same content from the authoring route", async () => {
    const [local, remote] = [await localClient(), await hostedClient()];
    const [a, b] = [await local.listResources(), await remote.listResources()];
    expect(a.resources.map((r) => r.uri).sort()).toEqual([
      "axonity://flow-app/contract",
      "axonity://flow-app/manifest-schema",
      "axonity://flow-app/surface/v1",
    ]);
    expect(b).toEqual(a);
    const expected: Record<string, unknown> = {
      "axonity://flow-app/contract": AUTHORING,
      "axonity://flow-app/surface/v1": AUTHORING.surface,
      "axonity://flow-app/manifest-schema": AUTHORING.manifestSchema,
    };
    for (const { uri } of a.resources) {
      const [x, y] = [await local.readResource({ uri }), await remote.readResource({ uri })];
      expect(y).toEqual(x);
      expect(JSON.parse(x.contents[0].text as string), uri).toEqual(expected[uri]);
    }
    await local.close();
    await remote.close();
  });

  it("the hosted prompt and resources call the API as the caller, with the caller's own token", async () => {
    answer = STARTER(3);
    bearersSeen.length = 0;
    const remote = await hostedClient();
    await remote.getPrompt({ name: "new-flow-app", arguments: {} });
    await remote.readResource({ uri: "axonity://flow-app/contract" });
    expect(bearersSeen).toEqual(["Bearer axp_hosted", "Bearer axp_hosted"]);
    await remote.close();
  });

  it("tools/list still holds the three entry tools, hosted", async () => {
    const remote = await hostedClient();
    const names = (await remote.listTools()).tools.map((t) => t.name);
    for (const n of ["get_flow_app_starter", "get_flow_app_authoring_contract", "check_flow_app_manifest"]) {
      expect(names).toContain(n);
    }
    await remote.close();
  });
});
