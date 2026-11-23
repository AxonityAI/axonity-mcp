#!/usr/bin/env node
/**
 * postbuild: give every bin target in package.json the execute bit.
 *
 * `tsc` writes dist/index.js as 0644. npx runs the bin straight through its
 * symlink, so a tarball packed from that build ships a bin that cannot run:
 * "Permission denied", and every MCP client shows "Connection closed". That is
 * what releases 1.0.0 to 1.1.0 did. Node's chmod is cross-platform (on Windows
 * it only touches the read-only flag, which is harmless here).
 *
 * Also refuses a bin that does not start with the node shebang, without which
 * the shell would not know to run it with node.
 *
 * Usage: node scripts/make-bin-executable.mjs [package-root]   (default: cwd)
 */
import { chmodSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const SHEBANG = "#!/usr/bin/env node";
const root = resolve(process.argv[2] ?? ".");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const bin = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
const targets = [...new Set(Object.values(bin))];

if (targets.length === 0) {
  console.error(`${pkg.name}: package.json declares no bin.`);
  process.exit(1);
}

let failed = false;
for (const target of targets) {
  const file = resolve(root, target);
  const firstLine = readFileSync(file, "utf8").split("\n", 1)[0];
  if (firstLine !== SHEBANG) {
    console.error(`${target}: first line must be "${SHEBANG}", found "${firstLine}".`);
    failed = true;
    continue;
  }
  chmodSync(file, statSync(file).mode | 0o755);
  console.log(`${target}: executable.`);
}
process.exit(failed ? 1 : 0);
