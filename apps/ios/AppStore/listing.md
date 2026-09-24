# App Store listing copy

Everything App Store Connect asks for, written out. Character limits are
enforced by App Store Connect — counts below are current as written.

---

## App name (30 max)

**Primary choice** — 29 chars:

```
phren — AI agent memory
```

Fallbacks if the name is taken or rejected:

- `phren: agent memory` (19)
- `phren — memory for agents` (25)

Do **not** name it anything containing "notes", "tasks", or "to-do". The
name is the strongest signal reviewers and browsers use to categorise the
app, and this app is a developer tool, not a list app.

## Subtitle (30 max)

**Primary** — 29 chars:

```
Explore what your agents know
```

Alternatives:

- `Control your agent's memory` (27)
- `Your AI coding agent's memory` (29)
- `Govern what your agents learn` (29)

## Primary category

**Developer Tools**

This is the single most important positioning decision. Productivity puts
the app next to to-do lists and invites the "another AI notes app"
reading. Developer Tools sets the right expectation for both browsers and
App Review.

Secondary category: **Productivity** (optional; only if a secondary is
required — it costs nothing and widens discovery).

## Promotional text (170 max, editable without a new build)

```
Explore your agents' memory, check their sessions, and add direction from
your phone. Your knowledge stays in a Git repository you own.
```

## Description (4000 max)

```
phren is the companion app for phren, an open-source knowledge layer for
AI coding agents (npm: @phren/cli).

Your agents accumulate knowledge as they work — architectural decisions,
pitfalls, patterns that only show up once you've hit them. phren stores
that knowledge as markdown in a git repository you own. This app is how
you explore it while you're away from your desk.


MEMORY AND AGENTS AT A GLANCE

Explore connected findings in a memory graph, manage skills and project
instructions, and search what your agents know. The Agents tab can read
live Herdr sessions through an optional SSH connection to your computer's
Moshi hook. No Phren gateway is required.

Open a live tab directly in Moshi, or let phren find a project's session
from its working directory. Choose between real sessions when several match.

Your agents capture and use memory while they work. Optional maintenance
groups candidates, stale memories, and conflicts by project. Copy a request
into your agent conversation, or select entries to manage yourself.
You do not need to review every agent action.


CAPTURE WITHOUT OPENING THE APP

Ask Siri to add a task or note, even from the Lock Screen. Or dictate into
the app with live on-device transcription. Everything is written to your
store and synced to git — phren always tells you which project it went to,
and asks when it isn't sure.


IT'S YOUR REPOSITORY

There is no phren account, no phren server, and no phren backend. The app
talks directly to the GitHub API using a token you provide, stored only in
this device's Keychain. Your knowledge lives in your repo, in plain
markdown, readable and editable by anything.


WORKS OFFLINE, HONESTLY

Every edit applies instantly to a local cache and queues for sync. Write on
the subway; it lands when you surface. Conflicts refetch and retry, and
anything that can't be resolved is shown to you rather than silently
dropped.


ALSO INCLUDED

• Findings, notes, tasks and summaries for every project in your store
• On-device search across everything, no network round trip
• Multiple stores — personal and team repositories side by side, with
  badges so you always know which repo you're writing to
• Active tasks at a glance, with a separate searchable backlog and full details
• Home Screen and Lock Screen widgets for your memory count and top task
• Live sync — new findings appear within seconds while an agent works on
  another machine

phren the CLI is free and open source. This app requires an existing phren
store in a GitHub repository.
```

## Keywords (100 max, comma-separated, no spaces after commas)

```
agent,memory,ai,coding,developer,knowledge,markdown,git,github,claude,llm,notes,devtools,sync
```

98 chars. Do not repeat words already in the app name or subtitle — App
Store Connect indexes those separately, so repeating them wastes budget.

## Support URL (required)

```
https://alaarab.github.io/phren/support.html
```

Publish `support.md` from this folder to that path (see the file's header
for the one-line instruction).

## Marketing URL (optional)

```
https://alaarab.github.io/phren/
```

## Privacy policy URL (required)

```
https://alaarab.github.io/phren/privacy.html
```

Publish `privacy-policy.md` from this folder to that path.

## Age rating

**4+**. No objectionable content of any kind. Answer "None" to every
content question. The one question worth care: unrestricted web access —
the app does not embed a browser, so answer No.

## Copyright

```
2026 Ala Arab
```

## Version

`1.0.0`

## What's New in This Version (first release)

```
First release.
```
