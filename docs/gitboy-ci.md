# Parallel release candidate on gitboy

phren's release candidate (RC) runs on GitHub Actions. It can also run, at the same commit and at the same time, on a self-hosted gitboy instance: Linux jobs on Docker runners and a macOS job on a self-hosted Mac. gitboy reports its result back to GitHub as the `gitboy/rc` commit status.

GitHub stays authoritative. `release.yml` reads only GitHub's own RC run, nothing on GitHub waits for gitboy, and a broken, slow or unconfigured gitboy cannot fail or delay a GitHub RC. Treat `gitboy/rc` as advisory: never add it to required status checks.

## What runs where

| Job | GitHub RC (`.github/workflows/ci.yml`) | gitboy RC (`.gitboy.yml`) |
| --- | --- | --- |
| Build and test, Linux | Node 22 and 26 | Node 22 and 26, Docker (`node:22`, `node:26`) |
| Build and test, macOS | Node 22 and 26 | The Mac's own Node, shell executor |
| Build and test, Windows | Node 22 and 26 | not run |
| Lint, private strings, typecheck | yes | yes |
| Agent tests | yes | yes |
| validate-docs | yes | yes |
| Playwright: CLI e2e and desktop | yes | yes, Docker (`playwright install --with-deps` as root in `node:26`) |
| npm publish with provenance (`release.yml`) | yes | never |
| Desktop installers (`release-desktop.yml`) | yes | never |
| VS Code extension (`release-vscode.yml`) | yes | never |

The gitboy jobs run the same commands as the GitHub jobs. Differences: the macOS job uses whatever Node the Mac has (it prints `node --version`), and it does not install tmux. Without tmux on the Mac the tmux provider's integration test skips itself.

## How a run starts

1. You dispatch CI on GitHub with `release_candidate=true`, as for any RC.
2. The `gitboy-rc` job in `ci.yml` asks the gitboy pull mirror to sync (best effort), then calls `POST /api/v1/repos/:owner/:repo/pipelines` with `ref` set to the commit's SHA and the variables `PHREN_RC=true`, `PHREN_RC_SHA`, `GITHUB_REPOSITORY` and `GITHUB_RUN_URL`. While the mirror doesn't have the commit yet, gitboy answers `400 Ref does not resolve to a commit` and the job retries for about four minutes.
3. `.gitboy.yml`'s `workflow.rules` admits only manual (API or Console) pipelines with `PHREN_RC=true`, so mirror syncs and pushes never start it.
4. `github-status-pending` posts `pending` for `gitboy/rc` on the commit and checks that gitboy resolved the SHA it was asked for. The test jobs run in parallel.
5. When they finish, `github-status-success` or `github-status-failure` posts the result. The status links to the gitboy pipeline page.

The `gitboy-rc` job has `continue-on-error`, a six-minute timeout and no token permissions. Without the two secrets it logs `gitboy RC not configured` and succeeds. It never prints the gitboy URL (GitHub masks secrets in the public log) and writes only the pipeline number to the run summary.

## Setup

### On gitboy

1. **Project.** Create a repository (for example `phren/phren`) and set up a pull mirror of `https://github.com/alaarab/phren.git` under **Settings → Mirroring**. Turn on **Instant sync** and add its webhook to the GitHub repository (push events), so a commit reaches gitboy within seconds. Mirror syncs never start CI; only the API call does.
2. **Linux runner.** Register at least one Docker runner with the labels `docker,linux`. The RC runs six Linux jobs; the desktop Playwright build (Monaco) needs the most memory, so give jobs at least 4 GB (`--job-memory-mb 4096`) or leave the limit unset.
3. **macOS runner.** Build `gitboy-runner` from source on the Mac, install it as a launchd agent (`deploy/runner/install.sh launchd`) and register it with the shell executor, the label `macos` and `--capacity 1`. It needs Node 22 or later, npm and Git on the agent's `PATH`. pnpm is installed per version into `$TMPDIR`, not globally.
4. **Status token.** On GitHub, create a fine-grained personal access token for the `alaarab/phren` repository only, with **Commit statuses: Read and write** and nothing else. In the gitboy repository's **Settings → CI variables**, add it as `GITHUB_STATUS_TOKEN`, **masked** and **not protected**: the pipeline runs at a bare SHA, which never counts as a protected ref, so a protected variable would never reach it.
5. **Trigger token.** Create a gitboy personal access token with `write:repo` for an account that can write to the repository. If that account is also an account administrator, the trigger can ask the mirror to sync right away; otherwise it relies on instant sync.

Optional CI variable: `GITHUB_STATUS_CONTEXT` changes the status name from `gitboy/rc`.

### On GitHub

Add two repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | Value |
| --- | --- |
| `GITBOY_URL` | The gitboy instance's base URL, for example `https://gitboy.example` |
| `GITBOY_TRIGGER_TOKEN` | The gitboy trigger token from step 5 |

If the gitboy repository's path differs from `alaarab/phren`, also add the Actions variable `GITBOY_REPO` (for example `phren/phren`). Remove either secret to turn the gitboy RC off.

## Reading results

- On GitHub, the commit (and any pull request at that head) shows `gitboy/rc` next to the Actions checks. Its link opens the gitboy pipeline.
- The GitHub RC run's `gitboy-rc` job summary names the gitboy pipeline number; its log says why nothing started (not configured, HTTP status, mirror never received the commit).
- On gitboy, the pipeline page shows each job's log. A failed `browser-test` keeps `coverage/desktop-playwright/` as an artifact for three days.

A pipeline whose jobs wait for a runner that is offline (the Mac asleep, for instance) stays `pending` on GitHub until the runner returns or you cancel the pipeline on gitboy. That never blocks a release: `release.yml` doesn't read commit statuses.

## What is not covered

- Windows. gitboy has no Windows runner; the GitHub RC remains the only Windows gate.
- Publishing. npm publish with provenance needs GitHub's OIDC, and desktop installers ship as GitHub releases for the auto-updater, so both stay on GitHub.
- Feature pull requests. Only the RC runs on gitboy; pushes and pull requests build on GitHub only.
