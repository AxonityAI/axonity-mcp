import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { ForbiddenError, errorForStatus } from "../src/errors.js";
import { registerAll } from "../src/index.js";
import { forbids } from "./denyList.js";

/**
 * axonity-mcp#86 — applications through the MCP (axonity-flow#1901).
 *
 * The entity verbs and versions come from the registrars, which
 * `register.test.ts` covers; what is pinned here is what the issue promises:
 *
 *   1. the whole lifecycle exists, and publishing goes through the queue;
 *   2. executors are read-only and no tool can reach a token;
 *   3. the link and the knowledge tools call the route they claim to, with the
 *      body that route reads;
 *   4. an admin-only refusal says why.
 */

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

function setup(postImpl?: () => Promise<unknown>) {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const schemas = new Map<string, Record<string, { description?: string }>>();
  const server = {
    tool: (
      name: string,
      description: string,
      schema: Record<string, { description?: string }>,
      handler: (a: never) => Promise<ToolResult>,
    ) => {
      handlers.set(name, handler as Handler);
      descriptions.set(name, description);
      schemas.set(name, schema);
    },
  };
  const client = {
    get: vi.fn(async () => ({ ok: true })),
    post: vi.fn(postImpl ?? (async () => ({ ok: true }))),
    put: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
  };
  registerAll(server as never, client as unknown as AxonityClient);
  return { handlers, descriptions, schemas, client };
}

const PROMISED = [
  "list_applications",
  "read_application",
  "read_application_published",
  "read_application_version",
  "list_application_versions",
  "create_application",
  "update_application",
  "ensure_application_major_version",
  "create_application_major_version",
  "name_application_major_version",
  "discard_application_draft",
  "request_publish_application",
  "delete_application",
  "restore_application",
  "list_deleted_applications",
  "delete_application_version",
  "restore_application_version",
  "restore_deleted_application_version",
  "list_deleted_application_versions",
  "read_application_executors",
  "set_application_executors",
  "list_executors",
  "read_executor",
  "list_application_knowledge",
  "list_application_knowledge_versions",
  "forget_application_knowledge",
  "restore_application_knowledge",
  "write_application_knowledge",
];

describe("applications", () => {
  it("has every tool the issue lists, each with a description and described fields", () => {
    const { handlers, descriptions, schemas } = setup();
    for (const name of PROMISED) {
      expect(handlers.has(name), `${name} is not registered`).toBe(true);
      expect(descriptions.get(name)!.length).toBeGreaterThan(40);
      for (const [field, schema] of Object.entries(schemas.get(name) ?? {})) {
        expect(schema.description, `${name}.${field} has no description`).toBeTruthy();
      }
    }
  });

  it("asks for a publish through the approval queue, never directly", async () => {
    const { handlers, client } = setup();
    await handlers.get("request_publish_application")!({ id: "a1", changeSummary: "lab" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/publish-approvals", {
      entityType: "application",
      entityId: "a1",
      changeSummary: "lab",
    });
    expect(forbids("POST", "/api/v1/applications/a1/versions/publish/2")).toBe(true);
    expect(forbids("POST", "/api/v1/applications/a1/versions/unpublish")).toBe(true);
  });

  /**
   * 18/10: ActaLibra (lab) had to be published again to rebuild its tools, had
   * no draft, and the MCP had no way in — a person changed a space in the UI.
   * The platform already allows it: ensure opens a draft of the current
   * content, and the request then passes `already_live`.
   */
  it("says how to publish again without a change, and that a release leaves the application out", async () => {
    const { handlers, descriptions, client } = setup();
    const publish = descriptions.get("request_publish_application")!;
    expect(publish).toMatch(/ensure_application_major_version first/);
    expect(publish).toMatch(/already_live/);
    expect(publish).toMatch(/Never edit a field just to make a draft/);
    expect(publish).toMatch(/release does not carry the application/);
    expect(descriptions.get("request_publish_release")).toMatch(/APPLICATION IS NOT IN A RELEASE YET/);

    await handlers.get("ensure_application_major_version")!({ id: "a1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/applications/a1/versions/ensure");
  });

  it("can be asked for in a bulk request", async () => {
    const { handlers, client } = setup();
    await handlers.get("request_publish_bulk")!({
      requests: [{ entityType: "application", entityId: "a1" }],
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/publish-approvals/bulk", {
      requests: [{ entityType: "application", entityId: "a1" }],
    });
  });

  it("creates with the fields passed through, and deletes with the snake_case key", async () => {
    const { handlers, client } = setup();
    const fields = {
      name: "Wikipedia (lab)",
      technology: "web",
      limits: { domains: ["nl.wikipedia.org"] },
    };
    await handlers.get("create_application")!({ fields });
    expect(client.post).toHaveBeenCalledWith("/api/v1/applications", fields);
    await handlers.get("update_application")!({ id: "a1", expectedVersion: 2, fields });
    expect(client.put).toHaveBeenCalledWith("/api/v1/applications/a1", {
      expectedVersion: 2,
      ...fields,
    });
    await handlers.get("delete_application")!({ id: "a1", expectedVersion: 3, confirm: true });
    expect(client.del).toHaveBeenCalledWith("/api/v1/applications/a1", {
      expected_version: 3,
    });
  });

  it("lists one page, narrowed by name in the query", async () => {
    const { handlers, descriptions, client } = setup();
    expect(descriptions.get("list_applications")).toMatch(/ONE PAGE/);
    await handlers.get("list_applications")!({ name: "ActaLibra (lab)" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/applications", {
      name: "ActaLibra (lab)",
      limit: undefined,
      cursor: undefined,
    });
  });

  it("reads the published limits where an application keeps them", async () => {
    const { handlers, client } = setup();
    await handlers.get("read_application_published")!({ id: "a1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/applications/a1/versions/published");
  });
});

describe("executors", () => {
  it("links executors from the application's side, the whole set", async () => {
    const { handlers, descriptions, client } = setup();
    await handlers.get("set_application_executors")!({ id: "a1", executorIds: ["e1", "e2"] });
    expect(client.put).toHaveBeenCalledWith("/api/v1/applications/a1/executors", {
      executorIds: ["e1", "e2"],
    });
    expect(descriptions.get("set_application_executors")).toMatch(/REPLACES THE WHOLE SET/);
    await handlers.get("read_application_executors")!({ id: "a1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/applications/a1/executors");
  });

  it("only reads executors: registering, revoking and the other-side write are excluded", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_executors")!({});
    expect(client.get).toHaveBeenCalledWith("/api/v1/executors");
    await handlers.get("read_executor")!({ id: "e1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/executors/e1");

    // POST /executors is the one route that returns a token in plaintext.
    expect(forbids("POST", "/api/v1/executors")).toBe(true);
    expect(forbids("POST", "/api/v1/executors/e1/revoke")).toBe(true);
    expect(forbids("PUT", "/api/v1/executors/e1/applications")).toBe(true);
    // The reads stay open.
    expect(forbids("GET", "/api/v1/executors")).toBe(false);
    expect(forbids("GET", "/api/v1/executors/e1/applications")).toBe(false);
    for (const name of handlers.keys()) {
      expect(name).not.toMatch(/(create|revoke|rotate)_executor|executor_token/);
    }
  });
});

describe("what an application has learned", () => {
  it("lists one page, by kind", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_application_knowledge")!({ id: "a1", kind: "lesson" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/applications/a1/knowledge", {
      kind: "lesson",
      limit: undefined,
      cursor: undefined,
    });
    await handlers.get("list_application_knowledge_versions")!({ id: "a1", knowledgeId: "k1" });
    expect(client.get).toHaveBeenCalledWith("/api/v1/applications/a1/knowledge/k1/versions", {
      limit: undefined,
      cursor: undefined,
    });
  });

  it("forgets and restores by the entry's id", async () => {
    const { handlers, client } = setup();
    await handlers.get("forget_application_knowledge")!({ id: "a1", knowledgeId: "k1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/applications/a1/knowledge/k1/forget");
    await handlers.get("restore_application_knowledge")!({ id: "a1", knowledgeId: "k1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/applications/a1/knowledge/k1/restore");
  });

  it("writes an entry under its kind, the body the route reads", async () => {
    const { handlers, client } = setup();
    await handlers.get("write_application_knowledge")!({
      id: "a1",
      kind: "lesson",
      entry: { text: "Close the search dialog with Esc." },
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/applications/a1/knowledge", {
      kind: "lesson",
      lesson: { text: "Close the search dialog with Esc." },
    });
  });

  it("an admin-only refusal says why, not 'your token is read-only'", async () => {
    const { handlers, descriptions } = setup(async () => {
      throw errorForStatus(403, {
        error: "Only administrators can perform this action",
        code: "forbidden",
        retryable: false,
        message: "Only administrators can perform this action",
      });
    });
    const result = await handlers.get("forget_application_knowledge")!({
      id: "a1",
      knowledgeId: "k1",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/ADMINISTRATOR ONLY/);
    expect(result.content[0].text).not.toMatch(/read-only token/);
    expect(new ForbiddenError({ message: "Only administrators" }).message).toMatch(
      /ADMINISTRATOR ONLY/,
    );
    for (const name of [
      "forget_application_knowledge",
      "restore_application_knowledge",
      "write_application_knowledge",
      "set_application_executors",
    ]) {
      expect(descriptions.get(name)).toMatch(/ADMINISTRATOR ONLY/);
    }
  });
});
