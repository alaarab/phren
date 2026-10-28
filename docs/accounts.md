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

A slug that isn't valid is refused with one that is: `Buildbox` suggests `buildbox`, and a `--label` that is the account's email suggests its user and domain (`sam@example.com` → `sam-example`). On a Mac, run over ssh for a new home, the command first checks that the session can use the login keychain (`security show-keychain-info`), because Claude saves a Mac's login there. When the keychain is locked to the session, the command says so and creates nothing: run it on the Mac itself, or unlock the keychain for the session first with `security unlock-keychain ~/Library/Keychains/login.keychain-db`. Only the keychain's own refusal ("User interaction is not allowed") counts as locked; a check that times out or can't run `security` doesn't block it.

`phren bridge accounts` lists the computer's harnesses and accounts, which is the same data as `GET /v1/harnesses`. An account Claude reports as signed out carries `signInAvailable: true` there (one whose state Claude didn't report does not).

### Signing in a slot from the phone

A slot that exists but is signed out is signed in again with `POST /v1/accounts/claude/add` and `{slug, mode: "sign-in"}` (owner only; `default` is the default slot). The Hook opens a pane, as adding an account does, running `claude /login` under the slot's own home: `env CLAUDE_CONFIG_DIR=~/.claude-<slug>` for an added slot, and `env -u CLAUDE_CONFIG_DIR` for the default slot. Either way a pane shell that exports another account's home (the owner's profile) can't sign in that one instead. The command names the `claude` executable the Hook finds on its PATH (or Claude's own `~/.claude/local/claude`), since `env` doesn't see a shell alias. It answers `{target, terminalOnly: true, slug}` for the phone to open that pane's terminal. A slot already signed in is refused with 409 `signed-in`, one that doesn't exist with 404, and a second sign-in while the first pane is open with 409, for up to 10 minutes or until the slot reports signed in (the pane stays open as a Claude session). When the Hook itself found the default slot through `CLAUDE_CONFIG_DIR`, the default slot's login sets that home explicitly too, even when it is `~/.claude`. `{slug, mode: "sign-in-status"}` answers `{slug, signedIn, plan?, unknown?}` without opening anything (`unknown`: Claude didn't report its state): the phone polls it until `signedIn`. For up to 10 minutes after a sign-in pane for the slot was opened, Claude is asked afresh each time; otherwise a signed-out answer is at most 30 seconds old. A Hook without this answers 400 to the `mode` field. The route acts on this computer's slots; another computer's are signed in through its own Hook.

Because transcripts live in `projects/` inside each home, a conversation started under one account is not visible to `claude --resume` under another. Switching a chat's account (`phren move <pane> --to claude --account <slug> --resume`) copies its transcript into the target home first; see conductor.md, "Switch a Claude conversation to another account".

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
- A Claude account carries `pool` and `role` when the owner set them, and the inventory carries this computer's `allowedPools` when set (see [Account pools and roles](#account-pools-and-roles)).

### Account pools and roles

All of this is opt-in. A store that sets none of it behaves exactly as before.

- **Pool:** a Claude account slot may have a `pool`, a short tag (`personal`, `client-a`) for whose work it may do.
- **Role:** a slot may have a `role`, which says how it is used without being named:
  - `helpers`: for helper runs;
  - `last-resort`: offered only when no `helpers` account fits;
  - `off`: never chosen automatically, though still by hand on the phone.

  An account with no role is an ordinary account, as every account was before.
- **Allowed pools:** a project and a computer may each list `allowedPools`, the pools whose accounts may do its work. No list means any pool.

For now these are recorded and reported only; nothing enforces them yet.

```bash
phren bridge accounts pool api200 personal        # or --clear
phren bridge accounts role api200 helpers         # helpers | last-resort | off | --clear
phren bridge accounts allowed-pools personal client-a              # this computer; no tags: show; --clear: any pool
phren bridge accounts allowed-pools --project client-a client-a    # the project's phren.project.yaml
phren bridge accounts                             # lists each account's pool and role
```

A slot's pool and role live in `<bridge>/accounts.yaml` under `slots.<id>` (`{ pool, role }`). This computer's list is the same file's `allowedPools`, and a project's list is `allowedPools` in its `phren.project.yaml`. A pool is 1 to 32 lowercase letters, digits and dashes, and a list holds at most 32.

The phone sets them through two owner-only routes, advertised as `capabilities.accountPools`:
- `POST /v1/accounts/claude/settings` takes `{ slug, pool?, role? }`. A field left out stays as it is, and `null` clears it. It answers `{ ok, slug, pool?, role? }`: 404 for an unknown slot, 400 for a bad pool or role.
- `POST /v1/accounts/allowed-pools` takes `{ allowedPools: [tags] | null }` for this computer and answers `{ ok, allowedPools? }`.

### Helper runs

A lead agent can hand a small, self-contained task to a cheaper model billed to another account with the `helper` MCP tool (conductor module, `full` profile). Claude Code's own subagents can't do this: a subagent always runs under the lead's login and its usage. A helper is a separate headless `claude -p` under the account you choose.

Opt in per project, in its `phren.project.yaml`:

```yaml
helper:
  account: api      # a Claude account on this computer (phren bridge accounts); default is ~/.claude
  model: haiku      # optional, haiku by default
```

Each call runs `claude -p --model <model> --output-format json` in the lead's folder (or the `cwd` it passes) with the account's `CLAUDE_CONFIG_DIR`. The lead's own `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed first, so the helper signs in and bills as that account only: sign the account in with a Console login to bill an API credit. It is read-only unless the lead passes `allowEdits`, stops after `timeoutSeconds` (120 by default, at most 600), and returns Claude's reply. The tool refuses, saying why, when the project has no `helper`, the account isn't on this computer, its role is `off`, or its pool is outside the project's or this computer's `allowedPools` (a list leaves out an account with no pool).

Each run's cost goes into the account's cost ledger, so it counts against the [API credits](#api-credits-estimate) entered for it, and one line per run (time, project, account, model, outcome, cost; never the prompt) goes to `<bridge>/usage/helper-runs.jsonl`, trimmed to its last 1000 lines past 512 KB.

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
- Every Claude row, live or from a snapshot, carries the login's `key` and, when `.claude.json` names it, `account.email`, so one login on several computers merges into one card named by its email. The key hashes the login (`accountUuid`, else the email) together with `organizationUuid`: one login with a personal plan and a Team seat is two accounts, two cards.
- Merging across computers takes each window from the newest report that has it (between equally new reports, the one with a reset time), so a computer that has only seen the 5-hour window never hides another computer's weekly window.
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

Codex reads only the claims payload of the ID token in this home's `auth.json`, using the `https://api.openai.com/auth` claims `chatgpt_plan_type`, `chatgpt_subscription_active_start` and `chatgpt_subscription_active_until`. The token, header, signature and other claims never enter a usage response or log; these claims are display metadata, not authentication proof. Claude reads each home's `.claude.json` `oauthAccount`: `organizationType` (Pro, Max, Team, Enterprise; `seatTier` `team_premium` is Team Premium), the rate tiers only for Pro and Max 5x / 20x, recognizable plan values in `billingType`, `subscriptionCreatedAt`, and `profileFetchedAt` as `checkedAt`, so the most recently fetched profile wins when computers disagree. Internal tier codes are never shown. When the profile names no plan Phren knows, the plan comes from `claude auth status` (`subscriptionType`, or `Console` for a Console login). Claude provides no renewal date, so the next monthly anniversary is estimated in UTC, clamped to the last day of short months while retaining the original day for later months (`renewsEstimated: true`).

ElevenLabs uses `tier` and `next_invoice.next_payment_attempt_unix` from the existing subscription read, with no extra request. The character reset remains a separate quota date. Copilot uses its known plan and monthly quota reset; OpenCode Go uses the Go plan and monthly window reset. Those two reset dates describe the provider's known monthly cycle, not a separately verified invoice. OpenCode's local spend and OpenRouter keys have no known subscription, so no plan is invented.

Account usage cards show a muted line under the title, for example `Pro · since Jul 13 · renews Oct 6`; estimated dates read `renews about Oct 13`. Missing dates simply leave out that part of the line.

### Codex credits

Codex reports a purchased credit balance beside its windows in the same `account/rateLimits/read` answer the Hook already reads. The Codex row carries it as `credits: { hasCredits, unlimited?, balance?, inUse? }`: `balance` is in Codex's own credit unit, not dollars, and `inUse` is set when credits are enabled and a plan window is spent (at 100%, or Codex says the rate limit is reached), so further work draws on the balance. `account_usage` keeps the newest report's credits for the account. Nothing is estimated: a row without `credits` means Codex sent none.

### API credits (estimate)

A Claude home signed in with a Console (API billing) login has no 5-hour or weekly window. To see roughly what is left of a prepaid or promotional credit, enter it once:

```sh
phren bridge accounts credit api --amount 100 --expires 2026-12-31 --label Promo   # spend counts from today, or --since <date>
phren bridge accounts credit api                                                  # list, with each credit's id
phren bridge accounts credit api --remove <credit>
```

Credits live in `<bridge>/accounts.yaml` under `credits.<id>`; an account holds up to 16. Nothing is recorded or shown for a home without one. The home's usage row then carries one window per unexpired credit: `id: "credit:<id>"`, a name ending in `estimate`, `usedUSD`, `limitUSD`, `usedPercent`, and the expiry as `resetsAt` (an exhausted credit has no `availableIn`). Spend is Claude Code's own per-session cost under that home: the status line's `cost.total_cost_usd`, kept per session in `usage/claude-cost[-<id>].json`, plus the `lastCost` Claude Code keeps per project in the home's `.claude.json`, dated by the session's transcript. Each session draws from the credit that expires first among those active when it began. It is an estimate: sessions outside that home, other API use of the organization and Console-side adjustments are not seen, and each computer counts only its own sessions.
