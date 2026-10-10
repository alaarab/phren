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
    { "source": "copilot", "installed": true, "version": "1.0.3", "usable": true },
    { "source": "phren", "installed": true, "version": "0.3.18", "usable": true }
  ]
}
```

- `installed` comes from `<tool> --version`, the probe `/v1/health/details` already runs. `phren` (phren's own agent) is probed as `phren agent --version`; a `phren` that answers without a version (no `@phren/agent` installed) counts as not installed.
- For Claude, `signedIn` comes from `claude auth status --json` run in each home, cached for 5 minutes. The Hook never reads a token for this. `plan` is the subscription type when Claude reports it.
- `key` is `claude:` followed by the first 12 hex characters of SHA-256 of the account's `oauthAccount.accountUuid` in that home's `.claude.json`. It is the same on every computer. When it is unknown, `key` is `claude:home:<id>` and the account is not deduplicated.
- Codex has exactly one account on every computer, keyed `codex` (owner decision). OpenCode, Copilot and phren report no `accounts`; phren's provider credentials are not checked.
- `usable` means that a launch should work now. A harness is usable when it is installed and at least one account is usable. `reason` explains a `false`, and also says why a usable account is not confirmed signed in. An account whose sign-in check did not answer stays usable, with `signedIn: false` and a `reason`. Only a missing binary or Claude reporting logged out makes something unusable.

### Session rows

A Claude row in `GET /v1/workspaces`, `WS /v1/overview` and `GET /v1/workspaces/panes` carries `account: { id, label, key }` when the Hook knows the account, whatever the fleet has. The phone shows the badge only when the owner's computers report more than one account for that source, so badges do not flicker. The account is known from the launch (recorded with the pane), from the Claude hook payload's `transcript_path`, or from the open transcript's path (`lsof`). In each case the file's home decides the account.

### Launch, dispatch, hand-off, schedules

- `POST /v1/workspaces/launch` takes `account?: string`. For a non-default account the Hook sets `CLAUDE_CONFIG_DIR` in the pane's environment and checks the folder-trust entry in that home's `.claude.json`. The Hook fails early with 409 before creating a pane in two cases: `harness_unavailable` (not installed) and `account_unavailable` (unknown, not signed in, or an account given for a harness without accounts).
- The `dispatch` tool and receipt take `account?`. `anywhere` keeps only computers whose `harnesses` report the requested harness and account usable, then picks the least busy one. Each skipped computer is listed with its reason. A named computer that lacks the harness or account fails with that reason and never launches.
- `hand_off` takes `account?`. When it resolves a session by project, it only picks sessions of that account.
- Schedules take `account?`. The headless runner passes the same environment.

### Choosing an account, and continuing on another signed-in account

A Claude launch that names no account (`POST /v1/workspaces/launch`, a dispatch, a schedule's Herdr or headless run) on a computer with more than one usable Claude account runs under the account with the most room. Accounts are ranked by percent left on the 5-hour window, then on the weekly window, then `default` first, then by id. A window whose reset has passed counts as full. An account with no report ranks below every reported one. Signed-out accounts, accounts with an exhausted window, and logins in the limit ledger are never chosen. A named account always wins. With one account, or when usage cannot be read in 2.5 seconds, the launch runs as before under `default`. The launch answer carries `account` and `accountChoice` (the reason), and the Hook logs both.

`GET /v1/dispatch/capacity` usage rows for Claude add `fiveHour` and `week` (`{ leftPercent, resetsAt }`). `anywhere` with no account rules a computer out for quota only when all of its Claude accounts are exhausted.

When a dispatched Claude worker's turn ends on Claude Code's usage-limit row (`isApiErrorMessage`, `error: "rate_limit"`), the worker's Hook reports it as failed with an error starting `Claude usage limit:`, plus its last reply and its checkout (folder and branch).

Continuing on another signed-in account is off by default. The owner opts in with `phren config account-failover on` (install preferences) or `PHREN_ACCOUNT_FAILOVER=on`. With it on, the dispatching Hook does the following after its returns poll:

1. Records the login in `<bridge>/account-limits.json` until its window resets. It uses the exhausted window's reset time when usage reports one, else holds the login for 5 hours. Logins are matched by `key`, so the same subscription is held back on every computer.
2. Picks the account with the most room on the worker's computer. If none has room, it picks the best account on any other connected computer.
3. Dispatches a new worker under that account, with the same project, model, effort, permission mode, integrator and dispatching pane. Its brief names the stopped dispatch, the limit, the checkout and branch, and the last reply, then gives the original brief (read from the worker's computer through `GET /v1/dispatch/brief?id=`). The new receipt carries `continues`.
4. Marks the stopped receipt `continued: { id, computer, account, at }`, or `{ at, error }` when nothing has room, and returns it unread. The error then begins "Continued on account X on Y (dispatch …)".

Each stopped dispatch is continued at most once. A continuation that also reaches its limit is continued in turn, while some account still has room. The stopped pane stays open.

Each account is the owner's own subscription, signed in through Claude Code's own /login in its own home, and used only by the official Claude Code binary. Phren reads, stores and forwards no token, runs no proxy, and never sends one session's requests through another account. A continuation is a new session.

### Models

`GET /v1/models?source=claude&account=<id>` reads that home's model catalogue cache. The cache is keyed by source and account. Without `account` it uses `default`, as now.

### Usage

`GET /v1/usage?accounts=all` returns one `source: "claude"` entry per home, `default` first, each with `account: { id, label, key }`. Without the parameter the response keeps its old shape: one Claude entry, for `default`, with `account` added. Phones up to TestFlight 162 reject a response that has two entries with the same `source`. The Codex entry carries `account: { id: "default", label: "Codex", key: "codex" }`.

- On Linux, live limits for every home come from that home's `.credentials.json`.
- On macOS, `default` keeps its live keychain read. Other homes use the status-line snapshot plus Claude's own `cachedUsageUtilization` in that home's `.claude.json`, until each home's keychain item name has been confirmed on a signed-in second home.
- The status line records to `usage/claude.json` for `default` and to `usage/claude-<id>.json` for other homes. It picks the file from the `CLAUDE_CONFIG_DIR` that Claude passes to its status-line command.
- Every Claude row, live or from a snapshot, carries the login's `key` and, when `.claude.json` names it, `account.email`, so one login on several computers merges into one card named by its email.
- A saved window whose reset time has passed comes back as `reset: true` without `usedPercent`. Windows reported more than three days ago are dropped, and a row left with none says since when there has been no report.
- The live read needs a current access token. The Hook never refreshes Claude's token itself (that would rotate Claude Code's refresh token under it), so a computer where Claude Code has not run for a few hours falls back to the snapshot until Claude runs there again.

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

### Subscription metadata

Usage rows optionally carry `subscription: { plan, startedAt?, renewsAt?, renewsEstimated?, checkedAt? }`. Dates are ISO 8601 UTC strings; unknown fields are omitted. `checkedAt` is when the metadata was read, separate from the quota report's `updatedAt`. The phone and `account_usage` retain the newest subscription by `checkedAt` within the existing account group, falling back to that report's `updatedAt` for older Hooks. A newer quota report without subscription metadata does not erase a known plan.

Codex reads only the claims payload of the ID token in this home's `auth.json`, using the `https://api.openai.com/auth` claims `chatgpt_plan_type`, `chatgpt_subscription_active_start` and `chatgpt_subscription_active_until`. The token, header, signature and other claims never enter a usage response or log; these claims are display metadata, not authentication proof. Claude reads each home's `.claude.json` `oauthAccount`: `organizationRateLimitTier`, recognizable plan values in `billingType`, and `subscriptionCreatedAt`. Claude provides no renewal date, so the next monthly anniversary is estimated in UTC, clamped to the last day of short months while retaining the original day for later months (`renewsEstimated: true`).

ElevenLabs uses `tier` and `next_invoice.next_payment_attempt_unix` from the existing subscription read, with no extra request. The character reset remains a separate quota date. Copilot uses its known plan and monthly quota reset; OpenCode Go uses the Go plan and monthly window reset. Those two reset dates describe the provider's known monthly cycle, not a separately verified invoice. OpenCode's local spend and OpenRouter keys have no known subscription, so no plan is invented.

Account usage cards show a muted line under the title, for example `Pro · since Jul 13 · renews Oct 6`; estimated dates read `renews about Oct 13`. Missing dates simply leave out that part of the line.
