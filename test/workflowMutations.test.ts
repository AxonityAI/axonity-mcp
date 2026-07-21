import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { AxonityApiError, VersionConflictError } from "../src/errors.js";
import {
  registerWorkflowMutations,
  toMutationBody,
} from "../src/tools/workflowMutations.js";

function fakeServer() {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: (a: never) => Promise<unknown>) => {
      handlers.set(name, handler as (args: Record<string, unknown>) => Promise<unknown>);
    },
  };
  return { server, handlers };
}

/** A client whose mutation route increments the version, like the backend does. */
function versioningClient(startVersion = 1) {
  let version = startVersion;
  return {
    post: vi.fn(async () => {
      version += 1;
      return { version, document: { steps: [] }, launchable: true, validationIssues: [] };
    }),
  };
}

function apply(client: unknown) {
  const { server, handlers } = fakeServer();
  registerWorkflowMutations(server as never, client as unknown as AxonityClient);
  return handlers.get("apply_workflow_mutations")!;
}

function replaceTool(client: unknown) {
  const { server, handlers } = fakeServer();
  registerWorkflowMutations(server as never, client as unknown as AxonityClient);
  return handlers.get("replace_workflow_document")!;
}

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0].text;
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

describe("toMutationBody", () => {
  it("passes an explicit payload through untouched", () => {
    expect(toMutationBody({ type: "add_step", payload: { name: "A" } }, 0)).toEqual({
      type: "add_step",
      payload: { name: "A" },
    });
  });

  it("lifts the flat form into a payload", () => {
    expect(toMutationBody({ type: "add_edge", from: "a", to: "b" }, 0)).toEqual({
      type: "add_edge",
      payload: { from: "a", to: "b" },
    });
  });

  it("allows an intentionally empty payload", () => {
    expect(toMutationBody({ type: "ungroup_triggers" }, 0)).toEqual({
      type: "ungroup_triggers",
      payload: {},
    });
  });

  it("rejects a command with no type, naming the index", () => {
    expect(() => toMutationBody({ name: "A" }, 2)).toThrow(/mutations\[2\].*type/);
  });

  it("rejects a non-object payload", () => {
    expect(() => toMutationBody({ type: "add_step", payload: [1] }, 0)).toThrow(
      /payload must be a JSON object/,
    );
  });
});

describe("apply_workflow_mutations", () => {
  it("sends one request per mutation in the backend's single-mutation shape", async () => {
    const client = versioningClient(1);
    await apply(client)({
      id: "wf-1",
      expectedVersion: 1,
      mutations: [
        { type: "add_trigger", payload: { kind: "manual" } },
        { type: "add_step", name: "Fetch" },
      ],
    });

    expect(client.post).toHaveBeenCalledTimes(2);
    // Exactly {type, payload, expectedVersion} — never a `mutations` array,
    // which is the shape that 422'd on every call before this was fixed.
    expect(client.post).toHaveBeenNthCalledWith(1, "/api/v1/workflows/wf-1/mutations", {
      type: "add_trigger",
      payload: { kind: "manual" },
      expectedVersion: 1,
    });
    expect(client.post).toHaveBeenNthCalledWith(2, "/api/v1/workflows/wf-1/mutations", {
      type: "add_step",
      payload: { name: "Fetch" },
      expectedVersion: 2,
    });
  });

  it("threads the version forward across a long sequence", async () => {
    const client = versioningClient(5);
    await apply(client)({
      id: "wf-1",
      expectedVersion: 5,
      mutations: [
        { type: "add_trigger" },
        { type: "add_step" },
        { type: "add_step" },
        { type: "add_step" },
        { type: "add_edge" },
        { type: "add_edge" },
      ],
    });

    const versions = client.post.mock.calls.map(
      (c) => (c[1] as { expectedVersion: number }).expectedVersion,
    );
    expect(versions).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it("returns the final document with the applied count", async () => {
    const result = await apply(versioningClient(1))({
      id: "wf-1",
      expectedVersion: 1,
      mutations: [{ type: "add_step" }, { type: "add_step" }],
    });

    const body = JSON.parse(textOf(result));
    expect(body.appliedCount).toBe(2);
    expect(body.version).toBe(3);
    expect(body.launchable).toBe(true);
  });

  it("reports the applied count and failing index on a mid-sequence failure", async () => {
    let calls = 0;
    const client = {
      post: vi.fn(async () => {
        calls += 1;
        if (calls === 3) throw new AxonityApiError("Unknown step type 'wibble'.", 422);
        return { version: calls + 1, document: {}, launchable: false, validationIssues: [] };
      }),
    };

    const result = await apply(client)({
      id: "wf-1",
      expectedVersion: 1,
      mutations: [
        { type: "add_step" },
        { type: "add_step" },
        { type: "add_step", stepType: "wibble" },
        { type: "add_edge" },
      ],
    });

    expect(isError(result)).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Unknown step type 'wibble'.");
    // The agent must be able to resume rather than replay the applied prefix.
    const summary = JSON.parse(text.slice(text.indexOf("{")));
    expect(summary).toMatchObject({
      appliedCount: 2,
      failedIndex: 2,
      failedType: "add_step",
      currentVersion: 3,
    });
    // The 4th mutation must not have been attempted after the failure.
    expect(client.post).toHaveBeenCalledTimes(3);
  });

  it("replaces the whole workflow document in one atomic PUT", async () => {
    const client = {
      put: vi.fn(async () => ({ id: "wf-1", version: 3 })),
    };
    await replaceTool(client)({
      id: "wf-1",
      expectedVersion: 2,
      document: { id: "wf-1", version: 2, draft: true },
    });
    expect(client.put).toHaveBeenCalledWith("/api/v1/workflows/wf-1", {
      expectedVersion: 2,
      document: { id: "wf-1", version: 2, draft: true },
    });
  });

  it("surfaces a 409 without swallowing it", async () => {
    const client = {
      post: vi.fn(async () => {
        throw new VersionConflictError();
      }),
    };
    const result = await apply(client)({
      id: "wf-1",
      expectedVersion: 1,
      mutations: [{ type: "add_step" }],
    });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain("Version conflict");
  });

  it("applies nothing when any command is malformed", async () => {
    const client = versioningClient(1);
    const result = await apply(client)({
      id: "wf-1",
      expectedVersion: 1,
      mutations: [{ type: "add_step" }, { name: "no type here" }],
    });

    expect(isError(result)).toBe(true);
    // Validation happens up front, so the valid first command is not applied.
    expect(client.post).not.toHaveBeenCalled();
  });
});
