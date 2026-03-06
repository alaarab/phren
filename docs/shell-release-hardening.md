# Shell Release Hardening

## Pre-release Checklist
- [ ] `npm run build` passes.
- [ ] `npm test` passes including `shell.test.ts`.
- [ ] `cortex` no-arg TTY opens shell.
- [ ] Non-TTY invocation still works for MCP mode.
- [ ] Backlog/learnings/memory queue writes are parity-checked with MCP tools.
- [ ] Session persistence survives restart and stale-state migration.
- [ ] Health remediation commands run without shell crash.
- [ ] `cortex update` and `:update` flows are documented.

## Staged Rollout
1. Internal dogfood in local clone and multi-machine profile setups.
2. Validate hook lifecycle + shell coexistence across Claude Code, Cursor, Copilot CLI, Codex.
3. Publish with clear fallback instructions and migration notes.

## Fallback Plan
- Use explicit MCP mode command in non-interactive contexts.
- Use existing CLI/MCP tools for all mutations if shell is unavailable.
- Keep hooks + memory governance independent of shell startup.

## Upgrade Notes
- `cortex` in a terminal now enters interactive mode by default.
- `cortex shell` remains explicit entrypoint.
- Add `cortex update` command for version upgrades.

## Rollback Path
- Pin previous release from npm if required.
- Re-run `cortex link --all-tools` after rollback to restore expected hook/script references.
- Keep markdown docs/backlog files unchanged; no migration lock-in.
