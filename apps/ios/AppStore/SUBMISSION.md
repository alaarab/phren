# App Store / TestFlight submission

## Ready
- Build settings: `ITSAppUsesNonExemptEncryption = NO` (standard algorithms),
  privacy manifest declares UserDefaults (CA92.1) and file timestamps
  (C617.1, 0A2A.1); no boot-time or disk-space APIs are used. Version and
  build come from `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` in
  project.yml (`deploy-phone.py` bumps the build).
- Screenshots (6.9", 1320×2868, the only iPhone size App Store Connect
  requires; it scales the rest) live outside the repo in
  `~/Projects/phren-appstore-screenshots/`. Suggested order:
  1. Complete-overview-after-coordinated-loading: Live sessions
  2. Custom-chat-with-compact-activity: native chat with tool cards
  3. Phren-memory-and-task-cards: phren memory calls
  4. Inline-approval-in-Phren: approve a tool call from the phone
  5. Claude-and-Codex-account-usage: usage limits
  6. Projects-design: memory projects
  7. Saved-graph-connections: memory graph
  8. Integrated-composer-with-keyboard: composer
  Regenerate with the UI tests named in each file's `capture(...)` call and
  `xcrun xcresulttool export attachments`.

## Review notes (draft: paste into App Store Connect › App Review Information)
> phren is a companion for the phren memory store (a git repository) and for
> coding agents (Claude Code, Codex, Copilot) running on the reviewer's own
> computers. Memory features need a GitHub token for a repository that holds a
> phren store; agent features need a computer running Phren Hook
> (`npx @phren/cli bridge install`) reachable over SSH/Tailscale.
> For review we provide a demo GitHub token (read/write to a demo store
> repository) in the sign-in field below. Agent screens can be explored without
> a computer: the Agents tab explains how to add one; nothing else is gated.
> No account is created by the app; the GitHub token is stored in the keychain
> only.

## Remaining owner checks
1. **Review credentials:** create a GitHub account or fine-grained PAT scoped
   to a demo store repository (findings/notes/tasks seeded, nothing private)
   and enter it as the demo sign-in in App Review Information.
2. **Declarations:** complete App Privacy and declare EU trader status in
   App Store Connect. These need the owner’s answers.
3. **Build:** build 99 is processed and attached, verified 2026-09-19.
4. **Physical-device pass before submitting:** sign-in with the demo token,
   add a computer (QR / key copy), open a chat, approve a request from the
   Lock Screen activity, Control Center controls, Siri "What is phren doing",
   Action button → "Talk to Phren".

## Store record (filled 2026-09-16, rechecked 2026-09-19)

Written through the App Store Connect API (`apps/ios/scripts/asc.py`, App
Manager key). App 6811508141, version 73b06487-558d-4ec5-aab2-232e29007622.
Build 99 is attached and VALID; nothing submitted.

### Set and verified
- **Version:** versionString `1.0.0`, copyright `2026 Ala Arab`, release
  AFTER_APPROVAL. State PREPARE_FOR_SUBMISSION.
- **App info:** primary category DEVELOPER_TOOLS, secondary PRODUCTIVITY;
  content rights DOES_NOT_USE_THIRD_PARTY_CONTENT.
- **App info localization (en-US):** name `Phren` (unchanged), subtitle
  `Your memory. Your agents.` (the 41-char line from ios.html does not fit
  the 30-char limit), privacy policy URL
  `https://alaarab.github.io/phren/privacy.html`.
- **Age rating:** every content descriptor NONE; advertising, gambling,
  lootBox, healthOrWellnessTopics, messagingAndChat, parentalControls,
  ageAssurance, socialMedia, userGeneratedContent, unrestrictedWebAccess
  all false; kidsAgeBand null; override NONE. Computed rating: **4+**.
  (messagingAndChat and userGeneratedContent are answered "no" because the
  chat is with the user's own agents and store content lives in the user's
  own GitHub repository; neither is user-to-user or hosted by us.)
- **Version localization (en-US):** description (2839 chars, from README /
  ios.html / CHANGELOG 1.0.0), keywords (96 chars:
  `claude code,codex,copilot,ai agent,coding agent,terminal,ssh,developer,memory,notes,tasks,github`),
  promotional text (144 chars), support URL
  `https://alaarab.github.io/phren/support.html`, marketing URL
  `https://alaarab.github.io/phren/ios.html`. **whatsNew is not editable on a
  first version** (API 409 STATE_ERROR); Apple only shows it for updates.
- **Screenshots:** set `ef6d70ca-7346-4bc5-8d51-4fc5044ff41f`, display type
  APP_IPHONE_67 (the API has no APP_IPHONE_69; 1320×2868 is accepted there).
  As of 2026-09-19, all ten screenshots are `COMPLETE` at 1320×2868.
  Marketing frame 03 now reads “Approve, answer, steer / from anywhere”
  without the em dash and remains third in the set. All three app previews
  are also `COMPLETE`. The list under “Ready” is the original capture list.
- **Price:** schedule created, base territory USA, manual price = the free
  point (customerPrice 0.0); 174 automatic free equivalents.
- **Availability (v2):** all 175 territories available,
  availableInNewTerritories true. Every territory reports
  CANNOT_SELL / AVAILABLE_FOR_SALE_UNRELEASED_APP, which is the normal
  pre-release state.

### Still open (owner)
1. **App Review Information: replace the demo-token placeholder.**
   Review contact details, including a phone number, now exist. On
   2026-09-19 the demo password was still `SET-BY-OWNER`. Enter a token
   scoped to the demo store directly in App Store Connect › the version ›
   App Review Information; do not put it in chat or this repository.
2. **App Privacy questionnaire** (App Store Connect › App Privacy): no API.
   Answer per `privacy-label.md` (data not collected).
3. **EU trader status (Digital Services Act):** owner confirmation remains
   pending. Declare whether distribution is part of a business or profession
   under App Store Connect › Business › Agreements › Compliance. See
   [Apple’s guidance](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements).
4. Confirm the physical-device pass above, then Submit for Review. Simulator
   checks do not establish that the physical-device checklist has passed.
