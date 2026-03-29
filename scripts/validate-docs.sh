#!/bin/bash
# Validate that documentation stays in sync with the codebase.
set -e

ERRORS=0

# 1. Check tool count in docs matches actual registrations in tools/*.ts files
REGISTERED=$(grep -r 'server\.registerTool(' packages/cli/src/tools/*.ts | wc -l | tr -d ' ')
DOCUMENTED=$(perl -ne 'print "$1\n" if /MCP Tools \((\d+)\)/' docs/llms-install.md | head -n 1)
DOCUMENTED=${DOCUMENTED:-0}

if [ "$REGISTERED" != "$DOCUMENTED" ]; then
  echo "FAIL: docs/llms-install.md says $DOCUMENTED MCP tools, but tools/*.ts files have $REGISTERED registrations"
  ERRORS=$((ERRORS + 1))
else
  echo "OK: Tool count matches ($REGISTERED)"
fi

# 2. Check that package.json version is not a placeholder
VERSION=$(node -p "require('./packages/cli/package.json').version")
if [ -z "$VERSION" ] || [ "$VERSION" = "0.0.0" ]; then
  echo "FAIL: package.json version is missing or placeholder"
  ERRORS=$((ERRORS + 1))
else
  echo "OK: package.json version is $VERSION"
fi

# 3. Verify runtime version comes from shared package metadata (not a hardcoded string)
if grep -q 'export const VERSION' packages/cli/src/package-metadata.ts && grep -q 'package.json' packages/cli/src/package-metadata.ts && grep -q 'version: PACKAGE_VERSION' packages/cli/src/index.ts; then
  echo "OK: runtime version is derived from shared package metadata"
else
  echo "FAIL: runtime version metadata may be hardcoded or disconnected from package.json"
  ERRORS=$((ERRORS + 1))
fi

# 4. Public onboarding docs should not advertise removed enrollment flows
PUBLIC_DOCS=("README.md" "docs/faq.md" "docs/llms-install.md" "docs/index.html")
REMOVED_PATTERNS=("phren link" "projects add" "--from-existing")
for doc in "${PUBLIC_DOCS[@]}"; do
  for pattern in "${REMOVED_PATTERNS[@]}"; do
    if grep -n -- "$pattern" "$doc" >/tmp/phren-doc-grep.txt; then
      echo "FAIL: $doc still mentions removed onboarding flow: $pattern"
      cat /tmp/phren-doc-grep.txt
      ERRORS=$((ERRORS + 1))
    fi
  done
done
if [ "$ERRORS" -eq 0 ]; then
  echo "OK: Public onboarding docs only advertise supported enrollment flows"
fi

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "$ERRORS validation error(s) found"
  exit 1
fi

echo ""
echo "All doc validations passed"
