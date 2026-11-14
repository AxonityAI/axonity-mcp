import { spawn } from "node:child_process";
import { createServer as netServer } from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadHttpConfig, transportOf } from "../src/config.js";

describe("transportOf", () => {
  it("is stdio unless told otherwise, so the local connector is unchanged", () => {
    expect(transportOf({})).toBe("stdio");
    expect(transportOf({ AXONITY_MCP_TRANSPORT: "http" })).toBe("http");
    expect(() => transportOf({ AXONITY_MCP_TRANSPORT: "sse" })).toThrow(/stdio.*http/);
  });
});

describe("loadHttpConfig", () => {
  const base = { AXONITY_API_URL: "http://127.0.0.1:8000/", AXONITY_MCP_PORT: "8765" };

  it("reads the API and the port, with the ceilings' defaults", () => {
    expect(loadHttpConfig(base)).toEqual({
      apiUrl: "http://127.0.0.1:8000",
      port: 8765,
      maxInFlight: 4,
      maxQueued: 32,
      maxBodyBytes: 25 * 1024 * 1024,
      apiTimeoutMs: 300_000,
    });
  });

  it("holds no token of its own: AXONITY_TOKEN set is refused", () => {
    expect(() => loadHttpConfig({ ...base, AXONITY_TOKEN: "axs_x" })).toThrow(/holds no token/);
  });

  it("has no default API and needs a port", () => {
    expect(() => loadHttpConfig({ AXONITY_MCP_PORT: "1" })).toThrow(/AXONITY_API_URL/);
    expect(() => loadHttpConfig({ AXONITY_API_URL: "http://x" })).toThrow(/AXONITY_MCP_PORT/);
    expect(() => loadHttpConfig({ ...base, AXONITY_MCP_PORT: "0" })).toThrow(/at least 1/);
    expect(() => loadHttpConfig({ ...base, AXONITY_MCP_PORT: "70000" })).toThrow(/65535/);
    expect(() => loadHttpConfig({ ...base, AXONITY_MCP_MAX_IN_FLIGHT: "two" })).toThrow(/whole number/);
  });
});

async function freePort(): Promise<number> {
  const probe = netServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

describe("the entry point in HTTP mode", () => {
  it("starts on loopback and serves the tools worded for a personal token", async () => {
    const port = await freePort();
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    const child = spawn(tsx, [entry], {
      env: {
        PATH: process.env.PATH,
        AXONITY_MCP_TRANSPORT: "http",
        AXONITY_MCP_PORT: String(port),
        AXONITY_API_URL: "http://127.0.0.1:9",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      let stderr = "";
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`not ready: ${stderr}`)), 20_000);
        child.stderr!.on("data", (chunk) => {
          stderr += String(chunk);
          if (stderr.includes("ready on 127.0.0.1")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
      });
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer axp_entry",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      const tools = ((await res.json()) as { result: { tools: { name: string; description: string }[] } })
        .result.tools;
      const del = tools.find((t) => t.name === "delete_workflow")!;
      expect(del.description).toMatch(/^NOT AVAILABLE WITH A PERSONAL TOKEN/);
      expect(stderr).not.toContain("axp_entry");
    } finally {
      child.kill();
    }
  }, 30_000);
});
