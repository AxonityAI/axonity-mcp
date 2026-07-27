import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { assertNoExtraArguments, isEntryPoint } from "../src/index.js";

// Real directory on disk so realpathSync has something to resolve. On macOS the
// tmp dir is itself behind a symlink (/var → /private/var), which is one of the
// cases that used to break the guard.
const dir = mkdtempSync(join(tmpdir(), "axonity-entry-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fixture(name: string): string {
  const file = join(dir, name);
  writeFileSync(file, "");
  return file;
}

/** What Node would report as `import.meta.url` for a file: realpath-resolved. */
function moduleUrlOf(file: string): string {
  return pathToFileURL(realpathSync(file)).href;
}

describe("isEntryPoint", () => {
  it("matches when the module is invoked by its real path", () => {
    const file = fixture("index.js");
    expect(isEntryPoint(moduleUrlOf(file), file)).toBe(true);
  });

  it("matches when invoked through a symlink, as npx/node_modules/.bin does", () => {
    const file = fixture("real.js");
    const link = join(dir, "linked.js");
    symlinkSync(file, link);
    // The module URL is always the resolved target; argv[1] is the symlink.
    expect(isEntryPoint(moduleUrlOf(file), link)).toBe(true);
  });

  it("matches when the path contains characters that need percent-encoding", () => {
    const file = fixture("a dir entry.js");
    expect(isEntryPoint(moduleUrlOf(file), file)).toBe(true);
    // Guards the original bug directly: the naive string form differs.
    expect(moduleUrlOf(file)).not.toBe(`file://${file}`);
  });

  it("does not match a different module", () => {
    const file = fixture("one.js");
    const other = fixture("two.js");
    expect(isEntryPoint(moduleUrlOf(file), other)).toBe(false);
  });

  it("does not match when there is no argv[1] or it is not a real path", () => {
    const file = fixture("solo.js");
    const url = moduleUrlOf(file);
    expect(isEntryPoint(url, undefined)).toBe(false);
    expect(isEntryPoint(url, join(dir, "does-not-exist.js"))).toBe(false);
  });

  describe("assertNoExtraArguments", () => {
    it("passes when no arguments are provided", () => {
      expect(() => assertNoExtraArguments([])).not.toThrow();
    });

    it("throws with a clear message when arguments are provided", () => {
      expect(() => assertNoExtraArguments(["--help"]))
        .toThrowError("This MCP server does not accept command-line arguments.");
      expect(() => assertNoExtraArguments(["foo", "bar"]))
        .toThrow(/Received arguments: foo bar/);
    });
  });

  /**
   * `npx <pkg>` derives the command to run from the package NAME, not from the
   * bin map: for `@axonity-ai/mcp` it looks for a bin called `mcp`. When no bin
   * matches, npx exits 0 with no output — so the documented install command
   * (`npx -y @axonity-ai/mcp`) started nothing, and Claude Code reported only
   * `-32000: Connection closed` with an empty log. Shipping a bin under the
   * name npx derives is what makes that command work at all.
   */
  describe("bin map is npx-resolvable", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { name: string; bin: Record<string, string> };

    it("exposes a bin under the name npx derives from the package name", () => {
      const derived = pkg.name.split("/").pop()!;
      expect(
        Object.keys(pkg.bin),
        `npx runs "${derived}" for package "${pkg.name}"; bin has ${JSON.stringify(Object.keys(pkg.bin))}`,
      ).toContain(derived);
    });

    it("every bin points at the built entry point", () => {
      for (const target of Object.values(pkg.bin)) {
        expect(target).toBe("dist/index.js");
      }
    });
  });
});
