#!/bin/bash
# Validate that documentation stays in sync with the codebase.
set -e

ERRORS=0

# 1. Check tool count in CLAUDE.md matches actual registrations in index.ts
REGISTERED=$(grep -c 'server\.registerTool(' mcp/src/index.ts)
DOCUMENTED=$(grep -oP 'MCP Tools \(\K[0-9]+' CLAUDE.md || echo "0")

if [ "$REGISTERED" != "$DOCUMENTED" ]; then
  echo "FAIL: CLAUDE.md says $DOCUMENTED MCP tools, but index.ts has $REGISTERED registrations"
  ERRORS=$((ERRORS + 1))
else
  echo "OK: Tool count matches ($REGISTERED)"
fi

# 2. Check that package.json version is not a placeholder
VERSION=$(node -p "require('./package.json').version")
if [ -z "$VERSION" ] || [ "$VERSION" = "0.0.0" ]; then
  echo "FAIL: package.json version is missing or placeholder"
  ERRORS=$((ERRORS + 1))
else
  echo "OK: package.json version is $VERSION"
fi

# 3. Verify index.ts reads version from package.json (not hardcoded)
# Check that PACKAGE_VERSION is derived from readFileSync + package.json (across multiple lines)
if grep -q 'PACKAGE_VERSION' mcp/src/index.ts && grep -q 'readFileSync.*package\.json' mcp/src/index.ts; then
  echo "OK: index.ts reads version dynamically from package.json"
else
  echo "FAIL: index.ts may have a hardcoded version instead of reading package.json"
  ERRORS=$((ERRORS + 1))
fi

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "$ERRORS validation error(s) found"
  exit 1
fi

echo ""
echo "All doc validations passed"
