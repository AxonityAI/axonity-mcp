/**
 * What the server says about itself on connect (`initialize.instructions`).
 *
 * Claude Code loads these at the start of every session, up to 4,096
 * characters, the important part first. The text is the variant measured in
 * round 0 of the starter kit (3 of 3 fresh sessions in an empty folder called
 * the starter first); change it only with a new measurement.
 */
export const SERVER_INSTRUCTIONS =
  "To create or change a Flow App, call get_flow_app_starter FIRST, before writing any file or " +
  "giving advice. It returns the starter package and the current contract; never write Flow App " +
  "files (manifest, AGENTS.md, app code) from memory, because the contract changes per Flow " +
  "version. Follow the steps the tool returns.";
