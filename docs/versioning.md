# Versioning

cortex follows [Semantic Versioning](https://semver.org/).

## Version format: MAJOR.MINOR.PATCH

| Bump | When |
|------|------|
| **Patch** | Bug fixes, typo corrections, test additions |
| **Minor** | New MCP tools, new CLI commands, new features |
| **Major** | Breaking changes (see below) |

## What counts as a breaking change

- Removing or renaming an MCP tool
- Removing or renaming a CLI command
- Changing the FINDINGS.md or backlog.md format in a way that breaks existing parsers
- Data schema changes that require migration (e.g., governance config shape changes)
- Dropping support for a previously supported agent (Claude Code, Copilot, Cursor, Codex)

## Support policy

One major version back. When 2.0 ships, 1.x will receive critical bug fixes for a reasonable period but no new features.

## Checking your version

```bash
cortex --version
npx @alaarab/cortex --version
```

The MCP server also reports its version in the `server_info` metadata on startup.

## Update model

- `cortex update` refreshes the installed package itself. In a local git checkout it pulls, installs, rebuilds, and runs a health check. In a global npm install it updates the package with npm and verifies it is installed.
- `cortex update --refresh-starter` does the package update and also refreshes shipped starter globals in the same flow.
- `npx @alaarab/cortex init --apply-starter-update` still works when you only want to refresh starter globals without doing the broader update step.
- Generated runtime metadata such as `cortex.SKILL.md` is derived from the live tool registry during link/setup so tool counts and descriptions stay aligned with the code, and shared manifests are emitted with portable versioned `npx` commands to avoid cross-machine path drift.
