/**
 * axonity-mcp#71 — the guide says how a validator is bound.
 *
 * `axonity_conventions` mentioned validator specs in exactly one place: the
 * snake_case exception under Field shape. True, and useless to anyone about to
 * write one. It said nothing about the two ways a spec names its check, and
 * nothing at all about how a validator TOOL receives what it judges.
 *
 * axonity-flow#1514 then made that shape fixed — every authored validator is
 * called `run(data, slots, binding)`, so a screen can offer its inputs and a
 * served spec can describe them — and axonity-flow#1515 wrote the contract into
 * the OpenAPI description of `schemaBody`. That description is the SOURCE. It
 * is also not reachable from here: `create_output_schema` takes an untyped
 * `fields` bag, so an agent working through this connector never sees it. The
 * guide is the only surface that can tell it, which is why the text lives here
 * and this file pins the facts it cannot lose.
 *
 * Names, not sentences. Rewriting the prose is fine; dropping a name is not.
 */
import { describe, expect, it } from "vitest";

import { registerConventions } from "../src/tools/conventions.js";

interface ToolResult {
  content: { text: string }[];
}

async function guide(): Promise<string> {
  const handlers = new Map<string, () => Promise<ToolResult>>();
  registerConventions({
    tool: (name: string, _d: string, _s: unknown, h: () => Promise<ToolResult>) =>
      handlers.set(name, h),
  } as never);
  return (await handlers.get("axonity_conventions")!()).content[0].text;
}

describe("the authoring guide carries the validator contract", () => {
  it("names both ways a spec can name its check", async () => {
    const text = await guide();
    for (const needle of [
      // A shipped predicate, bound by target + args…
      "validators.min_length",
      "`target`",
      "`args`",
      // …or a tool in the tenant's library. An author has to know both exist.
      "validator TOOL in this tenant's library",
    ]) {
      expect(text, needle).toContain(needle);
    }
  });

  it("spells out the standard call, which is the whole point of it", async () => {
    // A validator whose parameters differ per tool cannot be offered by a
    // screen or described by a served spec. The fix is worth nothing if the
    // one surface an agent reads does not say what the signature is.
    const text = await guide();
    expect(text).toContain("run(data, slots, binding)");
    for (const name of ["`data`", "`slots`", "`binding`"]) {
      expect(text, name).toContain(name);
    }
  });

  it("names the two keys that steer it, and that they are checked on save", async () => {
    const text = await guide();
    expect(text).toContain("`field`");
    expect(text).toContain("WHEN YOU SAVE");
    // The reason, which is the half an author cannot guess: both fail SILENTLY
    // at run time, so a typo would gate on values that were never resolved.
    expect(text).toMatch(/never looked up/i);
  });

  it("says where field and slots are accepted, and where they are a 422", async () => {
    // The trap this section exists to close: an author reads the standard call,
    // writes `field` into an agent's permissions, and meets a strict body.
    const text = await guide();
    expect(text).toMatch(/permissions\.outputValidators`? is a STRICT body/);
    expect(text).toContain("422");
  });

  it("keeps the older explicit binding documented", async () => {
    // It did not go away. A tool backed by a shipped predicate still needs it,
    // and an author meeting one has to recognise it.
    const text = await guide();
    expect(text).toContain("`inputs`");
    expect(text).toContain("units[].key");
    expect(text).toMatch(/does NOT\s+get the standard call/);
  });

  it("names the error template and its placeholder", async () => {
    const text = await guide();
    expect(text).toContain("error_message");
    expect(text).toContain("{value}");
  });

  it("no longer says a validator tool only wraps a builtin", async () => {
    // What it used to say: "a constrained kind that wraps a builtin;
    // `implementation` names the builtin registry key plus its args." An agent
    // reading that concludes it cannot write one, which is the opposite of
    // true — authored Python is an accepted implementation, and it is the
    // shape that gets the standard call.
    const text = await guide();
    expect(text).not.toContain("a constrained kind that wraps a builtin");
    expect(text).toContain('{"builtin": "validators.<name>"}');
    expect(text).toMatch(/returns a VERDICT/);
  });

  it("does not enumerate the shipped predicates", async () => {
    // #32/#44's rule. No route serves that registry, so a list here is a claim
    // nothing can check — and `list_tools` already answers it against the
    // tenant. One name to state behaviour stays; a catalogue does not.
    const text = await guide();
    const shipped = text.match(/validators\.[a-z_]+/g) ?? [];
    expect(new Set(shipped).size, shipped.join(", ")).toBeLessThanOrEqual(1);
  });
});
