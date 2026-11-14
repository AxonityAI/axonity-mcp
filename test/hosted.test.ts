import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { type HostedServer, startHostedServer } from "../src/http.js";
import { SERVER_INFO, registerHosted } from "../src/index.js";
import { recordTools } from "../src/routeClasses.js";
import { HOSTED_PATH_REFUSAL } from "../src/tools/runInputFiles.js";

/**
 * The hosted connector (HTTP mode), driven over real HTTP against a fake API
 * that records every request and answers with the bearer it saw.
 */

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
}

let api: Server;
let apiUrl: string;
let seen: Seen[] = [];
let delayMs = 0;
let inFlight = 0;
let maxInFlight = 0;
/** While set, the API holds every request until it is released. */
let held: Promise<void> | undefined;

beforeAll(async () => {
  api = createServer(async (req: IncomingMessage, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    for await (const _ of req) {
      /* drain */
    }
    // A different delay per request, so concurrent requests finish out of order.
    const wait = delayMs ? Math.floor(Math.random() * delayMs) + 1 : 0;
    await new Promise((r) => setTimeout(r, wait));
    if (held) await held;
    inFlight -= 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items: [], total: 0, sawBearer: req.headers.authorization ?? null }));
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => api.close(() => r()));
});

const running: HostedServer[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.close();
  seen = [];
  delayMs = 0;
  inFlight = 0;
  maxInFlight = 0;
  held = undefined;
});

async function start(
  overrides: Partial<{ maxInFlight: number; maxQueued: number; maxBodyBytes: number; apiTimeoutMs: number }> = {},
) {
  const hosted = await startHostedServer({
    apiUrl,
    port: 0,
    maxInFlight: 4,
    maxQueued: 64,
    maxBodyBytes: 1024 * 1024,
    apiTimeoutMs: 10_000,
    ...overrides,
    serverInfo: SERVER_INFO,
    register: registerHosted,
    log: () => {},
  });
  running.push(hosted);
  return `http://127.0.0.1:${hosted.port}`;
}

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "MCP-Protocol-Version": "2025-11-25",
};

async function post(base: string, body: unknown, headers: Record<string, string> = {}, path = "/mcp") {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...HEADERS, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: text ? (JSON.parse(text) as Record<string, any>) : undefined };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const call = (name: string, args: Record<string, unknown> = {}, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

describe("the hosted connector answers MCP over HTTP", () => {
  it("initialize and tools/list answer, with every tool the local connector has", async () => {
    const base = await start();
    const init = await post(
      base,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      },
      bearer("axp_one"),
    );
    expect(init.status).toBe(200);
    expect(init.json!.result.serverInfo).toEqual(SERVER_INFO);

    const list = await post(base, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, bearer("axp_one"));
    expect(list.status).toBe(200);
    const names = (list.json!.result.tools as { name: string }[]).map((t) => t.name).sort();
    const local = recordTools(registerHosted, {} as AxonityClient).map((t) => t.name).sort();
    expect(names).toEqual(local);
    expect(seen).toEqual([]);
  });

  it("a tool call reaches the API with the request's own bearer", async () => {
    const base = await start();
    const res = await post(base, call("list_workflows"), bearer("axp_caller1"));
    expect(res.status).toBe(200);
    expect(res.json!.result.isError).toBeFalsy();
    expect(seen.map((s) => s.authorization)).toEqual(["Bearer axp_caller1"]);
  });

  it("callers at the same time never get each other's token (the invariant over 40 calls)", async () => {
    delayMs = 25;
    const base = await start({ maxInFlight: 6 });
    const tokens = Array.from({ length: 40 }, (_, i) => `axp_person${i}`);
    const answers = await Promise.all(
      tokens.map((t, i) => post(base, call("list_workflows", {}, i + 1), bearer(t))),
    );
    answers.forEach((answer, i) => {
      expect(answer.status).toBe(200);
      const text = (answer.json!.result.content as { text: string }[]).map((c) => c.text).join("");
      expect(text).toContain(`"sawBearer": "Bearer ${tokens[i]}"`);
    });
    // Every token reached the API exactly once, and no other bearer did.
    expect(seen.map((s) => s.authorization).sort()).toEqual(tokens.map((t) => `Bearer ${t}`).sort());
  });
});

describe("the token of one caller never reaches the API for another", () => {
  it("a tool that calls the API twice, with I/O in between, sends every call with its own caller's token", async () => {
    // get_measure_formula_spec with includeWorkspace reads twice, one after the
    // other; a token kept anywhere but the request's own context would be
    // overwritten by another caller in between (review of the hosted mode, S-2).
    delayMs = 25;
    const base = await start({ maxInFlight: 8 });
    const tokens = Array.from({ length: 40 }, (_, i) => `axp_both${i}`);
    const answers = await Promise.all(
      tokens.map((t, i) =>
        post(base, call("get_measure_formula_spec", { includeWorkspace: true }, i + 1), bearer(t)),
      ),
    );
    answers.forEach((answer, i) => {
      const seenHere = [...answer.text.matchAll(/Bearer (axp_both\d+)/g)].map((m) => m[1]);
      expect(seenHere.length, `answer ${i} shows both reads`).toBeGreaterThanOrEqual(2);
      expect(new Set(seenHere), `answer ${i}`).toEqual(new Set([tokens[i]]));
    });
  });
});

describe("the hosted connector refuses what is not a personal token's MCP request", () => {
  it.each([
    ["no bearer", {}],
    ["a service token", bearer("axs_service")],
    ["a session JWT", bearer("eyJhbGciOiJIUzI1NiJ9.e30.sig")],
    ["a malformed personal token", bearer("axp_has space")],
    ["another scheme", { Authorization: "Basic YXhwX3g6" }],
  ])("%s: 401 with WWW-Authenticate, and the API sees nothing", async (_label, headers) => {
    const base = await start();
    const res = await post(base, call("list_workflows"), headers as Record<string, string>);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
    expect(res.text).not.toContain("axs_service");
    expect(seen).toEqual([]);
  });

  it("GET and DELETE on /mcp are 405 (no sessions, no stream); another path is 404", async () => {
    const base = await start();
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${base}/mcp`, { method, headers: bearer("axp_one") });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
    const other = await post(base, call("list_workflows"), bearer("axp_one"), "/api/v1/workflows");
    expect(other.status).toBe(404);
    expect(seen).toEqual([]);
  });

  it("a body over the limit is 413 and nothing reaches the API", async () => {
    const base = await start({ maxBodyBytes: 2048 });
    const res = await post(base, call("list_workflows", { padding: "x".repeat(4096) }), bearer("axp_one"));
    expect(res.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it("a batch is refused before any of it runs: one POST is one message", async () => {
    // A batch of fifty calls under one seat ran all fifty at once (review M-1).
    const base = await start({ maxInFlight: 1, maxQueued: 0 });
    const batch = Array.from({ length: 50 }, (_, i) => call("list_workflows", {}, i + 1));
    const res = await post(base, batch, bearer("axp_batch"));
    expect(res.status).toBe(400);
    expect(res.json!.error.code).toBe(-32600);
    expect(seen).toEqual([]);
  });

  it("a body that is not JSON is a JSON-RPC parse error", async () => {
    const base = await start();
    const res = await post(base, "{not json", bearer("axp_one"));
    expect(res.status).toBe(400);
    expect(res.json!.error.code).toBe(-32700);
  });
});

describe("the hosted connector has a ceiling", () => {
  it("never more than maxInFlight calls at the API at once, and past the queue a 503", async () => {
    let release!: () => void;
    held = new Promise<void>((r) => (release = r));
    const base = await start({ maxInFlight: 2, maxQueued: 1 });
    const pending = Array.from({ length: 5 }, (_, i) =>
      post(base, call("list_workflows", {}, i + 1), bearer(`axp_p${i}`)),
    );
    // Two are seated and held at the API, one waits, two are turned away at once.
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
    };
    await until(() => inFlight === 2);
    const statuses: number[] = [];
    pending.forEach((p) => void p.then((a) => statuses.push(a.status)));
    await until(() => statuses.length === 2);
    expect(statuses).toEqual([503, 503]);
    expect(inFlight).toBe(2);
    release();
    const answers = await Promise.all(pending);
    expect(maxInFlight).toBe(2);
    expect(answers.filter((a) => a.status === 200)).toHaveLength(3);
    expect(answers.find((a) => a.status === 503)!.headers.get("retry-after")).toBe("1");
  });

  it("a caller that hangs up does not give its seat back while its call still runs", async () => {
    // Ten calls aborted as soon as the API saw them ran ten at once (review S-1).
    let release!: () => void;
    held = new Promise<void>((r) => (release = r));
    const base = await start({ maxInFlight: 1, maxQueued: 32 });
    const aborted: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      const controller = new AbortController();
      aborted.push(
        fetch(`${base}/mcp`, {
          method: "POST",
          headers: { ...HEADERS, ...bearer(`axp_gone${i}`) },
          body: JSON.stringify(call("list_workflows", {}, i + 1)),
          signal: controller.signal,
        }).catch(() => undefined),
      );
      for (let t = 0; t < 50 && inFlight === 0 && i === 0; t++) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 30));
      controller.abort();
    }
    await Promise.all(aborted);
    await new Promise((r) => setTimeout(r, 100));
    expect(maxInFlight).toBe(1);
    release();
    // And nothing leaked: once the work is done, a new call is served.
    const after = await post(base, call("list_workflows"), bearer("axp_after"));
    expect(after.status).toBe(200);
  });

  it("an API call that never answers ends at the time limit, and the seat comes back", async () => {
    held = new Promise<void>(() => {});
    const base = await start({ maxInFlight: 1, maxQueued: 0, apiTimeoutMs: 200 });
    const res = await post(base, call("list_workflows"), bearer("axp_slow"));
    expect(res.json!.result.isError).toBe(true);
    expect(res.text).toMatch(/did not answer within/);
    held = undefined;
    const next = await post(base, call("list_workflows"), bearer("axp_next"));
    expect(next.status).toBe(200);
    expect(next.json!.result.isError).toBeFalsy();
  });

  it("a seat is given back: after the burst, every new call is served", async () => {
    const base = await start({ maxInFlight: 1, maxQueued: 0 });
    for (let i = 0; i < 5; i++) {
      const res = await post(base, call("list_workflows", {}, i + 1), bearer("axp_seq"));
      expect(res.status).toBe(200);
    }
  });
});

describe("the hosted connector reads no file on the server", () => {
  const dir = mkdtempSync(join(tmpdir(), "axonity-hosted-"));
  const file = join(dir, "secret.txt");
  writeFileSync(file, "SERVER-ONLY-BYTES");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("upload_run_input_file with `path` is refused before anything is read or sent", async () => {
    const base = await start();
    const res = await post(
      base,
      call("upload_run_input_file", { path: file, contentType: "text/plain" }),
      bearer("axp_one"),
    );
    expect(res.status).toBe(200);
    expect(res.json!.result.isError).toBe(true);
    const text = (res.json!.result.content as { text: string }[]).map((c) => c.text).join("");
    expect(text).toContain(HOSTED_PATH_REFUSAL);
    expect(text).not.toContain("SERVER-ONLY-BYTES");
    expect(seen).toEqual([]);
  });

  it("`path` is refused even alongside contentBase64, and the hosted text offers only base64", async () => {
    const base = await start();
    const res = await post(
      base,
      call("upload_run_input_file", {
        path: file,
        contentBase64: "aGk=",
        filename: "a.txt",
        contentType: "text/plain",
      }),
      bearer("axp_one"),
    );
    const text = (res.json!.result.content as { text: string }[]).map((c) => c.text).join("");
    expect(text).toContain(HOSTED_PATH_REFUSAL);
    expect(seen).toEqual([]);

    const list = await post(base, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, bearer("axp_one"));
    const tool = (list.json!.result.tools as { name: string; description: string }[]).find(
      (t) => t.name === "upload_run_input_file",
    )!;
    expect(tool.description).toMatch(/GIVE THE FILE as `contentBase64`/);
    expect(tool.description).not.toMatch(/WHAT `path` CAN READ/);
    // The schema says the same as the text: `path` is there only to be refused.
    const schema = (list.json!.result.tools as { name: string; inputSchema: any }[]).find(
      (t) => t.name === "upload_run_input_file",
    )!.inputSchema;
    expect(schema.properties.path.description).toMatch(/Always refused/);
    expect(JSON.stringify(schema)).not.toMatch(/Exactly one of `path`/);
  });

  it("without a file the hosted refusal names only base64", async () => {
    const base = await start();
    const res = await post(base, call("upload_run_input_file", { contentType: "text/plain" }), bearer("axp_one"));
    const text = (res.json!.result.content as { text: string }[]).map((c) => c.text).join("");
    expect(text).toContain("Give the file as `contentBase64`");
    expect(text).not.toMatch(/exactly one of `path`/i);
    expect(seen).toEqual([]);
  });

  it("with base64 the upload goes out, with the caller's bearer", async () => {
    const base = await start();
    const res = await post(
      base,
      call("upload_run_input_file", { contentBase64: "aGk=", filename: "a.txt", contentType: "text/plain" }),
      bearer("axp_uploader"),
    );
    expect(res.json!.result.isError).toBeFalsy();
    expect(seen).toEqual([
      { method: "POST", url: "/api/v1/run-input-files", authorization: "Bearer axp_uploader" },
    ]);
  });
});
