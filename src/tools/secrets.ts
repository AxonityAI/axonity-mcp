/**
 * Reading the tenant's secret catalogue.
 *
 * A connector points at a secret by id (`authConfig.secretId`), and the
 * credential guard lets that id through — it is a locator, not a credential.
 * Until now nothing let an agent FIND the id: the whole `/secrets` family was
 * deny-listed, so wiring a connector ended in "ask a human to copy the id out
 * of the UI". That is the gap these two tools close, and all they close.
 *
 * Reading is safe by construction on the backend: no secrets route ever returns
 * a decrypted value, and both GETs are open to any authenticated caller,
 * read-only tokens included (`backend/src/routes/secrets.py`). WRITES stay out
 * of this connector — the backend refuses them from a service token, and the
 * value-less half of that story is axonity-mcp#39 / axonity-flow#910.
 *
 * The one thing that is not safe by construction is `metadata`. It is stored
 * unencrypted, returned verbatim, readable by every user in the tenant
 * (axonity-flow#908), and after axonity-flow#890 an operator can put arbitrary
 * handshake headers in it — an `Authorization: Basic …` is the obvious next
 * use. So it is redacted on the way out: the shape of a handshake is what an
 * agent needs, the credential inside it is not.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { redactCredentials } from "./credentials.js";
import { guard, jsonResult } from "./result.js";

/**
 * Redact credential-shaped entries out of a secret's `metadata`, and say so.
 *
 * Exported for testing. Anything that is not an object with a `metadata` key
 * passes through untouched — the backend owns this response shape, and a
 * connector that silently reshapes it is the drift this repo keeps closing.
 */
export function redactSecretMetadata(response: unknown): unknown {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    return response;
  }

  const source = response as Record<string, unknown>;
  if (source.metadata === undefined || source.metadata === null) return response;

  const { value, redactedPaths } = redactCredentials(source.metadata);
  if (redactedPaths.length === 0) return response;

  return {
    ...source,
    metadata: value,
    // An omission the reader cannot see is worse than the omission itself.
    metadataRedacted: {
      paths: redactedPaths,
      why:
        "A secret's metadata is stored unencrypted and is readable by every user " +
        "in this tenant, so anything credential-shaped in it is withheld from " +
        "the agent. Read these fields in Axonity → Settings → Secrets.",
    },
  };
}

export function registerSecretTools(server: McpServer, client: AxonityClient): void {
  server.tool(
    "list_secrets",
    "List the tenant's secrets (id, name, description, authType, version, " +
      "updatedAt). This is the catalogue of what EXISTS — no route in Axonity " +
      "ever returns a secret's value, and this connector cannot create, change " +
      "or delete one. Use it to find the id for a connector's " +
      "`authConfig.secretId` instead of asking a human to copy one out of the " +
      "UI. " +
      "\n\nEach row also says what the secret is for and whether anything " +
      "depends on it: `holds` (the NAMES of the fields a secret of this kind " +
      "holds — never a value; empty for a kind that holds none), `usedBy` and " +
      "`usedByCount` (the tools, toolboxes, data sources and module settings " +
      "that use it: a tool's working or published credential, a box's shared " +
      "one, a source's connection, a mailbox) and `lastUsedAt` (when a call " +
      "last resolved it; null when never). " +
      "\n\nA secret that something uses can still be deleted — a person " +
      "deletes it in Axonity, after a confirmation, and whatever referenced " +
      "it fails at execution time; this connector has no tool for it. Check " +
      "read_secret_used_by before you rebind a connector away from a secret.",
    {},
    async () => guard(async () => jsonResult(await client.get("/api/v1/secrets"))),
  );

  server.tool(
    "read_secret",
    "Read one secret's configuration: `authType`, `valueKeys` (WHICH keys are " +
      "filled — never their values), `metadata` (connection config, e.g. a " +
      "session_cookie handshake) and `version`. Check `valueKeys` before you wire " +
      "a connector to a secret: an empty list means a human has not filled it in " +
      "yet, and the connector will fail at run time, not at author time. " +
      "Credential-shaped entries in `metadata` are withheld — see " +
      "`metadataRedacted` in the response for which and why.",
    { secretId: z.string().describe("The secret's id (from list_secrets).") },
    async ({ secretId }) =>
      guard(async () =>
        jsonResult(
          redactSecretMetadata(await client.get(`/api/v1/secrets/${secretId}`)),
        ),
      ),
  );

  server.tool(
    "read_secret_used_by",
    "What uses one secret: { usedBy: [{ kind, id, name }] }, `kind` being " +
      "`tool` (its working or PUBLISHED credential names it), `toolbox` (its " +
      "shared credential), `data_source` (it connects with it) or " +
      "`module_setting` (a mailbox). Empty means nothing does and it can be " +
      "deleted. A module setting only an administrator may change is named to " +
      "those who may see it, and shown as `a module setting` to anyone else. " +
      "Read-only: it answers names, never a value.",
    { secretId: z.string().describe("The secret's id (from list_secrets).") },
    async ({ secretId }) =>
      guard(async () => jsonResult(await client.get(`/api/v1/secrets/${secretId}/used-by`))),
  );
}
