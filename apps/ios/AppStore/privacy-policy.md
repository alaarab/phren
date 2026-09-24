# Privacy Policy — phren for iOS

<!--
Publish this to https://alaarab.github.io/phren/privacy.html before
submitting. App Store Connect requires a reachable privacy policy URL, and
App Review will open it. Any static host works; the existing docs/ GitHub
Pages site is the obvious home.

Keep the "Last updated" date accurate — a policy dated before a material
change is worse than no policy.
-->

**Last updated: 12 September 2026**

phren for iOS ("the app") is a client for a knowledge store you own,
stored in a Git repository on GitHub. This policy explains what the app
does with your data. Store sync goes directly to the GitHub account you
connect. Optional SSH connections, agent chat, and voice features are described below.

## We do not collect your data

There is no phren account or developer-operated phren backend. The
developer of this app receives **no** data from it — no analytics, no
crash reporting, no telemetry, no advertising identifiers, no usage
statistics. The app uses open-source SwiftNIO SSH and Swift Crypto for optional
computer connections; these libraries do not provide analytics or telemetry.

## What the app stores on your device

- **Your GitHub access token**, in the iOS Keychain. It never leaves the
  device except as an authorization header sent directly to GitHub's API
  over HTTPS.
- **A local cache** of the markdown files in your store repository, so the
  app works offline and searches without a network round trip.
- **A queue of pending changes** you have made but which have not yet been
  pushed to GitHub.
- **App settings**, such as your chosen default project for quick capture
  and a short log of recent captures, saved graph views, and custom themes.
  Optional live connections also
  save computer addresses, usernames, trusted SSH fingerprints, and directory
  links to projects in device preferences.
- **A separate SSH private key per added computer**, in the device Keychain,
  accessible only while unlocked and excluded from Keychain syncing and backups.
- **Last received live session metadata**, such as tab names, agent states, and
  working directories, in memory while the session screen exists.
- **Chat drafts and attached images**, in the app's private storage so they
  survive relaunch. Conversation content is read from your connected computer;
  it is not sent to the phren developer.

Deleting the app removes its private container. Keychain credentials can
survive app deletion: signing out clears the GitHub token, and **Forget
computer** deletes that connection's SSH key. Remove the corresponding public
key from the computer's authorized_keys file to revoke its access there.

## What the app sends, and where

For sign-in and store sync, the app communicates directly with **GitHub**:
`github.com` for optional device sign-in and `api.github.com` for repository
access with your token.

It reads the repository or repositories you select, and writes the changes
you make — findings, notes, tasks, and review decisions — back to those
repositories as commits authored by your GitHub account.

Your use of GitHub is governed by GitHub's own privacy policy:
https://docs.github.com/site-policy/privacy-policies

## Optional live computer connections

When you open an added computer, phren connects directly to its configured
SSH address and reads session metadata and conversations from Phren Hook on
that computer. Phren Hook is installed and operated on your own computer.
The SSH public key identifies this device; the private key is never sent.
The app verifies the computer's SSH host key against the fingerprint you trust.
GitHub credentials are not sent to this connection. If you attach project
memory, skills, text, or images to chat, the app sends that content to the
selected computer and agent when you submit the message. That agent may send
it to its configured AI provider under that provider's privacy policy.

Live reads pause when the app becomes inactive. You can send chat and terminal
input, stop a turn, and respond to supported approval requests. These actions
go to your connected computer. Uploaded images are retained there for up to
14 days, with expiry checked when another upload occurs; uninstalling the Hook
preserves local data for recovery. No live metadata is uploaded to GitHub or
the phren developer. Copying or
sharing the SSH authorization line exports only public key material.

Web previews forward the selected development server through SSH into an
isolated in-app browser. Pages can contact external resources they include;
those services receive normal web requests. Links to unrelated pages open
outside the privileged preview browser.

## Microphone and speech recognition

If you use voice capture, the app records audio only while you are
actively dictating, and uses Apple's Speech framework to transcribe it.

The app requests **on-device** recognition wherever the device supports
it, in which case the audio never leaves your iPhone. If on-device
recognition is unavailable, iOS may send the audio to Apple for
transcription under Apple's privacy policy. The recording is not stored;
only the resulting text becomes a note or task, and only if you save it.

You can decline microphone and speech permissions and continue to use
every other feature of the app, including typing or using the keyboard's
own dictation.

## Siri and App Intents

The app registers Siri shortcuts for adding a note or task. When you use
them, the dictated text is handled by Siri under Apple's privacy policy
and passed to the app, which writes it to your store. The developer
receives nothing.

## Children

The app is not directed at children and collects no data from anyone.

## Changes to this policy

If this policy changes materially, the updated version will be published
at this URL with a revised date, and the change will be noted in the app's
release notes.

**12 September 2026:** the app now also mirrors the store's `machines.yaml`,
`profiles/` and per-project `phren.project.yaml` (which computers carry which
projects, and where); reads a computer's hostname and a pane's git branch from
Phren Hook; can create a Herdr workspace and start an agent in a project folder
on request; and keeps queued chat messages in memory only. The
developer-receives-nothing statement is unchanged. The published copy is
https://alaarab.github.io/phren/privacy.html.

## Contact

Questions about this policy: **ala@alaarab.com**

Source code: https://github.com/alaarab/phren
