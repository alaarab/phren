# Schedules: screen design

Scheduled prompts run on a chosen computer, in a project, with a chosen
harness and model. This document is the complete visual and interaction
design; implementation follows it without inventing controls. Everything is
built from phren's own components. No `Form`, `List` section chrome,
`Picker`, `Toggle`, `DatePicker`, `Stepper`, `Menu` or `contextMenu` is
used anywhere on these screens.

Shared control measurements and migration rules: [controls.md](controls.md).

Components used (all existing unless marked new):

| Component | Where it lives | Used for |
|---|---|---|
| `sessionCard()` | SessionCardContent.swift | every list row: a flat rounded fill, no border, no separators |
| `plainListSectionLabel()` | SessionCardContent.swift | upper-case section labels |
| `PhrenIconSegment` | PhrenChrome.swift | the schedule-type segment (interval, daily, weekly, once, cron) |
| `PhrenChip` | PhrenChrome.swift | computer, harness and model chips on rows |
| `PhrenCountBadge` | PhrenChrome.swift | counts beside section labels |
| `PhrenMetadataHeader` | PhrenChrome.swift | the header of the history screen |
| `PhrenOptionRow` | PhrenControls.swift | single-choice rows (computer, harness, model, project) |
| `PhrenTimelineRail` | PhrenChrome.swift | the run history rail |
| `PhrenSwitch` | PhrenControls.swift | on/off: a 44x26 capsule, `PhrenTheme.accentSolid` when on, `PhrenTheme.surfaceRaised` when off, a 22pt white knob that slides with a 0.18 s ease; `.accessibilityAddTraits(.isToggle)` |
| `PhrenTimeField` (new) | Schedules/ScheduleControls.swift | a 24-hour time: two monospaced number fields "07" ":" "30" in one 44pt capsule; tapping opens the numeric keypad; values clamp on commit |
| `PhrenDurationField` (new) | Schedules/ScheduleControls.swift | an interval: a number field and a unit segment (min, h, d) in one 44pt capsule |
| `PhrenDateField` (new) | Schedules/ScheduleControls.swift | a date and time for `once`: three fields "2026-09-21" "09" ":" "30" in one row, numeric keypads, validated on commit; no wheel |
| `PhrenCodeField` (new) | Schedules/ScheduleControls.swift | monospaced multi-line text on `PhrenTheme.surfaceRaised`, radius 12, 16pt padding, grows with content up to 12 lines then scrolls |

Tokens: colours and fonts only through `PhrenTheme` and `PhrenTypography`.
Spacing: `PhrenTheme.Space` (4, 8, 12, 16, 24). Radius: `PhrenTheme.Radius`
(10, 12, 14, 18, pill). Touch targets: 44pt minimum. Dynamic Type: rows grow;
at accessibility sizes the row's second line wraps instead of truncating.

## 1. Entry points

**Project detail.** A "Schedules" row directly under the Knobs row, drawn
exactly like the Skills and Knobs rows (44pt, `PhrenTheme.surface`, radius
12, `Label("Schedules", systemImage: "clock.badge.checkmark")`, trailing
muted text, chevron). Trailing text: "None" when empty; "2" plus a middle
dot plus the soonest next run in words ("2 · 07:30", "3 · in 4h", "1 · paused")
otherwise. Identifier `project-schedules-row`.

**Agents tab.** A toolbar button `clock.badge.checkmark` at the trailing end
of the Agents navigation bar opens the all-projects list. Identifier
`schedules-all`.

## 2. Schedules list (`SchedulesView`)

Navigation title "Schedules" (inline). Trailing toolbar button `plus`
(identifier `schedule-add`) opens the editor as a sheet.

Body: a `ScrollView` with a `LazyVStack(spacing: 6)` and 14pt side margins,
`PhrenTheme.bg` behind. Sections (only when the list is opened for all
projects): one `plainListSectionLabel()` per project name, with a
`PhrenCountBadge`. Inside a project, rows are ordered: enabled by next run
ascending, then paused, then once-schedules already run.

**Row** (`ScheduleRow`, `sessionCard()`, 12pt padding, identifier
`schedule-row:<id>`, whole row tappable to open the editor):

```
● Nightly test sweep                              in 4h
  Desk · Codex · gpt-5.6-sol
  Daily at 07:30                                  ✓ 2h ago
```

- Line 1: an 8pt state dot (`PhrenTheme.stateWorking` when a run is in
  progress, `PhrenTheme.stateDone` when enabled and idle, `PhrenTheme.textDim`
  when paused, `PhrenTheme.stateWaiting` when the last run failed), the name in
  `PhrenTypography.subheadline.weight(.semibold)` `PhrenTheme.text`, one line,
  tail truncation, `layoutPriority(1)`; trailing the next run in
  `PhrenTypography.caption` `PhrenTheme.textMuted` ("in 4h", "tomorrow 07:30",
  "paused", "done" for a spent once-schedule, "not here" when the schedule
  names a computer that is not connected).
- Line 2: three `PhrenChip`s: computer (role `.host`, `desktopcomputer`
  symbol), harness (role `.type`, the provider glyph name as text: "Claude",
  "Codex", "OpenCode"), model (role `.type`, monospaced text, omitted when the
  harness default is used).
- Line 3: the schedule in words, `PhrenTypography.caption` `PhrenTheme.textSecondary`;
  trailing the last run: a 10pt symbol (`checkmark` `PhrenTheme.stateDone`,
  `xmark` `PhrenTheme.danger`, `circle.fill` `PhrenTheme.stateWorking` while
  running) plus relative time in `PhrenTypography.caption` `PhrenTheme.textMuted`.
  Nothing when never run.
- Words: "Every 6h", "Every 30m", "Every 2d", "Daily at 07:30", "Weekdays at
  07:30" (mon-fri), "Weekends at 09:00" (sat, sun), "Mon, Wed, Fri at 18:00",
  "Once, Sep 21 at 09:00", "Cron 0 7 * * 1-5".

**Row actions.** A trailing swipe reveals two 72pt actions drawn by us (no
`swipeActions`): "Pause"/"Resume" on `PhrenTheme.surfaceRaised` and "Delete"
on `PhrenTheme.danger`; the row slides with the finger and snaps at 144pt.
Delete confirms with an in-row state: the row's content is replaced by
"Delete this schedule?" with two 44pt buttons "Delete" (danger) and "Keep",
for 6 seconds or until tapped. Identifiers `schedule-pause:<id>`,
`schedule-delete:<id>`, `schedule-delete-confirm:<id>`.

**Run now.** A 32pt circular `play.fill` button at the row's trailing edge on
line 2 (identifier `schedule-run:<id>`), `PhrenTheme.accent` on
`PhrenTheme.surfaceRaised`. Tapping shows a 0.8 s spinner in place, then the
line 3 last-run symbol switches to running. Disabled with `PhrenTheme.textDim`
when the named computer is not connected; the next-run text then reads
"Desk offline".

**Empty state** (no schedules): one centered block, 24pt from the top: the
`clock.badge.checkmark` symbol at 28pt `PhrenTheme.textDim`, "No schedules"
in `PhrenTypography.subheadline` `PhrenTheme.textSecondary`, and a 44pt
"New schedule" button (`PhrenTheme.accentSolid` text on
`PhrenTheme.surfaceRaised`, radius 12). No explanatory sentence.

**Pull to refresh** re-reads the store snapshot and asks every connected
computer for `/v1/schedules` (state only).

## 3. Editor (`ScheduleEditorView`, sheet, `.presentationDetents([.large])`)

Sheet chrome: our own header row, 56pt: "Cancel" text button leading,
title "New schedule" / "Edit schedule" centered
`PhrenTypography.subheadline.weight(.semibold)`, "Save" trailing in
`PhrenTheme.accentSolid` (disabled `PhrenTheme.textDim` until valid).
Identifiers `schedule-editor`, `schedule-cancel`, `schedule-save`. Below it a
`PhrenScreen` with 16pt margins and 24pt between groups. Each `PhrenGroup`
has a `plainListSectionLabel()` caption. At accessibility text sizes the title
moves above the Cancel/Save row; the header grows from its 56pt minimum.

Groups in order:

1. **Name.** A single-line text field in a 44pt `PhrenTheme.surfaceRaised`
   capsule-cornered box (radius 12), placeholder "Nightly test sweep",
   `PhrenTypography.body`. Identifier `schedule-name`.
2. **Prompt.** `PhrenCodeField`, placeholder "What should the agent do?".
   Identifier `schedule-prompt`. Under it a right-aligned muted counter
   "412 / 8000" in `PhrenTypography.monoCaption2` once the text exceeds
   6000 characters.
3. **Project** (only from the all-projects list). One `PhrenOptionRow`
   per project, radio style, the snapshot's project names sorted. Identifier
   `schedule-project:<name>`.
4. **Computer.** One `PhrenOptionRow` per computer: the connected
   computers (`LiveSessionPreferences` hosts, each with its host colour dot
   from `PhrenTheme.hostColor` before the name) first, then the remaining
   `machines.yaml` keys in muted text with "offline" as trailing caption.
   Identifier `schedule-computer:<name>`. Selecting a computer reloads the
   model list.
5. **Harness.** Three `PhrenOptionRow`s: Claude, Codex, OpenCode, each
   with the provider glyph (`AgentProviderGlyph`) leading. Identifier
   `schedule-harness:<kind>`. Changing the harness reloads models.
6. **Model.** The chosen computer's `/v1/models?source=<harness>` list as
   `PhrenOptionRow`s: first "Harness default" (nil), then each model
   with its name and, in muted caption, its description; the catalogue's
   default is marked with a "default" `PhrenChip`. While loading, three
   skeleton rows (`PhrenTheme.surfaceRaised` at 0.5 opacity, 44pt). If the
   computer is offline, one muted row "Connect Desk to list models" and a
   single-line field "Model id" (`schedule-model-custom`) that accepts any id.
   Identifier `schedule-model:<id>`.
7. **When.** A `PhrenIconSegment` with five items: `repeat` (Every),
   `sun.max` (Daily), `calendar` (Weekly), `1.circle` (Once), `terminal`
   (Cron); identifier `schedule-every:<kind>`. Under it the fields for the
   chosen kind, each on its own 44pt-minimum line with a leading caption in
   `PhrenTypography.caption` `PhrenTheme.textMuted` 96pt wide. Captions move
   above fields at accessibility sizes; the date field always gets a full-width
   line:
   - Every: "Interval" `PhrenDurationField` (default 6 h; minimum 5 min).
   - Daily: "At" `PhrenTimeField` (default 07:30).
   - Weekly: "Days" a wrapping row of seven 40pt day chips Mon…Sun
     (`PhrenTheme.accentSolid` fill and white text when selected,
     `PhrenTheme.surfaceRaised` and `PhrenTheme.textSecondary` otherwise;
     identifier `schedule-day:<mon>`), then "At" `PhrenTimeField`.
   - Once: "On" `PhrenDateField` (default tomorrow 09:00).
   - Cron: "Cron" a monospaced single-line field (`schedule-cron`) and under
     it "Next" with the next three runs as muted caption lines computed on
     the phone, or "Not a valid cron line" in `PhrenTheme.danger`.
   Under every kind, a muted caption line "Times are the computer's local
   time" is NOT shown; the computer's time zone is implicit.
8. **Enabled.** One 44pt row: "Enabled" in `PhrenTypography.body` leading,
   `PhrenSwitch` trailing. Identifier `schedule-enabled`.
9. **Notify.** Three 44pt rows: Start, Finish and Failure, each with a
   `PhrenSwitch` trailing. Identifiers `schedule-notify:start`,
   `schedule-notify:finish` and `schedule-notify:failure`. Finish and Failure
   are on by default; Start is off.
10. **Delete** (edit only): a 44pt full-width "Delete schedule" button,
   `PhrenTheme.danger` text on `PhrenTheme.surfaceRaised`, radius 12, with the
   same in-place confirm as the list row.

Validation: Save enables when name (1..80) and prompt (1..8000) are set, a
computer and harness are chosen, and the when-fields are valid. Saving
writes the store file through `PendingOp.saveSchedules` and dismisses; a
conflict shows the sync engine's error in the existing `ActionErrorBanner`
style at the top of the sheet.

## 4. History (`ScheduleHistoryView`, pushed from a row's line 3 last-run text)

`PhrenMetadataHeader` with the schedule name, subtitle the schedule in
words, chips computer, harness, model. Below, runs newest first on a
`PhrenTimelineRail`: each entry a 44pt row with the state dot, "Sep 20,
07:30" in `PhrenTypography.subheadline`, duration ("12m 04s") muted
trailing, and a second line with the status word ("finished", "failed:
<reason>", "running", "skipped: Desk asleep"). A run with a pane is a
button that opens that session's chat through the existing session route
(`phren://session?route=`), with a `chevron.right` at 12pt. Identifier
`schedule-history-row:<runId>`. Empty: "No runs yet" centered muted.

## 5. States and edge cases

- Offline computer: the list still shows the schedule; run-now disabled;
  next run reads "Desk offline"; the editor still saves (the store syncs).
- A schedule for a computer that does not exist in `machines.yaml`: chip in
  `PhrenTheme.danger` tint and next run "unknown computer".
- Concurrent edits: the editor keeps the file content it read and saves
  with it as expected content; on conflict the banner says "Schedules changed
  on another device. Reopen to edit." and the sheet stays open.
- Accessibility: every control has a label; the row combines its text into
  one element with the run-now button separate; VoiceOver reads "Nightly test
  sweep, in 4 hours, Desk, Codex, daily at 7:30, last run finished 2 hours
  ago".
- Reduce Motion: switch and swipe animations become instant.

## 6. Fixture

`--schedules-fixture` seeds two projects with three schedules (daily, weekly,
once already run) and answers `/v1/schedules` (state), `/v1/schedules/run`
(flips the run to running for 2 s) and `/v1/schedules/history` (three runs,
one failed). The store fixture holds the matching `schedules.yaml` so the
editor round-trips.
