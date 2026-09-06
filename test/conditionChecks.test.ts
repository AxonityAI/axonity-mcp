import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerConventions } from "../src/tools/conventions.js";
import { registerTriggerTools } from "../src/tools/triggers.js";

/**
 * axonity-mcp#66 — a conditional trigger can have its check set.
 *
 * axonity-flow#1354/#1356/#1363 gave a conditional start a CHECK: a gate in
 * the dispatch loop that decides whether a beat becomes a run at all. The read
 * side already worked, because `list_conditional_triggers` is a pass-through
 * with no field list. The write side did not carry the two fields, so the
 * feature was built, live, and unreachable through the connector — a mailbox
 * kept making an empty run every fifteen minutes with the fix sitting there.
 *
 * Two things are worth pinning beyond "the field arrives":
 *
 *   1. `checkKind: ""` must survive the body filter. It is the ONLY way to
 *      clear a check, and it is one `!== undefined` away from being dropped as
 *      if the caller had said nothing — which would leave an author able to
 *      switch a check on and never off.
 *   2. The connector must NOT judge a check. The backend validates with the
 *      same function the dispatcher runs when the trigger fires, so a setting
 *      that saves is a setting that runs. A second rule set here would drift,
 *      invisibly, and the failure would land at three in the morning.
 */

function setup() {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const descriptions = new Map<string, string>();
  const server = {
    tool: (
      name: string,
      description: string,
      _schema: unknown,
      handler: (a: never) => Promise<unknown>,
    ) => {
      handlers.set(name, handler as (args: Record<string, unknown>) => Promise<unknown>);
      descriptions.set(name, description);
    },
  };
  const client = {
    get: vi.fn(async () => ({ ok: true })),
    post: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => undefined),
  };
  registerTriggerTools(server as never, client as unknown as AxonityClient);
  return { handlers, descriptions, client };
}

/** The shape the issue's acceptance case uses. */
const AUTOMATIC = {
  toolId: "9b549583-fade-45d7-9e6b-22c93cff7e0c",
  inputs: { limit: 25 },
  rule: { field: "count", op: "greater_than", value: 0 },
};

describe("create_conditional_trigger carries the check", () => {
  it("posts checkKind and checkConfig when they are given", async () => {
    const { handlers, client } = setup();
    await handlers.get("create_conditional_trigger")!({
      workflowId: "w-1",
      triggerId: "t-1",
      agentId: "a-1",
      conditionText: "there is unread mail",
      repeatIntervalMinutes: 15,
      checkKind: "automatic",
      checkConfig: AUTOMATIC,
    });

    expect(client.post).toHaveBeenCalledWith(
      "/api/v1/workflows/w-1/conditional-triggers",
      {
        triggerId: "t-1",
        agentId: "a-1",
        conditionText: "there is unread mail",
        repeatIntervalMinutes: 15,
        checkKind: "automatic",
        checkConfig: AUTOMATIC,
      },
    );
  });

  it("sends neither key when neither is given", async () => {
    // Absent is not the same as null on the wire here, and a trigger with no
    // check is the pre-existing behaviour — every start authored before this.
    const { handlers, client } = setup();
    await handlers.get("create_conditional_trigger")!({
      workflowId: "w-1",
      triggerId: "t-1",
      agentId: "a-1",
      conditionText: "a new CV arrives",
      repeatIntervalMinutes: 15,
    });

    const [, body] = client.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty("checkKind");
    expect(body).not.toHaveProperty("checkConfig");
  });
});

describe("update_conditional_trigger can set AND clear the check", () => {
  it("patches both fields onto an existing trigger", async () => {
    const { handlers, client } = setup();
    await handlers.get("update_conditional_trigger")!({
      triggerId: "17f2a6e1-ddf4-4b1c-8c78-67a65c92c0cf",
      checkKind: "automatic",
      checkConfig: AUTOMATIC,
    });

    expect(client.patch).toHaveBeenCalledWith(
      "/api/v1/conditional-triggers/17f2a6e1-ddf4-4b1c-8c78-67a65c92c0cf",
      { checkKind: "automatic", checkConfig: AUTOMATIC },
    );
  });

  it("passes an EMPTY STRING through — the only way to clear a check", async () => {
    // The body filter drops `undefined`, not falsy. "" is a stated intention
    // and must reach the backend, which clears the kind and its config with it.
    // If this ever regresses, a check becomes one-way and nothing else here
    // would notice.
    const { handlers, client } = setup();
    await handlers.get("update_conditional_trigger")!({
      triggerId: "ct-1",
      checkKind: "",
    });

    const [, body] = client.patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).toEqual({ checkKind: "" });
    expect(Object.prototype.hasOwnProperty.call(body, "checkKind")).toBe(true);
  });

  it("still sends only what was supplied", async () => {
    const { handlers, client } = setup();
    await handlers.get("update_conditional_trigger")!({
      triggerId: "ct-1",
      enabled: false,
    });

    expect(client.patch).toHaveBeenCalledWith("/api/v1/conditional-triggers/ct-1", {
      enabled: false,
    });
  });
});

describe("the connector forwards a check, it does not judge one", () => {
  it("passes a kind the backend will refuse straight through", async () => {
    // `agent` is a valid value the backend REFUSES today, because the judgement
    // is not built. Rejecting it here would produce a different message from
    // the one the platform gives, for the same situation.
    const { handlers, client } = setup();
    await handlers.get("update_conditional_trigger")!({
      triggerId: "ct-1",
      checkKind: "agent",
    });

    expect(client.patch).toHaveBeenCalledWith("/api/v1/conditional-triggers/ct-1", {
      checkKind: "agent",
    });
  });

  it("passes a malformed config through unaltered", async () => {
    // No toolId, an operator that does not exist, and a rule missing `field`.
    // Every one of these is refused at save time by the same function the
    // dispatcher uses — and the refusal names what to fix. A Zod error here
    // would say less, and would drift from that list the moment it changed.
    const broken = { rule: { op: "sounds_like", value: 3 } };
    const { handlers, client } = setup();
    await handlers.get("update_conditional_trigger")!({
      triggerId: "ct-1",
      checkKind: "automatic",
      checkConfig: broken,
    });

    expect(client.patch).toHaveBeenCalledWith("/api/v1/conditional-triggers/ct-1", {
      checkKind: "automatic",
      checkConfig: broken,
    });
  });
});

describe("the descriptions say what actually decides", () => {
  it("no longer claims an agent is what evaluates the condition", () => {
    const { descriptions } = setup();
    for (const name of [
      "list_conditional_triggers",
      "create_conditional_trigger",
      "update_conditional_trigger",
    ]) {
      const d = descriptions.get(name)!;
      // The old sentence — "an agent evaluates a condition" / "an agent checks
      // `conditionText`" — sends a reader down the expensive path without
      // telling them a cheap one exists.
      expect(d, `${name} still says an agent evaluates`).not.toMatch(
        /an agent (evaluates|checks)/i,
      );
      expect(d).toMatch(/checkKind/);
    }
  });

  it("says what no check means, which is what every existing trigger has", () => {
    const { descriptions } = setup();
    expect(descriptions.get("create_conditional_trigger")!).toMatch(/EVERY beat/i);
    expect(descriptions.get("list_conditional_triggers")!).toMatch(/every beat/i);
  });

  it("documents the empty string as the way to clear a check", () => {
    const { descriptions } = setup();
    const d = descriptions.get("update_conditional_trigger")!;
    expect(d).toMatch(/CLEAR/);
    expect(d).toMatch(/empty string/i);
  });

  it("tells the authoring guide too, not only the tool descriptions", async () => {
    // An agent reads `axonity_conventions` before it authors; a tool
    // description is only met once it has already chosen the tool. The default
    // is the expensive one here — every beat becomes a run — so the guide is
    // where "you probably want a check" has to be said.
    const handlers = new Map<string, () => Promise<{ content: { text: string }[] }>>();
    registerConventions({
      tool: (n: string, _d: string, _s: unknown, h: () => Promise<{ content: { text: string }[] }>) =>
        handlers.set(n, h),
    } as never);
    const guide = (await handlers.get("axonity_conventions")!()).content[0].text;

    expect(guide).toMatch(/checkKind/);
    expect(guide).toMatch(/every beat/i);
    // The clearing rule, which is the half an author cannot guess.
    expect(guide).toMatch(/checkKind: ""/);
  });

  it("does not enumerate the comparison operators", () => {
    // #32's lesson, and this issue is a live example of why: the text that
    // asked for this work listed seven operators where the backend has eight
    // (`not_contains` was missing). No route serves the list, so there is
    // nothing to pin it to — and a list nobody can check is one that goes
    // wrong in the direction that costs a call. The refusal names the usable
    // set; the description points at that instead.
    const { descriptions } = setup();
    const operators = [
      "is_not",
      "contains",
      "not_contains",
      "is_empty",
      "is_not_empty",
      "greater_than",
      "less_than",
    ];
    const alternation = operators.join("|");
    const enumeration = new RegExp(`(${alternation})\\b[^\\n]{0,12}?,[^\\n]{0,12}?\\b(${alternation})`);

    // The guard bites on the shape a hand-kept list would take.
    expect(
      "Usable: is, is_not, greater_than, less_than.".match(enumeration),
    ).not.toBeNull();

    for (const [name, text] of setup().descriptions) {
      const found = text.match(enumeration)?.[0];
      expect(
        found,
        `${name} lists the comparison operators ("${found}") — let the ` +
          "backend's refusal name them (#32)",
      ).toBeUndefined();
    }
    expect(descriptions.size).toBeGreaterThan(0);
  });
});
