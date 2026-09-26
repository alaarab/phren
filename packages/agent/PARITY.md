# phren-agent parity audit — 2026-09-25

Goal: phren-agent should be as good in daily use as Claude Code, Codex CLI and
OpenCode (and the DeepSeek harnesses built on them). This file compares the
capabilities that make those tools good, records where phren-agent stands with
evidence, and lists what is still missing.

How to read it:

- **phren-agent** cells cite `file:line` under `packages/agent/` and the
  test file that covers the behaviour. "Fixed here" marks work done in this
  pass (branch `feat/agent-parity`).
- **Claude Code / Codex / OpenCode** cells summarize their public docs and
  behaviour as of this date. They were not re-verified tool by tool in this
  pass; treat them as the reference bar, not as test results.
- Status: **yes**, **partial**, **no**.

## Capability table

| # | Capability | Claude Code | Codex CLI | OpenCode | phren-agent | Evidence (phren-agent) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Exact-string edit with useful failures | yes: Edit, unique match or `replace_all`, read-before-edit enforced | via apply_patch | yes: edit with fuzzy fallbacks | **yes (fixed here)**: unique match or `replace_all`; CRLF-aware; trailing-whitespace and indentation-tolerant whole-line fallback that re-indents; recovers pasted `N\t` prefixes; ambiguous matches list line numbers; not-found shows the closest region and first differing line | `src/tools/edit-engine.ts:249` (`applyEdit`), `:120` (`describeNotFound`); `src/tools/edit-file.ts:42`. Tests: `edit-engine.test.ts`, `tools.test.ts` "editFileTool" |
| 2 | Multi-edit (atomic, one file) | yes (Edit/MultiEdit) | via apply_patch | yes (multiedit) | **yes (fixed here)**: `multi_edit`, ordered, all-or-nothing | `src/tools/edit-file.ts:67`, `src/tools/edit-engine.ts:273`. Tests: `edit-engine.test.ts` "applyEdits", "multi_edit writes nothing when any edit fails" |
| 3 | apply_patch (Codex format) | no | yes (native) | yes (patch) | **yes (fixed here)**: add/delete/update/move, `@@` anchors, `*** End of File`, heredoc wrapper, whitespace and typographic-punctuation tolerant context that keeps the file's own text, atomic across files, paths checked by the permission checker | `src/tools/apply-patch.ts:308`, `src/permissions/checker.ts` (apply_patch branch). Tests: `apply-patch.test.ts` |
| 4 | Edit results don't flood context | yes (snippet) | yes | yes | **yes (fixed here)**: every edit/write result used to send the model the whole file twice (the TUI diff payload); now the model gets a short numbered excerpt, the TUI still gets the diff | `src/agent-loop/stream.ts:282` (`modelVisibleOutput`), `src/tools/edit-file.ts` (`snippetAround`). Test: `edit-engine.test.ts` "diff payload is not model-visible" |
| 5 | File read windows | yes: offset/limit, 2000-char lines | shell `sed`/`cat` | yes | **yes (fixed here)**: offset/limit, 2,000-char line cap, binary refusal, "continue with offset N", past-EOF error, CRLF stripped | `src/tools/read-file.ts:7`, `:47`. Tests: `edit-engine.test.ts` "read_file windows", `tools.test.ts` "readFileTool" |
| 6 | Read-before-edit / stale-file guard | yes | n/a | partial | **no**: description text only | `src/tools/read-file.ts` (description). Gap 2 below |
| 7 | Auto-compaction | yes | yes | yes | **yes (fixed here)**: LLM checkpoint at 75% with regex fallback; now also compacts single long tool loops (previously never pruned: no later user text message to split on) and compacts + retries once when the provider reports a context overflow | `src/context/pruner.ts:185`, `src/agent-loop/index.ts:223`, `src/providers/retry.ts:56`, `src/context/compactor.ts:248`. Tests: `loop-reliability.test.ts` "context overflow recovery", "planPrune on a pure tool loop"; `compactor.test.ts` |
| 8 | Manual compaction | yes `/compact` | yes `/compact` | yes | yes `/compact` | `src/commands.ts:177`, `src/commands/session.ts:156` |
| 9 | Token / cost display, budget | yes | yes | yes | yes: status bar `ctx N%` + cost, `/cost`, `--budget` | `src/tui/components/StatusBar.tsx:51`, `src/commands/info.ts:110`, `src/cost.ts:34`. Tests: `cost.test.ts` |
| 10 | Streaming UX | yes | yes | yes | yes: text and reasoning deltas, tool spinners, folded output | `src/agent-loop/stream.ts:143`, `src/tui/components/App.tsx`. Tests: `agent-loop.test.ts`, `reasoning.test.ts` |
| 11 | Interrupt mid-turn | yes (Esc) | yes (Esc) | yes | **yes (fixed here)**: Esc/Ctrl-C aborts; tool calls the model already emitted now get "Cancelled by user." results, and any history ending in unanswered calls is repaired before the next prompt (previously the next request could 400 on every later turn) | `src/agent-loop/index.ts:24` (`closeDanglingToolUses`), `:63`, `:258`; `src/tui/hooks/useKeyboardShortcuts.ts:151`. Tests: `loop-reliability.test.ts` "interrupt leaves a valid history" |
| 12 | Steer / queue input mid-turn | yes (queued messages) | yes | yes | partial: steer text is injected after each tool batch; `/mode` switches steer/queue | `src/agent-loop/index.ts` (getSteeringInput), `src/tui/ink-entry.tsx:626`. No test |
| 13 | Permission modes | yes: default, acceptEdits, plan, bypass | yes: untrusted / on-request / never | yes: allow/ask/deny per tool | yes: suggest, auto-confirm, plan, full-auto; Shift+Tab cycles | `src/permissions/checker.ts:50`. Tests: `permissions-checker.test.ts` |
| 14 | Command allowlists / rules | yes: allow/deny rules with patterns in settings | yes: approved command prefixes | yes: bash glob patterns | partial: session and persistent allowlist keyed by tool + first token/path; no declarative deny rules, no `--allowedTools` | `src/permissions/allowlist.ts:41`, `:101`. Tests: `allowlist.test.ts` |
| 15 | Sandboxing | yes (bash sandbox) | yes: Seatbelt/Landlock, network off by default | no | partial: bwrap write fence for shell on Linux, macOS opt-in (`PHREN_AGENT_MACOS_SANDBOX=1`), no network isolation; path sandbox for file tools | `src/permissions/kernel-sandbox.ts:4`, `src/permissions/sandbox.ts`. Tests: `kernel-sandbox.test.ts`, `sandbox.test.ts` |
| 16 | Plan mode | yes | partial | yes (plan agent) | yes: tools disabled until the plan is approved; feedback revises | `src/plan.ts`, `src/agent-loop/index.ts` (planPending). Tests: `agent-loop.test.ts` "plan approval gates" |
| 17 | Todo list | yes (TodoWrite) | yes (update_plan) | yes (todowrite) | yes: `update_plan`, ctrl+t panel | `src/tools/update-plan.ts:23`. Tests: `conversation-control.test.ts` |
| 18 | Subagents | yes (Task) | partial | yes (task, @agents) | yes: `spawn_agent` (types, optional worktree), send/list, multi-agent TUI | `src/tools/spawn-agent.ts:101`, `src/multi/spawner.ts`. Tests: `multi-spawner.test.ts`, `multi-coordinator.test.ts` |
| 19 | Background shells | yes | partial | yes | yes: `run_in_background`, `task_output`, `task_stop` | `src/tools/shell.ts:59`. No test for task_output/stop |
| 20 | Session save / resume / fork | yes: `-c`, `-r <id>`, picker, fork | yes: `codex resume`, `exec resume` | yes: session list, continue, share | **partial (improved here)**: durable event log; `--resume`/`-c` (newest), **`--session <id-prefix>`**, **`--list-sessions`**, `/fork`; `--resume "task"` now continues with that task (it used to be silently replaced by "continue"). Still needs a phren store; TUI `/resume` reads only the legacy snapshot | `src/session/persist.ts:120`, `:170`, `src/index.ts` (makeResumedLog), `src/config.ts:165`. Tests: `providers-compat.test.ts` "session listing and resume by id", `session-log.test.ts` |
| 21 | Slash + custom commands | yes (`.claude/commands`) | yes (prompts) | yes (`.opencode/command`) | yes: ~30 built-ins; custom Markdown commands with `$ARGUMENTS`/`$1..$9` from `~/.phren-agent/commands` and `.phren-agent/commands` | `src/commands.ts:162`, `src/custom-commands.ts:48`. Tests: `custom-commands.test.ts` |
| 22 | Hooks | yes (~10 events, can block/inject) | yes | yes (plugins) | partial: PreToolUse (can deny), PostToolUse, UserPromptSubmit, Stop; the last two cannot block or inject | `src/user-hooks.ts:6`. Tests: `user-hooks.test.ts` |
| 23 | MCP | yes: stdio/http/sse, OAuth, `.mcp.json` | yes | yes | partial: stdio/http/sse, OAuth PKCE, resources, list_changed; no default config file, prompts not surfaced | `src/mcp-client.ts:79`, `src/mcp-oauth.ts`, `src/tools/mcp-resources.ts`. Tests: `mcp-client.test.ts`, `mcp-remote.test.ts` |
| 24 | Image input | yes (paste, path) | yes (`-i`, paste) | yes | partial: `read_image` tool on vision models; no paste/attach in the TUI | `src/tools/read-image.ts:26`. Tests: `images.test.ts` |
| 25 | Web search / fetch | yes | yes (search) | yes (fetch) | partial: `web_fetch` with SSRF guard; `web_search` scrapes DuckDuckGo HTML | `src/tools/web-fetch.ts:73`, `src/tools/web-search.ts:11`. Tests: `kernel-sandbox.test.ts` "web_fetch SSRF guard" |
| 26 | Git awareness | yes (status in prompt, commits) | yes | yes (snapshots) | partial: git_status/diff/commit tools, per-edit checkpoints and `/rewind`; no git status in the system prompt; shell edits are not checkpointed | `src/tools/git.ts:16`, `src/checkpoint.ts`, `src/commands.ts:185`. Tests: `conversation-control.test.ts` "checkpoints" |
| 27 | Project instruction files | yes: CLAUDE.md hierarchy incl. subdirs, imports | yes: AGENTS.md hierarchy, 32 KiB | yes: AGENTS.md | **partial (improved here)**: AGENTS.md and CLAUDE.md from cwd up to root plus `~/.claude/CLAUDE.md`; **now loaded without a phren store** and capped at 32,000 chars (was 4,000, which cut this repo's AGENTS.md short); `PHREN_AGENT_USER_RULES=off` skips the user file. Subdirectory files are still not picked up | `src/memory/context.ts:109` (`buildProjectInstructions`), `src/index.ts` (no-store path). Tests: `providers-compat.test.ts` "project instructions without a phren store", `conversation-control.test.ts` "AGENTS.md injection" |
| 28 | Model / reasoning switch mid-session | yes `/model` | yes `/model` | yes | partial: `/model` picker with reasoning left/right, same provider only; no `/reasoning` | `src/tui/ink-entry.tsx:426`, `src/commands/model.ts:15`. No picker test |
| 29 | Headless `-p` with JSON output | yes: `-p`, `--output-format json/stream-json` | yes: `codex exec --json` | yes: `opencode run --format json` | **yes (fixed here)**: `-p/--print`, `--output-format text|json|stream-json`; stdout carries only that format; result object with subtype, turns, tool calls, usage, cost, session id, permission denials; exit 0/1/130; task from piped stdin; approvals fail closed instead of hanging on a closed stdin; no terminal bell into pipes | `src/headless.ts`, `src/index.ts:279`, `:541`, `src/config.ts:167`. Tests: `headless.test.ts` (unit + built-binary replay runs) |
| 30 | Provider coverage incl. DeepSeek | Anthropic, Bedrock, Vertex, any Anthropic-compatible URL | OpenAI + any OpenAI-compatible `model_providers` | 75+ via models.dev, OpenCode Zen/Go | **improved here**: openai-codex (ChatGPT subscription; default model now follows `~/.codex/config.toml` because the built-in `gpt-5.4` is rejected for ChatGPT accounts), openai, openrouter (DeepSeek ids refreshed against the live catalog), anthropic, **deepseek** (api.deepseek.com, `DEEPSEEK_API_KEY`, `deepseek-flash` / `deepseek-v4-pro`), **openai-compat** (`--base-url` / `PHREN_AGENT_BASE_URL` + `PHREN_AGENT_API_KEY`: OpenCode Go/Zen, vLLM, LM Studio, Together…), ollama, replay. Unknown `--provider` names now error instead of silently auto-detecting | `src/providers/resolve.ts:60`, `:118`, `src/providers/codex-auth.ts` (`codexConfiguredModel`), `src/models.ts` (deepseek catalog). Tests: `providers-compat.test.ts`, `resolve-provider.test.ts` |
| 31 | Retry / backoff | yes | yes | yes | yes: 429/5xx/network with backoff; no Retry-After header, 504 not retried, streams retried only at open | `src/providers/retry.ts`. Tests: `retry.test.ts`, `abort-retry.test.ts` |
| 32 | LSP / diagnostics | partial (IDE) | no | yes (LSP diagnostics after edits) | partial: post-edit lint/test commands through the permissioned shell; no LSP | `src/agent-loop/index.ts` (post-edit checks), `src/tools/lint-test.ts`. Tests: `post-edit-checks.test.ts` |
| 33 | Launch from the phone | Claude Code yes | Codex yes | OpenCode yes | **no**: the Phren Hook's `launchKinds` does not include phren-agent, so the iPhone/Android app cannot start a new session | Not implemented in this pass by request. A phren-agent started on the computer does appear on the phone (tmux process detection, Herdr session reporting in `src/herdr-hooks.ts`) |

## Top gaps remaining

In rough order of daily-use impact:

1. **No read-before-edit or stale-file guard.** The edit engine makes stale
   edits safe (exact or tightly bounded fuzzy matches), but a model can still
   write_file over a file it never read or that changed on disk.
2. **No LSP diagnostics.** OpenCode feeds type errors back after each edit;
   phren-agent only runs whole lint/test commands.
3. **Sandbox is shell-writes-only.** No network isolation, and macOS is
   opt-in. Codex runs everything under Seatbelt/Landlock by default.
4. **Permission rules are thin.** No declarative allow/deny rules with
   patterns in a settings file, and no `--allowedTools` for headless runs, so
   `-p` is either deny-everything or `--yolo`.
5. **Sessions depend on a phren store.** Without one there is no event log,
   so no resume; the TUI `/resume` still reads the legacy snapshot and has no
   picker.
6. **Hooks are limited to four events** and UserPromptSubmit/Stop can't block
   or inject context; no SessionStart, PreCompact or Notification hooks.
7. **No image paste/attach in the TUI**, only the `read_image` tool.
8. **Steering only lands between tool batches**, not during a long stream;
   there is no `/reasoning` command and `/model` can't change provider.
9. **Subdirectory AGENTS.md files and MCP prompts are not surfaced**; there is
   no default `.mcp.json`-style config.
10. **Web search is a DuckDuckGo HTML scrape**; no provider-native search.

Also: the phone cannot launch phren-agent yet (row 33), and retries ignore the
`Retry-After` header and HTTP 504.

## Benchmark

`scripts/bench/run.mjs` runs the built binary headless
(`--output-format json --yolo --no-subagents`) against the fixture repos in
`scripts/bench/fixtures/`, each copied into a fresh temp git repo with an empty
temporary phren store, and judges the result with the repo's own `npm test`,
byte-identical test files, and (for the rename) a grep for the old name.

| Task | What it checks |
| --- | --- |
| `fix-failing-test` | find and fix an off-by-one in `src/cart.js` without touching tests |
| `rename-symbol` | rename `calcTotal` → `computeTotal` across three files, including a namespace call |
| `add-cli-flag` | add `--json` and unknown-option handling to a small CLI to satisfy existing tests |

```sh
pnpm --filter @phren/agent build
node packages/agent/scripts/bench/run.mjs --self-check          # fixtures fail untouched
node packages/agent/scripts/bench/run.mjs --provider openai-codex --reasoning medium \
  [--model <id>] [--task rename-symbol] [--runs 3] [--output results.json]
```

The harness never picks a provider: paid ones (openrouter, deepseek, anthropic,
openai) cost money per run.

### Results, 2026-09-25

No task results yet. `--self-check` passes: all three fixtures fail their
checks before any agent runs. Two live attempts with the only free provider
available, the openai-codex subscription, never reached a model turn:

1. `gpt-5.4`, the built-in default, returned 400 "model is not supported when
   using Codex with a ChatGPT account". Fixed here: the default now follows the
   Codex CLI's own configured model.
2. `gpt-6-astra` and `gpt-5.6-luna` returned 429 `usage_limit_reached`. The
   ChatGPT Pro weekly window was exhausted and resets in about 9.6 hours. Fixed
   here: a quota 429 now fails at once instead of spending three backoff
   retries.

No paid key (OpenRouter, DeepSeek) was used. The only local Ollama model is an
embedding model. After the Codex window resets, rerun:

```sh
node packages/agent/scripts/bench/run.mjs --provider openai-codex --reasoning medium --output bench.json
```

The earlier opt-in OpenRouter smoke assessment (`ASSESSMENT.md`,
`scripts/assess.mjs`) passed 6 of 6 synthetic tool-use cases with
`deepseek/deepseek-v4.1-flash`.
