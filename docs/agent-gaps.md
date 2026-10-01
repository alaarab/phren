# phren agent: gaps and their fixes

On 2026-10-01 two independent analyses (Claude Opus and Codex GPT-6.1 Sol)
compared `packages/agent` with Claude Code, Codex CLI, OpenCode and DeepSeek
Harness; their merged findings are kept with the owner's notes, outside this
repository. Where phren agent was already ahead: memory shared with every
other harness, a tolerant edit engine with checkpoints, the phone and Hook
integration, and a testable core (event log, replay provider, headless JSON).
The DeepSeek fixes they called for shipped in 0.3.20. This page tracks the
rest.

## Fixed in the 2026-10-02 train

| Gap | Fix | PR |
| --- | --- | --- |
| Permissions | `auto-confirm` runs only read, build and test commands; `--yolo` allows warn patterns; a subagent never exceeds its parent's mode; approvals scoped to the subcommand | #296 |
| Permissions | `permissions.allow / ask / deny` rules in settings files, `--allowedTools`, `--disallowedTools` | #300 |
| Subagents | A child runs its parent's provider, model and effort unless it names another | #308 |
| Stale writes | Read-before-write and stale-file guard on every write tool | #290 |
| Compaction | Context measured from the provider's token count; old tool output cleared before compacting; compaction request carries the tools; `/compact <focus>` | #293 |
| Search | `grep` / `glob` on ripgrep with `.gitignore`, hidden directories searched, truncation reported, case-sensitive | #291 |
| System prompt | Environment block and the registered tool list | #292 |
| Plan mode | Plans with the read-only tools; approval once the plan is presented | #299 |
| Diagnostics | Syntax check after each edit; type check before lint and tests | #301, #312 |
| Sessions | Resumable without a phren store; `/resume` picker | #302, #310 |
| MCP | `~/.phren-agent/mcp.json` by default, a trusted project's `.mcp.json`, output cap; prompts as `/mcp__server__prompt` | #303, #311 |
| Hooks | Exit 2 blocks `UserPromptSubmit` and `Stop`, `PostToolUse` feedback, `SessionStart` and `PreCompact` | #304 |
| Headless | `--input-format stream-json`; a JSON Schema for every stream-json line, tested against real output | #305, #309 |

## Still open

- LSP diagnostics (the parse and type checks cover the cheap part).
- An output JSON schema for headless results (`--json-schema`).
- Smaller UX: image paste, `/reasoning`, `/model` across providers, steering
  mid-stream, provider-native web search, network isolation in the sandbox,
  OpenTelemetry.

## DeepSeek V4.1 Flash readiness

Ready for a live run. `src/__tests__/deepseek-e2e.test.ts` (#298) drives the
real loop and provider on DeepSeek's API and the OpenCode Go route against a
fake endpoint as strict as DeepSeek's docs (reasoning replayed on every turn,
tool calls paired, accepted effort levels), through tool turns, a plain
answer, a resume, a dropped stream and a compaction, and checks the cost
against the catalogue's cache-hit prices. Not verified without a key: live
behaviour beyond the docs, and peak-hour prices (the catalogue uses off-peak
rates). The live check, single-agent first:

```sh
PHREN_AGENT_BASE_URL=https://opencode.ai/zen/go/v1 PHREN_AGENT_API_KEY=… \
  node packages/agent/scripts/bench/run.mjs --provider openai-compat --model deepseek-v4.1-flash --reasoning high --runs 1
```
