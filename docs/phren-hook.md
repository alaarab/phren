# Phren Hook

Phren Hook connects the Phren iPhone app to agents already running on your
computers. It is part of the open-source Phren CLI and runs independently of
other phone or terminal applications.

## Install on each computer

Requires macOS or Linux, Node 20 or newer, Herdr, SSH, and `lsof`. Linux uses a
systemd user service; macOS uses a LaunchAgent in your signed-in user session.

```sh
npx --yes @phren/cli@0.2.14 bridge install
npx --yes @phren/cli@0.2.14 bridge doctor
```

Keep Tailscale connected on the iPhone and computer for remote access. Funnel and
public ports are unnecessary. In Phren, add the computer under Agents, copy its
SSH authorization line, add it to that user's `~/.ssh/authorized_keys`, then
verify the computer's SSH fingerprint. Existing Phren device keys are migrated
with a backup by the installer.

Updated web previews require a helper advertising `webPreview: "ssh-exec"`.
Released 0.2.14 builds without that capability need an updated CLI build before
running `bridge install`; repeating the released command above does not add it.
The installer removes generic forwarding from recognized device keys. Previews
then use the dispatcher's loopback TCP command, keeping private Unix sockets
inaccessible through SSH forwarding. Update the helper and authorization lines
on every computer before installing the updated phone app, then reconnect SSH.
An older helper produces an explicit update instruction in the app.

## What connects

Workspace snapshots optionally include `contextUsedPercent` for a tab with one
verified Codex agent. The helper reads the latest reported token count and
context-window limit from a bounded transcript tail, caches unchanged files,
and limits concurrent lookups. Optional enrichment returns partial results after
1.5 seconds; later requests omit metrics while the bounded pending work drains.
Missing limits, ambiguous panes, and unavailable observations omit the metric.
No extra request per iPhone row is needed.

- Codex, Claude Code, and Copilot conversations, with exact pane/session identity.
- Chat history, incremental transcript updates, real token counts, image uploads,
  stop, and project context from Phren's memory and skills.
- Native Herdr terminals, named servers, workspaces, tabs, and pane navigation.
- Codex/Claude approvals through Phren's lifecycle callbacks while you watch a
  conversation or the foreground session overview. Questions and unsupported
  interactions open in Phren's terminal.
- Git diffs, local HTTP app discovery, and SSH browser previews.
- Local project activity history, retained on the computer.

The helper does not start coding agents for you. Text updates depend on when
that agent writes its transcript; usage numbers are never estimated. In Codex,
review the installed Phren callbacks in `/hooks`. Resume existing sessions if
needed to load new callbacks. Ambiguous conversation identities disable sending.

The iPhone explicitly renews a 25-second approval watch with
`GET /v1/workspaces?watchApprovals=1`. Ordinary overview reads do not hold prompts.
Pending tabs expose `approvalPending`; the exact conversation's status stream
provides the action ID, input and expiry. Requests wait at most 55 seconds, then
return to the agent's terminal prompt without approving anything. Answers are
single use and validated against the exact provider conversation.

On iOS, a request received in an open chat can create a Live Activity with Deny
and Approve on the Lock Screen and Dynamic Island. Tapping either authenticates
and opens Phren, which uses its existing pinned SSH connection and protected
Keychain key. The widget contains no credentials or executable tool input.
Expired requests lose their buttons. New requests while the app is suspended
require a push delivery service, which this foreground SSH helper does not supply.

## Maintain and diagnose

```sh
npx --yes @phren/cli@0.2.14 bridge status
npx --yes @phren/cli@0.2.14 bridge update
npx --yes @phren/cli@0.2.14 bridge rollback
npx --yes @phren/cli@0.2.14 bridge uninstall
```

`update` installs the version of the CLI you invoke; choose an explicit newer
version when upgrading. The standalone bundle survives npm cache cleanup.
`rollback` activates the prior installed version; it leaves migrated key
restrictions in place. Rolling back to a helper without `ssh-exec` previews
therefore keeps previews unavailable until the helper is updated again.
`uninstall` stops the service
and removes Phren's agent callbacks, retaining local data and backups. Remove
Phren's public keys from `authorized_keys` to revoke phone access.

If the phone cannot connect, check Tailscale and SSH first, then run `bridge doctor`
on that computer. Verify Herdr is running and the device's current authorization
line includes the Phren dispatcher and `pty`. On Linux, enable user lingering if
you need the service to continue after logout. Hook errors on macOS are recorded
in `~/.local/share/phren/bridge/service.log`; on Linux use
`journalctl --user -u phren-hook`.

The helper exposes a private Unix socket, not a public HTTP port. SSH keys stay
in the iPhone Keychain. Images and activity remain local to the computer; see the
[protocol and storage limits](../apps/ios/AGENT_CONNECTIONS.md).
