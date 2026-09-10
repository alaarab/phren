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

## What connects

- Codex, Claude Code, and Copilot conversations, with exact pane/session identity.
- Chat history, incremental transcript updates, real token counts, image uploads,
  stop, and project context from Phren's memory and skills.
- Native Herdr terminals, named servers, workspaces, tabs, and pane navigation.
- Codex/Claude approvals through Phren's lifecycle callbacks while you watch a
  conversation. Questions and unsupported interactions open in Phren's terminal.
- Git diffs, local HTTP app discovery, and SSH browser previews.
- Local project activity history, retained on the computer.

The helper does not start coding agents for you. Text updates depend on when
that agent writes its transcript; usage numbers are never estimated. In Codex,
review the installed Phren callbacks in `/hooks`. Resume existing sessions if
needed to load new callbacks. Ambiguous conversation identities disable sending.

## Maintain and diagnose

```sh
npx --yes @phren/cli@0.2.14 bridge status
npx --yes @phren/cli@0.2.14 bridge update
npx --yes @phren/cli@0.2.14 bridge rollback
npx --yes @phren/cli@0.2.14 bridge uninstall
```

`update` installs the version of the CLI you invoke; choose an explicit newer
version when upgrading. The standalone bundle survives npm cache cleanup.
`rollback` activates the prior installed version. `uninstall` stops the service
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
