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
