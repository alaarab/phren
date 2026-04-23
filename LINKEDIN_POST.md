# LinkedIn Post — Phren

---

## Version A — Builder's story (recommended)

Your AI agent has amnesia.

Every new chat, it forgets the weird race condition you debugged last Tuesday. Forgets that your repo uses `pnpm`, not `npm`. Forgets the three gotchas you already walked it through this morning.

So you paste the same context. Again. And again.

I got tired of that. So I built Phren.

Phren is an open-source knowledge layer for AI agents. Findings, tasks, and patterns live as plain markdown in a git repo you control. No database. No vendor. No lock-in.

When you ask your agent a question, hooks search your history, pull the relevant snippets, and inject them into the prompt — before you hit send. You ask; Claude already knows the gotchas.

A few things I'm proud of:

– One install command: `npx @phren/cli init`. Wires up MCP and hooks for Claude Code, Copilot, Cursor, and Codex. Same store, every tool.
– Findings have a lifecycle. You can supersede them, retract them, flag contradictions. Your team's memory gets *more* accurate over time, not less.
– Trust scores decay. Decisions are permanent. Observations expire in 14 days. The model of how knowledge ages is built in.
– Team stores are just git repos. `phren team init`, `phren team join`. Your org's tribal knowledge, finally indexable.

54 MCP tools. FTS5 full-text search with semantic fallback. A fragment graph that actually makes the connections between projects visible.

The bet: memory is the missing layer in agentic coding. Not bigger models. Not longer context windows. A place for your agents to *actually remember*.

`@phren/cli` is on npm. MIT licensed. Link in the comments.

---

## Version B — Punchier, more provocative

Long context windows are a workaround for a missing feature.

The feature is memory.

Your agent doesn't need to re-read your repo every session. It needs to remember what you already taught it. The pitfall in the auth flow. The reason you rolled back that migration. The one library version that doesn't segfault on ARM.

I shipped Phren to do exactly that. Open source. Markdown in a git repo. Works with Claude Code, Copilot, Cursor, and Codex — same store, same knowledge, all four tools.

`npx @phren/cli init` — and your agents stop forgetting.

Findings have a lifecycle (supersede, retract, contradict). Trust decays. Decisions don't. Team stores sync over git. 54 MCP tools under the hood, but you never see them — context just starts flowing.

No database. No SaaS. No vendor lock-in. The knowledge is yours, in files you can grep.

Memory is the layer we skipped. Building it now.

MIT. Link below.

---

## Version C — Short, hook-forward

Every AI coding tool pretends it's the first one you've ever talked to.

Fresh chat, fresh amnesia. You re-explain your stack, your conventions, the gotcha from yesterday's PR. Every. Single. Time.

So I built Phren — persistent memory for AI agents, stored as markdown in a git repo you own.

One command: `npx @phren/cli init`. Works with Claude Code, Copilot, Cursor, Codex — same memory across all of them. Findings, tasks, sessions, team stores. Trust decays over time; decisions don't. Contradictions get surfaced, not hidden.

Open source, MIT licensed, on npm as `@phren/cli`.

The next model won't save you. Memory will.

---

## Notes for posting

- First line is the hook — LinkedIn cuts off around ~210 characters on mobile, so the first sentence has to stand alone.
- Put the link in the first comment, not the post body (LinkedIn de-ranks posts with outbound links).
- Tag relevant accounts sparingly: @Anthropic, @GitHub (for Copilot), @Cursor — only if you want the engagement surface.
- Good hashtags (pick 3): #AIEngineering #DeveloperTools #OpenSource #MCP #ClaudeCode
- If you post a screenshot, use the fragment graph — it's the most visually distinctive thing in the project.
