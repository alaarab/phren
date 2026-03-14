# Shell Release Hardening

## Pre-release Checklist
- [x] `npm run build` passes.
- [x] `npm test` passes including `shell.test.ts`.
- [x] `phren` no-arg TTY opens shell.
- [x] Non-TTY invocation still works for MCP mode.
- [x] Task/findings/review queue writes are parity-checked with MCP tools.
- [x] Session persistence survives restart and stale-state migration.
- [x] Health remediation commands run without shell crash.
- [x] `phren update` and `:update` flows are documented.

## Staged Rollout
1. Internal dogfood in local clone and multi-machine profile setups.
2. Validate hook lifecycle + shell coexistence across Claude Code, Cursor, Copilot CLI, Codex.
3. Publish with clear fallback instructions and migration notes.

## Fallback Plan
- Use explicit MCP mode command in non-interactive contexts.
- Use existing CLI/MCP tools for all mutations if shell is unavailable.
- Keep hooks + memory governance independent of shell startup.

## Upgrade Notes
- `phren` in a terminal now enters interactive mode by default.
- `phren shell` remains explicit entrypoint.
- Add `phren update` command for version upgrades.

## Rollback Path
- Pin previous release from npm if required.
- Re-run `npx phren init` after rollback to restore expected hook/script references.
- Keep markdown docs/tasks files unchanged; no migration lock-in.
