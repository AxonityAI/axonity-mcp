import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Axonity's image and Windows package install this package with
 * `npm install @axonity-ai/mcp@<version>`, and the hosted connector then serves
 * the personal token of every user of every tenant. npm resolves a package's
 * dependencies on that day, from their ranges (`^1.12.0` for the SDK) — the
 * review of the hosted mode found the image on SDK 1.32.2 while every test and
 * every memory measurement ran on the repository's 1.29.0 — unless the package
 * carries them. So it does: `bundleDependencies` ships, inside the tarball, the
 * dependency tree `npm ci` installed from `package-lock.json`, the tree these
 * tests ran on. One place states the versions: the lock.
 *
 * (`npm-shrinkwrap.json` would pin the same but is not an option: npm 12 never
 * packs it — its packlist ignores `/npm-shrinkwrap.json` — and a release is
 * cut from whatever npm the maintainer runs.)
 */

const root = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const read = <T>(name: string) => JSON.parse(readFileSync(root(name), "utf8")) as T;

const pkg = read<{ dependencies: Record<string, string>; bundleDependencies?: string[] }>("package.json");
const lock = read<{
  packages: Record<string, { version?: string; dev?: boolean; devOptional?: boolean; optional?: boolean }>;
}>("package-lock.json");

/** What `npm pack` would put in the tarball (nothing is written). */
function packed(): { files: string[]; bundled: string[] } {
  const run = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root("."),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(run.status, run.stderr).toBe(0);
  // npm 11 answers with an array, npm 12 with an object keyed by package name.
  const answer = JSON.parse(run.stdout) as unknown;
  const first = (Array.isArray(answer) ? answer[0] : Object.values(answer as object)[0]) as {
    files: { path: string }[];
    bundled?: string[];
  };
  return { files: first.files.map((f) => f.path), bundled: first.bundled ?? [] };
}

describe("the published package carries the dependencies it was tested with", () => {
  const tarball = packed();

  it("every dependency is bundled: none is left to be resolved on the day of the install", () => {
    expect([...(pkg.bundleDependencies ?? [])].sort()).toEqual(Object.keys(pkg.dependencies).sort());
  });

  it("the tarball holds the SDK and zod, at the versions the lock names", () => {
    for (const name of ["@modelcontextprotocol/sdk", "zod"]) {
      const locked = lock.packages[`node_modules/${name}`]?.version;
      expect(locked, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(tarball.files, name).toContain(`node_modules/${name}/package.json`);
      // The tree on disk is what gets packed; it must be the lock's (`npm ci`).
      const onDisk = JSON.parse(readFileSync(root(`node_modules/${name}/package.json`), "utf8")) as {
        version: string;
      };
      expect(onDisk.version, `${name} on disk is not the lock's: run npm ci`).toBe(locked);
    }
  });

  it("the invariant: every runtime package the lock names is in the tarball (the whole tree, not just the top)", () => {
    const missing = Object.entries(lock.packages)
      .filter(([path, e]) => path.startsWith("node_modules/") && !e.dev && !e.devOptional)
      // A platform binary the lock lists for other systems is not installed here.
      .filter(([path]) => existsSync(root(`${path}/package.json`)))
      .map(([path]) => path)
      .filter((path) => !tarball.files.includes(`${path}/package.json`));
    expect(missing).toEqual([]);
  });

  it("nothing from the development tree rides along", () => {
    for (const dev of ["typescript", "vitest", "tsx"]) {
      expect(tarball.files.some((f) => f.startsWith(`node_modules/${dev}/`)), dev).toBe(false);
    }
  });

  it("the tarball's own code is still there", () => {
    // `dist` is built after the tests in CI, so only what exists before it.
    expect(tarball.files).toContain("package.json");
    expect(tarball.bundled.length).toBeGreaterThan(50);
  });
});
