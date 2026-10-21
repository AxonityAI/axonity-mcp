/**
 * Applications beyond the entity verbs (axonity-mcp#86, the connector half of
 * axonity-flow#1901): which executors an application runs on, the executors
 * themselves, and what the application has learned about itself.
 *
 * The plain verbs — list/read/create/update/delete/restore, the versions and
 * request_publish_application — come from the registrars (see `ENTITIES` in
 * index.ts). Publishing is the human approval queue, as everywhere: the limits
 * are what an executor on a customer's machine is allowed to do.
 *
 * **Executors are read-only here.** Registering one mints its token and
 * revoking one cuts a machine off; both are deny-listed. Nothing here returns a
 * token: an executor's answer carries only its prefix and expiry.
 *
 * **Who may write.** Linking executors and writing, forgetting or restoring
 * knowledge are `require_admin` on the platform, and a service token always
 * resolves as a member — so today these answer 403 for every token, and
 * `ForbiddenError` says so in words. The tools are here so the refusal names
 * its reason rather than the tool being missing, and so they work the day the
 * platform opens them.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

const APPLICATIONS = "/api/v1/applications";
const EXECUTORS = "/api/v1/executors";

const APPLICATION_ID = z.string().describe("The application's id.");
const EXECUTOR_ID = z.string().describe("The executor's id.");

const ADMIN_ONLY =
  "ADMINISTRATOR ONLY on the platform, and a service token always counts as " +
  "a member: today this is refused for every token with a 403 that says so. " +
  "Do not retry — tell your human; an administrator does it in Axonity " +
  "(Digital Twin → Applications).";

const PAGE_NOTE =
  "THE RESPONSE IS ONE PAGE: { items, nextCursor, pageSize, hasMore }. While " +
  "hasMore is true you have not seen every entry — pass nextCursor back as " +
  "cursor until it is null. Never build a cursor.";

const PAGING = {
  limit: z
    .number()
    .int()
    .optional()
    .describe("Page size. The platform clamps it to its maximum."),
  cursor: z
    .string()
    .optional()
    .describe(
      "Opaque continuation cursor from the previous response's nextCursor. " +
        "Omit for the first page.",
    ),
};

const KIND = z.enum(["element", "instruction", "lesson"]);

export function registerApplicationTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "read_application_executors",
    "Which executors (machines) an application runs on: `{ executorIds }`. " +
      "Read it before set_application_executors, which replaces the whole " +
      `set.\n\n${ADMIN_ONLY}`,
    { id: APPLICATION_ID },
    async ({ id }) =>
      guard(async () => jsonResult(await client.get(`${APPLICATIONS}/${id}/executors`))),
  );

  server.tool(
    "set_application_executors",
    "Choose the executors (machines) an application runs on. REPLACES THE " +
      "WHOLE SET: send every executor it should run on, not only the one you " +
      "add — read_application_executors first. An empty list runs it on none. " +
      "Executor ids come from list_executors. An executor receives the " +
      "application's PUBLISHED limits, so a never-published application " +
      "gives it nothing yet." +
      `\n\n${ADMIN_ONLY}`,
    {
      id: APPLICATION_ID,
      executorIds: z
        .array(z.string())
        .max(50)
        .describe("Every executor this application should run on, by id."),
    },
    async ({ id, executorIds }) =>
      guard(async () =>
        jsonResult(await client.put(`${APPLICATIONS}/${id}/executors`, { executorIds })),
      ),
  );

  server.tool(
    "list_executors",
    "List the workspace's executors — the programs on a customer's machine " +
      "that carry out what an agent asks of an application. Read-only. Each " +
      "has `status` (online/offline), `lastSeenAt`, what the machine reported " +
      "(`reported`) and `limitsConfirmed`, the published limits version it " +
      "confirmed per application. Never a token: `tokenPrefix` only " +
      "recognises it. Registering an executor or revoking one is a human's " +
      "job in Axonity, not a tool here.",
    {},
    async () => guard(async () => jsonResult(await client.get(EXECUTORS))),
  );

  server.tool(
    "read_executor",
    "Read one executor: its status, when it was last seen, what it reported " +
      "and which published limits it confirmed per application. Read-only, " +
      "and never a token.",
    { id: EXECUTOR_ID },
    async ({ id }) => guard(async () => jsonResult(await client.get(`${EXECUTORS}/${id}`))),
  );

  server.tool(
    "read_executor_applications",
    "The other side of read_application_executors: which applications one " +
      "executor may operate, `{ applicationIds }`. To change the link, use " +
      `set_application_executors on the application.\n\n${ADMIN_ONLY}`,
    { id: EXECUTOR_ID },
    async ({ id }) =>
      guard(async () => jsonResult(await client.get(`${EXECUTORS}/${id}/applications`))),
  );

  server.tool(
    "list_executor_commands",
    "Every command an executor can carry out — click, type, read a screen, " +
      "open an address, … — with its `kind` (`read` or `navigate`), its " +
      "arguments (`inputSchema`) and its default timeout. Read-only; the " +
      "platform's fixed catalogue, the same for every workspace. Use it to " +
      "write an instruction's steps with actions that exist.",
    {},
    async () => guard(async () => jsonResult(await client.get(`${EXECUTORS}/commands`))),
  );

  server.tool(
    "list_application_knowledge",
    "What an application has learned about itself and uses now: `element` " +
      "(a control on screen and what it is for), `instruction` (how to do " +
      "something, as steps) and `lesson` (a short rule learned from a run). " +
      "Each entry has `id`, `kind`, `key`, `version`, `content`, `source`, " +
      "`status` and how often it `worked`. Read it before forget or write, " +
      "and when an agent keeps making the same mistake in an application." +
      `\n\n${PAGE_NOTE}`,
    {
      id: APPLICATION_ID,
      kind: KIND.optional().describe("Only entries of this kind. Omit for all three."),
      ...PAGING,
    },
    async ({ id, kind, limit, cursor }) =>
      guard(async () =>
        jsonResult(
          await client.get(`${APPLICATIONS}/${id}/knowledge`, { kind, limit, cursor }),
        ),
      ),
  );

  server.tool(
    "list_application_knowledge_versions",
    "Every version of one knowledge entry, newest first — what it said " +
      "before it was corrected or forgotten. Pick the one to bring back with " +
      `restore_application_knowledge.\n\n${PAGE_NOTE}`,
    {
      id: APPLICATION_ID,
      knowledgeId: z.string().describe("The entry's id, from list_application_knowledge."),
      ...PAGING,
    },
    async ({ id, knowledgeId, limit, cursor }) =>
      guard(async () =>
        jsonResult(
          await client.get(`${APPLICATIONS}/${id}/knowledge/${knowledgeId}/versions`, {
            limit,
            cursor,
          }),
        ),
      ),
  );

  server.tool(
    "write_application_knowledge",
    "Write or correct one entry of what an application knows, as a designer " +
      "would. Always a NEW version; the old one is kept and can be restored. " +
      "What the entry is about is its element's `label`, its `instruction` " +
      "or its lesson's `text` (case and spacing ignored): write the same one " +
      "again to correct it, a different one to add an entry. `entry` " +
      "takes the shape of its kind (camelCase): " +
      "\n- `element`: `{ label, purpose, kind?, place? }`; " +
      "\n- `instruction`: `{ instruction, steps, proof?, startsFrom? }`, each " +
      "step `{ action, target?, value?, toTarget?, options? }` with an action " +
      "from list_executor_commands, and `proof` `{ window?, text? }` — what " +
      "is on screen when it worked; " +
      "\n- `lesson`: `{ text }`, at most 500 characters. " +
      "\nNever put a secret's value in an entry: a step types a secret with " +
      "`type_secret` and the secret's NAME." +
      `\n\n${ADMIN_ONLY}`,
    {
      id: APPLICATION_ID,
      kind: KIND.describe("What kind of entry this is."),
      entry: z
        .record(z.unknown())
        .describe("The entry itself, in the shape of its kind (see above)."),
    },
    async ({ id, kind, entry }) =>
      guard(async () =>
        jsonResult(
          await client.post(`${APPLICATIONS}/${id}/knowledge`, { kind, [kind]: entry }),
        ),
      ),
  );

  server.tool(
    "forget_application_knowledge",
    "Stop the application using one entry — a wrong element, instruction or " +
      "lesson. Not a delete: it is kept, marked forgotten, with its versions, " +
      "and restore_application_knowledge brings it back. Only the current " +
      "version of an entry can be forgotten." +
      `\n\n${ADMIN_ONLY}`,
    {
      id: APPLICATION_ID,
      knowledgeId: z.string().describe("The entry's id, from list_application_knowledge."),
    },
    async ({ id, knowledgeId }) =>
      guard(async () =>
        jsonResult(
          await client.post(`${APPLICATIONS}/${id}/knowledge/${knowledgeId}/forget`),
        ),
      ),
  );

  server.tool(
    "restore_application_knowledge",
    "Make a forgotten entry, or an older version of one, current again — as " +
      "a new version, so nothing is overwritten. Pass the id of the version " +
      "you want back (from list_application_knowledge_versions), or the " +
      "forgotten entry's id to undo forget_application_knowledge. The " +
      "current version cannot be restored — it already is current." +
      `\n\n${ADMIN_ONLY}`,
    {
      id: APPLICATION_ID,
      knowledgeId: z
        .string()
        .describe("The id of the version to bring back, or of the forgotten entry."),
    },
    async ({ id, knowledgeId }) =>
      guard(async () =>
        jsonResult(
          await client.post(`${APPLICATIONS}/${id}/knowledge/${knowledgeId}/restore`),
        ),
      ),
  );
}
