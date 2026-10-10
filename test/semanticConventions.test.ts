/**
 * The rules for writing the semantic layer come from the PLATFORM, not this repo.
 *
 * Same contract as the placement rules (`conventionsPlacement.test.ts`): read
 * live from `GET /api/v1/authoring/semantic-knowledge`, introduced with their
 * `rulesVersion`, and when they cannot be read the tool says so and tells the
 * agent to write no knowledge — never a local copy. The difference is reach:
 * they have their own tool, and `axonity_conventions` only points at it.
 */

import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { AxonityApiError } from "../src/errors.js";
import {
  CONVENTIONS,
  PLACEMENT_ROUTE,
  SEMANTIC_KNOWLEDGE_ROUTE,
  registerConventions,
} from "../src/tools/conventions.js";
import { PLACEMENT_RESPONSE } from "./placementStub.js";

const SEMANTIC_RESPONSE = {
  markdown: [
    "# Semantic knowledge — how to write it",
    "",
    "## A source query says what one row of its result is",
    "That decides what the table can be asked afterwards.",
  ].join("\n"),
  rulesVersion: "sk-f187a66c",
};

interface ToolResult {
  content: { text: string }[];
}

function harness(get: (path: string) => Promise<unknown>) {
  const handlers = new Map<string, () => Promise<ToolResult>>();
  const descriptions = new Map<string, string>();
  const server = {
    tool: (name: string, d: string, _s: unknown, h: () => Promise<ToolResult>) => {
      handlers.set(name, h);
      descriptions.set(name, d);
    },
  };
  const client = { get: vi.fn(get) };
  registerConventions(server as never, client as unknown as AxonityClient);
  return {
    client,
    description: descriptions.get("axonity_semantic_conventions")!,
    call: async (name = "axonity_semantic_conventions") =>
      (await handlers.get(name)!()).content[0].text,
  };
}

describe("axonity_semantic_conventions serves the platform's rules", () => {
  it("reads the semantic-knowledge route on every call", async () => {
    const { client, call } = harness(async () => SEMANTIC_RESPONSE);
    await call();
    await call();
    expect(SEMANTIC_KNOWLEDGE_ROUTE).toBe("/api/v1/authoring/semantic-knowledge");
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(client.get).toHaveBeenCalledWith("/api/v1/authoring/semantic-knowledge");
  });

  it("returns a version line, then the served markdown verbatim", async () => {
    const { call } = harness(async () => SEMANTIC_RESPONSE);
    const text = await call();

    expect(text).toContain("rulesVersion `sk-f187a66c`");
    expect(text).toMatch(/served live by this deploy/);
    expect(text.endsWith(SEMANTIC_RESPONSE.markdown)).toBe(true);
    expect(text.indexOf("sk-f187a66c")).toBeLessThan(text.indexOf("# Semantic knowledge"));
    expect(text).not.toMatch(/could not be read/);
  });

  it.each([
    ["an old backend without the route (404)", async () => {
      throw new AxonityApiError("Not found.", 404);
    }],
    ["a network error", async () => {
      throw new AxonityApiError("Could not reach the Axonity API.", 0);
    }],
    ["an unexpected throw", async () => {
      throw new Error("boom");
    }],
    ["a response without markdown", async () => ({ ok: true })],
    ["an empty markdown body", async () => ({ markdown: "  ", rulesVersion: "x" })],
  ])("says so on %s, and serves no rules", async (_label, get) => {
    const { call } = harness(get as (p: string) => Promise<unknown>);
    const text = await call();

    expect(text).toMatch(/could not be read from this deploy/i);
    expect(text).toContain(SEMANTIC_KNOWLEDGE_ROUTE);
    expect(text).toMatch(/does not carry a copy/);
    expect(text).toMatch(/Do not build the semantic model/);
    expect(text).toMatch(/until they can be read/);
    expect(text).not.toMatch(/served live by this deploy/);
  });

  it("does not reach into axonity_conventions: that guide never reads this route", async () => {
    const { client, call } = harness(async (path) =>
      path === PLACEMENT_ROUTE ? PLACEMENT_RESPONSE : SEMANTIC_RESPONSE,
    );
    const guide = await call("axonity_conventions");
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith(PLACEMENT_ROUTE);
    expect(guide).not.toContain(SEMANTIC_RESPONSE.markdown);
  });

  it("the description says when to read it, and that it is live", () => {
    const { description } = harness(async () => SEMANTIC_RESPONSE);
    expect(description).toMatch(/semantic model/);
    expect(description).toMatch(/this deploy/);
    expect(description).toMatch(/live/);
  });
});

describe("CONVENTIONS points at the semantic rules without restating them", () => {
  it("names the tool where reference docs are described", () => {
    const section = CONVENTIONS.slice(
      CONVENTIONS.indexOf("### skill / policy / reference_doc"),
      CONVENTIONS.indexOf("### prompt_snippet"),
    );
    expect(section).toMatch(/SEMANTIC MODEL/);
    expect(section).toContain("axonity_semantic_conventions");
    expect(section).toMatch(/served by the platform/);
  });
});
