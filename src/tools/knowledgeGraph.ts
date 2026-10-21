/**
 * Reading what the platform has learned: the knowledge graph (axonity-mcp#88,
 * S5; the platform half is axonity-flow#1918).
 *
 * Runs, documents and colleagues teach the workspace facts. Each fact has a
 * certainty, a validity, the topics it belongs to and the passages it was
 * learned from. These tools let an agent look — to check what a run learned,
 * or why an answer said what it said.
 *
 * **It reads with the token's clearance.** The platform filters every read in
 * its own queries: a fact the token may not read is not in a search, not in
 * its topic, and not found by id. So an empty answer is an answer about what
 * THIS TOKEN may see, and the descriptions say so.
 *
 * **Looking, never judging.** Confirming, rejecting, correcting, archiving,
 * relabelling and erasing a fact, answering a decision or a learning round:
 * all of that ends with a person by design, and `test/denyList.ts` records it.
 * So do the work lists of the Oversight screen — they hold only what the
 * reader maintains or was handed, and a token maintains nothing, so a tool
 * over them could only ever answer an empty list.
 *
 * **The module can be off.** Every route here sits behind the Cortex module;
 * switched off, each answers 403 with the module's sentence, which
 * `ForbiddenError` turns into plain words rather than "your token may not".
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

const KNOWLEDGE = "/api/v1/knowledge";

/** Said on every tool: an empty answer is about the token, not the graph. */
const CLEARANCE_NOTE =
  "\n\nYOU READ WITH YOUR TOKEN'S CLEARANCE: what it may not read is " +
  "left out entirely, so an empty answer means nothing THIS TOKEN may see, " +
  "not that nothing was learned. If Cortex is switched off in the " +
  "workspace, the call is refused and says so.";

const PAGE_NOTE =
  "\n\nTHE RESPONSE IS ONE PAGE: { items, nextCursor, pageSize, hasMore }. " +
  "While hasMore is true you have not seen them all — pass nextCursor back " +
  "as cursor for the next page. Never build a cursor yourself, and never " +
  "count from one page.";

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

const AS_OF = z
  .string()
  .optional()
  .describe(
    "A date (YYYY-MM-DD): answer as the graph stood at the end of that day — " +
      "what was valid then. Omit for now.",
  );

export function registerKnowledgeGraphTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "search_knowledge_graph",
    "Search what the workspace has learned, with a question in plain words. " +
      "Read-only. The same search an agent in a run gets. " +
      "\n\nThe answer lands on up to eight places (`landing`), each a fact " +
      "or a topic with what hangs around it. A fact never comes bare: its " +
      "`certainty`, `status`, validity (`validFrom`, `validUntil`), its " +
      "topics and its `passages` — the evidence, each with its source, the " +
      "source's score and a date. Report a fact with its certainty and " +
      "source, not as plain truth. `tips` are facts below the threshold for " +
      "an answer; they are only shown to someone who maintains them. " +
      "\n\nUse read_fact for one fact's full card and read_source for where " +
      "it came from." +
      CLEARANCE_NOTE,
    {
      q: z.string().describe("The question, in plain words (at most 2000 characters)."),
      asOf: AS_OF,
    },
    async ({ q, asOf }) =>
      guard(async () =>
        jsonResult(await client.get(`${KNOWLEDGE}/search`, { q, as_of: asOf })),
      ),
  );

  server.tool(
    "list_knowledge_topics",
    "The topics of the knowledge graph, newest first, each with its summary, " +
      "its label and how many facts it holds. Read-only. A topic is a " +
      "subject facts are grouped under; list_topic_facts opens one." +
      PAGE_NOTE +
      CLEARANCE_NOTE,
    { limit: LIMIT, cursor: CURSOR },
    async ({ limit, cursor }) =>
      guard(async () =>
        jsonResult(await client.get(`${KNOWLEDGE}/topics`, { limit, cursor })),
      ),
  );

  server.tool(
    "list_topic_facts",
    "The facts of one topic, each with its certainty, status, label and " +
      "validity. Read-only. read_fact gives one fact's passages, sources " +
      "and history." +
      PAGE_NOTE +
      CLEARANCE_NOTE,
    {
      topicId: z
        .string()
        .describe("The topic's id, from list_knowledge_topics or a search."),
      limit: LIMIT,
      cursor: CURSOR,
    },
    async ({ topicId, limit, cursor }) =>
      guard(async () =>
        jsonResult(
          await client.get(`${KNOWLEDGE}/topics/${topicId}/facts`, { limit, cursor }),
        ),
      ),
  );

  server.tool(
    "read_fact",
    "One fact's whole card. Read-only. Beside the text and its certainty: " +
      "`passages` (the evidence, each with its source), `topics` and " +
      "`about` (what it is about), `formulations` (other ways it was said), " +
      "`provenance` (which run or document taught it), `events` (its " +
      "history: learned, confirmed, corrected, archived), `knownSince`, " +
      "`shelfLifeUntil`, and whether it waits on a person (`doubtful`, " +
      "`pendingCorrection`, `questionOpen`). " +
      "\n\nTo check what a run learned, look for that run in `provenance` " +
      "and `events[].runId`. A fact this token may not read answers as not " +
      "found, exactly like one that does not exist." +
      CLEARANCE_NOTE,
    { id: z.string().describe("The fact's id, from a search or a topic.") },
    async ({ id }) =>
      guard(async () => jsonResult(await client.get(`${KNOWLEDGE}/facts/${id}`))),
  );

  server.tool(
    "read_source",
    "Where facts came from: one source's card. Read-only. Its type and " +
      "score (`score`, and the `startScore` its type gave it), how often it " +
      "was right, wrong or silent (`nRight`, `nWrong`, `nSilent`), whether " +
      "its score is pinned, how many facts rest on it, and its history. A " +
      "fact's passages name their source by id." +
      CLEARANCE_NOTE,
    { id: z.string().describe("The source's id, from a fact's passages.") },
    async ({ id }) =>
      guard(async () => jsonResult(await client.get(`${KNOWLEDGE}/sources/${id}`))),
  );

  server.tool(
    "list_knowledge_tree",
    "One level of the knowledge graph's tree: the top layer, or the " +
      "children of `parent`. Read-only. Each node is a group or a topic, " +
      "with its summary, label, fact count and `hasChildren` — call again " +
      "with its id as `parent` to go one level down." +
      PAGE_NOTE +
      CLEARANCE_NOTE,
    {
      parent: z
        .string()
        .optional()
        .describe("The node to open. Omit for the top layer."),
      limit: LIMIT,
      cursor: CURSOR,
    },
    async ({ parent, limit, cursor }) =>
      guard(async () =>
        jsonResult(await client.get(`${KNOWLEDGE}/tree`, { parent, limit, cursor })),
      ),
  );

  server.tool(
    "list_related_topics",
    "The topics and groups nearest to one node of the tree, nearest first — " +
      "at most five, so the answer is always complete (`nextCursor` is " +
      "always null). Read-only. Use it to step sideways from a topic." +
      CLEARANCE_NOTE,
    { nodeId: z.string().describe("A topic or group id, from the tree or a search.") },
    async ({ nodeId }) =>
      guard(async () =>
        jsonResult(await client.get(`${KNOWLEDGE}/tree/${nodeId}/related`)),
      ),
  );

  server.tool(
    "list_archived_facts",
    "What was archived recently (the platform keeps them visible for a " +
      "while, thirty days to start with), so a second pair of eyes can look " +
      "afterwards. Read-only. Restoring one is a colleague's decision, not " +
      "something a token can do: report what you found." +
      PAGE_NOTE +
      CLEARANCE_NOTE,
    { limit: LIMIT, cursor: CURSOR },
    async ({ limit, cursor }) =>
      guard(async () =>
        jsonResult(await client.get(`${KNOWLEDGE}/archived`, { limit, cursor })),
      ),
  );
}
