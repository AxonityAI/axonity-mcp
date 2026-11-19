/**
 * Toolboxes — the groups a tenant's tools are filed in, and what an agent can
 * hold whole (axonity-mcp#54, backend axonity-flow#1012 / epic #1006; Tools, R9
 * of agent-first, DECISIONS.md 11 and 18).
 *
 * Since R9 a box is a versioned item like a skill or a table: a draft, a
 * publication that a person approves, version history, archive and the Trash.
 * The generic half of that family (read, restore, the Trash list, discard,
 * archive, the publish request) and its version tools are generated from the
 * same registrars as every other kind (`ENTITIES` and `VERSIONED` in
 * `index.ts`). This module holds what the generic tool cannot say: typed
 * fields, the lock spelled `expected_version`, a replace-all membership, the
 * credential, and who holds a box.
 *
 * Four things the schema cannot say, and an agent gets wrong without them:
 *
 * 1. **`set_toolbox_tools` DECLARES the membership.** It is a PUT, not an
 *    append: a tool in the box and absent from the list is evicted. Adding one
 *    tool means reading the box first — or using `assign_tool_toolbox`, which
 *    moves exactly one and takes `null` to ungroup.
 * 2. **Only what an agent holding the box GETS waits for the publication.**
 *    The tools it receives at run start come from the box's published version
 *    (`expand_toolbox_grants`), and publishing goes through an approval a
 *    person decides (`request_publish_toolbox`). The rest is read LIVE from the
 *    rows: membership (a column on `tools`), `toolCount`, how a tool is
 *    advertised, the name and description `discover_tools` shows, and the
 *    shared credential a tool inherits. Backend: `token_route_classes.py`
 *    ("even its draft changes behaviour"), `ToolboxRepository.set_membership`,
 *    `get_advert_state`, `resolve_tool_auth_config`.
 * 3. **An agent can hold a whole box** (`agent.toolboxIds`), as well as single
 *    tools (`agent.toolIds`). The box also decides how a tool is ADVERTISED: a
 *    boxed tool with `surfacing: "inherit"` is found via `discover_tools`
 *    instead of riding in every prompt.
 * 4. **Deleting a toolbox does not delete its tools.** It goes to the Trash and
 *    the tools read as ungrouped until `restore_toolbox`; it is refused while
 *    an agent holds it.
 *
 * `set_toolbox_auth` is the one write here that touches a credential, and it
 * runs the same guard as `create_connector`: placeholders or a `secretId`, never
 * a value. A shared credential is the reason the box exists for a family like
 * Microsoft Mail — ten tools, one mailbox, said once — which also makes it the
 * one write whose blast radius is wider than the row it edits. It stays on the
 * row, outside the versions (`ToolboxService.set_auth_config`).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { assertPlaceholderCredentials } from "./credentials.js";
import { guard, jsonResult } from "./result.js";

/** A required literal — an agent cannot satisfy it by filling in a default. */
const CONFIRM = z
  .literal(true)
  .describe("Must be true. Acknowledges you understand this is destructive.");

export function registerToolboxTools(server: McpServer, client: AxonityClient): void {
  server.tool(
    "list_toolboxes",
    "List the tenant's toolboxes — the groups its tools are filed under: id, " +
      "name, description, toolCount, hasAuthConfig, version, " +
      "`publishedMajorVersion` (the version that is live: what an agent that " +
      "holds the box gets; null while nothing is published), " +
      "`draftMajorVersion` (the working draft; null when there is " +
      "none), `heldByCount` (how " +
      "many agents hold the box whole), `isPlatform` (shipped by the platform, " +
      "read-only) and `archivedAt`. " +
      "Archived items are left out unless `archived` is `include` or `only`; " +
      "`archivedAt` is null while the box is in use. Whole, never paged: a " +
      "tenant holds O(10) boxes and they ARE the structure that tames the " +
      "tool list. " +
      "\n\nRead this BEFORE create_tool: pass the box's id as `toolboxId` in " +
      "the tool's fields and it is filed on creation. A tool created without " +
      "one is ungrouped — valid, but nobody finds it. " +
      "\n\nA box's `authConfig` comes back with secret values masked; " +
      "`hasAuthConfig` says whether it carries a shared credential at all. " +
      "`descriptionIsAutomatic` is true while the description is still the " +
      "sentence the platform wrote when it grouped the tools: rewrite it to say " +
      "what the box is for, because an agent reads that line to decide whether " +
      "to open the box.",
    {
      archived: z
        .enum(["exclude", "include", "only"])
        .optional()
        .describe(
          "`exclude` (default) leaves archived boxes out, `only` lists just the " +
            "archived ones, `include` lists both.",
        ),
    },
    async ({ archived }) =>
      guard(async () =>
        jsonResult(
          archived === undefined
            ? await client.get("/api/v1/toolboxes")
            : await client.get("/api/v1/toolboxes", { archived }),
        ),
      ),
  );

  server.tool(
    "create_toolbox",
    "Create a toolbox. It is a versioned item with a working draft, " +
      "publishable from the moment it exists; the box is visible and filable at " +
      "once, and what an agent that holds it gets (its tools) comes from the " +
      "published version, through request_publish_toolbox. Both `name` and `description` are REQUIRED — the " +
      "description is not politeness: it is the line an agent reads in the " +
      "discover_tools advert to decide whether to look inside the box, so it " +
      "must say what the tools DO. An empty one is rejected. " +
      "\n\n`name` is unique per tenant; a duplicate is a 422. Check " +
      "list_toolboxes first — the box you want usually already exists.",
    {
      name: z.string().describe('Display name, e.g. "Carerix".'),
      description: z
        .string()
        .describe(
          "What this toolbox is for, in one line. Read by a person in the tool " +
            "tab and by an agent deciding whether to look inside.",
        ),
    },
    async ({ name, description }) =>
      guard(async () =>
        jsonResult(await client.post("/api/v1/toolboxes", { name, description })),
      ),
  );

  server.tool(
    "update_toolbox",
    "Rename or re-describe a toolbox. The new name and description are read " +
      "live: discover_tools shows them at once, without a publication. What " +
      "an agent that holds the box gets (its tools) comes from the published " +
      "version and changes only with request_publish_toolbox. Read it first with " +
      "list_toolboxes for its `version`; a stale `expectedVersion` is a 409 — " +
      "re-read and retry rather than force. Pass only what you are changing; an " +
      "omitted field is left alone. Renaming to a name another box holds is a " +
      "422, and so is an empty description. An archived box is not edited: " +
      "\"… is archived. Unarchive it first.\" — call unarchive_toolbox first.",
    {
      toolboxId: z.string().describe("The toolbox's id."),
      expectedVersion: z
        .number()
        .int()
        .describe("The version you last read — rejected with 409 if stale."),
      name: z.string().optional().describe("New display name. Omit to leave unchanged."),
      description: z
        .string()
        .optional()
        .describe("New description. Omit to leave unchanged."),
    },
    async ({ toolboxId, expectedVersion, name, description }) =>
      guard(async () =>
        jsonResult(
          await client.put(`/api/v1/toolboxes/${toolboxId}`, {
            expectedVersion,
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
          }),
        ),
      ),
  );

  server.tool(
    "delete_toolbox",
    "Delete a toolbox: it goes to the Trash (list_trash) and its tools read as " +
      "UNGROUPED until restore_toolbox brings it back with the tools it held. " +
      "ITS TOOLS ARE NOT DELETED. " +
      "\n\nIt is refused while agents hold the box (\"Cannot delete: toolbox '…' " +
      "is held by agent(s): …. Take it off them first.\"): the refusal names " +
      "them, and list_toolbox_agents lists them beforehand. Platform-shipped " +
      "boxes are refused too. " +
      "\n\nIf the box carries a shared credential, call " +
      "list_toolbox_dependent_tools first: the tools it names have no " +
      "credential of their own and will start failing at RUN time with a bare " +
      "401 from the partner API, which says nothing about what changed. " +
      "\n\nRead the box first for its `version`; a stale one is a 409.",
    {
      toolboxId: z.string().describe("The toolbox's id."),
      expectedVersion: z
        .number()
        .int()
        .describe("The version you last read — rejected with 409 if stale."),
      confirm: CONFIRM,
    },
    async ({ toolboxId, expectedVersion }) =>
      guard(async () =>
        jsonResult(
          // Note the spelling: this route takes the lock as `expected_version`,
          // where the tool/agent/workflow deletes take `expectedVersion`. A real
          // backend inconsistency, and not one a caller should have to know.
          await client.del(`/api/v1/toolboxes/${toolboxId}`, {
            expected_version: expectedVersion,
          }),
        ),
      ),
  );

  server.tool(
    "set_toolbox_tools",
    "DECLARE exactly which tools this toolbox holds. This REPLACES the " +
      "membership — a tool currently in the box and absent from `toolIds` is " +
      "evicted and left ungrouped. It does not add. " +
      "\n\nTHE FILING IS LIVE, WHAT AN AGENT GETS IS NOT: the membership moves " +
      "at once (a tool that leaves another box leaves it at once too), so " +
      "toolCount, how each tool is advertised in discover_tools and the shared " +
      "credential a tool inherits change immediately. Agents that hold the box " +
      "keep the tools of its published version until request_publish_toolbox " +
      "is approved. At most " +
      "500 tools in one call; an archived box is not edited. " +
      "\n\nTo ADD one tool, either read the box's current contents and send " +
      "them plus the new one, or use assign_tool_toolbox, which moves a single " +
      "tool and cannot evict anything by accident. " +
      "\n\nA tool belongs to at most one box, so a tool named here leaves " +
      "whichever box it was in. Platform-shipped tools (the Axonity, Checks and " +
      "Branching boxes) are locked: the API refuses and NAMES the tool it " +
      "refused — read that name rather than bisecting your selection by hand.",
    {
      toolboxId: z.string().describe("The toolbox's id."),
      toolIds: z
        .array(z.string())
        .describe(
          "Ids of EVERY tool that should be in this box afterwards. An empty " +
            "array empties the box (the tools survive, ungrouped).",
        ),
    },
    async ({ toolboxId, toolIds }) =>
      guard(async () =>
        jsonResult(await client.put(`/api/v1/toolboxes/${toolboxId}/tools`, { toolIds })),
      ),
  );

  server.tool(
    "assign_tool_toolbox",
    "Move ONE tool into a toolbox, or out of one by passing `toolboxId: null`. " +
      "Prefer this over set_toolbox_tools whenever you are filing a single " +
      "tool — it cannot evict anything you forgot to list. " +
      "\n\nThis is deliberately not part of update_tool: which box a tool sits " +
      "in is not a field of the tool's own published document, and there `null` " +
      "already means 'leave this field alone', so there would be no way to say " +
      "'ungroup'. Here `toolboxId` is required and an explicit null MEANS " +
      "ungroup. " +
      "\n\nIt is a change to the BOXES, not to the tool, and the filing is live: " +
      "how the tool is advertised and which shared credential it inherits " +
      "change at once. Both boxes involved (the one it leaves and the one it " +
      "joins) get a working draft with the new membership, and what an agent " +
      "that holds a box gets does not change until request_publish_toolbox " +
      "is approved for each. An archived tool is not " +
      "moved, and neither is a tool into or out of an archived box. " +
      "A platform-shipped tool cannot be moved; the API names it in the " +
      "refusal.",
    {
      toolId: z.string().describe("The tool's id."),
      toolboxId: z
        .string()
        .nullable()
        .describe(
          "Id of the toolbox to move it into, or null to take it out of its " +
            "box. There is no 'leave unchanged' — that is why this is its own " +
            "endpoint.",
        ),
    },
    async ({ toolId, toolboxId }) =>
      guard(async () =>
        jsonResult(await client.put(`/api/v1/tools/${toolId}/toolbox`, { toolboxId })),
      ),
  );

  server.tool(
    "set_toolbox_auth",
    "Set the credential the tools in this toolbox SHARE, or pass " +
      "`authConfig: null` to clear it. Ten Microsoft Mail tools using one " +
      "mailbox is what this exists for: said once, on the box, instead of ten " +
      "times. A tool that carries its own auth keeps it — only a tool with none " +
      "inherits the box's. " +
      "\n\nSame shape as a connector's auth ({ type, config, secretId }) and the " +
      "same rule: POINT `secretId` AT A STORED SECRET (list_secrets) rather " +
      "than putting a credential here. Real-looking secret material is rejected " +
      "before it leaves this connector; a human fills values in Axonity. " +
      "\n\nThis edits one row but changes how every inheriting tool " +
      "authenticates. list_toolbox_dependent_tools names which ones those are. " +
      "\n\nThe credential is NOT versioned: it stays on the box, outside its " +
      "versions, so it takes effect without a publication — and an archived box " +
      "is not edited here either.",
    {
      toolboxId: z.string().describe("The toolbox's id."),
      authConfig: z
        .record(z.unknown())
        .nullable()
        .describe(
          'The shared auth, e.g. { "type": "bearer", "secretId": "…" }, or null ' +
            "to clear it. Placeholders or a secretId only — never a real value.",
        ),
    },
    async ({ toolboxId, authConfig }) =>
      guard(async () => {
        // The guard reads `authConfig` off the object it is given, which is how
        // it runs on create_tool/create_connector. Same walk, same message.
        assertPlaceholderCredentials({ authConfig });
        return jsonResult(
          await client.put(`/api/v1/toolboxes/${toolboxId}/auth`, { authConfig }),
        );
      }),
  );

  server.tool(
    "list_toolbox_dependent_tools",
    "Which tools would stop working if this toolbox lost its shared " +
      "credential — the ones with no auth of their own. Ask BEFORE " +
      "delete_toolbox, before set_toolbox_auth clears or replaces the " +
      "credential, and before moving a tool out with assign_tool_toolbox, so " +
      "the warning can name them. " +
      "\n\nAn empty list is an answer: either the box has no shared credential, " +
      "or every tool in it carries its own. Read-only.",
    { toolboxId: z.string().describe("The toolbox's id.") },
    async ({ toolboxId }) =>
      guard(async () =>
        jsonResult(await client.get(`/api/v1/toolboxes/${toolboxId}/dependent-tools`)),
      ),
  );

  server.tool(
    "list_toolbox_agents",
    "The agents that hold this toolbox WHOLE (`toolboxIds` on the agent): { " +
      "agents: [{ id, name }] }. Ask BEFORE delete_toolbox or archive_toolbox — " +
      "both are refused while an agent holds the box, and the agents named " +
      "there are these. An agent that holds only single tools of the box " +
      "(`toolIds`) is not listed. Read-only.",
    { toolboxId: z.string().describe("The toolbox's id.") },
    async ({ toolboxId }) =>
      guard(async () => jsonResult(await client.get(`/api/v1/toolboxes/${toolboxId}/agents`))),
  );

  server.tool(
    "read_tool_used_by",
    "Who uses a tool, in counts: { agents (live agents that hold this tool " +
      "itself), steps (workflow steps, draft or published, that name it), " +
      "viaToolboxId and viaToolboxName (the live toolbox it sits in, null when " +
      "none), viaToolboxAgents (live agents that hold that whole toolbox, so " +
      "reach the tool through it) }. An agent that holds the tool's whole box " +
      "is counted under `viaToolboxAgents`, not under `agents`. Read-only.",
    { id: z.string().describe("The tool's id.") },
    async ({ id }) =>
      guard(async () => jsonResult(await client.get(`/api/v1/tools/${id}/used-by`))),
  );
}
