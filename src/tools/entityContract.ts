/**
 * The platform's create contract per entity, read live (axonity-mcp#95,
 * axonity-flow#2103).
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
 * it. This is the same move for every other entity: `GET
 * /api/v1/authoring/entity-contracts`, generated from the schemas and checks
 * that enforce it, with a `rulesVersion`.
 *
 * FEATURE-DETECTED, NEVER SUBSTITUTED. A backend older than #2103 answers 404
 * (or 405). Then the tool says so in words — it does not fall back to the
 * hand-kept notes in `axonity_conventions`, because those notes are exactly
 * what drifted. Any other failure (auth, network) is reported as the error it
 * is: that is not "this deploy has no contract", and saying so would be false.
 *
 * The response shape is the platform's. Two forms are read: `markdown` (as the
 * placement and semantic-knowledge routes serve) is shown as text under its
 * version line; anything else is passed through as JSON, optionally narrowed to
 * the entity types asked for when it carries an `entities` map or list.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { AxonityApiError } from "../errors.js";
import { errorResult, jsonResult } from "./result.js";

/** Where this deploy serves its per-entity create contracts (axonity-flow#2103). */
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

/** One entry of an `entities` list, by whichever key names its type. */
function entryType(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as Record<string, unknown>;
  for (const key of ["entityType", "entity", "type", "kind", "name"]) {
    if (typeof e[key] === "string") return e[key] as string;
  }
  return undefined;
}

/**
 * Narrow a JSON contract to the entity types asked for. Unknown names come
 * back under `unknownEntityTypes` instead of failing; a shape this does not
 * recognise is returned whole, with a note, rather than guessed at.
 */
export function projectContract(
  response: unknown,
  entityTypes: string[] | undefined,
): unknown {
  if (!entityTypes || entityTypes.length === 0) return response;
  if (!response || typeof response !== "object") return response;
  const r = response as Record<string, unknown>;
  const entities = r.entities;
  const wanted = new Set(entityTypes);

  if (Array.isArray(entities)) {
    const kept = entities.filter((e) => wanted.has(entryType(e) ?? ""));
    const found = new Set(kept.map((e) => entryType(e)));
    return {
      ...r,
      entities: kept,
      unknownEntityTypes: entityTypes.filter((t) => !found.has(t)),
    };
  }
  if (entities && typeof entities === "object") {
    const map = entities as Record<string, unknown>;
    return {
      ...r,
      entities: Object.fromEntries(entityTypes.filter((t) => t in map).map((t) => [t, map[t]])),
      unknownEntityTypes: entityTypes.filter((t) => !(t in map)),
    };
  }
  return {
    ...r,
    note:
      "This deploy's contract has no `entities` map or list to narrow, so it " +
      "is returned whole.",
  };
}

/** What the tool answers: the live contract, the not-served notice, or the error. */
export async function readEntityContract(
  client: AxonityClient,
  entityTypes?: string[],
) {
  let response: unknown;
  try {
    response = await client.get(ENTITY_CONTRACT_ROUTE);
  } catch (err) {
    if (err instanceof AxonityApiError && (err.status === 404 || err.status === 405)) {
      return {
        content: [{ type: "text" as const, text: ENTITY_CONTRACT_UNAVAILABLE }],
      };
    }
    return errorResult(err);
  }

  const r = (response ?? {}) as { markdown?: unknown; rulesVersion?: unknown };
  if (typeof r.markdown === "string" && r.markdown.trim() !== "") {
    const version = typeof r.rulesVersion === "string" ? r.rulesVersion : "unknown";
    return {
      content: [
        {
          type: "text" as const,
          text:
            "The entity create contracts below are served live by this deploy " +
            `(rulesVersion \`${version}\`).\n\n${r.markdown}`,
        },
      ],
    };
  }
  return jsonResult(projectContract(response, entityTypes));
}

export function registerEntityContractTools(server: McpServer, client: AxonityClient): void {
  server.tool(
    "get_entity_authoring_contract",
    "Read this deploy's CREATE CONTRACT per entity — tool, connector, agent, " +
      "data table, knowledge, output schema … — from the platform itself: the " +
      "required fields, the allowed values, and the rules a PUBLICATION checks " +
      "(e.g. a connector's `implementation.effect`). Generated from the code " +
      "that enforces them, with a `rulesVersion`: while it is unchanged there " +
      "is nothing to re-read. " +
      "\n\nREAD IT BEFORE YOU CREATE an entity whose rules you have not checked " +
      "this session. Where it disagrees with `axonity_conventions` or a tool " +
      "description, it is right and they are behind. The workflow document's " +
      "own vocabulary is in `get_workflow_authoring_spec`, not here. " +
      "\n\nOn a backend that does not serve it yet, it SAYS SO instead of " +
      "returning a copy: then the platform's refusal on save and the publish " +
      "readiness are the authority.",
    {
      entityTypes: z
        .array(z.string())
        .optional()
        .describe(
          'Entity types to return, e.g. ["connector", "agent"]. Omit for all. ' +
            "A name this deploy does not have comes back under " +
            "`unknownEntityTypes` rather than as an error.",
        ),
    },
    async ({ entityTypes }) => readEntityContract(client, entityTypes),
  );
}
