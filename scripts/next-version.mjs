#!/usr/bin/env node
/**
 * Welke versie de volgende release krijgt, afgeleid uit de commits sinds de
 * vorige tag. `.github/workflows/release.yml` roept dit aan na elke merge op main.
 *
 *   major  een commit met het woord BREAKING (hoofdletters), of een type met `!`
 *          (`feat!:`, `fix(api)!:`)
 *   minor  een commit met het conventionele voorvoegsel `feat:` / `feat(scope):`
 *   patch  al het andere
 *   none   geen commits sinds de tag (er is niets nieuws om te publiceren)
 *
 * Een squash-merge zet de losse commits als `* feat: …` in de body; die regels
 * tellen mee, zodat een `feat` die in een PR met een `fix`-titel zit niet verloren
 * gaat.
 *
 * Gebruik (in de workflow):
 *   node scripts/next-version.mjs
 * schrijft `bump=…`, `version=…` en `previous=…` naar stdout, één per regel,
 * geschikt voor `>> "$GITHUB_OUTPUT"`. `version` is leeg bij `bump=none`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// `type(scope)!: …`, aan het begin van een regel, eventueel na een lijstteken.
const CONVENTIONAL = /^\s*(?:[*-]\s+)?([a-z]+)(?:\([^)]*\))?(!)?:\s/;
const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

/** De bump die één commitbericht (titel + body) vraagt. */
export function bumpForMessage(message) {
  if (/\bBREAKING\b/.test(message)) return "major";
  let bump = "patch";
  for (const line of message.split("\n")) {
    const match = CONVENTIONAL.exec(line);
    if (!match) continue;
    if (match[2] === "!") return "major";
    if (match[1] === "feat") bump = "minor";
  }
  return bump;
}

/** De hoogste bump over alle commits; `none` als er geen zijn. */
export function bumpFor(messages) {
  let bump = "none";
  for (const message of messages) {
    const candidate = bumpForMessage(message);
    if (RANK[candidate] > RANK[bump]) bump = candidate;
  }
  return bump;
}

/** `0.36.0` + `minor` → `0.37.0`. */
export function nextVersion(current, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new Error(`geen gewone versie: ${current}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "none":
      return null;
    default:
      throw new Error(`onbekende bump: ${bump}`);
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

/** De berichten van elke commit sinds `tag` (of de hele geschiedenis zonder tag). */
export function messagesSince(tag) {
  const range = tag ? [`${tag}..HEAD`] : ["HEAD"];
  // NUL tussen de commits: berichten bevatten zelf regeleinden.
  const out = git(["log", "--format=%B%x00", ...range]);
  return out
    .split("\0")
    .map((m) => m.trim())
    .filter(Boolean);
}

function main() {
  const current = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const tag = `v${current}`;
  const known = git(["tag", "--list", tag]).trim() === tag;
  if (!known) {
    console.error(`next-version: tag ${tag} bestaat niet; package.json en de tags lopen uiteen`);
    process.exit(1);
  }
  const bump = bumpFor(messagesSince(tag));
  const version = nextVersion(current, bump) ?? "";
  process.stdout.write(`bump=${bump}\nversion=${version}\nprevious=${current}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
