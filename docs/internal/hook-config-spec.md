# Hook Configuration Schema Specification

Version: 1.0
Last updated: 2026-03-06

Cortex registers lifecycle hooks with multiple AI coding tools. Each tool has its own config format. This document specifies the exact schema cortex writes for each tool, the validation rules applied before writing, and the shell wrapper contract.

## Lifecycle Events

Cortex hooks into three lifecycle events across all supported tools:

| Cortex Event | Purpose | Claude Code | Copilot CLI | Cursor | Codex |
|---|---|---|---|---|---|
| Session start | git pull, load context | `SessionStart` | `sessionStart` | `sessionStart` | `SessionStart` |
| Prompt submit | inject search context | `UserPromptSubmit` | `userPromptSubmitted` | `beforeSubmitPrompt` | `UserPromptSubmit` |
| Session end | auto-commit, push | `Stop` | `sessionEnd` | `stop` | `Stop` |

## Tool-Specific Schemas

### Claude Code

**Config file:** `~/.claude/settings.json`

Claude Code hooks are registered directly in the user's settings file under the `hooks` key. Each event is an array of hook groups.

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "CORTEX_PATH=\"/path\" node \"/path/to/index.js\" hook-session-start"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "CORTEX_PATH=\"/path\" node \"/path/to/index.js\" hook-prompt",
            "timeout": 3
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "CORTEX_PATH=\"/path\" node \"/path/to/index.js\" hook-stop"
          }
        ]
      }
    ]
  }
}
```

**Schema rules:**
- Each event key is an array of hook group objects
- Hook group: `{ matcher: string, hooks: HookEntry[] }`
- HookEntry: `{ type: "command", command: string, timeout?: number }`
- `matcher` is an empty string for cortex hooks (matches all tools)
- `timeout` is seconds (used on `UserPromptSubmit` to avoid blocking)
- Cortex hooks are identified by presence of `hook-prompt`, `hook-stop`, `hook-session-start`, or `isCortexCommand()` match in the command string

**Upsert behavior:** Cortex finds an existing hook group by scanning for known markers in command strings. If found, it replaces in place. If not, it appends.

**Removal behavior:** When hooks are disabled, cortex filters out any hook group whose inner hooks match `isCortexCommand()`.

### Copilot CLI

**Config file:** `~/.github/hooks/cortex.json`

```jsonc
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      { "type": "command", "bash": "<lifecycle command>" }
    ],
    "userPromptSubmitted": [
      { "type": "command", "bash": "<lifecycle command>" }
    ],
    "sessionEnd": [
      { "type": "command", "bash": "<lifecycle command>" }
    ]
  }
}
```

**Schema rules:**
- `version`: must be `number` (currently `1`)
- `hooks.sessionStart`: must be `HookEntry[]`
- `hooks.userPromptSubmitted`: must be `HookEntry[]`
- `hooks.sessionEnd`: must be `HookEntry[]`
- HookEntry: `{ type: "command", bash: string }`
- Note: Copilot uses `bash` key (not `command`) for the shell string
- Note: Copilot uses `userPromptSubmitted` (past tense) and `sessionEnd`

**Validation function:** `validateCopilotConfig()` checks all three arrays exist and version is a number.

**Known limitation:** Copilot CLI does not currently expose native hook support matching this schema. Cortex writes the config file speculatively and also installs a session wrapper binary as a fallback.

### Cursor

**Config file:** `~/.cursor/hooks.json`

```jsonc
{
  "version": 1,
  "sessionStart": { "command": "<lifecycle command>" },
  "beforeSubmitPrompt": { "command": "<lifecycle command>" },
  "stop": { "command": "<lifecycle command>" }
}
```

**Schema rules:**
- `version`: must be `number` (currently `1`)
- `sessionStart.command`: must be `string`
- `beforeSubmitPrompt.command`: must be `string`
- `stop.command`: must be `string`
- Each event is a single object (not an array), unlike other tools

**Validation function:** `validateCursorConfig()` checks version is a number and all three command strings exist.

**Merge behavior:** Reads existing `hooks.json` and spreads existing fields before overwriting cortex-managed keys. Preserves user-added fields.

**Known limitation:** Cursor does not currently expose native hook support matching this schema. Session wrapper provides lifecycle guarantees.

### Codex

**Config file:** `<cortexPath>/codex.json`

```jsonc
{
  "hooks": {
    "SessionStart": [
      { "type": "command", "command": "<lifecycle command>" }
    ],
    "UserPromptSubmit": [
      { "type": "command", "command": "<lifecycle command>" }
    ],
    "Stop": [
      { "type": "command", "command": "<lifecycle command>" }
    ]
  }
}
```

**Schema rules:**
- `hooks.SessionStart`: must be `HookEntry[]`
- `hooks.UserPromptSubmit`: must be `HookEntry[]`
- `hooks.Stop`: must be `HookEntry[]`
- HookEntry: `{ type: "command", command: string }`
- Note: Codex uses PascalCase event names and `command` key (not `bash`)
- No version field required

**Validation function:** `validateCodexConfig()` checks all three arrays exist.

**Merge behavior:** Reads existing `codex.json` and preserves non-hooks fields.

**Known limitation:** Codex CLI does not currently expose native hook support matching this schema. Session wrapper provides lifecycle guarantees.

## Session Wrapper Contract

For tools that lack native hook support (Copilot, Cursor, Codex), cortex installs a POSIX shell wrapper at `~/.local/bin/<tool>` that intercepts invocations.

**Wrapper behavior:**
1. Resolves the real binary (skipping itself via path comparison)
2. Runs session-start hook with 14s timeout
3. Executes the real binary with all arguments passed through
4. Captures exit status
5. Runs stop hook with 14s timeout
6. Exits with the original status

**Shell requirements:**
- Shebang: `#!/bin/sh` (POSIX sh, not bash)
- Uses `set -u` (undefined variable errors)
- No bash-specific syntax: no `[[ ]]`, no `${@:}` array slicing, no `$BASHPID`
- Timeout via `timeout` command if available, direct execution as fallback
- Uses `shift` pattern for timeout function arguments

**Passthrough cases:** `-h`, `--help`, `help`, `-V`, `--version`, `version`, `completion` bypass hooks and exec directly to the real binary.

**Installation gating:** Wrappers are only installed when `hooksEnabled !== false` in `.runtime/install-preferences.json`.

## Lifecycle Command Format

Local per-machine hook configs use the local entry script when available:

```
CORTEX_PATH="<escaped-path>" node "<entry-script>" <subcommand>
```

Or the npx fallback when the local entry script is not found:

```
CORTEX_PATH="<escaped-path>" npx -y @alaarab/cortex@<version> <subcommand>
```

Shared synced artifacts that may move across machines, such as `codex.json` and
`cortex.SKILL.md`, use portable versioned npx commands without embedding local
absolute paths:

```
npx -y @alaarab/cortex@<version> <subcommand>
```

**Subcommands:**
- `hook-session-start`: git pull, context injection
- `hook-prompt`: keyword extraction, cortex search, context injection
- `hook-stop`: git add, commit, push

**Path escaping:** Local machine configs escape backslashes (`\\` to `\\\\`) and double quotes (`"` to `\"`).

## Install Preferences

**File:** `<cortexPath>/.runtime/install-preferences.json`

```jsonc
{
  "mcpEnabled": true,
  "hooksEnabled": true,
  "installedVersion": "1.11.0",
  "updatedAt": "2026-03-06T00:00:00.000Z"
}
```

| Field | Type | Default | Purpose |
|---|---|---|---|
| `mcpEnabled` | boolean | `true` | Controls MCP server registration |
| `hooksEnabled` | boolean | `true` | Controls hook config writing and wrapper installation |
| `installedVersion` | string | - | Last installed cortex version |
| `updatedAt` | string (ISO) | - | Last update timestamp |

When `hooksEnabled` is `false`:
- Hook configs for Copilot/Cursor/Codex are still written (config files are always updated)
- Session wrapper binaries are NOT installed
- Claude Code hooks are removed from settings.json
- Hook subcommands (`hook-prompt`, `hook-stop`, `hook-session-start`) exit early

## Per-Tool Hook Enablement

Individual tools can be enabled or disabled independently via `install-preferences.json`:

```jsonc
{
  "hooksEnabled": true,
  "hookTools": {
    "claude": true,
    "copilot": true,
    "cursor": false,
    "codex": true
  }
}
```

When `hookTools` is present, each tool key controls whether hooks and wrappers are configured for that tool. Missing keys default to the value of `hooksEnabled`. When `hooksEnabled` is `false`, all tools are disabled regardless of `hookTools`.

## Validation

Every config is validated before being written to disk. If validation fails, the write is skipped with no partial output. Validation functions check structural shape only (required keys exist, correct types), not semantic correctness of command strings.

## File Locations Summary

| Tool | Hook Config | Wrapper | MCP Config |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` | n/a (native) | `~/.claude/settings.json` |
| Copilot CLI | `~/.github/hooks/cortex.json` | `~/.local/bin/copilot` | `~/.github/mcp.json` |
| Cursor | `~/.cursor/hooks.json` | `~/.local/bin/cursor` | `~/.cursor/mcp.json` |
| Codex | `<cortexPath>/codex.json` | `~/.local/bin/codex` | `~/.codex/config.json` |
