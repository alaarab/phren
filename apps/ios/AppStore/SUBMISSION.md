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

## Owner steps (cannot be done from this machine)
1. **Review credentials:** create a GitHub account or fine-grained PAT scoped
   to a demo store repository (findings/notes/tasks seeded, nothing private)
   and enter it as the demo sign-in in App Review Information.
2. **Upload:** Product › Archive in Xcode (Release, Automatic signing, team
   LYB298P4U6) › Distribute › App Store Connect, or
   `xcodebuild archive … && xcodebuild -exportArchive -exportOptionsPlist`
   with an App Store Connect API key. The export-compliance question is
   pre-answered by the plist key.
3. **Connect metadata:** filled through the API on 2026-09-16; see
   "Store record" below for what is set and what is still open.
4. **Physical-device pass before submitting:** sign-in with the demo token,
   add a computer (QR / key copy), open a chat, approve a request from the
   Lock Screen activity, Control Center controls, Siri "What is phren doing",
   Action button → "Talk to Phren".

## Store record (filled 2026-09-16)

Written through the App Store Connect API (`apps/ios/scripts/asc.py`, App
Manager key). App 6811508141, version 73b06487-558d-4ec5-aab2-232e29007622.
No build attached, nothing submitted.

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
  All eight uploaded in the order listed under "Ready", every asset
  `COMPLETE` at 1320×2868, order confirmed by a listing.
- **Price:** schedule created, base territory USA, manual price = the free
  point (customerPrice 0.0); 174 automatic free equivalents.
- **Availability (v2):** all 175 territories available,
  availableInNewTerritories true. Every territory reports
  CANNOT_SELL / AVAILABLE_FOR_SALE_UNRELEASED_APP, which is the normal
  pre-release state.

### Still open (owner)
1. **App Review Information: needs a real phone number.**
   `POST /v1/appStoreReviewDetails` requires `contactPhone` and validates it
   as a real number; `+10000000000` and `+1 555 010 0000` were both refused
   ("must be in a valid format"), so no review detail exists yet. Run, with
   your number and the demo token:
   ```
   python3 apps/ios/scripts/asc.py POST /v1/appStoreReviewDetails '{"data":{"type":"appStoreReviewDetails","attributes":{"contactFirstName":"Ala","contactLastName":"Arab","contactEmail":"alaarab@gmail.com","contactPhone":"+1 XXX XXX XXXX","demoAccountRequired":true,"demoAccountName":"<github account>","demoAccountPassword":"<fine-grained PAT for alaarab/phren-ios-demo>","notes":"<the Review notes block above, as plain text>"},"relationships":{"appStoreVersion":{"data":{"type":"appStoreVersions","id":"73b06487-558d-4ec5-aab2-232e29007622"}}}}}'
   ```
   or fill the same fields in App Store Connect › the version › App Review
   Information. The demo token needs Contents: Read and write + Metadata:
   Read on the demo store, expiring at least 90 days out.
2. **App Privacy questionnaire** (App Store Connect › App Privacy): no API.
   Answer per `privacy-label.md` (data not collected).
3. **EU trader status (Digital Services Act):** the 27 EU territories report
   `TRADER_STATUS_NOT_PROVIDED`; declare it under App Store Connect ›
   Business (or the app's Availability page) or the app will not be sold in
   the EU.
4. Attach the build (99 / 1.0.0) once it finishes processing, run the
   physical-device pass above, then Submit for Review.
