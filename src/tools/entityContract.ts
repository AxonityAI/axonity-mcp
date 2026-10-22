/**
 * The platform's create contract per entity kind, read live (axonity-mcp#95,
 * axonity-flow#2103, merged as axonity-flow#2104).
 *
 * The rules for creating a tool, a connector, an agent, a table — required
 * fields, allowed values, what a publication checks — were kept as prose in
 * this connector (`conventions.ts`, the tool descriptions). A rule added on the
 * platform then stayed missing here: since axonity-flow#1997 a connector must
 * declare `implementation.effect` before it can be published, and nothing in
 * this connector said so. An agent built a connector by the guide and the
 * human's approval refused it.
 *
 * For workflows that problem is already solved: `get_workflow_authoring_spec`
 * reads `GET /workflows/operations`, generated from the registry that enforces
 * it. This is the same move for every other kind:
 *
 *   GET /api/v1/authoring/entity-contracts?kinds=tool,agent
 *   → { kinds: string[], contracts: { <kind>: {...} }, rulesVersion: string }
 *
 * `kinds` is ONE comma-separated query parameter, filtered by the platform; an
 * unknown kind is the platform's 422, which names the known ones — passed on as
 * the error it is, not re-judged here. `rulesVersion` covers the whole
 * catalogue whatever `kinds` was. Authenticated like every route; a read-only
 * service token is enough. The answer is passed through unchanged.
 *
 * FEATURE-DETECTED, NEVER SUBSTITUTED. A backend older than the route answers
 * 404 (or 405). Then the tool says so in words — it does not fall back to the
 * hand-kept notes in `axonity_conventions`, because those notes are exactly
 * what drifted. Any other failure is reported as the error it is.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { AxonityApiError } from "../errors.js";
import { errorResult, jsonResult } from "./result.js";

/** Where this deploy serves its per-kind create contracts (axonity-flow#2103). */
export const ENTITY_CONTRACT_ROUTE = "/api/v1/authoring/entity-contracts";

/** Said when the deploy does not serve the route. Not a fallback. */
export const ENTITY_CONTRACT_UNAVAILABLE =
  "## Entity create contracts — NOT AVAILABLE on this deploy\n\n" +
  `This backend does not serve \`GET ${ENTITY_CONTRACT_ROUTE}\` ` +
  "(axonity-flow#2103): it is older than the live contract. This connector " +
  "carries no copy of it. The per-entity notes in `axonity_conventions` are " +
  "kept by hand and may be behind the platform — they are guidance, not the " +
  "contract. Until this deploy serves it, the authority is the platform's own " +
  "answer: the refusal on save, `validate_workflow`, and the readiness of " +
  "`request_publish_*` / `get_publish_release`. Tell your human which " +
  "environment this token points at if you need the contract.";

/** What the tool answers: the live contract, the not-served notice, or the error. */
export async function readEntityContract(client: AxonityClient, kinds?: string[]) {
  const wanted = (kinds ?? []).map((k) => k.trim()).filter((k) => k !== "");
  try {
    return jsonResult(
      wanted.length === 0
        ? await client.get(ENTITY_CONTRACT_ROUTE)
        : await client.get(ENTITY_CONTRACT_ROUTE, { kinds: wanted.join(",") }),
    );
  } catch (err) {
    if (err instanceof AxonityApiError && (err.status === 404 || err.status === 405)) {
      return {
        content: [{ type: "text" as const, text: ENTITY_CONTRACT_UNAVAILABLE }],
      };
    }
    return errorResult(err);
  }
}

export function registerEntityContractTools(server: McpServer, client: AxonityClient): void {
  server.tool(
    "get_entity_authoring_contract",
    "Read this deploy's CREATE CONTRACT per entity kind from the platform " +
      "itself — tools (each type's `implementation`, connectors included), " +
      "agents, personas, knowledge, schemas, tables, toolboxes, secrets and " +
      "starts. Answers `{ kinds, contracts, rulesVersion }`: per kind the " +
      "`create` and `update` fields (name, required, type, allowed values, " +
      "shape, and `refused` with where the value is authored instead), and " +
      "`publish.rules` — what stops it from going live, each with a `code` " +
      "and the platform's own message (e.g. a connector without " +
      "`implementation.effect`). Generated from the schemas and checks that " +
      "enforce it. `rulesVersion` covers the whole catalogue: while it is " +
      "unchanged there is nothing to re-read. " +
      "\n\nREAD IT BEFORE YOU CREATE an entity whose rules you have not checked " +
      "this session. Where it disagrees with `axonity_conventions` or a tool " +
      "description, it is right and they are behind. The workflow document's " +
      "own vocabulary is in `get_workflow_authoring_spec`. " +
      "\n\nThe whole catalogue is large; pass `kinds` for the ones you need. " +
      "`kinds` in the answer lists every kind this deploy serves. On a backend " +
      "that does not serve the route yet, the tool SAYS SO instead of " +
      "returning a copy.",
    {
      kinds: z
        .array(z.string())
        .optional()
        .describe(
          'Kinds to return, e.g. ["tool", "agent"]. Omit for every kind. An ' +
            "unknown kind is refused by the platform with the list of known ones.",
        ),
    },
    async ({ kinds }) => readEntityContract(client, kinds),
  );
}
