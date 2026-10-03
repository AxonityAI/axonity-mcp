/**
 * The prompt-element placement rules come from the PLATFORM, not this repo.
 *
 * `axonity_conventions` used to carry its own "decision map" — where a persona,
 * a policy, a skill, a reference doc and a step activity each belong — and it
 * contradicted the platform's rules. The platform now serves those rules
 * (`GET /api/v1/authoring/prompt-placement`), and the guide appends them live.
 * When they cannot be read, the guide says so and tells the agent not to touch
 * prompt elements — it never falls back to a local copy, because a local copy
 * is exactly what drifted.
 */

import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { AxonityApiError } from "../src/errors.js";
import {
  CONVENTIONS,
  PLACEMENT_ROUTE,
  registerConventions,
} from "../src/tools/conventions.js";
import { PLACEMENT_RESPONSE } from "./placementStub.js";

interface ToolResult {
  isError?: boolean;
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
    description: descriptions.get("axonity_conventions")!,
    call: async () => (await handlers.get("axonity_conventions")!()).content[0].text,
  };
}

describe("axonity_conventions appends the platform's placement rules", () => {
  it("reads the placement route on every call", async () => {
    const { client, call } = harness(async () => PLACEMENT_RESPONSE);
    await call();
    await call();
    expect(PLACEMENT_ROUTE).toBe("/api/v1/authoring/prompt-placement");
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(client.get).toHaveBeenCalledWith("/api/v1/authoring/prompt-placement");
  });

  it("returns CONVENTIONS, then a version line, then the served markdown", async () => {
    const { call } = harness(async () => PLACEMENT_RESPONSE);
    const text = await call();

    expect(text.startsWith(CONVENTIONS)).toBe(true);
    expect(text).toContain("rulesVersion `pp-0123abcd`");
    expect(text).toMatch(/served live by this deploy/);
    expect(text.endsWith(PLACEMENT_RESPONSE.markdown)).toBe(true);
    for (let n = 1; n <= 8; n++) expect(text).toContain(`## ${n}.`);
    expect(text).not.toMatch(/could not be read/);

    // The version line sits between the guide and the rules.
    const guideEnd = CONVENTIONS.length;
    const rulesStart = text.indexOf("# Prompt element placement — the rules");
    const versionAt = text.indexOf("pp-0123abcd");
    expect(versionAt).toBeGreaterThan(guideEnd - 1);
    expect(versionAt).toBeLessThan(rulesStart);
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
  ])("says so loudly on %s, and serves no rules", async (_label, get) => {
    const { call } = harness(get as (p: string) => Promise<unknown>);
    const text = await call();

    expect(text.startsWith(CONVENTIONS)).toBe(true);
    expect(text).toMatch(/placement rules could not be read from this deploy/i);
    expect(text).toMatch(/must not be changed until they can be read/i);
    for (const element of ["persona", "policy", "skill", "reference doc", "step activities"]) {
      expect(text.slice(CONVENTIONS.length)).toContain(element);
    }
    expect(text).not.toContain("# Prompt element placement — the rules");
    expect(text).not.toMatch(/served live by this deploy/);
  });

  it("the tool description says it returns this deploy's placement rules", () => {
    const { description } = harness(async () => PLACEMENT_RESPONSE);
    expect(description).toMatch(/prompt-placement rules/);
    expect(description).toMatch(/this deploy/);
  });
});

describe("CONVENTIONS states no placement rules of its own", () => {
  it("carries no decision map", () => {
    expect(CONVENTIONS).not.toMatch(/decision map/i);
    expect(CONVENTIONS).not.toMatch(/where each kind of instruction belongs/i);
  });

  it("does not say where an instruction belongs", () => {
    // The lines the old map carried, each a placement claim the platform owns.
    expect(CONVENTIONS).not.toMatch(/voice\/character for one agent/);
    expect(CONVENTIONS).not.toMatch(/background knowledge the agent reads/);
    expect(CONVENTIONS).not.toMatch(/step-specific instruction/);
    expect(CONVENTIONS).not.toMatch(/a rule that must hold everywhere/);
  });

  it("points at the platform's rules instead", () => {
    expect(CONVENTIONS).toMatch(
      /placement rules are served by the platform and appended to this guide/,
    );
  });

  it("keeps the placement MECHANICS", () => {
    expect(CONVENTIONS).toContain("attach_prompt_snippet_to_flow_step");
    expect(CONVENTIONS).toContain("reorder_flow_step_prompts");
    expect(CONVENTIONS).toContain("list_wildcard_prompts");
    expect(CONVENTIONS).toContain("episodicMemoryEnabled");
  });

  it("states no size budget for a prompt element", () => {
    expect(CONVENTIONS).not.toMatch(/\b\d[\d,]*\s*(characters|chars|words|tokens)\b/i);
  });
});
