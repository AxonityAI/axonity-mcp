import { describe, expect, it, vi } from "vitest";

import type { AxonityClient } from "../src/client.js";
import { registerAll } from "../src/index.js";

/**
 * axonity-mcp#81 — the connector follows the semantic model
 * (axonity-flow#1881).
 *
 * Pinned here: the objects an agent now builds a star model with — a table's
 * provenance in place of a sync, a measure as its own versioned entity, and
 * concepts — reach the routes the platform declares, and the descriptions send
 * an agent to the new place instead of the old one. A description that still
 * said "semanticKind" or "create_data_source_sync" would be an agent writing to
 * fields the platform now refuses.
 */

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

function setup() {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const server = {
    tool: (
      name: string,
      description: string,
      _schema: unknown,
      handler: (a: never) => Promise<ToolResult>,
    ) => {
      handlers.set(name, handler as Handler);
      descriptions.set(name, description);
    },
  };
  const client = {
    get: vi.fn(async () => ({ ok: true })),
    post: vi.fn(async () => ({ ok: true })),
    put: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
  };
  registerAll(server as never, client as unknown as AxonityClient);
  return { handlers, descriptions, client };
}

describe("a table's provenance replaces the sync", () => {
  it("refresh_data_table posts to the table's refresh route", async () => {
    const { handlers, client } = setup();
    await handlers.get("refresh_data_table")!({ id: "t1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/data-tables/t1/refresh");
  });

  it("create and update name provenance, its grain, and the end of syncs", () => {
    const { descriptions } = setup();
    for (const name of ["create_data_table", "update_data_table"]) {
      const text = descriptions.get(name)!;
      expect(text).toMatch(/`provenance`/);
      expect(text).toMatch(/`grain`/);
      expect(text).toMatch(/refresh_data_table/);
      expect(text).toMatch(/run_data_source_sync/);
    }
    expect(descriptions.get("update_data_table")).toMatch(/clearProvenance/);
  });
});

describe("a measure is an entity of its own", () => {
  it("gets the whole family, publish request and versions included", () => {
    const { handlers } = setup();
    for (const name of [
      "list_measures",
      "read_measure",
      "create_measure",
      "update_measure",
      "delete_measure",
      "restore_measure",
      "list_deleted_measures",
      "discard_measure_draft",
      "request_publish_measure",
      "list_measure_versions",
      "restore_measure_version",
      "list_measure_live_versions",
    ]) {
      expect(handlers.has(name), `${name} is not registered`).toBe(true);
    }
  });

  it("deletes with the camelCase version key its route declares", async () => {
    const { handlers, client } = setup();
    await handlers.get("delete_measure")!({ id: "m1", expectedVersion: 2, confirm: true });
    expect(client.del).toHaveBeenCalledWith("/api/v1/measures/m1", { expectedVersion: 2 });
  });

  it("asks for publication through the queue, as entityType measure", async () => {
    const { handlers, client } = setup();
    await handlers.get("request_publish_measure")!({ id: "m1" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/publish-approvals", {
      entityType: "measure",
      entityId: "m1",
    });
  });

  it("create_measure says a measure means a concept", () => {
    const { descriptions } = setup();
    const text = descriptions.get("create_measure")!;
    expect(text).toMatch(/`concept`/);
    expect(text).toMatch(/create_concept first/);
    expect(text).toMatch(/`questions`/);
  });

  it("read_measure_design no longer promises measures", () => {
    const { descriptions } = setup();
    expect(descriptions.get("read_measure_design")).toMatch(/MEASURES ARE NOT HERE/);
  });
});

describe("concepts", () => {
  it("list, create, update and delete reach /concepts", async () => {
    const { handlers, client } = setup();
    await handlers.get("list_concepts")!({ q: "customer" });
    await handlers.get("create_concept")!({
      kind: "metric",
      name: "CAC",
      meaning: "Acquisition cost per new customer, not per dog.",
      owner: "CGO",
    });
    await handlers.get("update_concept")!({ id: "c1", synonyms: [] });
    await handlers.get("delete_concept")!({ id: "c1", confirm: true });

    expect(client.get).toHaveBeenCalledWith("/api/v1/concepts", {
      q: "customer",
      limit: undefined,
      cursor: undefined,
    });
    expect(client.post).toHaveBeenCalledWith("/api/v1/concepts", {
      kind: "metric",
      name: "CAC",
      meaning: "Acquisition cost per new customer, not per dog.",
      owner: "CGO",
    });
    // An emptied list is a real edit, so it must travel.
    expect(client.patch).toHaveBeenCalledWith("/api/v1/concepts/c1", { synonyms: [] });
    expect(client.del).toHaveBeenCalledWith("/api/v1/concepts/c1");
  });

  it("says how concepts are published, since there is no request_publish_concept", () => {
    const { handlers, descriptions } = setup();
    expect(handlers.has("request_publish_concept")).toBe(false);
    for (const name of ["create_concept", "update_concept", "delete_concept"]) {
      expect(descriptions.get(name)).toMatch(/request_publish_data_table/);
    }
  });
});

describe("nothing still teaches the retired fields", () => {
  it("no description mentions semanticKind or subjectSourceId", () => {
    const { descriptions } = setup();
    const offenders = [...descriptions.entries()]
      .filter(([, text]) => /semanticKind|subjectSourceId|create_data_source_sync/.test(text))
      // These two name the old tools only to say they are gone.
      .filter(([name]) => !["create_data_table", "update_data_table"].includes(name))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});
