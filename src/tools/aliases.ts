/**
 * The old names of what Flow renamed, kept for one release.
 *
 * Flow renamed a "flow" to a "method" (agent-first R6: the routes, the kind a
 * publish request names, the keys of a document). This connector follows — the
 * tools take the new names and call the new routes — and a caller written
 * before still works: each old tool name stays registered beside the new one,
 * says on its first words that it is the old name, and makes the SAME call on
 * the SAME (new) route. Nothing here talks to an old route: the backend still
 * rewrites old addresses for an older connector, but this one does not lean on
 * that.
 *
 * Removal is one deletion: every use of this module sits behind the `former…`
 * field of the definition that names it, and `test/methods.test.ts` holds the
 * whole list of old names. The notice says "the next release" because the plan
 * for the rename (`MCP-UPDATE.md` §1.3) is one version of overlap.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

/** Where an old name comes from: the current name, with the old word put back. */
export function formerName(name: string, current: string, former: string): string {
  return name.split(current).join(former);
}

/** The notice an old tool name carries in front of its description. */
export function deprecationNotice(current: string): string {
  return (
    `DEPRECATED — the old name of \`${current}\`, which does exactly this. ` +
    `It still works in this release and is removed in the next release: ` +
    `call \`${current}\` instead. `
  );
}

export interface FormerTool {
  /** The old tool name. */
  name: string;
  /**
   * The argument shape the old tool takes, when an argument was renamed too
   * (`flowId` → `methodId`). Omit it when the arguments did not change.
   */
  shape?: z.ZodRawShape;
  /** Turns the old tool's arguments into the current ones. Needed with `shape`. */
  adapt?: (args: Record<string, unknown>) => Record<string, unknown>;
}

type Handler = (args: never) => Promise<unknown>;

/**
 * Register a tool, and its old name beside it when it had one.
 *
 * The old registration shares the handler: an alias is the same code under a
 * second name, never a second implementation that could drift from the first.
 */
export function defineTool(
  server: McpServer,
  name: string,
  description: string,
  shape: z.ZodRawShape,
  handler: Handler,
  former?: FormerTool,
): void {
  server.tool(name, description, shape, handler as never);
  if (!former) return;
  const adapt = former.adapt;
  const formerHandler: Handler = adapt
    ? ((async (args: Record<string, unknown>) =>
        (handler as unknown as (a: Record<string, unknown>) => Promise<unknown>)(
          adapt(args),
        )) as unknown as Handler)
    : handler;
  server.tool(
    former.name,
    deprecationNotice(name) + description,
    former.shape ?? shape,
    formerHandler as never,
  );
}

/**
 * Read the fields an agent wrote the old way as the current ones
 * (`flowSteps` → `methodSteps`).
 *
 * Both spellings in one call is refused, not resolved: picking one would drop
 * the other without a word, and an agent that wrote both meant something by it.
 */
export function currentSpelling(
  fields: Record<string, unknown>,
  formerToCurrent: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!formerToCurrent) return fields;
  const out: Record<string, unknown> = { ...fields };
  for (const [old, current] of Object.entries(formerToCurrent)) {
    if (!(old in out)) continue;
    if (current in out) {
      throw new Error(
        `\`${old}\` and \`${current}\` are the same field — \`${old}\` is the old ` +
          `spelling. Send \`${current}\` only.`,
      );
    }
    out[current] = out[old];
    delete out[old];
  }
  return out;
}
