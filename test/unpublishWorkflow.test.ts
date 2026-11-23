import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { AxonityApiError } from "../src/errors.js";
import { buildServer } from "../src/index.js";
import { forbids } from "./denyList.js";

/**
 * `unpublish_workflow` (axonity-flow#2626): a token ASKS to take a workflow off
 * the air and a person approves; `archive_workflow` refuses a published one, so
 * without this an agent could clean up nothing it had published.
 *
 * Driven through the real MCP layer: the connector's own McpServer, an
 * in-memory transport and an SDK client, with a backend client that records
 * every request. The route and its two answers are pinned to the OpenAPI
 * snapshot, its class to the token-route snapshot.
 */

const APP = "https://app.example.test";
const ROUTE = "/api/v1/workflows/{workflow_id}/unpublish";

async function connected(post: (path: string, body?: unknown) => Promise<unknown>) {
  const backend = {
    get: vi.fn(async () => ({})),
    post: vi.fn(post),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    del: vi.fn(async () => ({})),
    appUrl: (path: string) => `${APP}${path}`,
  };
  const server = buildServer(backend as unknown as AxonityClient);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "probe", version: "0.0.0" });
  await client.connect(clientSide);
  return { client, backend };
}

interface ToolAnswer {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

async function call(client: Client, args: Record<string, unknown>): Promise<ToolAnswer> {
  return (await client.callTool({ name: "unpublish_workflow", arguments: args })) as ToolAnswer;
}

const parsed = (answer: ToolAnswer) => JSON.parse(answer.content[0].text ?? "null");

const PENDING = {
  status: "pending_approval",
  message:
    "Nothing has changed yet: a person has to approve this request in Axonity (Approvals). " +
    "Asking again returns this same request.",
  approval: {
    id: "ap-1",
    action: "workflows.unpublish",
    status: "pending",
    summary: "Unpublish the workflow Weekly digest (v10)",
    targetLabel: "Weekly digest",
  },
};

describe("unpublish_workflow through the MCP layer", () => {
  it("is offered with an id and an optional reason, and points on to archive_workflow", async () => {
    const { client } = await connected(async () => ({}));
    const tool = (await client.listTools()).tools.find((t) => t.name === "unpublish_workflow");
    expect(tool).toBeDefined();
    const props = (tool!.inputSchema as { properties: Record<string, unknown>; required?: string[] })
      .properties;
    expect(Object.keys(props).sort()).toEqual(["id", "reason"]);
    expect((tool!.inputSchema as { required?: string[] }).required).toEqual(["id"]);
    expect(tool!.description).toMatch(/archive_workflow/);
    expect(tool!.description).toMatch(/approve/);
    expect(tool!.description).toMatch(/active trigger/);
  });

  it("a person's or an at-once answer says it is done, and that archive_workflow can follow", async () => {
    const { client, backend } = await connected(async () => ({
      previousMajorVersion: null,
      draftMajorVersion: 11,
      draftVersionName: "Version 11",
    }));
    const answer = await call(client, { id: "wf-1", reason: "Old sandbox copy" });
    expect(answer.isError).toBeFalsy();
    expect(backend.post).toHaveBeenCalledWith("/api/v1/workflows/wf-1/unpublish", {
      reason: "Old sandbox copy",
    });
    const body = parsed(answer);
    expect(body.outcome).toBe("unpublished");
    expect(body.workflowId).toBe("wf-1");
    expect(body.draftMajorVersion).toBe(11);
    expect(body.next).toMatch(/archive_workflow/);
  });

  it("a token's request says it waits for a person, with the request and a link", async () => {
    const { client, backend } = await connected(async () => PENDING);
    const answer = await call(client, { id: "wf-1" });
    expect(answer.isError).toBeFalsy();
    expect(backend.post).toHaveBeenCalledWith("/api/v1/workflows/wf-1/unpublish", {});
    const body = parsed(answer);
    expect(body.outcome).toBe("waiting_for_approval");
    expect(body.approvalId).toBe("ap-1");
    expect(body.summary).toBe(PENDING.approval.summary);
    expect(body.link).toBe(`${APP}/digitaltwin/approvals/admin`);
    expect(body.message).toBe(PENDING.message);
    expect(body.next).toMatch(/archive_workflow/);
  });

  it("the refusal for an active trigger reaches the agent in the backend's words", async () => {
    const refusal =
      'This workflow still has active triggers: Schedule "Every Monday" (d4e6b29d-…). ' +
      "Switch them off first, then ask again.";
    const { client } = await connected(async () => {
      throw new AxonityApiError(refusal, 409);
    });
    const answer = await call(client, { id: "wf-1" });
    expect(answer.isError).toBe(true);
    expect(answer.content.map((c) => c.text).join("\n")).toContain("Every Monday");
  });

  it("an empty id is refused before anything is sent", async () => {
    const { client, backend } = await connected(async () => ({}));
    let text = "";
    try {
      const answer = await call(client, { id: "" });
      expect(answer.isError).toBe(true);
      text = answer.content.map((c) => c.text).join("\n");
    } catch (error) {
      text = (error as Error).message;
    }
    expect(text).toMatch(/empty/i);
    expect(backend.post).not.toHaveBeenCalled();
  });
});

describe("the boundary: only the workflow's unpublish is opened", () => {
  it("the connector may ask to unpublish a workflow; every other direct (un)publish stays closed", () => {
    expect(forbids("POST", "/api/v1/workflows/wf-1/unpublish")).toBe(false);
    expect(forbids("POST", "/api/v1/workflows/wf-1/publish")).toBe(true);
    expect(forbids("POST", "/api/v1/agents/a-1/unpublish")).toBe(true);
    expect(forbids("POST", "/api/v1/tools/t-1/unpublish")).toBe(true);
    expect(forbids("POST", "/api/v1/methods/m-1/unpublish")).toBe(true);
    expect(forbids("POST", "/api/v1/company/unpublish")).toBe(true);
    expect(forbids("POST", "/api/v1/skills/s-1/versions/unpublish")).toBe(true);
  });
});

describe("the contract pin of the route", () => {
  const read = (name: string) =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));

  it("the body is the optional reason and the answer is the result or the request", () => {
    const snapshot = read("openapi.snapshot.json");
    const op = snapshot.paths[ROUTE].post;
    const body = op.requestBody.content["application/json"].schema;
    expect(JSON.stringify(body)).toContain("#/components/schemas/UnpublishWorkflowRequest");
    const request = snapshot.components.schemas.UnpublishWorkflowRequest;
    expect(Object.keys(request.properties)).toEqual(["reason"]);
    expect(request.properties.reason.anyOf[0].maxLength).toBe(1000);
    expect(request.required ?? []).toEqual([]);
    const answer = JSON.stringify(op.responses["200"].content["application/json"].schema);
    expect(answer).toContain("#/components/schemas/UnpublishResponse");
    expect(answer).toContain("#/components/schemas/ActionApprovalAccepted");
    const accepted = snapshot.components.schemas.ActionApprovalAccepted;
    expect(Object.keys(accepted.properties).sort()).toEqual(["approval", "message", "status"]);
    const item = snapshot.components.schemas.ActionApprovalItem;
    for (const field of ["id", "summary", "status", "action"]) {
      expect(item.properties, field).toHaveProperty(field);
    }
  });

  it("a personal token may ask for it: the class is configuratie", () => {
    const classes = read("token-route-classes.snapshot.json");
    expect(classes[`POST ${ROUTE}`].class).toBe("configuratie");
  });
});
