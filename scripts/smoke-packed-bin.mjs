#!/usr/bin/env node
/**
 * Smoke test on the tarball that would be published: unpack it, check that
 * every bin is executable and starts with the node shebang, and start it once
 * (`<bin> --version`, run directly, the way npx runs it through its symlink).
 *
 * Runs in ci.yml on every pull request and in release.yml before the version
 * commit, the tag and `npm publish`: a failure here means nothing ships.
 * Releases 1.0.0 to 1.1.0 went out with a bin that was not executable, and
 * every Axonity MCP failed to start ("Connection closed").
 *
 * Usage:
 *   node scripts/smoke-packed-bin.mjs              pack the current build (run `npm run build` first)
 *   node scripts/smoke-packed-bin.mjs <file.tgz>   check that tarball
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SHEBANG = "#!/usr/bin/env node";
const posix = process.platform !== "win32";
const work = mkdtempSync(join(tmpdir(), "axonity-smoke-"));
const problems = [];

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

function fail(message) {
  console.error(message);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

let tarball = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!tarball) {
  // --ignore-scripts: pack exactly the build that is on disk.
  const packed = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], {
    shell: !posix,
  });
  if (packed.status !== 0) fail(`npm pack failed:\n${packed.stderr}`);
  const answer = JSON.parse(packed.stdout);
  // npm 11 answers with an array, npm 12 with an object keyed by package name.
  const first = Array.isArray(answer) ? answer[0] : Object.values(answer)[0];
  tarball = join(work, first.filename);
}

const unpacked = run("tar", ["-xzf", tarball, "-C", work]);
if (unpacked.status !== 0) fail(`could not unpack ${tarball}:\n${unpacked.stderr}`);

const pkgDir = join(work, "package");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const bin = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
if (Object.keys(bin).length === 0) fail(`${pkg.name}: package.json declares no bin.`);

for (const target of new Set(Object.values(bin))) {
  const file = join(pkgDir, target);
  let mode;
  try {
    mode = statSync(file).mode;
  } catch {
    problems.push(`${target}: missing from the tarball.`);
    continue;
  }
  const firstLine = readFileSync(file, "utf8").split("\n", 1)[0];
  if (firstLine !== SHEBANG) {
    problems.push(`${target}: no shebang — first line must be "${SHEBANG}", found "${firstLine}".`);
    continue;
  }
  if (posix && (mode & 0o111) === 0) {
    problems.push(`${target}: not executable in the tarball (mode ${(mode & 0o777).toString(8)}).`);
    continue;
  }
  // Start it the way npx does: the file itself, not `node <file>`.
  const started = posix
    ? run(file, ["--version"], { timeout: 30_000 })
    : run(process.execPath, [file, "--version"], { timeout: 30_000 });
  const out = (started.stdout ?? "").trim();
  if (started.status !== 0 || out !== pkg.version) {
    problems.push(
      `${target}: did not start — \`${target} --version\` exited ${started.status ?? started.signal ?? started.error?.message}` +
        `, printed "${out}" (expected "${pkg.version}").\n${started.stderr ?? ""}`,
    );
    continue;
  }
  console.log(`${target}: executable, shebang ok, --version → ${out}.`);
}

rmSync(work, { recursive: true, force: true });
if (problems.length > 0) {
  console.error(`Smoke on ${pkg.name}@${pkg.version} failed — do not publish:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`Smoke on ${pkg.name}@${pkg.version}: ok.`);
