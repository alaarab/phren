# Installing phren as a Claude Code plugin

`phren init` is still the supported way to set phren up, and the only one that
covers Copilot, Cursor and Codex. This page is for Claude Code users who would
rather install phren the way they install everything else.

## Install

```
/plugin marketplace add alaarab/phren
/plugin install phren@phren
```

No central registry is involved: Claude Code clones the repository and reads
`.claude-plugin/marketplace.json` from it.

## What it brings

| | |
|---|---|
| **Skills** | The five `phren-*` slash commands, namespaced as `/phren:sync`, `/phren:discover` and so on, so they cannot collide with your own |
| **MCP server** | phren's 59 tools, run through `npx -y @phren/cli mcp-mode` |
| **Hook** | The session-stop hook that commits and pushes what the session learned |

The MCP server runs the published CLI rather than a copy bundled in the plugin,
so the plugin stays small and the server tracks whatever version of
`@phren/cli` you have.

## Plugin or `phren init`?

They overlap, and you do not need both.

**The plugin** is explicit and reversible. You approve what it adds, it is
version-pinned, `/plugin uninstall` removes it cleanly, and it can be scoped to
one project rather than your whole account. Nothing edits your
`~/.claude/settings.json` behind your back.

**`phren init`** does more. It sets up the store itself, wires the other agents
you have installed, and configures per-project context. If you use anything
besides Claude Code, you want it.

A reasonable split is to run `phren init` once to create the store, then use
the plugin for the Claude Code wiring.

## Note on history

The manifests in `.claude-plugin/` predate the monorepo layout and, until
0.1.46, pointed at directories that no longer existed — installing the plugin
produced an empty one. If you installed it before then, reinstall.
