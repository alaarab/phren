# Cortex FAQ

## Does cortex require MCP?

No. MCP is recommended, but cortex also works in hooks-only mode.

```bash
npx @alaarab/cortex init --mcp off
```

You can turn MCP back on later:

```bash
npx @alaarab/cortex mcp-mode on
```

## How do I preview init changes without writing files?

Use dry-run mode:

```bash
npx @alaarab/cortex init --dry-run
```

This prints what would be created or updated and exits without modifying files.

## Which clients are supported?

Cortex works with Claude Code, Codex, Cursor, and Copilot CLI. `cortex init` attempts to configure detected clients automatically.

## Where does cortex store data?

By default in `~/.cortex`. Set `CORTEX_PATH` to use a custom location.

## How do I see shell commands quickly?

Inside the shell:

- Press `:help` for the full command map.
- Use `:open <project>` to set project context.
- Use single-key navigation (`p`, `b`, `l`, `m`, `h`, `q`).
