/**
 * A client stub for tests that read the `axonity_conventions` guide.
 *
 * The guide fetches this deploy's prompt-placement rules on every call
 * (`GET /api/v1/authoring/prompt-placement`), so registering it needs a client.
 * Tests that only assert on the CONVENTIONS prose use this; the placement
 * behaviour itself is pinned in `conventionsPlacement.test.ts`.
 */

import type { AxonityClient } from "../src/client.js";

/** The shape the platform serves: eight numbered sections, the 8th on size. */
export const PLACEMENT_RESPONSE = {
  markdown: [
    "# Prompt element placement — the rules",
    "",
    "## 1. Persona",
    "Who the agent is.",
    "## 2. Policy",
    "A guardrail that holds everywhere.",
    "## 3. Skill",
    "A capability.",
    "## 4. Reference doc",
    "Background knowledge.",
    "## 5. Step activities",
    "What this step does.",
    "## 6. System vs user",
    "Channels.",
    "## 7. Anti-patterns",
    "Step text in a persona.",
    "## 8. Size",
    "Budgets per element.",
  ].join("\n"),
  rulesVersion: "pp-0123abcd",
};

/** A client whose GET answers with the placement rules. */
export function placementClient(response: unknown = PLACEMENT_RESPONSE): AxonityClient {
  return { get: async () => response } as unknown as AxonityClient;
}
