# Sessions tab

Sessions answers what is running across computers, including work outside a
connected memory project. Projects remains the place for project memory and
project-specific setup.

The screen contains:

- Phren search and session cards grouped by activity, with the existing Focus,
  loading, empty, stale and connection-recovery states.
- Computers below the sessions, using PhrenMenuRow with connection status and
  the existing computer color. Tap opens the computer; Connection settings
  edits it. Keep `live-host:<id>` on the navigation row as the hook for the
  computer hold action.
- Add computer below those rows and in More so a long session list does not
  bury the action.
- A toolbar More action sheet containing Skills and Agent instructions, or
  Connect memory when memory is disconnected. Refresh all sessions
  and Schedules also live in More so a full navigation bar cannot hide them.
  Usage and enabled computer-tool shortcuts retain their destinations.

Rule: sessions lead the screen. Setup belongs in More, never in a second
Agent setup group. Computers stay visible below sessions and open in one tap;
editing takes two. Keep the full computer rows instead of a horizontal strip:
names and connection state need room to wrap, and the row supports the hold
action. A strip would consume space above the work and hide longer names.
The standing Tailscale footer does not earn space on a daily sessions screen;
connection guidance belongs with connection setup. The cross-computer session
list serves a different scope from the project session list.

Use phren controls with ScrollView and PhrenGroup, without native list,
section or search chrome. Preserve `agents-loading`, `live-host:<id>`,
`overview-reconnect:<id>` and all session card identifiers.

## Visual checks

LiveSessionsTests captures phone layouts with zero, one and six sessions,
then the Computers rows, More, Skills and Add computer. Launch with
`--ui-testing --automatic-sessions-fixture --session-details-fixture` and
`--sessions-layout-count=0`, `=1` or `=6`. Skills uses
`--project-skills-fixture`. Captures are retained as xcresult attachments.

The placement judgment is based on the view hierarchy until those captures
can be run and inspected. The implementation sandbox could not connect to
CoreSimulator, so this note does not claim visual validation.

Validation in the implementation worktree: XcodeGen succeeded; all 525
PhrenKit tests passed using scratch-local caches and SwiftPM's
`--disable-sandbox` option within the workspace sandbox. Changed Swift files
passed syntax parsing. Build-for-testing stopped before app compilation at
the denied SwiftPM manifest cache write, including a retry with scratch-local
module caches. LiveSessionsTests and LiveSessionsModelTests still need the
iOS build and simulator run. No before or after screenshots were produced.

## Card gestures

A horizontal swipe reveals Close without opening chat; swiping right hides
it. The card uses a direction-gated pan recognizer that cancels its tap.
Vertical gestures remain with the sessions scroll view. Swipe Close still
removes only that computer's tab immediately, without confirmation.
