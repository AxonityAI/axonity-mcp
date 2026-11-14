/**
 * The hosted connector: Streamable HTTP on loopback, behind Axonity's `/mcp`.
 *
 * Axonity runs this process next to its API (AXONITY_MCP_TRANSPORT=http). Its
 * `/mcp` route checks the caller's personal token and forwards the request
 * here unchanged; this server answers it with the same tools the local
 * connector has, calling the API with THAT request's token. The API checks the
 * token again and decides, per route, what it may do — this process is not a
 * trust boundary for that.
 *
 * WHY IT IS BUILT THIS WAY (measured before it was built, 473 tools, Node 22):
 *
 * - STATELESS. Every POST is one JSON-RPC message with its own transport and
 *   its own MCP server object, and nothing is kept between requests: no
 *   session, no stream to resume. A batch (an array of messages, which the
 *   protocol dropped in 2025-06-18) is refused: one POST would otherwise run
 *   every call in it at once, under one seat. The SDK refuses to reuse a stateless
 *   transport, and a server object holds one transport at a time.
 * - THE TOOLS ARE REGISTERED ONCE. Building all of them again for every
 *   request cost ~15 MB per request in flight, 839 MB at fifty at once.
 *   Instead they are recorded once, against a client whose token is whatever
 *   the CURRENT request brought (AsyncLocalStorage), and each request's server
 *   only replays the record. The token is bound to the request's async
 *   context, so work that outlives its request still carries its own token
 *   and never the next caller's.
 * - THE TOOL LIST IS COMPUTED ONCE. It does not depend on who asks, and
 *   rendering the schemas of every tool per `tools/list` was the largest cost.
 * - THREE ROOMS, so the memory has a ceiling that does not depend on how hard
 *   anyone pushes, and one person cannot take it from the rest. A request waits
 *   in each in turn, and a caller that hangs up while it waits leaves the queue
 *   at once. (1) The token's own: `maxInFlightPerToken` at once and
 *   `maxQueuedPerToken` waiting, then 429 — one token cannot fill what everybody
 *   shares. (2) For a body over `largeBodyBytes` (or one that does not say its
 *   size): `maxLargeBodies` at once. A body costs about three times its size
 *   while it is read (the Buffer, its text, the parsed object), so with a limit
 *   of 25 MiB per body, places alone left room for four of them; this is what
 *   bounds it to one. (3) `maxInFlight` seats, `maxQueued` waiting, then 503. A
 *   seat is given back when the request's work is done, not when its caller
 *   hangs up — work that goes on after a disconnect still holds it — and every
 *   API call has a time limit (`apiTimeoutMs`), so no seat is held for ever.
 *
 * - A MESSAGE IS BOUNDED BY WHAT IT HOLDS, not only by its size. The heap
 *   hangs on what a parse builds: 10 MB of `{},` is 3.3 million objects and
 *   ended the process (V8 heap limit), where a 10 MB base64 file is one string.
 *   The structure marks `{`, `[` and `,` outside strings are counted as the body
 *   arrives (`StructureCounter`); over `maxStructure` it is answered 400 before it
 *   is parsed. That bounds one message, not the sum: twelve messages of 49 500
 *   marks at once (a list of numbers through `apply_workflow_mutations`) ended
 *   the process in 3 runs of 5, twenty in 4 of 5, each one alone harmless. So
 *   the marks of all the messages in work at once share one budget
 *   (`maxStructureInFlight`, `Budget`): a message is weighed after it is read
 *   and before it is parsed, and waits (first come, first served) while the
 *   budget is spent, holding its seat, so what it waits behind is the seats and
 *   the queue that were already there, and past them the same 503. The budget
 *   comes back with the seat: when the work is done, not when the caller hangs up.
 *   And the seat is kept until the answer has left the process, not until the
 *   handler returns: a failed call of a big message answers with a thousand times
 *   its size (97 KB of numbers is 10.9 MB of validation errors), and answers of
 *   seats that went back early piled up past the heap (the budget alone did not
 *   stop it: measured, 2 of 5 runs died with it). Default 100000, kept under the
 *   200000 at which one message ended the process; see the README.
 *
 * WHAT WAS MEASURED (the hosted process itself, started as Axonity starts it,
 * with the V8 limits `--max-old-space-size=160 --max-semi-space-size=4`, against
 * a fake API; Node 22 on macOS, so this is macOS RSS read with `ps` every 50 ms,
 * not Linux and not the 2 GB sandbox; 473 tools). At rest about 85–95 MB. With
 * 50 requests at once, five times over: peak 209–292 MB (before the structure
 * limit; one run in twelve died of the V8 heap limit then, which was not
 * reproduced in later runs and is not explained: dense JSON and many messages
 * at the per-message limit at once are two causes that were found, and are
 * closed above). With 12 bodies of 23
 * MiB at once from different tokens: peak 234–267 MB, where the version before
 * the large-body place peaked at 375–384 MB (6 bodies: 241–262 against 338–349).
 * Not measured: Linux, the memory of the Axonity process that forwards a body
 * to this one (it holds the whole body too), and any load past what is above.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

import { AxonityClient } from "./client.js";
import type { HttpConfig } from "./config.js";
import type { ProbeServer } from "./contract.js";
import { type RegisteredTool, recordTools } from "./routeClasses.js";

/** How long an answer that is not being read may stand still before its connection is cut. */
const ANSWER_STALL_MS = 30_000;

/** The one path this server answers MCP on. */
export const MCP_PATH = "/mcp";

/**
 * A personal token as a bearer. The hosted connector serves personal tokens
 * only: a service token (`axs_…`) keeps the local connector (stdio).
 */
const PERSONAL_BEARER = /^Bearer\s+(axp_[A-Za-z0-9_-]+)$/i;

export interface HostedServerOptions extends HttpConfig {
  /** Name and version the MCP server introduces itself with. */
  serverInfo: { name: string; version: string };
  /** Register the hosted tool surface onto a server, against a client. */
  register: (server: ProbeServer, client: AxonityClient) => void;
  /** Rewrite the recorded tools before they are served (their texts). */
  prepare?: (tools: RegisteredTool[]) => RegisteredTool[] | Promise<RegisteredTool[]>;
  /** Bind address. Loopback; a test may not change it either. */
  host?: "127.0.0.1";
  /**
   * How long an answer may stand still in this process before the connection is
   * cut, in milliseconds. Not a setting of the connector: only a test changes it.
   */
  answerStallMs?: number;
  /** Where the one startup line goes. Never a token. */
  log?: (message: string) => void;
}

/** The limits the gate applies: the part of `HttpConfig` that is about load. */
type HostedLimits = Pick<
  HttpConfig,
  | "maxInFlight"
  | "maxQueued"
  | "maxInFlightPerToken"
  | "maxQueuedPerToken"
  | "maxLargeBodies"
  | "maxStructureInFlight"
>;

export interface HostedServer {
  server: Server;
  port: number;
  /** Tokens that hold a place or have a caller waiting now (0 when idle). */
  tokensTracked: () => number;
  close: () => Promise<void>;
}

/** A waiting room with a fixed number of seats. */
class Seats {
  private inFlight = 0;
  private readonly waiting: ((leave: () => void) => void)[] = [];

  constructor(
    private readonly seats: number,
    private readonly room: number,
  ) {}

  get idle(): boolean {
    return this.inFlight === 0 && this.waiting.length === 0;
  }

  /**
   * A release function once seated; `"full"` when there is no seat and no room
   * to wait; `"gone"` when `gone` fires while waiting — a caller that hung up
   * leaves the queue at once, it does not keep its place until a seat is free.
   */
  async enter(gone: AbortSignal): Promise<(() => void) | "full" | "gone"> {
    if (gone.aborted) return "gone";
    if (this.inFlight < this.seats) {
      this.inFlight += 1;
      return this.leaver();
    }
    if (this.waiting.length >= this.room) return "full";
    return new Promise((resolve) => {
      const grant = (leave: () => void) => {
        gone.removeEventListener("abort", giveUp);
        resolve(leave);
      };
      const giveUp = () => {
        const at = this.waiting.indexOf(grant);
        if (at >= 0) this.waiting.splice(at, 1);
        resolve("gone");
      };
      this.waiting.push(grant);
      gone.addEventListener("abort", giveUp, { once: true });
    });
  }

  private leaver(): () => void {
    let left = false;
    return () => {
      if (left) return;
      left = true;
      const next = this.waiting.shift();
      // The seat is handed over to the one next in line; the count did not drop.
      if (next) next(this.leaver());
      else this.inFlight -= 1;
    };
  }
}

/**
 * A budget shared by weight: the sum of what is held never passes `capacity`,
 * and what does not fit waits its turn (first come, first served, so a heavy
 * one is not starved by a stream of light ones). A request waits here only
 * while it holds a seat, so how many can wait is bounded by the seats and the
 * queue before them; nobody waits for the budget while holding something that
 * one who holds it needs.
 */
class Budget {
  private used = 0;
  private readonly waiting: { weight: number; grant: () => void }[] = [];

  constructor(private readonly capacity: number) {}

  /** A release function once the weight is held; `"gone"` when `gone` fires while waiting. */
  async enter(weight: number, gone: AbortSignal): Promise<(() => void) | "gone"> {
    if (gone.aborted) return "gone";
    // A weight the budget could never hold is held whole: the config refuses a
    // limit per message above the budget, this keeps a mistake from waiting for ever.
    const w = Math.min(Math.max(weight, 1), this.capacity);
    if (this.waiting.length === 0 && this.used + w <= this.capacity) {
      this.used += w;
      return this.leaver(w);
    }
    return new Promise((resolve) => {
      const entry = {
        weight: w,
        grant: () => {
          gone.removeEventListener("abort", giveUp);
          this.used += w;
          resolve(this.leaver(w));
        },
      };
      const giveUp = () => {
        const at = this.waiting.indexOf(entry);
        if (at >= 0) this.waiting.splice(at, 1);
        resolve("gone");
        // The one in front may have been the only thing keeping the others out.
        this.admit();
      };
      this.waiting.push(entry);
      gone.addEventListener("abort", giveUp, { once: true });
    });
  }

  private leaver(weight: number): () => void {
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.used -= weight;
      this.admit();
    };
  }

  private admit(): void {
    while (this.waiting.length > 0 && this.used + this.waiting[0].weight <= this.capacity) {
      this.waiting.shift()!.grant();
    }
  }
}

type Admission =
  | { kind: "seat"; leave: () => void }
  | { kind: "token_busy" }
  | { kind: "busy" }
  | { kind: "gone" };

/**
 * Where a request waits, in this order: the places of its own token (so one
 * token cannot fill what everybody shares), then — for a big body — the big-body
 * places (so the bodies held in memory at once are few), then the seats. A
 * request waiting in an earlier room holds nothing in a later one, and nobody
 * waits for something while holding what the one they wait for needs.
 */
class Gate {
  private readonly tokens = new Map<string, Seats>();
  private readonly large: Seats;
  private readonly seats: Seats;

  constructor(private readonly limits: HostedLimits) {
    this.seats = new Seats(limits.maxInFlight, limits.maxQueued);
    this.large = new Seats(limits.maxLargeBodies, limits.maxQueued);
  }

  /** How many tokens have a place or a waiting caller right now. */
  get tokensTracked(): number {
    return this.tokens.size;
  }

  async enter(token: string, large: boolean, gone: AbortSignal): Promise<Admission> {
    // A hash, so the token itself is not what the map is keyed by.
    const key = createHash("sha256").update(token).digest("hex");
    let mine = this.tokens.get(key);
    if (!mine) {
      mine = new Seats(this.limits.maxInFlightPerToken, this.limits.maxQueuedPerToken);
      this.tokens.set(key, mine);
    }
    const own = mine;
    const tidy = () => {
      if (own.idle && this.tokens.get(key) === own) this.tokens.delete(key);
    };

    const held: (() => void)[] = [];
    let left = false;
    const leaveAll = () => {
      if (left) return;
      left = true;
      while (held.length) held.pop()!();
      tidy();
    };
    const rooms: [Seats, "token_busy" | "busy"][] = [[own, "token_busy"]];
    if (large) rooms.push([this.large, "busy"]);
    rooms.push([this.seats, "busy"]);
    for (const [room, refusal] of rooms) {
      const got = await room.enter(gone);
      if (typeof got !== "function") {
        leaveAll();
        return got === "gone" ? { kind: "gone" } : { kind: refusal };
      }
      held.push(got);
    }
    return { kind: "seat", leave: leaveAll };
  }
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** A JSON-RPC error with no id: the request never became a message. */
function rpcError(code: number, message: string): unknown {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

/**
 * Counts the JSON structure marks `{`, `[` and `,` outside strings, a chunk at
 * a time (the state carries over, so where the body is cut does not matter).
 *
 * Every value a parse makes (an object, an array, an item, a member) is
 * opened by one of these marks, so the count bounds what `JSON.parse` and the
 * schemas behind it will build, whatever the body's size: 10 MB of `{},` is
 * 3.3 million objects, and that — not the 10 MB — ended the process. A string
 * is not structure (a 20 MB base64 file is one value), so it does not count,
 * and for a valid body this count is exact; an invalid one fails to parse at
 * the first fault, before anything past it is built.
 */
export class StructureCounter {
  private count = 0;
  private inString = false;
  private escaped = false;

  /** Add a chunk; the count so far. */
  add(chunk: Uint8Array): number {
    let count = this.count;
    let inString = this.inString;
    let escaped = this.escaped;
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (byte === 0x5c) escaped = true;
        else if (byte === 0x22) inString = false;
      } else if (byte === 0x22) {
        inString = true;
      } else if (byte === 0x7b || byte === 0x5b || byte === 0x2c) {
        count += 1;
      }
    }
    this.count = count;
    this.inString = inString;
    this.escaped = escaped;
    return count;
  }
}

class BodyTooLarge extends Error {}
class BodyTooComplex extends Error {}

/** A body read, and the structure marks it holds (what the budget is weighed in). */
interface BodyRead {
  raw: Buffer;
  structure: number;
}

async function readBody(req: IncomingMessage, limit: number, maxStructure: number): Promise<BodyRead> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  const counter = new StructureCounter();
  let structure = 0;
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new BodyTooLarge();
    // Counted as it arrives: a body that holds too much is refused after the
    // chunk that crosses the line, not after the whole of it has been read.
    structure = counter.add(chunk as Buffer);
    if (structure > maxStructure) throw new BodyTooComplex();
    chunks.push(chunk as Buffer);
  }
  return { raw: Buffer.concat(chunks), structure };
}

/** The tool list, rendered once by the SDK itself from one replayed server. */
async function listOnce(
  serverInfo: HostedServerOptions["serverInfo"],
  tools: RegisteredTool[],
): Promise<ListToolsResult> {
  const server = replay(serverInfo, tools);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "axonity-tool-list", version: "0" });
  await client.connect(clientSide);
  try {
    return await client.listTools();
  } finally {
    await client.close();
    await server.close();
  }
}

function replay(serverInfo: HostedServerOptions["serverInfo"], tools: RegisteredTool[]): McpServer {
  const server = new McpServer(serverInfo);
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.shape as never, tool.handler as never);
  }
  return server;
}

/**
 * Start the hosted connector. Resolves once it listens.
 *
 * Answers `POST /mcp` only: GET and DELETE on it are 405 (no sessions, no
 * server stream — a client falls back to plain requests), anything else 404.
 */
export async function startHostedServer(options: HostedServerOptions): Promise<HostedServer> {
  // What belongs to the request being handled: its caller's token, and the
  // tool calls it started (a seat is given back only once they are done).
  const ofRequest = new AsyncLocalStorage<{ token: string; work: Set<Promise<unknown>> }>();
  const client = new AxonityClient({
    apiUrl: options.apiUrl,
    timeoutMs: options.apiTimeoutMs,
    get token(): string {
      const token = ofRequest.getStore()?.token;
      // Only reachable by a call made outside any request — a bug, and one
      // that must fail rather than send no token or somebody else's.
      if (!token) throw new Error("No request token: the hosted connector calls the API only for a request.");
      return token;
    },
  });

  const recorded = recordTools(options.register, client);
  const prepared = options.prepare ? await options.prepare(recorded) : recorded;
  const toolList = await listOnce(options.serverInfo, prepared);
  // Every tool call is counted with the request that started it.
  const tools = prepared.map((tool) => ({
    ...tool,
    handler: ((args: never, extra: never) => {
      const work = Promise.resolve(tool.handler(args, extra));
      const mine = ofRequest.getStore()?.work;
      if (mine) {
        mine.add(work);
        const done = () => mine.delete(work);
        work.then(done, done);
      }
      return work;
    }) as RegisteredTool["handler"],
  }));
  const gate = new Gate(options);
  const budget = new Budget(options.maxStructureInFlight);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== MCP_PATH) {
      send(res, 404, { error: "Not found. The MCP endpoint is /mcp." });
      return;
    }
    if (req.method !== "POST") {
      // No sessions and no standalone stream: a GET or DELETE has nothing to act on.
      send(res, 405, rpcError(-32000, "Method not allowed. Send each message as a POST."), {
        Allow: "POST",
      });
      return;
    }
    const bearer = PERSONAL_BEARER.exec(req.headers.authorization ?? "");
    if (!bearer) {
      send(res, 401, rpcError(-32001, "A personal token (axp_…) is required as a bearer."), {
        "WWW-Authenticate": 'Bearer realm="axonity"',
      });
      return;
    }
    const token = bearer[1];

    // A body that is too large is refused before it waits for anything; one
    // that is large, or does not say its size, takes a big-body place first.
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > options.maxBodyBytes) {
      send(res, 413, rpcError(-32000, "Request body too large."));
      return;
    }
    const large = !Number.isFinite(declared) || declared > options.largeBodyBytes;

    // The seat. A caller that hangs up while it waits gives up its place
    // (`hungUp` ends the wait in whichever room it is in): nobody is left to
    // answer. One that hangs up once seated keeps it until the tool calls it
    // started are done — the SDK does not finish a request whose connection
    // is gone, so waiting for that would hold the seat for ever, and giving it
    // back at once would let work pile up past the ceiling by connecting and
    // hanging up (review of the hosted mode, S-1).
    const context = { token, work: new Set<Promise<unknown>>() };
    const hungUp = new AbortController();
    let gone = false;
    let leave: (() => void) | undefined;
    // What the message holds of the shared budget, once it is read and weighed.
    let leaveBudget: (() => void) | undefined;
    res.once("close", () => {
      gone = true;
      hungUp.abort();
      const seated = leave;
      if (seated) void Promise.allSettled([...context.work]).then(seated);
    });
    const admission = await gate.enter(token, large, hungUp.signal);
    if (admission.kind === "gone") return;
    if (admission.kind === "token_busy") {
      send(res, 429, rpcError(-32000, "Too many calls from this token at once. Try again in a moment."), {
        "Retry-After": "1",
      });
      return;
    }
    if (admission.kind === "busy") {
      send(res, 503, rpcError(-32000, "The connector is busy. Try again in a moment."), {
        "Retry-After": "1",
      });
      return;
    }
    // The seat and the budget are given back together, once, whichever comes first.
    let left = false;
    const seat = admission.leave;
    leave = () => {
      if (left) return;
      left = true;
      seat();
      leaveBudget?.();
    };
    if (gone) {
      leave();
      return;
    }
    try {
      let body: unknown;
      try {
        const { raw, structure } = await readBody(req, options.maxBodyBytes, options.maxStructure);
        // Weighed before it is parsed: what a parse builds hangs on the marks, and
        // the limit per message does not bound the sum of the messages in work at
        // once. One that does not fit waits here, holding its seat (so the queue and
        // the 503 behind the seats are the ones that were there already).
        const got = await budget.enter(structure, hungUp.signal);
        if (got === "gone") return;
        leaveBudget = got;
        // The caller hung up and the seat went back while it waited: nothing more is held.
        if (left) got();
        if (gone) return;
        body = JSON.parse(raw.toString("utf8"));
        if (Array.isArray(body)) {
          send(res, 400, rpcError(-32600, "Invalid Request: send one message per POST, not a batch."));
          return;
        }
      } catch (error) {
        if (error instanceof BodyTooLarge) {
          send(res, 413, rpcError(-32000, "Request body too large."));
        } else if (error instanceof BodyTooComplex) {
          send(
            res,
            400,
            rpcError(
              -32600,
              `Invalid Request: the message holds more than ${options.maxStructure} objects, ` +
                "array items and members (the connector's limit). Send less in one call, " +
                "for example fewer rows or steps.",
            ),
          );
        } else {
          send(res, 400, rpcError(-32700, "Parse error: the body is not JSON."));
        }
        return;
      }
      if (gone) return;

      const server = replay(options.serverInfo, tools);
      server.server.setRequestHandler(ListToolsRequestSchema, () => toolList);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.once("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await ofRequest.run(context, () => transport.handleRequest(req, res, body));
    } finally {
      // A request that ended without its connection going (an answer, a
      // refusal) gives its seat back once the answer has left this process;
      // one whose caller hung up gives it back when its work is done (above).
      // Not when the handler returns: the answer is still in this process then
      // (a failed call of a big message is ten megabytes of errors, a thousand
      // times its request), and seats that go back before it is written let
      // those pile up past the heap. Leaving twice is a no-op.
      if (!gone) {
        if (res.writableFinished) {
          leave();
        } else {
          // An answer nobody reads would keep the seat for ever: the connection
          // is cut when it stands still for `answerStallMs` with the answer in
          // it, and a cut connection gives the seat back like any hang-up.
          const socket = res.socket;
          const stall = options.answerStallMs ?? ANSWER_STALL_MS;
          socket?.setTimeout(stall, () => socket.destroy());
          res.once("finish", () => {
            socket?.setTimeout(0);
            leave();
          });
        }
      }
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      // Never the error itself: it could quote a header.
      send(res, 500, rpcError(-32603, "Internal error in the connector."));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  (options.log ?? ((m: string) => console.error(m)))(
    `Axonity MCP connector (hosted) ready on 127.0.0.1:${port}${MCP_PATH}, ` +
      `${tools.length} tools, API ${options.apiUrl}.`,
  );
  return {
    server,
    port,
    tokensTracked: () => gate.tokensTracked,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
