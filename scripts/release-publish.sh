#!/usr/bin/env bash
# Publishes one package for release.yml, once: usage release-publish.sh <name> <directory-or-tarball>.
# INPUT_VERSION, GITHUB_SHA and GITHUB_STEP_SUMMARY come from the workflow.
#
# A version already on npm is never published again (npm refuses, and the step
# would fail though the release shipped): when npm says it came from this
# commit, or records no commit (a tarball from pnpm pack carries none), the
# step notes it and succeeds; when npm names another commit it fails, since the
# version on npm is not the one this run built.
set -euo pipefail

name="$1"
target="$2"
version="${INPUT_VERSION:?INPUT_VERSION is not set}"

# One lookup for both fields, so a failure can't pass for "no commit recorded".
# A version npm doesn't have answers nothing (or an empty object or list); a
# failed lookup (network, registry, a package npm doesn't know) answers nothing
# too. Both are taken as not published, so npm publish runs and, if the version
# is there after all, its refusal fails the step.
found=$(npm view "$name@$version" version gitHead --json 2>/dev/null || true)
# "absent", or "present" and the commit npm records (empty when it records none).
# An answer that isn't JSON, or names another version, fails the step.
answer=$(FOUND="$found" node -e '
  const text = process.env.FOUND.trim();
  const found = text ? JSON.parse(text) : undefined;
  const entry = typeof found === "string" ? { version: found } : found;
  if (entry === undefined || entry === null || Array.isArray(entry) && !entry.length || typeof entry === "object" && !Array.isArray(entry) && !Object.keys(entry).length) { console.log("absent"); process.exit(0); }
  if (Array.isArray(entry) || entry.version !== process.env.INPUT_VERSION) { console.error("npm answered for another version: " + text); process.exit(1); }
  console.log("present " + (typeof entry.gitHead === "string" ? entry.gitHead : ""));
')
if [ "$answer" = "absent" ]; then
  npm publish "$target" --access public --provenance
  echo "Published $name@$version." >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

head="${answer#present}"
head="${head# }"
if [ -n "$head" ] && [ "$head" != "$GITHUB_SHA" ]; then
  echo "::error::$name@$version is already on npm, published from $head, not this commit ($GITHUB_SHA). Bump the version to publish this commit."
  exit 1
fi
if [ -n "$head" ]; then
  echo "::notice::$name@$version is already on npm from this commit; not publishing it again."
  echo "$name@$version was already on npm from $GITHUB_SHA; skipped." >> "$GITHUB_STEP_SUMMARY"
else
  echo "::notice::$name@$version is already on npm (npm records no commit for it); not publishing it again."
  echo "$name@$version was already on npm (no commit recorded); skipped." >> "$GITHUB_STEP_SUMMARY"
fi
