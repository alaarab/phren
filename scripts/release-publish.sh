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

# Empty for a version npm doesn't have. A failed lookup (network, registry) is
# taken as not published, so npm publish runs and reports the real error.
published=$(npm view "$name@$version" version 2>/dev/null || true)
if [ "$published" != "$version" ]; then
  npm publish "$target" --access public --provenance
  echo "Published $name@$version." >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

head=$(npm view "$name@$version" gitHead 2>/dev/null || true)
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
