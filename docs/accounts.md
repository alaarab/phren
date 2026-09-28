# Harnesses and accounts per computer

Every computer can have its own mix of harnesses. One computer might have two Claude subscriptions and Codex, and another might have Codex only. Each computer's Hook reports what is installed and signed in there. The phone offers only those options. Dispatch to `anywhere` picks a computer that has the requested harness and account.

## Claude homes

One account uses one Claude config home. Claude Code keeps an account's login, settings, `.claude.json`, model catalogue and transcripts inside `CLAUDE_CONFIG_DIR`, and leaves `HOME` alone. On macOS each home also gets its own login-keychain item.

| Home | Account id | How the Hook launches it |
|------|------------|--------------------------|
| `~/.claude` (`.claude.json` beside it, in `~`) | `default` | Without `CLAUDE_CONFIG_DIR`, exactly as before |
| `~/.claude-<slug>`, containing `.claude.json` | `<slug>` (`[a-z0-9-]{1,32}`) | With `CLAUDE_CONFIG_DIR=~/.claude-<slug>` |

The Hook finds homes by this naming rule; nothing needs registering. Pointing `CLAUDE_CONFIG_DIR` at `~/.claude` for the default account would move its keychain item and `.claude.json`, so the Hook never sets it for `default`.

A Hook run with `CLAUDE_CONFIG_DIR` already set (tests, or an owner who moved the default home) treats that directory as `default`.

### Adding an account home

`phren bridge accounts add <slug> [--label <name>]` creates `~/.claude-<slug>` and shares the owner's setup with it:

- Symlinks to the default home for `settings.json`, `CLAUDE.md`, `skills`, `agents`, `commands` and `plugins`. The Hook's agent hooks, the usage status line, permissions and plugins are then the same for every account.
- The user-scope `mcpServers` from `~/.claude.json`, copied into the new home's `.claude.json`. `phren bridge install` copies them again on every run, so phren's MCP server stays current.
- The label, written to `<bridge>/accounts.yaml`.

The login stays in the home, and so do `.claude.json`'s account and onboarding state, `projects/` and the model catalogue cache.

`phren bridge accounts` lists the computer's harnesses and accounts, which is the same data as `GET /v1/harnesses`.

An owner who wants different settings for one account can replace that home's `settings.json` symlink with a real file. `phren bridge install` writes the Hook's hooks into every home whose `settings.json` is a real file and skips symlinks that point to another home's settings.

Labels come from `<bridge>/accounts.yaml`:

```yaml
claude:
  default: Personal
  work: Work
```

Without a label, the slug is title-cased (`work` becomes `Work`) and `default` becomes `Claude`. Use the same slug for the same subscription on every computer. Dispatch matches accounts by id, and the phone uses the account `key` to recognize one subscription across computers.

### Migration

There is nothing to migrate. The existing `~/.claude` becomes the `default` account, and its files, keychain item and transcripts stay where they are. A second subscription gets a new home. An old phone ignores the new fields and keeps working with `default`, and it still gets a single Claude usage entry.

## Hook contract

All fields are additive. A request that leaves out `account` means `default`.

### `GET /v1/harnesses`

The computer's inventory. The same object also rides on `GET /v1/dispatch/capacity` as `harnesses`, so dispatch can filter without another round trip. The phone should use `computer.id` from `/v1/health` (and `/v1/computers`) as the key for each computer's inventory.

```jsonc
{
  "harnesses": [
    { "source": "claude", "installed": true, "version": "2.1.284", "usable": true,
      "accounts": [
        { "id": "default", "label": "Personal", "key": "claude:3f9a…", "signedIn": true, "usable": true, "plan": "max" },
        { "id": "work", "label": "Work", "key": "claude:81c2…", "signedIn": false, "usable": false, "reason": "Not signed in" }
      ] },
    { "source": "codex", "installed": true, "version": "0.155.0", "usable": true,
      "accounts": [{ "id": "default", "label": "Codex", "key": "codex", "signedIn": true, "usable": true }] },
    { "source": "opencode", "installed": false, "usable": false, "reason": "Not installed" },
    { "source": "copilot", "installed": true, "version": "1.0.3", "usable": true }
  ]
}
```

- `installed` comes from `<tool> --version`, the probe `/v1/health/details` already runs.
- For Claude, `signedIn` comes from `claude auth status --json` run in each home, cached for 5 minutes. The Hook never reads a token for this. `plan` is the subscription type when Claude reports it.
- `key` is `claude:` followed by the first 12 hex characters of SHA-256 of the account's `oauthAccount.accountUuid` in that home's `.claude.json`. It is the same on every computer. When it is unknown, `key` is `claude:home:<id>` and the account is not deduplicated.
- Codex has exactly one account on every computer, keyed `codex` (owner decision). OpenCode and Copilot report no `accounts`.
- `usable` means that a launch should work now. A harness is usable when it is installed and at least one account is usable. `reason` explains a `false`, and also says why a usable account is not confirmed signed in. An account whose sign-in check did not answer stays usable, with `signedIn: false` and a `reason`. Only a missing binary or Claude reporting logged out makes something unusable.

### Session rows

A Claude row in `GET /v1/workspaces`, `WS /v1/overview` and `GET /v1/workspaces/panes` carries `account: { id, label, key }` when the Hook knows the account, whatever the fleet has. The phone shows the badge only when the owner's computers report more than one account for that source, so badges do not flicker. The account is known from the launch (recorded with the pane), from the Claude hook payload's `transcript_path`, or from the open transcript's path (`lsof`). In each case the file's home decides the account.

### Launch, dispatch, hand-off, schedules

- `POST /v1/workspaces/launch` takes `account?: string`. For a non-default account the Hook sets `CLAUDE_CONFIG_DIR` in the pane's environment and checks the folder-trust entry in that home's `.claude.json`. The Hook fails early with 409 before creating a pane in two cases: `harness_unavailable` (not installed) and `account_unavailable` (unknown, not signed in, or an account given for a harness without accounts).
- The `dispatch` tool and receipt take `account?`. `anywhere` keeps only computers whose `harnesses` report the requested harness and account usable, then picks the least busy one. Each skipped computer is listed with its reason. A named computer that lacks the harness or account fails with that reason and never launches.
- `hand_off` takes `account?`. When it resolves a session by project, it only picks sessions of that account.
- Schedules take `account?`. The headless runner passes the same environment.

### Models

`GET /v1/models?source=claude&account=<id>` reads that home's model catalogue cache. The cache is keyed by source and account. Without `account` it uses `default`, as now.

### Usage

`GET /v1/usage?accounts=all` returns one `source: "claude"` entry per home, `default` first, each with `account: { id, label, key }`. Without the parameter the response keeps its old shape: one Claude entry, for `default`, with `account` added. Phones up to TestFlight 162 reject a response that has two entries with the same `source`. The Codex entry carries `account: { id: "default", label: "Codex", key: "codex" }`.

- On Linux, live limits for every home come from that home's `.credentials.json`.
- On macOS, `default` keeps its live keychain read. Other homes use the status-line snapshot plus Claude's own `cachedUsageUtilization` in that home's `.claude.json`, until each home's keychain item name has been confirmed on a signed-in second home.
- The status line records to `usage/claude.json` for `default` and to `usage/claude-<id>.json` for other homes. It picks the file from the `CLAUDE_CONFIG_DIR` that Claude passes to its status-line command.

### Install

`phren bridge install` writes the Hook's agent hooks and usage status line into every home whose `settings.json` is a real file. It also copies the user-scope `mcpServers` from `~/.claude.json` into each extra home.

## Phone

- Launch, dispatch and the model chip offer only what the selected computer's `harnesses` report as usable, and hide the rest. The chip reads "Opus 5.5 · high · Work". The account can only be chosen at launch; switching it means relaunching.
- The header usage rings can be configured: which (source, account key) pairs appear, in what order, and which window each ring shows (5-hour, 7-day, or a per-model 7-day). By default they show every signed-in account across connected computers, deduplicated by `key`, with the 5-hour window. The configuration lives in Settings and opens with a long press on the rings. Account Usage still lists everything.
- Chat and session rows show an account badge when there is more than one account for that source.
- Android parity rows are listed in each phone PR.

## One-time sign-in per computer (owner)

For each extra Claude subscription on a computer, pick a slug and use the same slug on every computer. The example uses `work`:

```sh
phren bridge accounts add work --label Work   # creates ~/.claude-work with your shared settings, skills and MCP servers
CLAUDE_CONFIG_DIR=~/.claude-work claude       # finish first-run setup, run /login with the Work subscription, then /exit
CLAUDE_CONFIG_DIR=~/.claude-work claude auth status --text   # check that it shows the Work account
phren bridge accounts                          # the Hook's view: claude default + work, both signed in
```

To name the existing login, run `phren bridge accounts label default Personal`. The existing `~/.claude` login is not changed.
