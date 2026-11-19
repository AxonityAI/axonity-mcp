/**
 * Tools (R9 of agent-first): a toolbox joins the lifecycle, an agent holds a
 * whole box, a secret says what uses it.
 *
 * What is held here, and against what:
 *   - The routes a tool calls are read from the pinned OpenAPI schema (a capture
 *     of the backend of the R9 branch), never from a list kept in this file.
 *   - Every parameter reaches the wire (Zod drops an unknown key without a word).
 *   - Each sentence an agent reads is pinned by a phrase from the backend's own
 *     message or schema description; the source is named beside it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { registerAll } from "../src/index.js";
import { registerConventions } from "../src/tools/conventions.js";
import { placementClient } from "./placementStub.js";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

type Schema = { properties?: Record<string, unknown>; additionalProperties?: unknown };
const snapshot = JSON.parse(read("./fixtures/openapi.snapshot.json")) as {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, Schema> };
};

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function surface() {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const shapes = new Map<string, Record<string, unknown>>();
  const client = {
    get: vi.fn(async () => ({ ok: true })),
    post: vi.fn(async () => ({ ok: true })),
    put: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(async () => ({ ok: true })),
    del: vi.fn(async () => ({ ok: true })),
  };
  registerAll(
    {
      tool: (name: string, d: string, s: Record<string, unknown>, h: Handler) => {
        handlers.set(name, h);
        descriptions.set(name, d);
        shapes.set(name, s);
      },
    } as never,
    client as never,
  );
  return { handlers, descriptions, shapes, client };
}

const BOX = "/api/v1/toolboxes";

describe("a toolbox has the whole lifecycle, and every tool calls a route the backend mounts", () => {
  it("restore, discard, archive, unarchive, read and the agents who hold it", async () => {
    const { handlers, client } = surface();

    await handlers.get("read_toolbox")!({ id: "b-1" });
    expect(client.get).toHaveBeenCalledWith(`${BOX}/b-1`);

    await handlers.get("restore_toolbox")!({ id: "b-1" });
    expect(client.post).toHaveBeenLastCalledWith(`${BOX}/b-1/restore`);
    await handlers.get("restore_toolbox")!({ id: "b-1", name: "Mail 2" });
    expect(client.post).toHaveBeenLastCalledWith(`${BOX}/b-1/restore`, { name: "Mail 2" });

    await handlers.get("list_deleted_toolboxes")!({});
    expect(client.get).toHaveBeenLastCalledWith(`${BOX}/deleted`);

    await handlers.get("discard_toolbox_draft")!({ id: "b-1" });
    expect(client.post).toHaveBeenLastCalledWith(`${BOX}/b-1/discard-draft`);

    await handlers.get("archive_toolbox")!({ id: "b-1" });
    expect(client.post).toHaveBeenLastCalledWith(`${BOX}/b-1/archive`);
    await handlers.get("unarchive_toolbox")!({ id: "b-1" });
    expect(client.post).toHaveBeenLastCalledWith(`${BOX}/b-1/unarchive`);

    await handlers.get("list_toolbox_agents")!({ toolboxId: "b-1" });
    expect(client.get).toHaveBeenLastCalledWith(`${BOX}/b-1/agents`);
  });

  it("the restore body the backend takes is `name` alone", () => {
    const op = JSON.stringify(snapshot.paths[`${BOX}/{toolbox_id}/restore`].post);
    expect(op).toContain("RestoreEntityRequest");
    expect(Object.keys(snapshot.components.schemas.RestoreEntityRequest.properties!)).toEqual([
      "name",
    ]);
  });

  it("the version history is reachable, by number and by id, and publishing is only requested", async () => {
    const { handlers, client } = surface();
    await handlers.get("list_toolbox_versions")!({ id: "b-1", type: "major", limit: 5, offset: 10 });
    expect(client.get).toHaveBeenLastCalledWith(`${BOX}/b-1/versions`, {
      type: "major",
      limit: 5,
      offset: 10,
    });
    await handlers.get("read_toolbox_version")!({ id: "b-1", version: 3 });
    expect(client.get).toHaveBeenLastCalledWith(`${BOX}/b-1/versions/3`);
    await handlers.get("read_toolbox_published")!({ id: "b-1" });
    expect(client.get).toHaveBeenLastCalledWith(`${BOX}/b-1/versions/published`);
    await handlers.get("restore_toolbox_version")!({ id: "b-1", versionId: "v-1", expectedVersion: 4 });
    expect(client.post).toHaveBeenLastCalledWith(`${BOX}/b-1/versions/v-1/restore`, {
      expectedVersion: 4,
    });

    await handlers.get("request_publish_toolbox")!({ id: "b-1", changeSummary: "Adds the mail tools" });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/publish-approvals", {
      entityType: "toolbox",
      entityId: "b-1",
      changeSummary: "Adds the mail tools",
    });
  });

  it("request_publish_bulk takes a toolbox (the approval queue does)", () => {
    const accepted =
      snapshot.components.schemas.CreateApprovalRequest.properties as Record<string, { enum?: string[] }>;
    expect(accepted.entityType.enum).toContain("toolbox");
    const { shapes } = surface();
    const requests = shapes.get("request_publish_bulk")!.requests as {
      element: { shape: { entityType: { options: string[] } } };
    };
    expect(requests.element.shape.entityType.options).toContain("toolbox");
  });

  it("list_toolboxes sends `archived`, and nothing when it is not asked", async () => {
    const { handlers, shapes, client } = surface();
    expect(Object.keys(shapes.get("list_toolboxes")!)).toEqual(["archived"]);
    await handlers.get("list_toolboxes")!({});
    expect(client.get).toHaveBeenLastCalledWith(BOX);
    await handlers.get("list_toolboxes")!({ archived: "only" });
    expect(client.get).toHaveBeenLastCalledWith(BOX, { archived: "only" });
  });
});

describe("what an agent reads about a toolbox says what the backend does", () => {
  const { descriptions } = surface();

  it("only what an agent holding the box gets waits for the publication; the filing is live", () => {
    // Source: ToolboxSchema.publishedMajorVersion ("what an agent holding this
    // box gets") for the part that waits; for the part that does not,
    // token_route_classes.py ("read live from the rows, so even its draft
    // changes behaviour"), ToolboxRepository.set_membership (UPDATE tools SET
    // toolbox_id), tool_repository.get_advert_state and
    // toolbox_auth.resolve_tool_auth_config ("Read LIVE from the tool row").
    for (const tool of ["create_toolbox", "update_toolbox", "set_toolbox_tools", "assign_tool_toolbox"]) {
      expect(descriptions.get(tool), tool).toContain("request_publish_toolbox");
    }
    for (const tool of ["set_toolbox_tools", "assign_tool_toolbox"]) {
      expect(descriptions.get(tool), tool).toMatch(/at once|immediately/i);
      expect(descriptions.get(tool), tool).toMatch(/advertised/);
      expect(descriptions.get(tool), tool).toMatch(/shared credential/);
    }
    expect(descriptions.get("update_toolbox")).toMatch(/read\s+live/);
    expect(descriptions.get("set_toolbox_tools")).not.toMatch(/IS A DRAFT UNTIL/);
    for (const tool of ["create_toolbox", "update_toolbox", "set_toolbox_tools", "assign_tool_toolbox"]) {
      expect(descriptions.get(tool), tool).not.toMatch(/goes live with request_publish/);
    }
  });

  it("restore and discard on a box say that tools move at once, not 'only the draft'", () => {
    // Source: ToolboxService.restore_version / discard_draft put the membership
    // back through tools.toolbox_id.
    expect(descriptions.get("restore_toolbox_version")).not.toMatch(/changes only the draft/);
    expect(descriptions.get("restore_toolbox_version")).toMatch(/membership back at once/);
    expect(descriptions.get("discard_toolbox_draft")).toMatch(/membership back at once/);
    // A kind without that effect keeps the generic sentence.
    expect(descriptions.get("restore_skill_version")).toMatch(/changes only the draft/);
    expect(descriptions.get("discard_skill_draft")).not.toMatch(/membership/);
  });

  it("assign_tool_toolbox no longer claims that grouping needs no publication", () => {
    // It was true while the box was a slot; since DECISIONS.md 18 both boxes
    // involved get a draft (`ToolboxService.assign_tool`).
    expect(descriptions.get("assign_tool_toolbox")).not.toMatch(/nor needs a republish/);
    expect(descriptions.get("assign_tool_toolbox")).toMatch(/both boxes/i);
  });

  it("publication names the member refusals (publish_readiness.toolbox_member_blockers)", () => {
    const d = descriptions.get("request_publish_toolbox")!;
    expect(d).toContain("has no published version");
    expect(d).toContain("is archived");
  });

  it("delete goes to the Trash and is refused while agents hold the box (refuse_if_in_use)", () => {
    const d = descriptions.get("delete_toolbox")!;
    expect(d).toContain("Trash");
    expect(d).toContain("restore_toolbox");
    expect(d).toContain("held by agent(s)");
    expect(d).toContain("list_toolbox_agents");
    expect(d).not.toMatch(/there is no restore_toolbox/);
  });

  it("archive is refused in the same words as delete", () => {
    expect(descriptions.get("archive_toolbox")).toMatch(/same words as delete_toolbox/);
  });

  it("list_toolbox_agents says what a holder is and where the refusal names them", () => {
    const d = descriptions.get("list_toolbox_agents")!;
    // ToolboxHoldersResponse: "The agents that hold this box whole".
    expect(d).toMatch(/hold this toolbox WHOLE/);
    expect(d).toContain("toolboxIds");
  });

  it("the credential of a box stays on the row, and an archived box is not edited", () => {
    // ToolboxService.set_auth_config: "The credential stays on the row, outside the
    // versions, but an archived box is not edited at all".
    const d = descriptions.get("set_toolbox_auth")!;
    expect(d).toMatch(/NOT versioned/);
    expect(d).toMatch(/archived/);
  });

  it("list_toolboxes names the new row fields", () => {
    const d = descriptions.get("list_toolboxes")!;
    for (const field of ["publishedMajorVersion", "draftMajorVersion", "heldByCount", "archivedAt"]) {
      expect(d, field).toContain(field);
      const row = snapshot.components.schemas.ToolboxSchema.properties!;
      expect(Object.keys(row), field).toContain(field);
    }
  });
});

describe("an agent holds a whole box: `toolboxIds` reaches the wire on create and update", () => {
  it("both request bodies carry it in the pinned schema", () => {
    for (const body of ["CreateAgentRequest", "UpdateAgentRequest", "GetAgentResponse", "AgentListItem"]) {
      expect(Object.keys(snapshot.components.schemas[body].properties!), body).toContain("toolboxIds");
    }
  });

  it("create_agent and update_agent pass it through, an empty list included", async () => {
    const { handlers, client } = surface();
    await handlers.get("create_agent")!({ fields: { name: "A", toolboxIds: ["b-1"] } });
    expect(client.post).toHaveBeenLastCalledWith("/api/v1/agents", { name: "A", toolboxIds: ["b-1"] });
    await handlers.get("update_agent")!({ id: "a-1", expectedVersion: 2, fields: { toolboxIds: [] } });
    expect(client.put).toHaveBeenLastCalledWith("/api/v1/agents/a-1", { expectedVersion: 2, toolboxIds: [] });
  });

  it("the agent tools say what a held box is (DECISIONS.md 11, expand_toolbox_grants)", () => {
    const { descriptions } = surface();
    for (const tool of ["create_agent", "update_agent"]) {
      const d = descriptions.get(tool)!;
      expect(d, tool).toContain("toolboxIds");
      // The box's PUBLISHED version decides which tools the agent gets.
      expect(d, tool).toMatch(/published version of the box/);
      // `_validate_toolbox_ids`: refused by name, not dropped.
      expect(d, tool).toContain("do not exist in this workspace");
    }
  });
});

describe("a secret says what uses it and when it was last used", () => {
  it("read_secret_used_by reads the route the backend mounts", async () => {
    expect(snapshot.paths["/api/v1/secrets/{secret_id}/used-by"]).toBeDefined();
    const { handlers, client } = surface();
    await handlers.get("read_secret_used_by")!({ secretId: "s-1" });
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/secrets/s-1/used-by");
  });

  it("list_secrets names the fields the rows really carry", () => {
    const { descriptions } = surface();
    const row = snapshot.components.schemas.SecretListItem.properties!;
    const d = descriptions.get("list_secrets")!;
    for (const field of ["holds", "usedBy", "usedByCount", "lastUsedAt"]) {
      expect(Object.keys(row), field).toContain(field);
      expect(d, field).toContain(field);
    }
    // `SecretService.delete_secret` no longer refuses a secret in use (Jonathan, 19 Nov):
    // used-by informs, it does not forbid, and the text must not say it does.
    expect(d).toContain("can still be deleted");
    expect(d).not.toContain("cannot be deleted");
    expect(d).toContain("read_secret_used_by");
  });

  it("the connector still cannot write a secret: no tool for a delete exists", () => {
    const { handlers } = surface();
    expect([...handlers.keys()].filter((n) => /secret/.test(n)).sort()).toEqual([
      "list_secrets",
      "read_secret",
      "read_secret_used_by",
    ]);
  });
});

describe("a tool says who uses it, and whether it needs a secret", () => {
  it("read_tool_used_by reads the route the backend mounts", async () => {
    expect(snapshot.paths["/api/v1/tools/{tool_id}/used-by"]).toBeDefined();
    const { handlers, client } = surface();
    await handlers.get("read_tool_used_by")!({ id: "t-1" });
    expect(client.get).toHaveBeenLastCalledWith("/api/v1/tools/t-1/used-by");
  });

  it("list_tools names needsSecret and dryRunStale as the backend defines them", () => {
    const { descriptions } = surface();
    const row = snapshot.components.schemas.ToolListItem.properties!;
    const d = descriptions.get("list_tools")!;
    for (const field of ["needsSecret", "dryRunStale"]) {
      expect(Object.keys(row), field).toContain(field);
      expect(d, field).toContain(field);
    }
    // ToolListItem.needsSecret: "A credential inherited from its toolbox is not counted here."
    expect(d).toMatch(/inherited from its toolbox is not counted/);
    // ToolListItem.dryRunStale: "the next publish needs a new dry-run".
    expect(d).toMatch(/next publish needs a new dry-run/);
  });
});

describe("the guide tells the new truth about toolboxes", () => {
  async function guide(): Promise<string> {
    const handlers = new Map<string, Handler>();
    registerConventions(
      { tool: (n: string, _d: string, _s: unknown, h: Handler) => handlers.set(n, h) } as never,
      placementClient(),
    );
    return (await handlers.get("axonity_conventions")!({})).content[0].text;
  }

  it("a box can be given whole, is versioned, and only what an agent gets waits for publication", async () => {
    const text = await guide();
    expect(text).toMatch(/hold a WHOLE toolbox/);
    expect(text).toContain("toolboxIds");
    expect(text).toMatch(/Only what an agent\s+that holds the box GETS waits for the publication/);
    expect(text).toMatch(/filing itself is live/);
    expect(text).not.toMatch(/membership is a DRAFT until the box is published/);
    expect(text).toContain("request_publish_toolbox");
  });

  it("deleting a box goes to the Trash and can be restored; the old claims are gone", async () => {
    const text = await guide();
    expect(text).toContain("restore_toolbox");
    expect(text).not.toMatch(/The\s+box itself has no restore/);
    expect(text).not.toMatch(/there is no route that\s+grants a whole box/);
    expect(text).not.toMatch(/An agent is linked to\s+individual tools \(`agent\.toolIds`\), never to a box/);
  });

  it("lists toolbox among the archivable and the renaming kinds", async () => {
    const text = await guide();
    expect(text).toMatch(/`archive_\*` \/ `unarchive_\*` on[^]*?`toolbox`[^]*?`data_source` and `dashboard`/);
    expect(text).toMatch(/`table_database` and `toolbox`, whose name is unique, pass\s+`name`/);
  });
});
