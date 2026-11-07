# D4 desktop Forge transport design — blocked on Hook routes

## Verified transport

The phone talks directly to GitHub/gitboy, not through the Hook. Read-only reference:
`Phren/Features/Forge/ForgeAccountsModel.swift` builds `GitHubForge(client: appModel.client)`
and `GitboyClient(host:token:)`. `PhrenKit/Forge/ForgeCredential.swift` documents Keychain
storage. `GitHubForge+Runs.swift` calls GitHubClient workflow runs/jobs/log APIs;
its liveLog polls run detail every **5 seconds**, and only downloads the completed job log.
GitHub does not expose a live log in this phone implementation.
`GitboyClient+Runs.swift` uses `/api/v1/repos/:owner/:repo/pipelines`, pipeline detail,
repo-scoped job `/log` and `/log/stream` SSE with a byte offset and one reconnect.
The phone buffers at most 512 KiB, coalesces display at 100 ms and follows the tail
unless the person scrolls away. The ForgeRunDetail model has jobs, not step data;
GitHub's upstream jobs API can provide steps; gitboy may have none.

Desktop checks currently come from `/v1/git/pulls` (session/worktree scoped), or
`GET /v1/projects/:project/git` (registered checkout, no session). The former serves
ci-watch and merge-when-green; project-pulls shares the latter's cache.
`git-hosts.ts`, `git-host-gitboy.ts` normalize checks (including some job duration
and failure detail), but do not expose a runs catalogue, full job detail or log.
`server-pane-routes.ts` and `server-routes.ts` register no Forge run/log route.
The generic daemon proxy can carry existing Hook routes, but is not a forge API.
No existing route can deliver this feature end to end. No Hook changes made.

## Proposed additive Hook contract (not implemented or called)

Advertise health capabilities `forgeRuns`, `forgeJobLogs` and, independently,
`forgeRunActions`. Desktop must gate controls on those capabilities; absent flags
show a disabled live control with an update reason, with no route probing.
All requests go via daemon `/hosts/<computer>/v1/...` using hookGet/hookPost,
never directly to the forge from the browser. Bind repository resolution to the
registered checkout's remote. Clients must not submit arbitrary upstream URLs.

- `GET /v1/projects/:project/forge/runs?branch=<branch>&headSha=<sha>&cursor=<opaque>`
  → `{ host: { kind, name, domain, webUrl }, items: Run[], next?: string }`.
  Cap at 30 items. PR launch carries branch and preferably immutable head SHA;
  filter to that SHA to exclude a newer run on a moved branch. Branch alone is
  best effort, especially for fork PRs. Do not claim branch runs belong to a PR.
- `GET /v1/projects/:project/forge/runs/:id`
  → `{ run: Run, jobs: Job[], actions: { rerunAll: boolean, retryFailed: boolean } }`.
  Preserve matrix job IDs; gitboy uses pipeline IID, stage order, newest attempts.
- `GET /v1/projects/:project/forge/runs/:id/jobs/:jobId/log?offset=<byte>&limit=<bytes>`
  → `{ text: string, nextOffset: number, finished: boolean, status, reset: boolean,
  truncated: boolean }`. Bounded UTF-8 chunks, e.g. 64 KiB; independent byte cursor,
  no character-count offsets. Hook verifies the job belongs to the run/repo.
  For GitHub, return empty unfinished chunks until terminal, then download once,
  bound/cache the result and serve chunks. Never pass its signed redirect URL to
  the browser; follow only validated log-download destinations without bearer auth.
  For gitboy, bridge SSE into a bounded per-job cache or use its offset-capable
  transport; one upstream reader per active job, with abort/idle eviction.
- Optional `POST /v1/projects/:project/forge/runs/:id/action`
  `{ action: "rerunAll" | "retryFailed", expectedHeadSha: string }`
  → `{ ok: true, runId?: string }`. No action until separately capability gated;
  GitHub can rerun all, gitboy cannot. Respect permissions and reject stale heads.

`Run`: `{ id: string, number?: number, title, workflow?, branch?, sha, actor?,
status, createdAt?, startedAt?, finishedAt?, webUrl }`.
`Job`: `{ id: string, name, stage?, attempt?, status, startedAt?, finishedAt?,
runnerName?, allowFailure?, failureReason?, webUrl, steps?: [{ number, name,
status, startedAt?, finishedAt? }] }`.
Statuses: queued/running/success/failed/canceled/skipped/waiting. Unknown upstream
states stay nonterminal; never infer success. Distinguish missing steps from empty.
Errors: fixed codes for auth, scope, not-found, unsupported, rate-limit (retryAfter),
upstream-unavailable. Keep prior data on transient failures; explicit Retry.

## Auth and resource ownership

Reuse `git-host-auth.ts`: GitHub uses the Hook's `gh` sign-in; gitboy resolves its
existing host-pinned env/file token (0600 bridge git-hosts.json). Existing desktop
Connect sends secrets to the Hook and does not return them. Do not introduce a
second desktop account store or localStorage tokens. Enforce HTTPS, host pinning,
redirect policy and output/body limits on Hook requests. Logs may contain secrets;
keep them in bounded memory, never persist in desktop preferences or diagnostics.

Visible run/detail polls and unfinished log reads use a single nonoverlapping
5-second timer. Stop and invalidate responses on hide/back/project switch;
resume on show. Terminal logs stop polling. Abort HTTP where supported. SSE can be
considered later; the daemon currently has HTTP and WebSocket proxy plumbing, so
bounded polling avoids adding an EventSource transport for this slice.

## Delivered fallback / integration

`ui/sections/forge.js` offers a disabled live state plus explicit GitHub/gitboy
previews, sourced only from `forge/fixture.js`. Project CI and PR Runs entries pass
scope but never substitute fake runs for a real project silently. Preview run list,
jobs/steps, growing log snapshots at 5 seconds, safe ANSI spans, find and external
links are implemented. The fake GitHub log waits for terminal status before publishing; gitboy
preview snapshots grow every five seconds, exercising the same display buffer.
No rerun button: no action route exists. Real adapter/pagination/auth/rate-limit
handling and live transport require a later Hook-owned change.

Open questions: approve route names/capability vocabulary; choose gitboy stream-to-
HTTP cache strategy; authorize log redaction policy; decide PR fork/head identity;
confirm gitboy step availability. The project entry opens the shared CI page rather
than embedding a second independent poller inside the project detail page.
