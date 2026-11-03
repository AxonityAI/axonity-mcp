import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AxonityClient } from "../src/client.js";
import { errorForStatus } from "../src/errors.js";
import { registerAll } from "../src/index.js";

/**
 * Conversations with the Dashboard Analyst, through the connector.
 *
 * A chat about a dashboard is a `kind=conversation` run with no workflow, so
 * list_runs (kind=workflow) never showed one and nothing could start one: the
 * analyst could only be tested by hand in the app. Pinned here:
 * list_conversations picks the backend list that can answer — one dashboard's
 * history, or every dashboard's chats filtered by status and date — and
 * refuses a mix no route serves; start_conversation sends exactly the body
 * the chat sends, always with a dashboard (what makes the backend serve the
 * Analyst, not the Builder team); a refusal comes back in the backend's own
 * words; and the run-reading tools say where a conversation's answer and tool
 * calls are.
 */

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/openapi.snapshot.json", import.meta.url)),
    "utf8",
  ),
) as {
  paths: Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
  components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
};

function setup() {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
  const server = {
    tool: (
      name: string,
      description: string,
      schema: Record<string, z.ZodTypeAny>,
      handler: (a: never) => Promise<ToolResult>,
    ) => {
      handlers.set(name, handler as Handler);
      descriptions.set(name, description);
      schemas.set(name, schema);
    },
  };
  const client = {
    get: vi.fn(async (): Promise<unknown> => ({ ok: true })),
    post: vi.fn(async (): Promise<unknown> => ({ ok: true })),
    put: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
  };
  registerAll(server as never, client as unknown as AxonityClient);
  return { handlers, descriptions, schemas, client };
}

/** The input schema as the SDK parses it before the handler runs. */
function inputOf(tool: string): z.ZodTypeAny {
  const { schemas } = setup();
  return z.object(schemas.get(tool)!);
}

const FOCUS = {
  title: "Netto omzet",
  type: "number",
  config: { measure: "net_revenue", tableId: "t-1" },
  period: "last_month",
};

describe("list_conversations", () => {
  it("one dashboard: the chat's own history route, with only its own query", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_conversations")!({
      dashboardId: "d-1",
      limit: 50,
      cursor: "MjAyNi0xMS0wM3wx",
    });
    expect(client.get).toHaveBeenCalledWith("/api/v1/conversations", {
      dashboardId: "d-1",
      limit: 50,
      cursor: "MjAyNi0xMS0wM3wx",
    });
  });

  it("across dashboards: /runs?kind=conversation, with status and dates in the query", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_conversations")!({
      status: "failed,completed",
      createdAfter: "2026-11-01",
      createdBefore: "2026-11-03",
      includeArchived: true,
      limit: 100,
      cursor: "c-2",
    });
    expect(client.get).toHaveBeenCalledWith("/api/v1/runs", {
      kind: "conversation",
      status: "failed,completed",
      created_after: "2026-11-01",
      created_before: "2026-11-03",
      include_archived: true,
      limit: 100,
      cursor: "c-2",
    });
  });

  it("with no arguments lists every dashboard's chats, never the Builder's", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_conversations")!({});
    expect(client.get).toHaveBeenCalledTimes(1);
    const [route, query] = client.get.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(route).toBe("/api/v1/runs");
    expect(query.kind).toBe("conversation");
  });

  for (const extra of [
    { status: "failed" },
    { createdAfter: "2026-11-01" },
    { createdBefore: "2026-11-01" },
    { includeArchived: false },
  ]) {
    it(`refuses dashboardId with ${Object.keys(extra)[0]} instead of dropping it`, async () => {
      const { handlers, client } = setup();
      const result = await handlers.get("list_conversations")!({ dashboardId: "d-1", ...extra });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(Object.keys(extra)[0]);
      expect(result.content[0].text).toMatch(/cannot be combined with dashboardId/);
      expect(client.get).not.toHaveBeenCalled();
    });
  }

  it("uses only query parameters each route declares", async () => {
    const declared = (path: string) =>
      (snapshot.paths[path].get.parameters ?? [])
        .filter((p) => p.in === "query")
        .map((p) => p.name);
    const { handlers, client } = setup();
    await handlers.get("list_conversations")!({ dashboardId: "d-1", limit: 1, cursor: "c" });
    await handlers.get("list_conversations")!({
      status: "failed",
      createdAfter: "2026-11-01",
      createdBefore: "2026-11-02",
      includeArchived: true,
      limit: 1,
      cursor: "c",
    });
    const calls = client.get.mock.calls as unknown as [string, Record<string, unknown>][];
    for (const [path, query] of calls) {
      for (const key of Object.keys(query)) expect(declared(path), `${path} ${key}`).toContain(key);
    }
    expect(calls.map(([p]) => p)).toEqual(["/api/v1/conversations", "/api/v1/runs"]);
  });

  it("forwards the page envelope whole on both routes, so hasMore stays visible", async () => {
    const page = {
      items: [
        {
          id: "r-1",
          kind: "conversation",
          dashboardId: "d-1",
          question: "Waarom daalde de omzet?",
          status: "completed",
        },
      ],
      nextCursor: "abc",
      pageSize: 20,
      hasMore: true,
    };
    for (const args of [{ dashboardId: "d-1" }, { status: "completed" }]) {
      const { handlers, client } = setup();
      client.get.mockResolvedValueOnce(page);
      const result = await handlers.get("list_conversations")!(args);
      expect(JSON.parse(result.content[0].text)).toEqual(page);
    }
  });

  it("validates its input", () => {
    const input = inputOf("list_conversations");
    expect(input.safeParse({}).success).toBe(true);
    expect(input.safeParse({ dashboardId: "d-1" }).success).toBe(true);
    expect(input.safeParse({ dashboardId: "" }).success).toBe(false);
    expect(input.safeParse({ limit: 2.5 }).success).toBe(false);
    expect(input.safeParse({ includeArchived: "yes" }).success).toBe(false);
    // No Builder door: a target workflow is not part of this tool.
    expect(input.safeParse({ workflowId: "w-1" }).data).not.toHaveProperty("workflowId");
  });

  it("has no input for the two filters no route offers: opener and question text", () => {
    // zod strips unknown keys without an error, so the description has to be
    // the place an agent learns these do not exist.
    const input = inputOf("list_conversations");
    const parsed = input.safeParse({ dashboardId: "d-1", createdBy: "u-1", search: "plan" });
    expect(parsed.success).toBe(true);
    expect(Object.keys(parsed.data as object)).toEqual(["dashboardId"]);
    const d = setup().descriptions.get("list_conversations")!;
    expect(d).toMatch(/CANNOT BE FILTERED AT ALL: who opened the chat, and the text of the question/);
  });

  for (const [status, message] of [
    [404, "This dashboard does not exist, or it is not shared with you."],
    [403, "The module Insights is switched off for this workspace."],
  ] as [number, string][]) {
    it(`hands the backend's ${status} back unchanged`, async () => {
      const { handlers, client } = setup();
      client.get.mockRejectedValueOnce(
        errorForStatus(status, { error: "x", code: "x", retryable: false, message }),
      );
      const result = await handlers.get("list_conversations")!({ dashboardId: "d-x" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(message);
    });
  }

  it("says whose chats, which filters where, that it pages, and where the tile is", () => {
    const d = setup().descriptions.get("list_conversations")!;
    expect(d).toMatch(/token belongs to/);
    expect(d).toMatch(/Without `dashboardId`.*`status`, `createdAfter`\/`createdBefore`/s);
    expect(d).toMatch(/refused here rather than half-applied/);
    expect(d).toMatch(/hasMore/);
    expect(d).toMatch(/triggerInput\.focus/);
    expect(d).toMatch(/insights/);
    expect(d).not.toMatch(/ONLY FILTER/);
  });

  it("warns that the backend ignores an unparseable date", () => {
    const { schemas } = setup();
    const after = schemas.get("list_conversations")!.createdAfter.description ?? "";
    expect(after).toMatch(/IGNORED, not refused/);
  });
});

describe("start_conversation", () => {
  it("sends exactly the body the dashboard chat sends", async () => {
    const { handlers, client } = setup();
    await handlers.get("start_conversation")!({
      dashboardId: "d-1",
      message: "Wat bewoog de netto omzet deze maand?",
      focus: FOCUS,
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/conversations", {
      targetWorkflowId: null,
      message: "Wat bewoog de netto omzet deze maand?",
      dashboardId: "d-1",
      focus: FOCUS,
    });
  });

  it("sends focus null for a question about the whole dashboard, as the chat does", async () => {
    const { handlers, client } = setup();
    await handlers.get("start_conversation")!({ dashboardId: "d-1", message: "Hoe gaat het?" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/conversations", {
      targetWorkflowId: null,
      message: "Hoe gaat het?",
      dashboardId: "d-1",
      focus: null,
    });
  });

  it("sends only fields StartConversationRequest declares", async () => {
    const { handlers, client } = setup();
    await handlers.get("start_conversation")!({ dashboardId: "d-1", message: "x", focus: FOCUS });
    const sent = (client.post.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    const declared = Object.keys(
      snapshot.components.schemas.StartConversationRequest.properties ?? {},
    );
    for (const key of Object.keys(sent)) expect(declared).toContain(key);
  });

  it("returns the run the backend started, untouched", async () => {
    const { handlers, client } = setup();
    const run = { id: "r-9", kind: "conversation", status: "running" };
    client.post.mockResolvedValueOnce(run);
    const result = await handlers.get("start_conversation")!({ dashboardId: "d-1", message: "x" });
    expect(JSON.parse(result.content[0].text)).toEqual(run);
  });

  it("validates its input: a dashboard and a question are required", () => {
    const input = inputOf("start_conversation");
    expect(input.safeParse({ dashboardId: "d-1", message: "x" }).success).toBe(true);
    expect(input.safeParse({ dashboardId: "d-1", message: "x", focus: FOCUS }).success).toBe(true);
    expect(input.safeParse({ message: "x" }).success).toBe(false);
    expect(input.safeParse({ dashboardId: "d-1" }).success).toBe(false);
    expect(input.safeParse({ dashboardId: "d-1", message: "" }).success).toBe(false);
    expect(input.safeParse({ dashboardId: "d-1", message: "x", focus: "tile" }).success).toBe(
      false,
    );
    // No Builder door: a target workflow is not part of this tool.
    expect(
      input.safeParse({ dashboardId: "d-1", message: "x", targetWorkflowId: "w-1" }).data,
    ).not.toHaveProperty("targetWorkflowId");
  });

  const refusals: [number, string][] = [
    [404, "This dashboard does not exist, or it is not shared with you."],
    [404, "The Dashboard Analyst is not available for this workspace."],
    [403, "This service token lacks the 'author' scope"],
    [422, "focus is too large"],
  ];
  for (const [status, message] of refusals) {
    it(`hands the backend's ${status} back unchanged: ${message}`, async () => {
      const { handlers, client } = setup();
      client.post.mockRejectedValueOnce(
        errorForStatus(status, { error: "x", code: "x", retryable: false, message }),
      );
      const result = await handlers.get("start_conversation")!({
        dashboardId: "d-1",
        message: "x",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(message);
    });
  }

  it("says it executes, answers in the background, and as whom", () => {
    const d = setup().descriptions.get("start_conversation")!;
    expect(d).toMatch(/EXECUTES/);
    expect(d).toMatch(/send_run_message/);
    expect(d).toMatch(/read_run_invocation_messages/);
    expect(d).toMatch(/read_measure/);
    expect(d).toMatch(/show_visual/);
    expect(d).toMatch(/token belongs to/);
    expect(d).toMatch(/lacks the 'author' scope/);
    expect(d).toMatch(/read-only/);
    expect(d).toMatch(/any token they minted/);
  });
});

describe("the run tools say where a conversation is", () => {
  it("read_run and read_run_invocation_messages point at the transcript", () => {
    const { descriptions } = setup();
    const readRun = descriptions.get("read_run")!;
    expect(readRun).toMatch(/kind: conversation/);
    expect(readRun).toMatch(/read_run_invocation_messages/);
    expect(readRun).toMatch(/triggerInput/);

    const messages = descriptions.get("read_run_invocation_messages")!;
    expect(messages).toMatch(/CONVERSATION/);
    expect(messages).toMatch(/read_measure/);
    expect(messages).toMatch(/show_visual/);
    expect(messages).toMatch(/arguments/);
  });

  it("list_runs and read_run_trace send a conversation elsewhere", () => {
    const { descriptions } = setup();
    expect(descriptions.get("list_runs")!).toMatch(/list_conversations/);
    expect(descriptions.get("list_runs")!).toMatch(/kind=conversation/);
    expect(descriptions.get("read_run_trace")!).toMatch(/read_run_invocation_messages/);
  });

  it("send_run_message names the follow-up refusals and its scope", () => {
    const d = setup().descriptions.get("send_run_message")!;
    expect(d).toMatch(/not awaiting a message right now/);
    expect(d).toMatch(/404/);
    expect(d).toMatch(/operate/);
  });

  it("send_run_message hands 'still answering' back unchanged", async () => {
    const { handlers, client } = setup();
    const message =
      "The conversation is not awaiting a message right now — the team is still working on the previous turn.";
    client.post.mockRejectedValueOnce(
      errorForStatus(422, { error: "x", code: "validation_error", retryable: false, message }),
    );
    const result = await handlers.get("send_run_message")!({ runId: "r-1", message: "en nu?" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not awaiting a message right now");
  });
});
