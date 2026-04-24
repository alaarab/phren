# linkedin post — phren

three drafts, all lowercase, all trying to sound like a person and not a press release.

---

## draft 1

i had the same conversation with claude four times yesterday.

same repo. same question about the auth flow. same explanation from me about the legacy cookie we can't kill yet. every new chat i'm the living documentation and honestly it's making me feel crazy.

so i built a thing. it's called phren. it gives your agent memory.

that's it. that's the pitch. markdown files in a git repo you own, some hooks that search what you've already taught it, and suddenly claude walks into the conversation already caught up. works with copilot and cursor and codex too, same memory across all of them.

`npx @phren/cli init` and you're done.

no database. no saas. no waitlist. no "book a demo." i don't want to book a demo with anyone ever again in my life.

it's open source, mit, on npm as `@phren/cli`. if you try it and something's broken please tell me, that's the whole point of putting it out there.

link's in the comments because linkedin hates outbound links.

---

## draft 2

longer context windows are not memory. we keep acting like they are and it's driving me a little nuts.

context is the thing you paste in. memory is the thing it already knew. every agent i use is stuck in paste-it-in mode and i've been doing it so long i forgot how dumb it is.

so i shipped phren. open source memory layer for ai agents. plain markdown in a git repo you control, one command to install, works across claude code, copilot, cursor and codex. same memory, all four tools.

the part i like most: findings have a lifecycle. you can supersede them, retract them, flag contradictions. so the bad advice from six months ago doesn't follow you around forever. trust decays. decisions stick. it's a tiny thing but it matters a lot once you have more than like fifty notes.

`npx @phren/cli init`. mit. on npm as `@phren/cli`. link below.

would love for people who've actually felt this pain to try it and tell me what sucks about it.

---

## draft 3 — the short one

my agent has amnesia and i'm tired.

built a fix. it's called phren. memory for ai agents, stored as markdown in a git repo you already own. claude, copilot, cursor, codex — one store, all four.

`npx @phren/cli init`

open source. mit. link in comments. try it, break it, tell me.

---

## notes

- first line carries the whole post. linkedin truncates around 210 chars on mobile, so whatever you want them to click on has to live up there.
- link in the first comment, not the body. linkedin throttles outbound links.
- before posting, swap the auth-flow story in draft 1 for something that actually happened to you this week. the post works because that bit is true.
- post tuesday–thursday morning, reply to every comment in the first hour.
- one screenshot helps. fragment graph or the session-start output where prior context auto-loads is the aha moment.
