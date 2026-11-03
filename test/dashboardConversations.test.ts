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
 * list_runs never showed one and nothing could start one: the analyst could
 * only be tested by hand in the app. Pinned here: list_conversations and
 * start_conversation reach the routes the dashboard chat uses, with exactly
 * the query and body the chat sends; both always name a dashboard (that is
 * what makes the backend serve the Analyst, not the Builder team); a refusal
 * comes back with the backend's own words; and the run-reading tools say
 * where a conversation's answer and tool calls are.
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
  it("lists one dashboard's conversations with the query the chat sends", async () => {
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

  it("uses only query parameters the route declares", () => {
    const declared = (snapshot.paths["/api/v1/conversations"].get.parameters ?? [])
      .filter((p) => p.in === "query")
      .map((p) => p.name);
    for (const name of ["dashboardId", "limit", "cursor"]) {
      expect(declared).toContain(name);
    }
  });

  it("forwards the page envelope whole, so hasMore stays visible", async () => {
    const { handlers, client } = setup();
    const page = {
      items: [
        {
          id: "r-1",
          kind: "conversation",
          dashboardId: "d-1",
          question: "Waarom daalde de omzet?",
          status: "waiting_for_input",
        },
      ],
      nextCursor: "abc",
      pageSize: 20,
      hasMore: true,
    };
    client.get.mockResolvedValueOnce(page);
    const result = await handlers.get("list_conversations")!({ dashboardId: "d-1" });
    expect(JSON.parse(result.content[0].text)).toEqual(page);
  });

  it("requires a dashboard — without one the route serves the Builder chat", () => {
    const input = inputOf("list_conversations");
    expect(input.safeParse({ dashboardId: "d-1" }).success).toBe(true);
    expect(input.safeParse({}).success).toBe(false);
    expect(input.safeParse({ dashboardId: "" }).success).toBe(false);
    expect(input.safeParse({ dashboardId: "d-1", limit: 2.5 }).success).toBe(false);
    expect(input.safeParse({ dashboardId: "d-1", workflowId: "w-1" }).data).not.toHaveProperty(
      "workflowId",
    );
  });

  it("hands a 404 for an unshared dashboard back unchanged", async () => {
    const { handlers, client } = setup();
    const message = "This dashboard does not exist, or it is not shared with you.";
    client.get.mockRejectedValueOnce(
      errorForStatus(404, { error: "not_found", code: "not_found", retryable: false, message }),
    );
    const result = await handlers.get("list_conversations")!({ dashboardId: "d-x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(message);
  });

  it("says whose conversations they are, that it pages, and where the tile is", () => {
    const d = setup().descriptions.get("list_conversations")!;
    expect(d).toMatch(/token belongs to/);
    expect(d).toMatch(/hasMore/);
    expect(d).toMatch(/nextCursor/);
    expect(d).toMatch(/triggerInput\.focus/);
    expect(d).toMatch(/list_dashboards/);
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
    expect(d).toMatch(/author/);
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
