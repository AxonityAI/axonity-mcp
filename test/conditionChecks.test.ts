import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerConventions } from "../src/tools/conventions.js";
import { placementClient } from "./placementStub.js";
import { registerTriggerTools } from "../src/tools/triggers.js";

/**
 * axonity-mcp#95 — a conditional start's check lives in the WORKFLOW.
 *
 * #66 taught `create_/update_conditional_trigger` to send `checkKind` and
 * `checkConfig`. The platform has since moved the check onto the trigger
 * element in the workflow document and copies it onto the row at publish
 * (`conditional_trigger_sync`). A check sent to the row is REFUSED
 * (`conditional_trigger_service._refuse_check_fields`), so every call the
 * connector advertised for it was a 422. And `create_conditional_trigger` sent
 * no `workflowId` in the body, which `ConditionalTriggerIn` requires: every
 * create was a 422 too.
 *
 * Pinned here: the tools match the platform's body schemas, they do not offer
 * what the platform refuses, and the descriptions and the guide send an author
 * to the document and to publishing.
 */

function setup() {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const descriptions = new Map<string, string>();
  const schemas = new Map<string, Record<string, unknown>>();
  const server = {
    tool: (
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: (a: never) => Promise<unknown>,
    ) => {
      handlers.set(name, handler as (args: Record<string, unknown>) => Promise<unknown>);
      descriptions.set(name, description);
      schemas.set(name, schema);
    },
  };
  const client = {
    get: vi.fn(async () => ({ ok: true })),
    post: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => undefined),
  };
  registerTriggerTools(server as never, client as unknown as AxonityClient);
  return { handlers, descriptions, schemas, client };
}

async function guide(): Promise<string> {
  const handlers = new Map<string, () => Promise<{ content: { text: string }[] }>>();
  registerConventions({
    tool: (n: string, _d: string, _s: unknown, h: () => Promise<{ content: { text: string }[] }>) =>
      handlers.set(n, h),
  } as never, placementClient());
  return (await handlers.get("axonity_conventions")!()).content[0].text;
}

describe("create_conditional_trigger sends what the platform's body schema requires", () => {
  it("puts workflowId in the BODY as well as the path", async () => {
    const { handlers, client } = setup();
    await handlers.get("create_conditional_trigger")!({
      workflowId: "w-1",
      triggerId: "6f1c0e8e-3b7a-4d3e-9f39-0c1f6b5e2a11",
      agentId: "a-1",
      conditionText: "there is unread mail",
      repeatIntervalMinutes: 15,
    });

    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/w-1/conditional-triggers", {
      workflowId: "w-1",
      triggerId: "6f1c0e8e-3b7a-4d3e-9f39-0c1f6b5e2a11",
      agentId: "a-1",
      conditionText: "there is unread mail",
      repeatIntervalMinutes: 15,
    });
  });

  it("never sends a check, even when a caller passes one", async () => {
    const { handlers, client } = setup();
    await handlers.get("create_conditional_trigger")!({
      workflowId: "w-1",
      triggerId: "t-1",
      agentId: "a-1",
      conditionText: "x",
      repeatIntervalMinutes: 15,
      checkKind: "automatic",
      checkConfig: { plan: [] },
    });
    const [, body] = client.post.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty("checkKind");
    expect(body).not.toHaveProperty("checkConfig");
  });

  it("does not offer the check fields on create or update", () => {
    const { schemas } = setup();
    for (const name of ["create_conditional_trigger", "update_conditional_trigger"]) {
      const schema = schemas.get(name)!;
      expect(schema, name).not.toHaveProperty("checkKind");
      expect(schema, name).not.toHaveProperty("checkConfig");
    }
    expect(schemas.get("create_conditional_trigger")).toHaveProperty("workflowId");
  });
});

describe("update_conditional_trigger", () => {
  it("sends only what was supplied, and no check", async () => {
    const { handlers, client } = setup();
    await handlers.get("update_conditional_trigger")!({
      triggerId: "ct-1",
      enabled: false,
      checkKind: "",
    });
    expect(client.patch).toHaveBeenCalledWith("/api/v1/conditional-triggers/ct-1", {
      enabled: false,
    });
  });
});

describe("the descriptions send an author to the workflow document", () => {
  it("each conditional-trigger write says publishing is the normal path", () => {
    const { descriptions } = setup();
    for (const name of [
      "list_conditional_triggers",
      "create_conditional_trigger",
      "update_conditional_trigger",
    ]) {
      const d = descriptions.get(name)!;
      expect(d, name).toMatch(/conditional-poll/);
      expect(d, name).toMatch(/PUBLISHING the workflow creates or updates the row/);
      expect(d, name).toMatch(/apply_workflow_mutations/);
      expect(d, name).toMatch(/UUID/);
      expect(d, name).not.toMatch(/an agent (evaluates|checks)/i);
    }
    expect(descriptions.get("create_conditional_trigger")!).toMatch(/RARELY WHAT YOU WANT/);
    expect(descriptions.get("update_conditional_trigger")!).toMatch(/platform refuses/);
  });

  it("still says what no check means", () => {
    const { descriptions } = setup();
    expect(descriptions.get("list_conditional_triggers")!).toMatch(/every beat/i);
  });

  it("no longer documents the empty string as a way to clear a check", () => {
    const { descriptions } = setup();
    for (const d of descriptions.values()) expect(d).not.toMatch(/checkKind: ""/);
  });

  it("delete says the next publish recreates a row whose element remains", () => {
    const { descriptions } = setup();
    expect(descriptions.get("delete_conditional_trigger")!).toMatch(
      /next publish creates the row again/,
    );
  });
});

describe("the authoring guide matches the platform", () => {
  it("says a conditional start IS reconciled on publish", async () => {
    const text = await guide();
    expect(text).toMatch(/A schedule and a conditional start are reconciled for you/);
    expect(text).not.toMatch(/A webhook or conditional trigger is NOT/);
    expect(text).toContain("**A webhook is NOT.**");
  });

  it("says where the check is authored and what its settings are", async () => {
    const text = await guide();
    expect(text).toMatch(/authored in the workflow, on the trigger element/);
    expect(text).toMatch(/MUST be a UUID/);
    for (const key of [
      "conditionText",
      "repeatIntervalMinutes",
      "checkKind",
      "plan",
      "outputs",
      "startsWhen",
    ]) {
      expect(text).toContain(`\`${key}\``);
    }
    expect(text).toMatch(/takes\s+effect when the workflow is published/);
    expect(text).toMatch(/every beat/i);
  });

  it("no longer claims an agent check is refused, nor that an empty string clears one", async () => {
    const text = await guide();
    expect(text).not.toMatch(/refused today/);
    expect(text).not.toMatch(/checkKind: ""/);
    expect(text).toContain("Removing `checkKind` does NOT take a check off");
  });
});

describe("the connector forwards, it does not judge", () => {
  it("does not enumerate the comparison operators", () => {
    // #32's lesson: no route serves the decision-rule operators, so a list
    // here could only go stale. The platform's refusal names the usable set.
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
    const enumeration = new RegExp(
      `(${alternation})\\b[^\\n]{0,12}?,[^\\n]{0,12}?\\b(${alternation})`,
    );
    expect("Usable: is, is_not, greater_than, less_than.".match(enumeration)).not.toBeNull();

    const { descriptions } = setup();
    for (const [name, text] of descriptions) {
      const found = text.match(enumeration)?.[0];
      expect(found, `${name} lists the comparison operators ("${found}")`).toBeUndefined();
    }
  });
});
