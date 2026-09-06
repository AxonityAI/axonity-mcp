#!/usr/bin/env bash
#
# One command to cut a release. `npm run release:minor` (or :patch / :major).
#
# WHY THIS EXISTS. The documented recipe was a list of commands to run in order,
# and the order was load-bearing: `git pull` first, or the version bump lands on
# a stale checkout. That went wrong twice in one week, the same way both times —
# the bump was made on a tree that did not have the last merge, the branch push
# was refused, and the TAG went up anyway. Recovering meant deleting a published
# tag and resetting, which is not a thing anyone should have to know.
#
# A recipe you have to follow correctly is not a fix. This is the fix.
#
# What it does, in order, stopping at the first thing that is wrong:
#   1. refuses unless you are on main with nothing uncommitted
#   2. resets main to exactly what is on GitHub  <- the step that was skipped
#   3. installs, tests and builds before touching the version
#   4. bumps, tags, pushes, publishes, and reads the version back from npm
#
set -euo pipefail

BUMP="${1:-}"
case "$BUMP" in
  patch|minor|major) ;;
  *)
    echo "usage: npm run release:patch | release:minor | release:major" >&2
    exit 2
    ;;
esac

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$1" >&2; exit 1; }

# Read from package.json rather than written here, so a rename cannot leave this
# script confidently checking a package that no longer exists.
PACKAGE="$(node -p "require('./package.json').name")"

# --- 1. refuse to start from anywhere but a clean main --------------------
# Both failures began here. Nothing below can be safe if this is not true.
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || die "you are on '$branch', not main. Releases come from main."

if [ -n "$(git status --porcelain)" ]; then
  git status --short >&2
  die "there are uncommitted changes. Commit them, or put them on a branch first."
fi

# --- 2. become exactly what GitHub has -----------------------------------
# A hard reset is safe HERE, and only here: work reaches main through merged
# pull requests, never by committing on it. Anything local that this discards
# was not meant to be there — which is precisely the bump commits that a failed
# release leaves behind.
step "Syncing main with GitHub"
git fetch origin --tags --prune
if [ -n "$(git log origin/main..HEAD --oneline)" ]; then
  echo "Discarding local commits that are not on GitHub:"
  git log origin/main..HEAD --oneline
fi
git reset --hard origin/main

echo "main is now at: $(git log --oneline -1)"
echo "current version: $(node -p "require('./package.json').version")"

# --- 3. prove it is shippable BEFORE the version moves -------------------
# After `npm version` there is a commit and a tag to unpick; before it there is
# nothing to undo. So every check that can fail, fails here.
step "Installing"
npm ci

step "Testing"
npm test

step "Building"
npm run build

# --- 4. bump, push, publish ----------------------------------------------
# No -m flag. npm names the commit after the version on its own, which is what
# the older release commits look like. Passing a message by hand is how two of
# them ended up named "%".
step "Bumping the $BUMP version"
npm version "$BUMP"

version="$(node -p "require('./package.json').version")"

# The branch goes first, ON PURPOSE. `--follow-tags` pushes both, but if the
# branch is refused the tag can still land — that is exactly the mess this
# script exists to prevent. Pushing the branch alone first means a refusal
# leaves nothing behind on GitHub.
step "Pushing main"
git push origin main

step "Pushing the tag v$version"
git push origin "v$version"

step "Publishing to npm"
npm publish

# --- 5. confirm, patiently ------------------------------------------------
# `npm publish` returning 0 is what says the publish took. This step only asks
# whether the registry's READ side is showing it yet, and that lags — the first
# version of this script asked once, immediately, and announced "the publish did
# not take" over a release that had in fact just succeeded. A release ending in
# a false alarm is worse than one ending in silence: it sends someone to undo
# work that was fine.
#
# So: retry for a minute, and if it still has not appeared, say what is actually
# known — it is published, npm is being slow — rather than claiming a failure
# nothing has established.
step "Confirming"
published=""
for _ in $(seq 1 12); do
  published="$(npm view "$PACKAGE" version 2>/dev/null || true)"
  [ "$published" = "$version" ] && break
  sleep 5
done

if [ "$published" = "$version" ]; then
  printf '\n\033[32mReleased %s.\033[0m\n' "$version"
  echo "Optional: cut a GitHub release for v$version to run the tag verification."
else
  printf '\n\033[32mPublished %s.\033[0m\n' "$version"
  printf '\033[33mnpm still reports %s after a minute — that is its read side\n' "${published:-nothing}"
  printf 'catching up, not a failed publish. Check again shortly:\n\n'
  printf '  npm view %s version\n\n' "$PACKAGE"
fi
