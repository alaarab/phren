# Cross-Agent Setup Guide

phren supports two install modes:

- `shared`: user-scoped personal memory rooted at `~/.phren`
- `project-local`: repo-scoped memory rooted at `<repo>/.phren`

`phren init` configures integrations differently depending on that mode.

```bash
phren status          # see which agents are active on this machine
phren doctor --agents # check which integrations are configured vs missing
phren init            # add or fix any missing agent configurations
```

## Feature Matrix

| Tool | Shared mode | Project-local mode |
|------|-------------|--------------------|
| Claude Code | user MCP + hooks | not supported |
| Cursor | user MCP | not supported |
| VS Code Copilot | user MCP | workspace MCP |
| Codex | user MCP/TOML | not supported |
| GitHub Copilot CLI | user MCP | not supported |

Native hooks are only supported by Claude Code. Copilot CLI, Cursor, and Codex use generated wrappers and tool config to preserve equivalent lifecycle behavior around MCP tool use.

## Claude Code

Claude Code is the primary target. `phren init` configures both MCP and lifecycle hooks.

**Config locations:**
- MCP server: `~/.claude.json` and `~/.claude/settings.json`
- Hooks: `~/.claude/settings.json`

**MCP config snippet** (`~/.claude.json`):
```json
{
  "mcpServers": {
    "phren": {
      "command": "node",
      "args": ["/path/to/phren/mcp/dist/index.js", "/path/to/.phren"],
      "env": {}
    }
  }
}
```

**Hooks config snippet** (`~/.claude/settings.json`):
```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node /path/to/phren/mcp/dist/index.js hook-prompt"
      }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node /path/to/phren/mcp/dist/index.js hook-stop"
      }]
    }],
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node /path/to/phren/mcp/dist/index.js hook-session-start"
      }]
    }]
  }
}
```

**Common pitfalls:**
- The `args` array must use the resolved path to `index.js`, not `npx`. Using `npx` causes cold-start timeouts.
- Hooks must use absolute paths. Relative paths fail when the working directory changes.
- If hooks stop working after an update, run `phren init` again to refresh the paths.

## Cursor

Cursor supports MCP servers via `mcp.json`. Hooks are not supported.

**Config location:** `~/.cursor/mcp.json` (or platform-specific paths)
- Linux: `~/.cursor/mcp.json` or `~/.config/Cursor/User/mcp.json`
- macOS: `~/Library/Application Support/Cursor/User/mcp.json`
- Windows: `%APPDATA%\Cursor\User\mcp.json`

**MCP config snippet** (`~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "phren": {
      "command": "node",
      "args": ["/path/to/phren/mcp/dist/index.js", "/path/to/.phren"]
    }
  }
}
```

**Common pitfalls:**
- Cursor looks for `mcpServers` (camelCase), not `servers`.
- Without hooks, you must manually call `search_knowledge` to get context. The MCP tools work but there is no automatic injection.
- Restart Cursor after changing `mcp.json`.

## VS Code Copilot

VS Code with GitHub Copilot extension supports MCP servers.

**Shared-mode config location:** VS Code User settings directory
- Linux: `~/.config/Code/User/mcp.json`
- macOS: `~/Library/Application Support/Code/User/mcp.json`
- Windows: `%APPDATA%\Code\User\mcp.json`

**MCP config snippet** (`mcp.json`):
```json
{
  "servers": {
    "phren": {
      "command": "node",
      "args": ["/path/to/phren/mcp/dist/index.js", "/path/to/.phren"]
    }
  }
}
```

**Common pitfalls:**
- VS Code uses `servers` (not `mcpServers`) as the root key.
- Copilot MCP support requires the GitHub Copilot extension with MCP enabled in settings.
- Without hooks, no automatic memory injection occurs on prompt submit.

### VS Code in project-local mode

Project-local mode writes workspace MCP instead of user MCP:

- config file: `<repo>/.vscode/mcp.json`
- server root key: `servers`
- phren path: `${workspaceFolder}/.phren`

Example:

```json
{
  "servers": {
    "phren": {
      "command": "node",
      "args": ["/path/to/phren/mcp/dist/index.js", "${workspaceFolder}/.phren"]
    }
  }
}
```

That keeps the install repo-local and avoids any home-directory writes.

## Codex (OpenAI)

Codex CLI supports MCP via config files.

**Config location:**
- `~/.codex/config.json` or `~/.codex/mcp.json`
- Also supports TOML: `~/.codex/config.toml`

**JSON config snippet** (`~/.codex/config.json`):
```json
{
  "mcpServers": {
    "phren": {
      "command": "node",
      "args": ["/path/to/phren/mcp/dist/index.js", "/path/to/.phren"]
    }
  }
}
```

**Common pitfalls:**
- Codex may use either JSON or TOML config. `phren init` handles both formats.
- No hook support; use MCP tools directly.

## Windsurf

Windsurf is not currently auto-configured by `phren init`. Manual setup:

1. Find your Windsurf MCP config file (check Windsurf documentation for the exact path).
2. Add the phren MCP server entry using the same format as Cursor:
```json
{
  "mcpServers": {
    "phren": {
      "command": "node",
      "args": ["/path/to/phren/mcp/dist/index.js", "/path/to/.phren"]
    }
  }
}
```
3. Replace `/path/to/phren` with the actual path (find it with `which phren` or `npm root -g`).
4. Replace `/path/to/.phren` with your phren data directory (usually `~/.phren`).

## Verifying Setup

After configuration, run:
```bash
phren verify    # checks MCP config and hook registration
phren doctor    # health check with optional --fix
phren status    # shows active project and stats
```

## Updating

When phren is updated, run `phren init` again to refresh MCP paths and hook commands for all configured IDEs. The init process is idempotent and will not overwrite your data.
