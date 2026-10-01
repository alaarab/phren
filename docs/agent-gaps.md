# phren agent: gaps against Claude Code, Codex CLI, OpenCode and DeepSeek Harness

Written 2026-10-01 against `@phren/agent` 0.3.20; the Status section tracks the fixes since. This compares `packages/agent`
with the four harnesses people use for the same work, lists what phren agent is
missing, and ranks the gaps by how much they hurt real coding sessions. It
replaces the open items in `packages/agent/PARITY.md` (2026-09-25) and folds in
the two independent analyses run on 2026-10-01 (Claude Opus and Codex GPT-6.1
Sol).

Reference versions: Claude Code 2.1.286, Codex CLI 0.159.3, OpenCode 1.18.34
(all 2026-09-30), and DeepSeek Harness (`dsh`, developer preview since
2026-08-13). Competitor cells summarize their public docs; they were not
re-tested tool by tool. Phren cells cite code under `packages/agent/src/`.

## Already fixed in 0.3.20

These were the top gaps a week ago and are in `main` now:

- DeepSeek thinking replay: `reasoning_content` goes back on every assistant
  turn when tools are present, so a second turn or a resume no longer 400s.
- Tool history stays valid after truncation, `max_tokens` and compaction;
  incomplete streams fail and are retried instead of passing as success.
- Model catalogue: DeepSeek Flash and Go have the 1M window and real prices;
  `--context-window` and `--price-in|out|cache` cover anything else, scoped to
  the model they were given for.
- Cached tokens are counted and priced for DeepSeek, OpenAI and Anthropic
  (cache writes at 1.25x), including subagents.
- Shell: output over 100 KB keeps head and tail and spills the rest to a file
  instead of failing the command; 2-minute default, 10-minute cap; foreground
  process groups die with the agent.
- The 75% "context flush" prompt that ended tasks early is gone.
- Retries: mid-stream failures, 504, `Retry-After`, Anthropic
  `overloaded_error`; malformed tool JSON gets an error result instead of
  running with `{}`.
- Subagents inherit the parent's provider, model and endpoint.

## Comparison

| Area | Claude Code | Codex CLI | OpenCode | DeepSeek Harness | phren agent |
| --- | --- | --- | --- | --- | --- |
| Editing | Read, Edit (unique or `replace_all`), Write; refuses to edit a file it hasn't read or that changed since | `apply_patch` only (freeform grammar tool) | read, edit with fuzzy fallbacks, write, `apply_patch` for GPT models; LSP diagnostics after edits | file editing | Tolerant edit engine, `multi_edit`, atomic multi-file `apply_patch`, short result excerpts. **No read-before-write or stale-file guard; no diagnostics after edits** |
| Context and compaction | Auto-compact near the limit from real token counts, `/compact [focus]`, clears old tool results, re-reads recent files after compacting | `/compact`, token-limit config, remote compaction | Auto-compact plus pruning of old tool outputs | not documented | LLM checkpoint at 75% with regex fallback, compact and retry on overflow, `/compact`. **Trigger is a chars/4 estimate, never the provider's reported prompt size; old tool output is never cleared short of a full compaction; `/compact` takes no focus** |
| Permissions | allow / ask / deny rules with patterns in settings, `--allowedTools` / `--disallowedTools`, modes incl. `acceptEdits` (edits only) and a classifier `auto` | approval policy plus sandbox mode, Starlark `prefix_rule` exec policy | allow / ask / deny per tool with globs, last match wins | approval policies | Four modes, regex blocklist, session/persistent allowlist by first token. **`auto-confirm` runs any shell command the blocklist misses (`rm -rf src`, `git push`, `npm publish`); `--yolo` still asks on `$(…)` and `env`, which headless runs deny; the model can spawn a `full-auto` child from a stricter session; no declarative rules or `--allowedTools`** |
| Sandbox | Seatbelt / bubblewrap with network proxy and domain allowlist | Seatbelt / bubblewrap + seccomp, network off by default | none by design | sandbox plugins | bwrap write fence on Linux by default, macOS opt-in, no network isolation |
| Search | ripgrep-backed | shell `rg` | ripgrep grep and glob | file search | **JS walk: ignores `.gitignore`, skips every dotdir (`.github`), stops silently at 5,000 files, case-insensitive by default** |
| System prompt | Environment block (cwd, OS, date, git) | Environment context incl. sandbox and approval policy | Environment block | — | **No cwd, OS, date or git state; tool list out of date (no `multi_edit`, `apply_patch`, `spawn_agent`)** |
| Tools | Bash with background + Monitor, WebFetch, WebSearch, Task, Todo | PTY `exec_command`, `write_stdin`, `web_search`, `update_plan` | bash, webfetch, websearch, task, todowrite | shell, search, plans | shell with background tasks, `web_fetch` (SSRF guard), `web_search` (DuckDuckGo HTML scrape), `update_plan`, git tools, `read_image` |
| MCP | stdio / HTTP, OAuth, `.mcp.json` scopes, output cap | stdio / HTTP, OAuth | local / remote, OAuth | — | stdio / http / sse, OAuth PKCE, resources. **No default project config, prompts not surfaced, no output cap** |
| Subagents | Agent tool, background, worktree isolation | spawn / send / wait / resume / close | task (sequential) | subagents | `spawn_agent` (types, worktree), send, list, multi-agent TUI |
| Sessions / resume | `-c`, `-r`, picker, fork, conversation rewind | `resume`, `fork` | `-c`, `-s`, `--fork`, revert | sessions plugin | `-c`, `--session`, `--list-sessions`, `/fork`, code `/rewind`. **Needs a phren store; TUI `/resume` reads only the legacy snapshot; no conversation rewind** |
| Hooks | ~30 events, can block and inject | ~12 events incl. PermissionRequest and compaction | JS plugins | everything is a plugin | 4 events; only PreToolUse can block |
| Headless | `-p`, text / json / stream-json in and out, `--json-schema`, SDK | `exec --json`, `--output-schema`, app-server | `run --format json`, `serve`, ACP | web UI | `-p`, text / json / stream-json out. No stream-json input, no output schema |
| Providers | Anthropic, Bedrock, Vertex, gateways | OpenAI / ChatGPT, Responses-wire providers | 75+ via models.dev | DeepSeek, Anthropic, OpenAI-compatible | ChatGPT/Codex subscription, OpenAI, OpenRouter, Anthropic, DeepSeek, any OpenAI-compatible URL, Ollama. Catalogue is hand-maintained |
| Cost | `/usage` incl. cache, OpenTelemetry | `/status`, OpenTelemetry | `opencode stats` | — | Status bar ctx% and cost, `/cost`, `--budget`, cache-aware since 0.3.20 |
| UX | Statusline, vim mode, image paste, background tasks | Fullscreen TUI, voice | TUI, web, desktop | web UI | Ink TUI with steer/queue, approval panel, diffs, themes, model picker. No image paste, no `/reasoning`, `/model` can't change provider |

## Where phren agent is ahead

- **Memory shared across harnesses.** Every session starts with the project's
  truths, tasks, findings and last-session summary from the same store Claude
  Code, Codex and OpenCode sessions write to, and compaction promotes what it
  learns into findings instead of throwing it away.
- **Edit tolerance.** Exact match first, then CRLF-, whitespace- and
  indentation-tolerant matching that re-indents, recovery of pasted line-number
  prefixes, nearest-region errors, atomic `multi_edit` and multi-file
  `apply_patch`. Cheaper models that copy text imperfectly fail less here than
  in Claude Code's strict Edit, and edits are reversible through `/rewind`.
- **Phone and Hook integration.** Launch, live transcript and prompts from the
  iPhone and Android apps.
- **A testable core.** The session event log has a reconstruct invariant, the
  keyless `replay` provider drives the real binary in tests, and headless
  output matches Claude Code's.

## Gaps, ranked by impact

Impact is how often the gap costs a real session (a wrong result, lost work, a
stop that needs a human) times how bad that is.

1. **Permissions don't mean what their names say.**
   - `auto-confirm` (`permissions/checker.ts`) allows every shell command
     that no blocklist regex matches, so `rm -rf src`, `git push` and
     `npm publish` run unprompted. Claude Code's equivalent, `acceptEdits`,
     auto-approves edits only.
   - `--yolo` turns the blocklist's "warn" patterns (`$(…)`, backticks,
     `env`, `sudo`, `git reset --hard`) into asks, and a headless run denies
     every ask, so `--yolo -p` refuses everyday shell and benchmark failures
     that are not the model's fault.
   - `spawn_agent` is auto-allowed in `auto-confirm` and takes a
     `permissions` argument, so the model can start a `full-auto` child from
     a `suggest` or `auto-confirm` session.
   - Approving `git` for the session approves `git push --force` too.
   - No declarative allow / deny rules and no `--allowedTools`, so a scripted
     run is either everything or almost nothing.
2. **No read-before-write or stale-file guard.** `write_file` overwrites a file
   the model never read, and `edit_file` / `multi_edit` / `write_file` proceed
   on a file the user or a formatter changed since the model last read it. The
   edit engine keeps a stale `old_string` from matching the wrong place, but
   a whole-file write silently discards the other change. Claude Code refuses
   both cases with an error that tells the model to read first.
3. **Compaction runs on a guess.** The 75% trigger uses chars/4 even though
   every provider reports the real prompt size on each response. Code and
   JSON tokenize denser than 4 chars per token, so sessions reach the window
   before compacting and lean on the overflow-and-retry path. Large old tool
   outputs (file reads, test logs) stay verbatim until a full compaction, and
   `/compact` can't be told what to keep.
4. **Search misses files and floods results.** `grep` and `glob` walk the tree
   in JS, read `dist/`, `build/` and `coverage/`, skip `.github/`, stop at
   5,000 files without saying so ("No matches." can be false on a monorepo)
   and match case-insensitively by default.
5. **The system prompt doesn't say where the agent is.** No cwd, OS, date,
   branch or permission mode, and the tool list omits `multi_edit`,
   `apply_patch`, `spawn_agent`, `task_output` and `read_image`. Weaker models
   guess paths and pick the wrong edit tool.
6. **Plan mode can't look.** The planning turn gets no tools at all, so the
   plan is written without reading the code. Claude Code and OpenCode plan
   with read-only tools.
7. **No diagnostics after edits.** OpenCode feeds type errors back from LSP
   after each edit; phren agent only runs whole lint / test commands when
   configured.
8. **Sessions depend on a phren store.** Without one there is no event log
   and no resume; the TUI `/resume` has no picker; there is no conversation
   rewind.
9. **MCP and hooks are thin.** No `.mcp.json`-style default config, no MCP
   prompts, no cap on MCP tool output; hooks cover 4 events and only
   PreToolUse can block or inject.
10. **Headless can't be driven.** No stream-json input for multi-turn runs and
    no output schema.
11. **Smaller UX gaps.** No image paste, no `/reasoning`, `/model` can't
    change provider, steering lands only between tool batches, web search is
    an HTML scrape, no network isolation in the sandbox, no OpenTelemetry.

## Status

Fixed in the 2026-10-02 train, one PR each:

| Gap | Fix | PR |
| --- | --- | --- |
| 1 Permissions | `auto-confirm` runs only read, build and test commands; `--yolo` allows warn patterns; a subagent never exceeds its parent's mode; approvals scoped to the subcommand | #296 |
| 1 Permissions | `permissions.allow / ask / deny` rules in settings files, `--allowedTools`, `--disallowedTools` | #300 |
| 2 Stale writes | Read-before-write and stale-file guard on every write tool | #290 |
| 3 Compaction | Context measured from the provider's token count; old tool output cleared before compacting; compaction request carries the tools; `/compact <focus>` | #293 |
| 4 Search | `grep` / `glob` on ripgrep with `.gitignore`, hidden directories searched, truncation reported, case-sensitive | #291 |
| 5 System prompt | Environment block and the registered tool list | #292 |
| 6 Plan mode | Plans with the read-only tools; approval once the plan is presented | #299 |
| 7 Diagnostics | Syntax check after each edit (TypeScript / JavaScript, Python, JSON) | #301 |
| 8 Sessions | Resumable sessions without a phren store | #302 |
| 9 MCP | `~/.phren-agent/mcp.json` by default, a trusted project's `.mcp.json`, output cap | #303 |
| 9 Hooks | Exit 2 blocks `UserPromptSubmit` and `Stop`, `PostToolUse` feedback, `SessionStart` and `PreCompact` | #304 |
| 10 Headless | `--input-format stream-json` for multi-turn runs | #305 |

Still open, in order: type errors after edits (an LSP client; the syntax check
covers parse errors only), MCP prompts, an output JSON schema for headless
runs, a `/resume` picker in the terminal UI, and the smaller UX gaps in 11
(image paste, `/reasoning`, `/model` across providers, mid-stream steering,
provider-native web search, network isolation, OpenTelemetry).

## DeepSeek V4.1 Flash readiness

Ready for a live run. `src/__tests__/deepseek-e2e.test.ts` drives the real
loop and provider, for `--provider deepseek` and for the OpenCode Go route
(`openai-compat` with `deepseek-v4.1-flash`), against a fake endpoint as strict
as DeepSeek's documented API: with tools present every earlier assistant
message must carry `reasoning_content`, every tool call must be answered
before the next message and no result may answer a call that wasn't made, and
`reasoning_effort` must be a level DeepSeek takes. One session runs a tool
turn, a plain answer, a resume from the persisted log, a stream that drops
mid-answer, a compaction and a turn after it. Every request passes; the
dropped stream is asked again and its half answer never reaches the history;
`reasoning_effort` goes out as `high`; and with 90% cache hits the cost matches
the catalogue's miss, hit and output prices. Removing the reasoning replay
makes it fail with DeepSeek's 400.

Run it single-agent first:

```sh
# DeepSeek API
DEEPSEEK_API_KEY=… phren-agent --provider deepseek --model deepseek-flash --reasoning high --no-subagents
# OpenCode Go
PHREN_AGENT_BASE_URL=https://opencode.ai/zen/go/v1 PHREN_AGENT_API_KEY=… \
  phren-agent --provider openai-compat --model deepseek-v4.1-flash --reasoning high --no-subagents
# the benchmark fixtures, one run each
PHREN_AGENT_BASE_URL=https://opencode.ai/zen/go/v1 PHREN_AGENT_API_KEY=… \
  node packages/agent/scripts/bench/run.mjs --provider openai-compat --model deepseek-v4.1-flash --reasoning high --runs 1
```

Not verified without a key: DeepSeek's live behaviour beyond its docs, and the
peak-hour price (the catalogue uses off-peak rates; pass `--price-*` for peak).
