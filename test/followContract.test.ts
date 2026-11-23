/**
 * The connector offers only the tools the backend it talks to can serve.
 *
 * Connector 1.1.0 calls routes that older backends do not have (Talentus
 * staging `5418aadf6`, production `af7c86fd7` — `DELETE /api/v1/methods/{id}`
 * among them). Before this, such a tool was listed, an agent picked it, and it
 * failed mid-task. Now the startup contract check decides which tools to
 * register: a tool whose routes are not ALL mounted is left out, and the
 * server's instructions say once which ones and why. Nothing crashes, and no
 * tool is offered half-working.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { collectCalledRoutes, followBackendContract } from "../src/contract.js";
import { AxonityApiError, NotFoundError } from "../src/errors.js";
import { buildServer, registerAll } from "../src/index.js";
import { SERVER_INSTRUCTIONS } from "../src/instructions.js";

const register = (server: never, client: AxonityClient) => registerAll(server, client);

/** Every route this build calls, as contract entries (a literal segment matches itself). */
async function everyRoute(): Promise<string[]> {
  const calls = await collectCalledRoutes((server, client) => registerAll(server as never, client));
  return [...new Set(calls.map((c) => `${c.method} ${c.path}`))];
}

/** What an older deploy lacks, by route shape. The method delete is the reported case. */
const OLD_BACKEND_LACKS = [/^DELETE \/api\/v1\/methods\/[^/]+$/];

/** The contract an older backend serves: everything this build needs, minus what it lacks. */
async function oldContract() {
  return {
    buildVersion: "af7c86fd7",
    environment: "production",
    contractHash: "old",
    routes: (await everyRoute()).filter((r) => !OLD_BACKEND_LACKS.some((p) => p.test(r))),
  };
}

async function newContract() {
  return { buildVersion: "new1234", environment: "staging", contractHash: "new", routes: await everyRoute() };
}

function contractClient(answer: unknown | (() => never)): AxonityClient {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/api/v1/contract") {
        if (typeof answer === "function") (answer as () => never)();
        return answer;
      }
      return {};
    }),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    del: vi.fn(async () => ({})),
  } as unknown as AxonityClient;
}

/** The server as an MCP client sees it: tool names and instructions. */
async function served(plan: Parameters<typeof buildServer>[1]) {
  const server = buildServer(contractClient({}), plan);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "probe", version: "0.0.0" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  return { names: tools.map((t) => t.name), instructions: client.getInstructions() ?? "" };
}

const opts = { apiUrl: "https://api.test", ignoreCache: true };

describe("the connector follows the backend's contract", () => {
  it("an older backend gets fewer tools, and no error", async () => {
    const log = vi.fn();
    const plan = await followBackendContract(contractClient(await oldContract()), register, {
      ...opts,
      log,
    });

    expect(plan.status).toBe("missing");
    expect([...plan.hidden.keys()]).toContain("delete_method");
    expect(plan.hidden.get("delete_method")?.[0]).toMatch(/^DELETE \/api\/v1\/methods\//);

    const full = await served({});
    const narrowed = await served(plan);
    expect(narrowed.names).not.toContain("delete_method");
    // Only what the backend lacks goes; the rest of the surface is untouched.
    expect(narrowed.names).toContain("read_method");
    expect(narrowed.names).toContain("list_workflows");
    expect(narrowed.names.length).toBe(full.names.length - plan.hidden.size);

    // One clear message, where an agent reads it: the instructions.
    expect(narrowed.instructions.startsWith(SERVER_INSTRUCTIONS)).toBe(true);
    expect(narrowed.instructions).toContain("af7c86fd7");
    expect(narrowed.instructions).toContain("delete_method");
    expect(narrowed.instructions).toMatch(/update the (Axonity )?environment/i);
    expect(narrowed.instructions.length).toBeLessThanOrEqual(4096);
    // And once on stderr for the human starting it.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("delete_method");
  });

  it("a tool is left out whole when only one of its routes is missing", async () => {
    // No half tools: list_templates reaches four catalogue routes; take one away.
    const contract = await newContract();
    const routes = contract.routes;
    const templateRoutes = routes.filter((r) => r.startsWith("GET ") && r.includes("template"));
    expect(templateRoutes.length).toBeGreaterThan(1);
    const plan = await followBackendContract(
      contractClient({ ...contract, routes: routes.filter((r) => r !== templateRoutes[0]) }),
      register,
      { ...opts, log: vi.fn() },
    );
    expect(plan.hidden.size).toBeGreaterThan(0);
    for (const [, missing] of plan.hidden) expect(missing).toEqual([templateRoutes[0]]);
  });

  it("a current backend gets every tool and the instructions unchanged", async () => {
    const log = vi.fn();
    const plan = await followBackendContract(contractClient(await newContract()), register, {
      ...opts,
      log,
    });
    expect(plan.status).toBe("ok");
    expect(plan.hidden.size).toBe(0);
    expect(plan.notice).toBeUndefined();

    const full = await served({});
    const following = await served(plan);
    expect(following.names).toEqual(full.names);
    expect(following.instructions).toBe(SERVER_INSTRUCTIONS);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["a backend without the contract route", () => {
      throw new NotFoundError("no such route", {});
    }],
    ["a server error", () => {
      throw new AxonityApiError("boom", 503);
    }],
    ["a network error", () => {
      throw new TypeError("fetch failed");
    }],
  ])("%s: every tool stays, with a warning", async (_label, answer) => {
    const log = vi.fn();
    const plan = await followBackendContract(contractClient(answer), register, { ...opts, log });
    expect(plan.status).toBe("unavailable");
    expect(plan.hidden.size).toBe(0);
    expect(plan.notice).toMatch(/could not read/i);
    expect(log).toHaveBeenCalledTimes(1);

    const full = await served({});
    const following = await served(plan);
    expect(following.names).toEqual(full.names);
    expect(following.instructions.startsWith(SERVER_INSTRUCTIONS)).toBe(true);
    expect(following.instructions).toMatch(/could not read/i);
  });

  it("a backend that does not answer in time: every tool stays, with a warning", async () => {
    const log = vi.fn();
    const client = { get: vi.fn(() => new Promise(() => {})) } as unknown as AxonityClient;
    const plan = await followBackendContract(client, register, { ...opts, log, timeoutMs: 20 });
    expect(plan.status).toBe("timeout");
    expect(plan.hidden.size).toBe(0);
    expect(plan.notice).toMatch(/could not read/i);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
