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
 * - AT MOST `maxInFlight` REQUESTS AT ONCE, the rest wait, and past
 *   `maxQueued` waiting a request is answered 503. A seat is given back when
 *   the request's work is done, not when its caller hangs up — work that goes
 *   on after a disconnect still holds it — and every API call has a time
 *   limit (`apiTimeoutMs`), so no seat is held for ever. Memory then has a
 *   ceiling that does not depend on how hard anyone pushes (217 MB at fifty
 *   at once, with the V8 limits Axonity starts this process with).
 */

import { AsyncLocalStorage } from "node:async_hooks";
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
  /** Where the one startup line goes. Never a token. */
  log?: (message: string) => void;
}

export interface HostedServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/** A waiting room with a fixed number of seats. */
class Gate {
  private inFlight = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly seats: number,
    private readonly room: number,
  ) {}

  /** A release function once seated, or `undefined` when the room is full. */
  async enter(): Promise<(() => void) | undefined> {
    if (this.inFlight < this.seats) {
      this.inFlight += 1;
      return this.leaver();
    }
    if (this.waiting.length >= this.room) return undefined;
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    // The seat was handed over by the one who left; the count did not drop.
    return this.leaver();
  }

  private leaver(): () => void {
    let left = false;
    return () => {
      if (left) return;
      left = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.inFlight -= 1;
    };
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

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
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
  const gate = new Gate(options.maxInFlight, options.maxQueued);

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

    // The seat. A caller that hangs up while it waits gives up its place:
    // nobody is left to answer. One that hangs up once seated keeps it until
    // the tool calls it started are done — the SDK does not finish a request
    // whose connection is gone, so waiting for that would hold the seat for
    // ever, and giving it back at once would let work pile up past the
    // ceiling by connecting and hanging up (review of the hosted mode, S-1).
    const context = { token, work: new Set<Promise<unknown>>() };
    let gone = false;
    let leave: (() => void) | undefined;
    res.once("close", () => {
      gone = true;
      const seated = leave;
      if (seated) void Promise.allSettled([...context.work]).then(seated);
    });
    leave = await gate.enter();
    if (!leave) {
      send(res, 503, rpcError(-32000, "The connector is busy. Try again in a moment."), {
        "Retry-After": "1",
      });
      return;
    }
    if (gone) {
      leave();
      return;
    }
    try {
      let body: unknown;
      try {
        const raw = await readBody(req, options.maxBodyBytes);
        body = JSON.parse(raw.toString("utf8"));
        if (Array.isArray(body)) {
          send(res, 400, rpcError(-32600, "Invalid Request: send one message per POST, not a batch."));
          return;
        }
      } catch (error) {
        if (error instanceof BodyTooLarge) {
          send(res, 413, rpcError(-32000, "Request body too large."));
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
      // refusal) gives its seat back here; one whose caller hung up gives it
      // back when its work is done (above). Leaving twice is a no-op.
      if (!gone) leave();
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
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
