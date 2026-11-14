import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as netServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The hosted connector as Axonity starts it: its own process, with the V8
 * heap limits the supervisor gives it. The reviewer's probes of 14/11/2026
 * (review M1) became these tests: a message inside the limits of the port that
 * ends the process (heap out of memory) is a bug, whatever it holds.
 *
 * This is a real process on purpose. An in-process test runs with a heap of
 * gigabytes and cannot fail the way the connector failed.
 */

const HEAP_FLAGS = "--max-old-space-size=160 --max-semi-space-size=4";

let api: Server;
let apiUrl: string;
const children: ChildProcess[] = [];

/** One connector process: its port, and how it ended (null while it lives). */
interface Connector {
  port: number;
  exited: () => string | null;
  stop: () => void;
}

beforeAll(async () => {
  api = createServer(async (req: IncomingMessage, res) => {
    for await (const _ of req) {
      /* drain */
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items: [], total: 0 }));
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const child of children) child.kill();
  await new Promise<void>((r) => api.close(() => r()));
});

async function freePort(): Promise<number> {
  const probe = netServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const found = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return found;
}

async function startConnector(): Promise<Connector> {
  const port = await freePort();
  let exited: string | null = null;
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
  const child = spawn(tsx, [entry], {
    env: {
      PATH: process.env.PATH,
      NODE_OPTIONS: HEAP_FLAGS,
      AXONITY_MCP_TRANSPORT: "http",
      AXONITY_MCP_PORT: String(port),
      AXONITY_API_URL: apiUrl,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.once("exit", (code, signal) => {
    exited = `${code ?? signal}`;
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`not ready: ${stderr}`)), 30_000);
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.includes("ready on 127.0.0.1")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
  });
  return { port, exited: () => exited, stop: () => child.kill() };
}

const dense = (bytes: number) =>
  `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_workflows","arguments":{"x":[${"{},".repeat(
    Math.floor(bytes / 3),
  )}0]}}}`;

const post = (port: number, token: string, body: string) =>
  fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer axp_${token}`,
    },
    body,
    signal: AbortSignal.timeout(60_000),
  }).then(
    (res) => res.status,
    (error: Error & { cause?: { code?: string } }) => `error:${error.cause?.code ?? error.name}`,
  );

const toolsList = '{"jsonrpc":"2.0","id":2,"method":"tools/list"}';

describe("the hosted connector stays alive whatever one message holds (review M1)", () => {
  it("one dense body of 10 MB, inside the body limit, is refused and the process lives", async () => {
    const connector = await startConnector();
    expect(await post(connector.port, "dense", dense(10 * 1024 * 1024))).toBe(400);
    expect(connector.exited()).toBeNull();
    expect(await post(connector.port, "dense", toolsList)).toBe(200);
    connector.stop();
  }, 90_000);

  it("a dense 3 MB body with four of 1 MB at once (inside the limits of the places) does not end it", async () => {
    const connector = await startConnector();
    const answers = await Promise.all([
      post(connector.port, "big", dense(3 * 1024 * 1024)),
      ...[1, 2, 3, 4].map((i) => post(connector.port, `small${i}`, dense(1000 * 1000))),
    ]);
    expect(connector.exited()).toBeNull();
    expect(answers.every((status) => status === 400)).toBe(true);
    expect(await post(connector.port, "big", toolsList)).toBe(200);
    connector.stop();
  }, 90_000);
});
