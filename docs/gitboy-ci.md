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

1. You dispatch CI on GitHub with `release_candidate=true` on the default branch, as for any RC.
2. That starts `.github/workflows/gitboy-rc.yml` through `workflow_run` on CI's `requested` event, so both RCs run side by side and CI never waits for it. It runs only when the CI run is an `RC validation` dispatch started by the repository owner on the default branch, and uses that run's `head_sha`. Its `trigger` job asks the gitboy pull mirror to sync (best effort), then calls `POST /api/v1/repos/:owner/:repo/pipelines` with `ref` set to the commit's SHA and the variables `PHREN_RC=true` and `GITHUB_REPOSITORY`, then checks that the pipeline gitboy started is at that SHA. No per-run values go into the variables, because gitboy's content-hash reuse includes them in its key (see below). While the mirror doesn't have the commit yet, gitboy answers `400 Ref does not resolve to a commit` and the job retries for about four minutes.
3. `.gitboy.yml`'s `workflow.rules` admits only manual (API or Console) pipelines with `PHREN_RC=true`, so mirror syncs and pushes never start it.
4. `github-status-pending` posts `pending` for `gitboy/rc` on the commit and checks that gitboy resolved the SHA it was asked for. The test jobs run in parallel.
5. When they finish, `github-status-success` or `github-status-failure` posts the result. The status links to the gitboy pipeline page.

The gitboy RC workflow is separate from `ci.yml`, so it never holds the RC run open, and `release.yml` (which reads only the CI run) cannot see it. Its job has `continue-on-error`, a six-minute timeout and no token permissions. Without the two secrets it logs `gitboy RC not configured` and succeeds. Only the repository owner can start it: a collaborator with write access dispatching CI or this workflow gets a skipped job, because the secrets start code on the owner's runners. It never prints the gitboy URL, curl's error text or gitboy's response body; failures are reported as `gitboy could not be reached` or the HTTP status. The run summary names only the pipeline number.

GitHub only fires `workflow_run` for a workflow file on the default branch, so nothing happens until this file is merged. To start it by hand (for example after adding the secrets), run the **gitboy RC** workflow from the Actions tab on the default branch, optionally with a full commit `sha`.

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

## Fast checks (`fast-check`)

Any gitboy pipeline that isn't the RC runs one job, `fast-check`: a push or pull request made on gitboy itself, or a pipeline started through the API or the Console without `PHREN_RC`. It runs the development build's checks, the same set GitHub runs on a feature PR (build, lint, private strings, typecheck, the agent build and validate-docs). Tests stay deferred to the RC and are never reported as passed.

It is built to be fast:

- **One job.** One install and one build feed every check, instead of six jobs that each install and build. Lint and the build run together under turbo, alongside the private-strings and docs checks, and the typechecks then run side by side. Each check's output is printed only when it fails.
- **Only what changed.** The job compares the commit with `PHREN_BASE_SHA`, or for a push with the previous branch head (`GITBOY_BEFORE_SHA`). It builds, lints and typechecks only the packages changed since then and the packages that depend on them (turbo `--affected`). It checks every package when files outside `packages/` and `docs/` changed (scripts, lockfile, root config), when the comparison commit isn't in the checkout (a new branch, or more than 50 commits back), or when the package list can't be read.
- **Warm start.** The pnpm store and turbo's cache (`.turbo/cache`) are one gitboy cache, keyed by `pnpm-lock.yaml`. Every successful run refreshes it, so the next run installs from the local store and replays unchanged packages from turbo's cache. Root files the builds and lint read (`biome.json`, `scripts/build.mjs`, `scripts/build-code.mjs`) are `globalDependencies` in `turbo.json`, so changing one misses the cache rather than replaying an old result. Entries unused for 7 days are dropped.

Pull mirror syncs start no CI, so on a mirrored repository start it through the API like the RC: `POST /api/v1/repos/:owner/:repo/pipelines` with `{"ref": "<sha>", "variables": {"PHREN_BASE_SHA": "<sha to compare with>"}}`. Without `PHREN_BASE_SHA` it checks everything.

## Reading results

- On GitHub, the commit (and any pull request at that head) shows `gitboy/rc` next to the Actions checks. Its link opens the gitboy pipeline.
- The **gitboy RC** workflow run's summary names the gitboy pipeline number; its log says why nothing started (not configured, HTTP status, mirror never received the commit).
- On gitboy, the pipeline page shows each job's log. A failed `browser-test` keeps `coverage/desktop-playwright/` as an artifact for three days.

A pipeline whose jobs wait for a runner that is offline (the Mac asleep, for instance) stays `pending` on GitHub until the runner returns or you cancel the pipeline on gitboy. That never blocks a release: `release.yml` doesn't read commit statuses.

## What is not covered

- Windows. gitboy has no Windows runner; the GitHub RC remains the only Windows gate.
- Publishing. npm publish with provenance needs GitHub's OIDC, and desktop installers ship as GitHub releases for the auto-updater, so both stay on GitHub.
- Feature pull requests' tests. Only the RC runs tests on gitboy; other gitboy pipelines run `fast-check`, which runs none.

## Reusing earlier runs

`agent-test`, `browser-test` and `validate-docs` declare `inputs:`, the repository paths their result depends on. gitboy reuses an earlier green run of such a job when those paths, the job's definition, its variables and the repository's CI variables are all unchanged, so a release candidate that changes only, say, the VS Code extension doesn't run the browser suite again. `build-and-test`, its macOS leg and `lint` depend on most of the repository and always run. The status jobs set `checkout: none`: they only call GitHub's API, and a gitboy server with `GITBOY_API_ONLY_JOBS` on starts them without a checkout.

When a job's result starts depending on a new path, add it to that job's `inputs:`; a path left out can let a stale green result stand. A manual retry always runs.
