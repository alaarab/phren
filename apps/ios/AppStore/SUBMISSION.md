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
  1. Complete-overview-after-coordinated-loading — Live sessions
  2. Custom-chat-with-compact-activity — native chat with tool cards
  3. Phren-memory-and-task-cards — phren memory calls
  4. Inline-approval-in-Phren — approve a tool call from the phone
  5. Claude-and-Codex-account-usage — usage limits
  6. Projects-design — memory projects
  7. Saved-graph-connections — memory graph
  8. Integrated-composer-with-keyboard — composer
  Regenerate with the UI tests named in each file's `capture(...)` call and
  `xcrun xcresulttool export attachments`.

## Review notes (draft — paste into App Store Connect › App Review Information)
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
3. **Connect metadata:** name, subtitle, description, keywords, support URL
   (repo), privacy policy URL, age rating, the eight screenshots above,
   the review notes.
4. **Physical-device pass before submitting:** sign-in with the demo token,
   add a computer (QR / key copy), open a chat, approve a request from the
   Lock Screen activity, Control Center controls, Siri "What is phren doing",
   Action button → "Talk to Phren".
