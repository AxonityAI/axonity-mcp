import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script without type declarations
import { bumpFor, bumpForMessage, nextVersion } from "../scripts/next-version.mjs";

describe("bumpForMessage", () => {
  it("is patch for fix, docs and anything without a prefix", () => {
    expect(bumpForMessage("fix: paden dicht (#131)")).toBe("patch");
    expect(bumpForMessage("docs(queries): tooltekst noemt `reads` (#133)")).toBe("patch");
    expect(bumpForMessage("Update README")).toBe("patch");
  });

  it("is minor for a feat prefix, with or without scope", () => {
    expect(bumpForMessage("feat: nieuwe tool")).toBe("minor");
    expect(bumpForMessage("feat(apps): Flow-App MCP tools (#127)")).toBe("minor");
  });

  it("counts a feat listed in a squash-merge body", () => {
    expect(bumpForMessage("fix: iets (#9)\n\n* feat(mcp): nieuwe ingang (#8)\n\nbody")).toBe("minor");
  });

  it("does not take 'feat' somewhere in prose for a prefix", () => {
    expect(bumpForMessage("fix: de feat: tekst in een zin")).toBe("patch");
    expect(bumpForMessage("featuring: geen type")).toBe("patch");
    expect(bumpForMessage("fix: x\n\nwe deden feat werk")).toBe("patch");
  });

  it("is major for BREAKING or a type with !", () => {
    expect(bumpForMessage("feat!: weg met oude namen")).toBe("major");
    expect(bumpForMessage("fix(api)!: ander antwoord")).toBe("major");
    expect(bumpForMessage("feat: x\n\nBREAKING CHANGE: tools hernoemd")).toBe("major");
  });

  it("only takes BREAKING in capitals", () => {
    expect(bumpForMessage("fix: niet meer breaking voor oude clients")).toBe("patch");
  });
});

describe("bumpFor", () => {
  it("is none without commits", () => {
    expect(bumpFor([])).toBe("none");
  });

  it("takes the highest bump over all commits", () => {
    expect(bumpFor(["docs: a", "fix: b"])).toBe("patch");
    expect(bumpFor(["docs: a", "feat: b", "fix: c"])).toBe("minor");
    expect(bumpFor(["feat: a", "fix!: b"])).toBe("major");
  });
});

describe("nextVersion", () => {
  it("bumps each part and resets the lower ones", () => {
    expect(nextVersion("0.36.2", "patch")).toBe("0.36.3");
    expect(nextVersion("0.36.2", "minor")).toBe("0.37.0");
    expect(nextVersion("0.36.2", "major")).toBe("1.0.0");
    expect(nextVersion("0.36.2", "none")).toBeNull();
  });

  it("refuses a version it cannot read", () => {
    expect(() => nextVersion("0.36.0-beta.1", "patch")).toThrow();
  });
});
