import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { isVersionRequest } from "../src/index.js";

/**
 * The automatic releases 1.0.0 to 1.1.0 shipped `dist/index.js` without the
 * execute bit (0.35.0, packed on a maintainer's machine, still had it). `npx`
 * runs the bin straight through its symlink, so every Axonity MCP failed with
 * "Permission denied" and Claude Code showed only "Connection closed".
 *
 * Three guards: the build itself makes the bin executable (postbuild), the
 * packed tarball is checked and started once before anything is published
 * (scripts/smoke-packed-bin.mjs, in ci.yml and release.yml), and these tests
 * prove both scripts do what they say.
 */

const root = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const pkg = JSON.parse(readFileSync(root("package.json"), "utf8")) as {
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
};

const scratch = mkdtempSync(join(tmpdir(), "axonity-bin-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const posix = process.platform !== "win32";

/** A tiny package whose bin answers `--version`, like ours. */
function fixturePackage(name: string, opts: { mode: number; shebang: boolean }): string {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `fixture-${name}`, version: "9.9.9", bin: { [name]: "dist/index.js" }, files: ["dist"] }),
  );
  const body = 'if (process.argv[2] === "--version") console.log("9.9.9");\n';
  writeFileSync(join(dir, "dist", "index.js"), (opts.shebang ? "#!/usr/bin/env node\n" : "") + body);
  chmodSync(join(dir, "dist", "index.js"), opts.mode);
  return dir;
}

function pack(dir: string): string {
  const run = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], {
    cwd: dir,
    encoding: "utf8",
    shell: !posix,
  });
  expect(run.status, run.stderr).toBe(0);
  const answer = JSON.parse(run.stdout) as unknown;
  const first = (Array.isArray(answer) ? answer[0] : Object.values(answer as object)[0]) as { filename: string };
  return join(scratch, first.filename);
}

const node = (script: string, args: string[]) =>
  spawnSync(process.execPath, [root(script), ...args], { encoding: "utf8", timeout: 60_000 });

describe("the bin is declared so npx can start it", () => {
  it("every bin points at dist/index.js, which the package ships", () => {
    expect(Object.values(pkg.bin).length).toBeGreaterThan(0);
    for (const target of Object.values(pkg.bin)) expect(target).toBe("dist/index.js");
    expect(pkg.files).toContain("dist");
  });

  it("the entry point starts with the node shebang", () => {
    expect(readFileSync(root("src/index.ts"), "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  it("answers --version with the package version, and nothing else counts as one", () => {
    expect(isVersionRequest(["--version"])).toBe(true);
    expect(isVersionRequest([])).toBe(false);
    expect(isVersionRequest(["--version", "x"])).toBe(false);
    expect(isVersionRequest(["--help"])).toBe(false);
  });
});

describe("the build makes the bin executable", () => {
  it("postbuild runs scripts/make-bin-executable.mjs", () => {
    expect(pkg.scripts.postbuild).toBe("node scripts/make-bin-executable.mjs");
  });

  it.runIf(posix)("sets the execute bit on every bin target", () => {
    const dir = fixturePackage("chmod", { mode: 0o644, shebang: true });
    const run = node("scripts/make-bin-executable.mjs", [dir]);
    expect(run.status, run.stderr).toBe(0);
    expect(statSync(join(dir, "dist", "index.js")).mode & 0o111).toBe(0o111);
  });

  it("refuses a bin without the shebang", () => {
    const dir = fixturePackage("noshebang", { mode: 0o644, shebang: false });
    const run = node("scripts/make-bin-executable.mjs", [dir]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/#!\/usr\/bin\/env node/);
  });
});

describe("the smoke on the packed tarball", () => {
  it.runIf(posix)("passes a tarball whose bin is executable and starts", () => {
    const tarball = pack(fixturePackage("good", { mode: 0o755, shebang: true }));
    const run = node("scripts/smoke-packed-bin.mjs", [tarball]);
    expect(run.status, run.stderr + run.stdout).toBe(0);
  });

  it.runIf(posix)("fails a tarball whose bin lacks the execute bit, as 1.0.0 did", () => {
    const tarball = pack(fixturePackage("noexec", { mode: 0o644, shebang: true }));
    const run = node("scripts/smoke-packed-bin.mjs", [tarball]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/not executable/);
  });

  it("fails a tarball whose bin has no shebang", () => {
    const tarball = pack(fixturePackage("bare", { mode: 0o755, shebang: false }));
    const run = node("scripts/smoke-packed-bin.mjs", [tarball]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/shebang/);
  });
});
