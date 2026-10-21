/**
 * Who may read what: the audiences and roles of a workspace (axonity-mcp#88,
 * S1; the platform half is axonity-flow#1918).
 *
 * Every piece of knowledge — a policy, a skill, a reference doc, a table —
 * carries a label: a level and the audiences it is meant for. Every reader
 * carries a clearance. Both name audiences BY ID, so an agent that writes a
 * label needs the ids, and the only honest source of them is the workspace
 * itself. That is all this file is for: reading the vocabulary.
 *
 * **Reading only.** Creating or changing an audience or a role, and giving a
 * colleague a role, are `require_admin` on the platform, and a service token
 * always resolves as a member. Whether a token may ever do that is an open
 * decision in #88 (S3); until it is taken those routes are not in the pinned
 * snapshot, so they are neither covered nor excluded here.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

const AUDIENCES = "/api/v1/audiences";
const ROLES = "/api/v1/roles";

/** Said on both list tools: these are pages, not the whole vocabulary. */
const PAGE_NOTE =
  "\n\nTHE RESPONSE IS ONE PAGE: { items, nextCursor, pageSize, hasMore }. " +
  "While hasMore is true you have not seen them all — pass nextCursor back " +
  "as cursor for the next page. Never build a cursor yourself.";

const LIMIT = z
  .number()
  .int()
  .optional()
  .describe("Page size. Omit for the platform's default.");

const CURSOR = z
  .string()
  .optional()
  .describe(
    "The previous response's nextCursor, to get the next page. Omit for the " +
      "first page.",
  );

export function registerAccessTools(server: McpServer, client: AxonityClient): void {
  server.tool(
    "list_audiences",
    "The workspace's audiences. Read-only. " +
      "\n\nAN AUDIENCE IS WHOM KNOWLEDGE IS MEANT FOR: Staff, Clients, " +
      "Candidates — a group of people, not a permission. A policy, skill, " +
      "reference doc or table names its audiences in `audienceIds`; a role " +
      "says which audiences a colleague may read. `internal: true` means " +
      "people inside the workspace, false the people it serves. `isSystem` " +
      "marks the one the platform ships (Staff): usable, not changeable. " +
      "\n\nThis is where an audience id comes from. Never guess one and never " +
      "match on a name: two workspaces can both have \"Clients\" with " +
      "different ids, and a name can be changed." +
      PAGE_NOTE,
    { limit: LIMIT, cursor: CURSOR },
    async ({ limit, cursor }) =>
      guard(async () => jsonResult(await client.get(AUDIENCES, { limit, cursor }))),
  );

  server.tool(
    "read_audience",
    "One audience: its name, description, and whether it is inside the " +
      "workspace (`internal`). Read-only. An audience is whom knowledge is " +
      "meant for — see list_audiences.",
    { id: z.string().describe("The audience's id, from list_audiences.") },
    async ({ id }) => guard(async () => jsonResult(await client.get(`${AUDIENCES}/${id}`))),
  );

  server.tool(
    "list_roles",
    "The workspace's roles. Read-only. " +
      "\n\nA ROLE IS WHAT A COLLEAGUE MAY READ AND MAINTAIN. Each one says: " +
      "up to which level it reads (`readMaxLevel`: public, internal or " +
      "confidential; null reads nothing), for which audiences " +
      "(`readAudienceIds`), and which audiences it maintains " +
      "(`maintainAudienceIds`) — maintaining is confirming, correcting and " +
      "labelling what is meant for them. `holders` is how many colleagues " +
      "hold it. `isSystem` marks the one the platform ships (Member). A " +
      "colleague with several roles reads with the widest. " +
      "\n\nRoles are for people. An agent, a workflow and your own token " +
      "have a clearance of their own instead, and none of them ever " +
      "maintains anything." +
      PAGE_NOTE,
    { limit: LIMIT, cursor: CURSOR },
    async ({ limit, cursor }) =>
      guard(async () => jsonResult(await client.get(ROLES, { limit, cursor }))),
  );

  server.tool(
    "read_role",
    "One role: up to which level it reads, for which audiences, which " +
      "audiences it maintains, and how many colleagues hold it. Read-only. " +
      "The audiences are ids — read_audience or list_audiences names them.",
    { id: z.string().describe("The role's id, from list_roles.") },
    async ({ id }) => guard(async () => jsonResult(await client.get(`${ROLES}/${id}`))),
  );

  server.tool(
    "read_member_roles",
    "Which roles one colleague holds, as role ids. Read-only. Use it to " +
      "answer \"can this person read that?\": read each role with read_role. " +
      "With several roles, the widest applies. The colleague's id comes from " +
      "list_users.",
    { userId: z.string().describe("The colleague's user id, from list_users.") },
    async ({ userId }) =>
      guard(async () => jsonResult(await client.get(`/api/v1/users/${userId}/roles`))),
  );
}
