# Cross-Agent Setup Guide

cortex works across all major AI coding agents. One memory layer, one command to install. `npx @alaarab/cortex init` auto-detects and configures every agent it finds.

```bash
cortex status          # see which agents are active on this machine
cortex doctor --agents # check which integrations are configured vs missing
cortex init            # add or fix any missing agent configurations
```

## Feature Matrix

| Feature | Claude Code | Cursor | VS Code Copilot | Codex |
|---------|:-----------:|:------:|:---------------:|:-----:|
| FTS5 search | yes | yes | yes | yes |
| Lifecycle hooks | yes | no | no | no |
| Backlog management | yes | yes | yes | yes |
| Finding capture | yes | yes | yes | yes |
| Auto-extract (hooks) | yes | no | no | no |
| Session-start sync | yes | no | no | no |
| Memory feedback | yes | yes | yes | yes |

Hooks (UserPromptSubmit, Stop, SessionStart, PostToolUse) are only supported by Claude Code. Other IDEs get full MCP tool access but no automatic context injection.

## Claude Code

Claude Code is the primary target. `cortex init` configures both MCP and lifecycle hooks.

**Config locations:**
- MCP server: `~/.claude.json` and `~/.claude/settings.json`
- Hooks: `~/.claude/settings.json`

**MCP config snippet** (`~/.claude.json`):
```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["/path/to/cortex/mcp/dist/index.js", "/path/to/.cortex"],
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
        "command": "node /path/to/cortex/mcp/dist/index.js hook-prompt"
      }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node /path/to/cortex/mcp/dist/index.js hook-stop"
      }]
    }],
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node /path/to/cortex/mcp/dist/index.js hook-session-start"
      }]
    }]
  }
}
```

**Common pitfalls:**
- The `args` array must use the resolved path to `index.js`, not `npx`. Using `npx` causes cold-start timeouts.
- Hooks must use absolute paths. Relative paths fail when the working directory changes.
- If hooks stop working after an update, run `cortex init` again to refresh the paths.

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
    "cortex": {
      "command": "node",
      "args": ["/path/to/cortex/mcp/dist/index.js", "/path/to/.cortex"]
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

**Config location:** VS Code User settings directory
- Linux: `~/.config/Code/User/mcp.json`
- macOS: `~/Library/Application Support/Code/User/mcp.json`
- Windows: `%APPDATA%\Code\User\mcp.json`

**MCP config snippet** (`mcp.json`):
```json
{
  "servers": {
    "cortex": {
      "command": "node",
      "args": ["/path/to/cortex/mcp/dist/index.js", "/path/to/.cortex"]
    }
  }
}
```

**Common pitfalls:**
- VS Code uses `servers` (not `mcpServers`) as the root key.
- Copilot MCP support requires the GitHub Copilot extension with MCP enabled in settings.
- Without hooks, no automatic memory injection occurs on prompt submit.

## Codex (OpenAI)

Codex CLI supports MCP via config files.

**Config location:**
- `~/.codex/config.json` or `~/.codex/mcp.json`
- Also supports TOML: `~/.codex/config.toml`

**JSON config snippet** (`~/.codex/config.json`):
```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["/path/to/cortex/mcp/dist/index.js", "/path/to/.cortex"]
    }
  }
}
```

**Common pitfalls:**
- Codex may use either JSON or TOML config. `cortex init` handles both formats.
- No hook support; use MCP tools directly.

## Windsurf

Windsurf is not currently auto-configured by `cortex init`. Manual setup:

1. Find your Windsurf MCP config file (check Windsurf documentation for the exact path).
2. Add the cortex MCP server entry using the same format as Cursor:
```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["/path/to/cortex/mcp/dist/index.js", "/path/to/.cortex"]
    }
  }
}
```
3. Replace `/path/to/cortex` with the actual path (find it with `which cortex` or `npm root -g`).
4. Replace `/path/to/.cortex` with your cortex data directory (usually `~/.cortex`).

## Verifying Setup

After configuration, run:
```bash
cortex verify    # checks MCP config and hook registration
cortex doctor    # health check with optional --fix
cortex status    # shows active project and stats
```

## Updating

When cortex is updated, run `cortex init` again to refresh MCP paths and hook commands for all configured IDEs. The init process is idempotent and will not overwrite your data.
