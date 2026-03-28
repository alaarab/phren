<p align="center"><img src="docs/phren-transparent.png" width="180" alt="phren"></p>

<h3 align="center">Your agents forget everything. Phren doesn't.</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/@phren/cli"><img src="https://img.shields.io/npm/v/%40phren%2Fcli?style=flat&labelColor=0D0D0D&color=7C3AED" alt="npm version"></a>
  <a href="https://github.com/alaarab/phren/blob/main/LICENSE"><img src="https://img.shields.io/github/license/alaarab/phren?style=flat&labelColor=0D0D0D&color=7C3AED" alt="license"></a>
  <a href="https://alaarab.github.io/phren/"><img src="https://img.shields.io/badge/docs-alaarab.github.io%2Fphren-7C3AED?style=flat&labelColor=0D0D0D" alt="docs"></a>
  <a href="https://alaarab.github.io/phren/whitepaper.pdf"><img src="https://img.shields.io/badge/whitepaper-PDF-7C3AED?style=flat&labelColor=0D0D0D" alt="whitepaper"></a>
</p>

<p align="center">
Every time you start a new session, your AI agent forgets everything it learned. Phren fixes that. Findings, decisions, and patterns persist as markdown in a git repo you control. No database, no hosted service, no vendor lock-in.
</p>

---

## Install

```bash
npx @phren/cli init
```

That single command creates `~/.phren`, wires up MCP, installs hooks, and gives your agents a memory they can actually keep. Re-running on a new machine with an existing remote picks up right where you left off.

## What phren tracks

- **Findings**: bugs hit, patterns discovered, decisions and their reasoning. Tagged by type (`[pattern]`, `[decision]`, `[pitfall]`, `[observation]`) with per-type decay rates
- **Fragments**: named concepts (auth, build, React) that connect findings across projects. Search for a topic and phren pulls in everything linked to that fragment
- **Tasks**: work items that persist across sessions with priority, pinning, and GitHub issue linking
- **Sessions**: conversation boundaries with summaries and checkpoints, so the next session picks up where the last one left off
- **Skills**: reusable slash commands you teach phren. Drop them in `~/.phren/global/skills/` and they work everywhere

## How it works

- **Surfaces relevant context on every prompt** via hooks. Agents build on what they know instead of starting fresh
- **Trust scores decay over time.** Old findings lose confidence. Decisions never decay. Observations expire in 14 days
- **Syncs across machines** through git push/pull. No coordination service
- **Works with Claude Code, Copilot, Cursor, and Codex.** One store, every agent
- **Shell and web UI** for browsing, searching, and triaging (`phren` or `phren web-ui`)

## Quick start

```bash
npx @phren/cli init          # set up phren (interactive walkthrough)
```

Init detects your tools, registers MCP servers, and installs lifecycle hooks. After it finishes, open a prompt in any tracked project. Phren is already injecting context.

To add a project later, run `phren add` from that directory. To browse what phren knows, run `phren` to open the interactive shell.

## Team stores

Phren supports shared team knowledge repos alongside your personal store. A team store is a separate git repo that multiple people push to. Findings, tasks, and skills saved there are visible to everyone on the team.

Create a team store:

```bash
phren team init my-team --remote git@github.com:org/phren-team.git
phren team add-project my-team my-project
```

Join an existing team store:

```bash
phren team join git@github.com:org/phren-team.git
```

Each team store syncs independently. Run `phren team list` to see all registered stores.

### Filtering Team Store Projects

Subscribe to only the projects you care about:

```bash
phren store subscribe qualus-shared arc intranet ogrid
phren store unsubscribe qualus-shared dendron powergrid-api
```

Unsubscribed projects still exist in the store but won't appear in search, UI, or context injection.

---

MIT License. Made by [Ala Arab](https://github.com/alaarab).
