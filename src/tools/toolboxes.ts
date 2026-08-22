/**
 * Toolboxes — the grouping label a tenant's tools live in (axonity-mcp#54,
 * backend axonity-flow#1012 / epic #1006).
 *
 * Until this module the connector could not see a toolbox at all, and that was
 * not a missing convenience: `create_tool` silently produced an ORPHAN. On the
 * dev tenant 76 tools collapse into eight boxes and one loose tool, so a tool
 * outside every box is not "unfiled", it is the one nobody finds.
 *
 * Three things the schema cannot say, and an agent gets wrong without them:
 *
 * 1. **`set_toolbox_tools` DECLARES the membership.** It is a PUT, not an
 *    append: a tool in the box and absent from the list is evicted. Adding one
 *    tool means reading the box first — or using `assign_tool_toolbox`, which
 *    moves exactly one and takes `null` to ungroup.
 * 2. **A toolbox never changes what an agent MAY call.** An agent is linked to
 *    individual tools (`agent.toolIds`), never to a box. The box decides how a
 *    tool is ADVERTISED: a boxed tool with `surfacing: "inherit"` is found via
 *    `discover_tools` instead of riding in every prompt. "Assign the whole
 *    toolbox to this agent" is a bulk write of individual links, and there is
 *    no route that does it.
 * 3. **Deleting a toolbox does not delete its tools.** They survive, ungrouped.
 *
 * `set_toolbox_auth` is the one write here that touches a credential, and it
 * runs the same guard as `create_connector`: placeholders or a `secretId`, never
 * a value. A shared credential is the reason the box exists for a family like
 * Microsoft Mail — ten tools, one mailbox, said once — which also makes it the
 * one write whose blast radius is wider than the row it edits.
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
    "List the tenant's toolboxes — the groups its tools are filed under (id, " +
      "name, description, toolCount, hasAuthConfig, version). Whole, never " +
      "paged: a tenant holds O(10) boxes and they ARE the structure that tames " +
      "the tool list. " +
      "\n\nRead this BEFORE create_tool: pass the box's id as `toolboxId` in " +
      "the tool's fields and it is filed on creation. A tool created without " +
      "one is ungrouped — valid, but nobody finds it. " +
      "\n\nA box's `authConfig` comes back with secret values masked; " +
      "`hasAuthConfig` says whether it carries a shared credential at all.",
    {},
    async () => guard(async () => jsonResult(await client.get("/api/v1/toolboxes"))),
  );

  server.tool(
    "create_toolbox",
    "Create a toolbox. Both `name` and `description` are REQUIRED — the " +
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
    "Rename or re-describe a toolbox. Read it first with list_toolboxes for its " +
      "`version`; a stale `expectedVersion` is a 409 — re-read and retry rather " +
      "than force. Pass only what you are changing; an omitted field is left " +
      "alone. Renaming to a name another box holds is a 422.",
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
    "Delete a toolbox. ITS TOOLS SURVIVE — they become ungrouped, and nothing " +
      "an agent may call changes. The BOX itself does not come back: unlike an " +
      "entity delete there is no restore_toolbox, so re-creating it and " +
      "re-filing its tools is the only undo. " +
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
      "\n\nThis is deliberately not part of update_tool: grouping is not a " +
      "change to the tool's published document. It neither bumps the version " +
      "nor needs a republish to take effect, and there `null` already means " +
      "'leave this field alone', so there would be no way to say 'ungroup'. " +
      "Here `toolboxId` is required and an explicit null MEANS ungroup. " +
      "\n\nA platform-shipped tool cannot be moved; the API names it in the " +
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
      "authenticates. list_toolbox_dependent_tools names which ones those are.",
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
}
