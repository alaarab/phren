# Account usage: screen design

Status: approved direction, September 21. Owner: "the usage needs to be
better". Screen: `AccountUsageView.swift` (cards), `AccountUsageRings.swift`
(rings and `AccountUsagePresentation`), data from
`PhrenKit/Sessions/MergedAccountUsage.swift`.

## 1. What is wrong today

- Go rows read "opencode-...-v4.1-flash" with "$0.21 · $0.66 · $0.66" and a
  tiny ring: truncated id, three unlabelled numbers, a control too small to
  read.
- "Updated 6 sec ago" appears under every card.
- OpenCode "$11.90" and OpenCode Go "$3.29" look like two bills. They are
  not: OpenCode is an estimate OpenCode records from local sessions; Go is
  what the plan meters.
- OpenRouter at $0.00 takes a whole card.
- The Claude card names no account, and its limits (the ones that stop the
  owner working) are the same size as everything else.

## 2. Layout, top to bottom

1. **Top bar**: back chevron, "Account usage", refresh. Under the title one
   subtitle line: "Updated 6 s ago · Desk, Linuxbox" (the newest report and
   the computers that reported). No per-card "Updated" lines.
2. **Claude card** first and largest. Header: "Claude" and the account
   name (the Hook reports the signed-in email or handle; show what it
   reports, muted, right-aligned). Three limit lines, each: name left, percent
   right in `PhrenTypography.title3.monospacedDigit`, a 6pt bar under, and
   under the bar in caption "resets in 3 h 5 m". Order: 5-hour, 7-day Fable,
   7-day all models. A bar over 80 percent uses `PhrenTheme.warning`, over 95
   `PhrenTheme.danger`; otherwise the accent.
3. **Codex card**: same shape as Claude, one or two lines.
4. **OpenCode Go card**. Header: "OpenCode Go" and "billed" as a muted chip.
   One line "Past 30 days $3.29" in title3. Then one block per model:
   model name in words ("DeepSeek v4.1 flash", "GLM 5.3 flash": strip the
   `opencode-go/` prefix, replace `-` and `_` with spaces, keep version
   numbers), then three window lines "5h $0.21 of $0.80", "7d $0.66 of
   $2.00", "30d $0.66 of $4.00", each with the 6pt bar; "of" omitted when the
   plan reports no limit. No ring.
5. **OpenCode card**. Header: "OpenCode" and "estimate" as a muted chip.
   One line "Past 7 days $11.90" and one caption "Recorded by OpenCode from
   local sessions; not a bill."
6. **OpenRouter**: when the week's charge is 0, one row "OpenRouter · $0.00
   this week" with no card body. Otherwise the same shape as OpenCode with
   "billed".
7. Footer caption, once: what each source means, in three short sentences.

Cards use `sessionCard()`, 12pt padding, 8pt between cards. Every window
line is 44pt tall. Stale data (older than the newest report by more than
ten minutes) shows a small amber dot before the card title and the caption
"snapshot from 1 d 4 h ago" under the header; no "Last reported" badge.

## 3. Data

`MergedAccountUsage` already merges windows across computers and computes
Go percent from `usedUSD / limitUSD`. Add the model name formatting and the
"billed / estimate" classification in `AccountUsagePresentation`
(`modelTitle(_:)`, `billing(for source:)`), and the account name from the
`accountId` or a new optional `accountName` the Hook may send (fall back to
nothing; never invent one).

## 4. Identifiers (keep the tests compiling)

Keep `account-usage:<source>`, `usage-primary-window:<source>`,
`usage-window:<source>:<id>`, `usage-window-caption:<id>`,
`usage-spend:<source>`, `usage-go-model:<name>`. The subtitle line is
`usage-updated`. The OpenRouter one-liner is `account-usage:openrouter`.

## 5. Controls

phren's own only: `sessionCard()`, `PhrenChip` for "billed" and
"estimate", a plain `Capsule` bar (no `ProgressView`), `PhrenTypography`
and `PhrenTheme` tokens. No native controls.
