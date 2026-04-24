# LinkedIn Post — Phren

Three human-voice drafts. Pick one, tweak a line or two so it sounds like *you*, post.

---

## Draft 1 — The rant

I had the same conversation with Claude four times yesterday.

Same repo. Same question about why our auth flow is weird. Same explanation from me about the legacy session cookie we can't kill yet. Every new chat, a blank slate. Every new chat, I'm the living documentation.

It's 2026. My agent should not be dumber than my intern.

So I built Phren. It's a memory layer for AI agents — just markdown files in a git repo you own. When you ask Claude (or Copilot, or Cursor, or Codex) something, it searches what you've already taught it and quietly injects the relevant stuff before the prompt goes out.

Nothing fancy. No database, no SaaS, no "sign up for our waitlist." One command:

`npx @phren/cli init`

That's it. Your agent stops forgetting.

A couple things that make it not suck:

Findings have a lifecycle. You can supersede them, retract them, flag contradictions. So when you change your mind about something, the old advice doesn't haunt you forever. Trust scores decay. Decisions stick. Random observations expire after two weeks.

Team stores are just git repos. You `phren team init`, your coworkers `phren team join`, and suddenly the tribal knowledge in your head is searchable by everyone's agent.

It's MIT. It's on npm as `@phren/cli`. I'd love for you to try it and tell me what's broken.

Link in comments.

---

## Draft 2 — The take

Everyone's racing to ship a bigger context window. Nobody's shipping memory.

There's a difference. Context is what you paste in. Memory is what the thing already knows. Every agent I use is stuck in the paste-it-in loop — and it's the dumbest, most expensive workflow I've ever gotten used to.

I built Phren because I got sick of it.

It's a knowledge layer for AI agents. Findings, tasks, patterns — all stored as markdown in a git repo you control. When you prompt your agent, Phren finds what's relevant from everything you've taught it before, and injects it into the request. Your agent walks into the conversation already caught up.

One install: `npx @phren/cli init`. Works across Claude Code, Copilot, Cursor, and Codex — same memory, all four tools. No lock-in, no database, no vendor doing weird things with your repo.

Findings can supersede each other. They can retract. They can contradict, and the system surfaces the conflict instead of burying it. Your team's institutional knowledge gets more accurate over time, not less.

MIT licensed. On npm. Been building it in public for a while. Would love feedback — especially the "this is broken" kind.

Comments have the link.

---

## Draft 3 — The short one

We got longer context windows and called it memory. It's not.

Memory is the thing where your agent remembers, at the start of a new chat, that last week you told it the migration script on staging needs the `--skip-locks` flag or it hangs. Context is you retyping that sentence for the 40th time.

Built a thing to fix this. It's called Phren. Open source. Markdown in a git repo you own. Works with Claude Code, Copilot, Cursor, Codex — same memory across all of them.

`npx @phren/cli init`

Would mean a lot if you tried it. Even more if you broke it and told me how.

Link's in the comments. MIT.

---

## Posting notes

- LinkedIn cuts off around the 210-char mark on mobile. The first sentence has to carry the click.
- Put the link in the first comment. Posts with outbound links get throttled.
- Don't post on a weekend. Tuesday-Thursday, 8-10am your audience's local time.
- One image > no image. Screenshot the fragment graph or the "session start" output where it shows prior context auto-loading — that's the aha moment.
- Reply to every comment in the first hour. The algorithm rewards early engagement.
- Hashtags are mostly theater on LinkedIn now, but pick 2-3 if you want: #DeveloperTools #OpenSource #AIEngineering.
