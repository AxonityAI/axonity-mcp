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

  it("is major for a BREAKING CHANGE footer or a type with ! in the subject", () => {
    expect(bumpForMessage("feat!: weg met oude namen")).toBe("major");
    expect(bumpForMessage("fix(api)!: ander antwoord")).toBe("major");
    expect(bumpForMessage("feat: x\n\nBREAKING CHANGE: tools hernoemd")).toBe("major");
    expect(bumpForMessage("feat: x\n\nBREAKING-CHANGE: tools hernoemd")).toBe("major");
  });

  it("is major for a type with ! listed in a squash-merge body", () => {
    expect(bumpForMessage("fix: iets (#9)\n\n* feat!: oude namen weg (#8)")).toBe("major");
  });

  it("does not take BREAKING in prose for a breaking change", () => {
    expect(bumpForMessage("fix: niet meer breaking voor oude clients")).toBe("patch");
    expect(bumpForMessage("docs: x\n\nmajor bij BREAKING of !")).toBe("patch");
    expect(bumpForMessage("docs: x\n\nBREAKING CHANGE staat hier niet als voettekst")).toBe("patch");
    expect(bumpForMessage("fix: x\n\nzie BREAKING CHANGE: in de spec")).toBe("patch");
  });

  it("does not take a ! type in plain body prose for a breaking change", () => {
    expect(bumpForMessage("fix: x\n\nfix!: als voorbeeld in een zin")).toBe("patch");
  });

  // De squash-body van #134 maakte van de eerste automatische release 1.0.0.
  it("is patch for the real squash message of #134", () => {
    const message = [
      "ci: publiceer automatisch naar npm bij elke merge op main (#134)",
      "",
      "release.yml draait na de CI, bouwt/test/pakt in, kiest de versie met",
      "scripts/next-version.mjs (patch, minor bij feat, major bij BREAKING of !),",
      "pusht versiecommit + tag atomair als github-actions[bot] en publiceert via",
      "npm Trusted Publishing (OIDC, geen token). publish.yml en scripts/release.sh",
      "zijn weg: één publicatiepad.",
      "",
      "Co-authored-by: Claude Opus 5.5 <noreply@anthropic.com>",
    ].join("\n");
    expect(bumpForMessage(message)).toBe("patch");
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
