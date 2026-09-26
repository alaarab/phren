# phren for Claude Code (plugin)

phren gives Claude Code a memory that lasts between sessions. It recalls
relevant findings from past sessions on every prompt, keeps each project's
context (and, if you turn tasks on, its task queue), and saves what a session learned to a git-backed store
on your machine.

## Install

```
/plugin marketplace add alaarab/phren
/plugin install phren@phren
```

Then restart Claude Code. On first run phren has no store yet; ask Claude to
set phren up (or run `/phren:phren-init`). With your go-ahead it runs
`phren init`, which creates `~/.phren` and wires Claude Code. Restart once more
and memory is live.

Prefer a terminal? `npx -y @phren/cli init` does the same thing, and also wires
Codex, Copilot CLI, Cursor and VS Code if you use them.

## What it brings

| | |
|---|---|
| **Hooks** | SessionStart loads the project's context, UserPromptSubmit injects the findings that match the prompt, PostToolUse notes tool activity, Stop saves and syncs the session. The same four hooks `phren init` writes. |
| **MCP server** | phren's memory tools (`search_knowledge`, `add_finding`, `get_project_summary`, `session`, …; task tools too once `phren modules enable tasks` is on) through `npx -y @phren/cli@<version> mcp`, pinned to the release the plugin ships with. |
| **Skills** | `/phren:phren-init`, `/phren:phren-sync`, `/phren:phren-discover`, `/phren:phren-consolidate`, `/phren:phren-summarize`, `/phren:phren-profiles`. |

`claude plugin details phren` reports about 300 tokens always loaded (the six
skill descriptions); hooks add nothing until they inject memory, and each skill
costs 0.3k to 1.4k tokens only when it runs.

## Plugin and `phren init` together

You can have both; you never get two of anything. `phren init` owns whatever it
wired, and the plugin fills in the rest:

- **Hooks.** Each plugin hook first checks the settings file Claude Code reads
  (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`). If
  `phren init` already runs that event there, the plugin's copy exits without
  doing anything. Remove phren's hooks from settings (`phren hooks-mode off`
  also turns hooks off inside phren, so prefer editing settings or
  `phren uninstall`) and the plugin's copies take over on the next event.
- **MCP server.** If `phren init` registered its own `phren` server in
  `.claude.json`, the plugin's server starts empty, so each tool appears once.

`PHREN_PLUGIN_HOOKS=off` in the environment turns the plugin's hooks off.

## First run and missing pieces

The plugin fails open. With no store, the hooks stay silent (they never run
phren, which would create one), and the MCP server offers a single
`phren_setup` tool: without arguments it explains what setup does, and with
`confirm: true` (only after you agree) it runs `phren init --yes`.

The hooks never start a cold `npx` on a prompt. They use, in order: `$PHREN_BIN`,
a `phren` on `PATH`, the `~/.local/bin/phren` wrapper `phren init` installs, and
finally the copy of the pinned release already in npm's cache (the MCP server
puts it there), run offline. If none is there, the hook does nothing.

Plugin hooks run through `sh`, which Claude Code provides through Git Bash on
Windows.

## Privacy

phren is local-first. The store is a git repository on your machine and nothing
leaves it unless you add a git remote to sync between machines. There is no
account. Usage telemetry is off by default and, when turned on
(`phren config telemetry on`), only keeps local counters; it has no network
upload. Optional features that call out are opt-in and use your own keys or
local services: semantic search through a local Ollama, OpenAI-compatible
embeddings, and LLM-assisted dedup (`PHREN_FEATURE_SEMANTIC_DEDUP`).

## Evals

`evals/` holds a small `claude plugin eval` suite: memory recall from a seeded
store, saving a finding, and adding a task. phren's MCP server is replaced by
fixed mocks (`evals/mocks/phren/`, with the real tool schemas in `_tools.json`),
and each run gets a temporary home, so no store is touched; but every run is a
real model call on your own Claude credential.

```
claude plugin eval . --trust-plugin --runs 1 --no-publish
```

Three cases at one run each, plus the no-plugin baseline arm and the haiku
judge, stay well under a dollar on the default model. Add `--max-cost-usd 1`
for a hard ceiling.

## For maintainers

- The manifests are `.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json`; hooks are `hooks/hooks.json` and
  `hooks/phren-hook.sh`; skills are read straight from
  `packages/cli/starter/global/skills/` (the set `phren init` provisions),
  leaving out `conductor` and `fanout`, which need the Hook and enrolled
  computers.
- The plugin version, the marketplace entry, the MCP server's
  `@phren/cli@<version>` pin and `PHREN_PIN` in `hooks/phren-hook.sh` all equal
  `packages/cli/package.json`'s version; `pnpm run validate-docs` fails
  otherwise, and a release bumps them together.
- Check a change with `claude plugin validate --strict .claude-plugin/plugin.json`
  and `claude plugin validate --strict .claude-plugin/marketplace.json`, then
  `claude plugin details phren` after installing from a local path.
