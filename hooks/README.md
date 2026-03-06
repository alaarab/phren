# Cortex hooks

Shell scripts that plug into Claude Code's hook system. These run automatically at specific lifecycle points in a Claude session.

## Available hooks

### post-session.sh

Fires when Claude finishes responding (`Stop` event). Auto-commits and pushes any cortex changes from the session.

Set `CORTEX_AUTO_LEARN=1` to make it output a stronger prompt that triggers an automatic learning extraction instead of a passive reminder.

## Installation

Add the hook config to `~/.claude/settings.json` (applies to all projects) or `.claude/settings.json` in a specific project.

### Stop hook (post-session reminder)

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.cortex/hooks/post-session.sh"
          }
        ]
      }
    ]
  }
}
```

If your cortex repo lives somewhere other than `~/.cortex`, update the path or set `CORTEX_DIR`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "CORTEX_DIR=/path/to/cortex /path/to/cortex/hooks/post-session.sh"
          }
        ]
      }
    ]
  }
}
```

### Merging with existing hooks

If you already have hooks in your settings, merge the entries. Each event key (`Stop`, `PostToolUse`, etc.) takes an array, so you can have multiple hook groups per event:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "~/.cortex/hooks/post-session.sh" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "your-formatter-here" }
        ]
      }
    ]
  }
}
```

## Writing new hooks

Hook scripts receive JSON on stdin with context about the event. Use `jq` to parse it:

```bash
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
```

Exit codes:
- **0**: allow the action. Stdout gets injected into Claude's context (for `Stop`, `SessionStart`, `UserPromptSubmit`).
- **2**: block the action. Stderr becomes Claude's feedback.
- **Other**: allow the action. Stderr is logged but not shown to Claude.

See the [Claude Code hooks docs](https://code.claude.com/docs/en/hooks-guide) for the full event list and input schemas.

## Per-tool hook enablement

By default, `hooksEnabled` is all-or-nothing. To control which tools get session wrappers, add a `hookTools` key to `.governance/install-preferences.json`:

```json
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

Missing keys default to the value of `hooksEnabled`. When `hooksEnabled` is `false`, all tools are disabled regardless of `hookTools`.

See `docs/internal/hook-config-spec.md` for the full schema specification.

## Dependencies

- `jq` for JSON parsing (`apt install jq` or `brew install jq`)
- POSIX sh (bash not required; scripts use `#!/bin/sh`)
