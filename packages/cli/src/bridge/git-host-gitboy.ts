import type { GitHost, GitHostProvider, HostTerms, MergeRequest, RequestList } from "./git-hosts.js";
import { resolveHostToken } from "./git-host-auth.js";
import { fillFromCommits } from "./git-host-gitlab.js";
import { apiRoot, HostApiError, hostJson, safeLink } from "./git-host-http.js";
import type { Json } from "./protocol.js";

/** gitboy, the self-hosted forge, over its REST API (/api/v1). gitboy names a
 * pull request by `index`, has no draft state, no aggregate review decision
 * and no web links in its answers, so this provider derives them: web pages
 * are `<origin>/<owner>/<repo>/pulls/<n>` and `/pipelines/<iid>?job=<id>`, a
 * review decision counts approvals on the head commit, and a newer gitboy
 * that sends `html_url`, `draft` or `review_decision` is taken at its word.
 * The token is GITBOY_TOKEN or the Hook's stored one, a gbp_ personal access
 * token with read:repo (write:repo to open or merge). */

export const PULL_TERMS: HostTerms = { short: "PR", long: "pull request", ref: "#" };

type Order = "failing" | "pending" | "passing" | "skipped" | "neutral";
const ORDER: Record<Order, number> = { failing: 0, pending: 1, passing: 2, skipped: 3, neutral: 4 };

/** A gitboy job or pipeline status as one state word. */
export function gitboyState(status: unknown, allowFailure = false): Order {
  switch (String(status ?? "").toLowerCase()) {
    case "success": return "passing";
    case "failed": case "failure": case "error": return allowFailure ? "neutral" : "failing";
    case "canceled": case "cancelled": return allowFailure ? "neutral" : "failing";
    case "skipped": return "skipped";
    default: return "pending"; // created, blocked, queued, claimed, running, pending
  }
}

function obj(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function rows(value: unknown): Json[] {
  const list = Array.isArray(value) ? value : Array.isArray(obj(value).items) ? obj(value).items as unknown[] : [];
  return list.map(obj);
}

function stateOf(pull: Json): string {
  if (pull.merged_at) return "MERGED";
  return String(pull.state ?? "").toLowerCase() === "open" ? "OPEN" : "CLOSED";
}

interface Ctx { api: string; web: string; repo: string; token: string; domain: string; account: { source: string; user?: string } }

const SIGN_IN = (domain: string) =>
  `Phren has no gitboy token for ${domain}. Connect it from the desktop's Changes pane, or run phren bridge git-host set ${domain} gitboy on this computer with a personal access token that has read:repo (write:repo to open and merge).`;

async function context(root: string, host: GitHost): Promise<Ctx | RequestList> {
  const repo = host.webUrl?.replace(/^https?:\/\/[^/]+\//, "") ?? "";
  if (!host.domain || repo.split("/").length !== 2) return { available: false, reason: "unknown-host", message: "This repository has no gitboy remote of the form owner/repo.", pulls: [], current: null };
  const token = await resolveHostToken("gitboy", host.domain);
  if (!token) return { available: false, reason: "auth", message: SIGN_IN(host.domain), pulls: [], current: null };
  const api = await apiRoot(root, host.domain, `https://${host.domain}/api/v1`);
  return { api, web: api.replace(/\/api\/v1$/, ""), repo, token: token.token, domain: host.domain, account: { source: token.source, ...(token.user ? { user: token.user } : {}) } };
}

function call<T = unknown>(ctx: Ctx, path: string, init: { method?: "GET" | "POST"; body?: Json } = {}) {
  return hostJson<T>(`${ctx.api}/repos/${ctx.repo}${path}`, { token: ctx.token, scheme: "bearer", ...init });
}

function pullUrl(ctx: Ctx, pull: Json): string {
  return safeLink(pull.html_url) ?? `${ctx.web}/${ctx.repo}/pulls/${pull.index ?? pull.number}`;
}

function listed(ctx: Ctx, pull: Json): Json {
  const number = typeof pull.index === "number" ? pull.index : pull.number;
  return { number, title: String(pull.title ?? ""), head: String(pull.head_branch ?? ""), base: String(pull.base_branch ?? ""),
    author: String(pull.author_username ?? ""), url: pullUrl(ctx, pull), draft: pull.draft === true, state: stateOf(pull),
    updated: String(pull.updated_at ?? "") };
}

/** GitHub's reviewDecision from gitboy's reviews: each reviewer's latest
 * verdict on the head commit, the author's own left out. */
export function gitboyReviewDecision(pull: Json): string | undefined {
  if (typeof pull.review_decision === "string" && pull.review_decision) return pull.review_decision.toUpperCase();
  const head = String(pull.head_sha ?? "");
  const latest = new Map<string, string>();
  for (const review of rows(pull.reviews).sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))) {
    const who = String(review.reviewer_username ?? review.reviewer_id ?? "");
    if (!who || who === pull.author_username) continue;
    const state = String(review.state ?? "");
    if (state === "changes_requested") latest.set(who, state);
    else if (state === "approved" && (!head || review.commit_sha === head)) latest.set(who, state);
  }
  const verdicts = [...latest.values()];
  if (verdicts.includes("changes_requested")) return "CHANGES_REQUESTED";
  const blockers = Array.isArray(pull.merge_blockers) ? pull.merge_blockers.map(String) : [];
  if (blockers.some(text => /approval/i.test(text))) return "REVIEW_REQUIRED";
  return verdicts.includes("approved") ? "APPROVED" : undefined;
}

/** gitboy's mergeability and blockers in GitHub's mergeStateStatus words. */
export function gitboyMergeState(pull: Json): { mergeState?: string; mergeDetail?: string; blockers?: string[] } {
  const blockers = (Array.isArray(pull.merge_blockers) ? pull.merge_blockers : []).map(text => String(text).slice(0, 300)).slice(0, 20);
  const status = String(pull.status ?? "");
  if (stateOf(pull) !== "OPEN") return {};
  if (status === "conflict") return { mergeState: "DIRTY", mergeDetail: "Has merge conflicts", ...(blockers.length ? { blockers } : {}) };
  if (status === "checking" || status === "") return { mergeState: "UNKNOWN", mergeDetail: "Checking mergeability", ...(blockers.length ? { blockers } : {}) };
  if (status === "empty" || status === "ancestor") return { mergeState: "UNKNOWN", mergeDetail: "No changes to merge" };
  if (status === "error") return { mergeState: "UNKNOWN", mergeDetail: "gitboy could not check mergeability" };
  if (blockers.length) return { mergeState: "BLOCKED", mergeDetail: blockers[0], blockers };
  return { mergeState: "CLEAN", mergeDetail: "Ready to merge" };
}

/** The head commit's pipeline jobs, newest attempt of each; failing first. */
async function jobsFor(ctx: Ctx, pull: Json): Promise<{ runs: Json[]; pipeline?: Json }> {
  const sha = String(pull.head_sha ?? "");
  const branch = String(pull.head_branch ?? "");
  if (!sha || !branch) return { runs: [] };
  const { json } = await call<unknown>(ctx, `/pipelines?branch=${encodeURIComponent(branch)}&limit=20`).catch(() => ({ json: [] as unknown }));
  const pipeline = rows(json).filter(p => p.sha === sha).sort((a, b) => Number(b.iid ?? 0) - Number(a.iid ?? 0))[0];
  if (!pipeline || pipeline.iid === undefined) return { runs: [] };
  const { json: detail } = await call<Json>(ctx, `/pipelines/${pipeline.iid}`).catch(() => ({ json: {} as Json }));
  const newest = new Map<string, Json>();
  for (const job of rows(obj(detail).jobs)) {
    const name = String(job.name ?? "Job");
    const seen = newest.get(name);
    if (!seen || Number(job.attempt ?? 0) >= Number(seen.attempt ?? 0)) newest.set(name, job);
  }
  const pipelineUrl = `${ctx.web}/${ctx.repo}/pipelines/${pipeline.iid}`;
  const runs = [...newest.values()].map(job => {
    const state = gitboyState(job.status, job.allow_failure === true);
    const seconds = job.started_at && job.finished_at ? Math.max(0, Math.round((Date.parse(String(job.finished_at)) - Date.parse(String(job.started_at))) / 1000)) : undefined;
    return { name: String(job.name ?? "Job").slice(0, 200), state, ...(job.stage ? { workflow: String(job.stage).slice(0, 200) } : {}),
      url: job.id ? `${pipelineUrl}?job=${encodeURIComponent(String(job.id))}` : pipelineUrl,
      ...(seconds !== undefined && Number.isFinite(seconds) ? { seconds } : {}),
      ...(typeof job.failure_reason === "string" && job.failure_reason ? { detail: job.failure_reason.slice(0, 300) } : {}) };
  }).sort((a, b) => ORDER[a.state] - ORDER[b.state]).slice(0, 100);
  return { runs, pipeline: { id: pipeline.iid as number, state: gitboyState(obj(detail).status ?? pipeline.status), url: pipelineUrl } };
}

/** Commit statuses, when there is no pipeline to read jobs from. */
function statusRuns(pull: Json): Json[] {
  return rows(pull.checks).filter(check => check.context !== "gitboy/pipeline").map(check => {
    const url = safeLink(check.target_url);
    return { name: String(check.context ?? "Check").replace(/^gitboy\//, "").slice(0, 200), state: gitboyState(check.state), ...(url ? { url } : {}) };
  }).sort((a, b) => ORDER[a.state] - ORDER[b.state]).slice(0, 100);
}

function rollup(runs: Json[]): "passing" | "failing" | "pending" | null {
  if (!runs.length) return null;
  const states = runs.map(run => run.state);
  if (states.includes("failing")) return "failing";
  return states.includes("pending") ? "pending" : "passing";
}

async function currentRequest(ctx: Ctx, branch: string): Promise<Json | null> {
  if (!branch) return null;
  // gitboy can't filter by head branch: read the newest and pick this branch's.
  const { json } = await call<unknown>(ctx, `/pulls?state=all&limit=100`);
  const mine = rows(json).filter(pull => pull.head_branch === branch && !pull.head_repository_fork)
    .sort((a, b) => Number(stateOf(b) === "OPEN") - Number(stateOf(a) === "OPEN") || String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))[0];
  const index = mine?.index ?? mine?.number;
  if (index === undefined) return null;
  const { json: detail } = await call<Json>(ctx, `/pulls/${index}`);
  const pull = obj(detail);
  const { runs: jobs, pipeline } = await jobsFor(ctx, pull);
  const checkRuns = jobs.length ? jobs : statusRuns(pull);
  const reviewDecision = gitboyReviewDecision(pull);
  const approvals = new Set(rows(pull.reviews).filter(review => review.state === "approved" && review.reviewer_username !== pull.author_username
    && (!pull.head_sha || review.commit_sha === pull.head_sha)).map(review => String(review.reviewer_username ?? review.reviewer_id))).size;
  const conflicted = Array.isArray(pull.conflicted_files) ? pull.conflicted_files.length : 0;
  return { ...listed(ctx, pull), checks: rollup(checkRuns), checkRuns,
    ...(reviewDecision ? { reviewDecision } : {}),
    ...gitboyMergeState(pull),
    ...(pipeline ? { pipeline } : {}),
    ...(approvals ? { approvals: { given: approvals } } : {}),
    ...(typeof pull.comment_count === "number" ? { comments: pull.comment_count } : Array.isArray(pull.comments) ? { comments: pull.comments.length } : {}),
    ...(typeof pull.commits_behind === "number" ? { behind: pull.commits_behind } : {}),
    ...(typeof pull.commits_ahead === "number" ? { ahead: pull.commits_ahead } : {}),
    ...(conflicted ? { conflicts: true } : {}),
    ...(typeof pull.head_sha === "string" ? { headSha: pull.head_sha } : {}) };
}

function failed(error: unknown, domain: string): RequestList {
  if (error instanceof HostApiError) return { available: false, reason: error.reason, message: error.reason === "auth" ? `${error.message} ${SIGN_IN(domain)}` : error.message, pulls: [], current: null };
  return { available: false, reason: "failed", message: error instanceof Error ? error.message : String(error), pulls: [], current: null };
}

export const gitboy: GitHostProvider = {
  kind: "gitboy",
  name: "gitboy",
  terms: PULL_TERMS,
  supported: true,

  async list(root, branch, host) {
    const ctx = await context(root, host);
    if (!("api" in ctx)) return ctx;
    try {
      const [{ json }, current] = await Promise.all([call<unknown>(ctx, "/pulls?state=open&limit=50"), currentRequest(ctx, branch)]);
      return { available: true, pulls: rows(json).map(pull => listed(ctx, pull)), current, account: ctx.account };
    } catch (error) { return failed(error, ctx.domain); }
  },

  async open(root, branch, draft, host) {
    const ctx = await context(root, host);
    if (!("api" in ctx)) return { ok: false, reason: ctx.reason, message: ctx.message };
    try {
      const { json: open } = await call<unknown>(ctx, "/pulls?state=open&limit=100");
      const existing = rows(open).find(pull => pull.head_branch === branch);
      if (existing) return { ok: true, url: pullUrl(ctx, existing), number: existing.index as number, branch, existing: true };
      const { json: repo } = await call<Json>(ctx, "");
      const target = String(obj(repo).default_branch ?? "main");
      const fill = await fillFromCommits(root, `${host.remote ?? "origin"}/${target}`, branch);
      // gitboy has no draft state; the title says it, as GitLab's convention does.
      const title = draft && !/^draft:/i.test(fill.title) ? `Draft: ${fill.title}` : fill.title;
      const { json } = await call<Json>(ctx, "/pulls", { method: "POST", body: { head_branch: branch, base_branch: target, title, body: fill.body } });
      const pull = obj(json);
      return { ok: true, url: pullUrl(ctx, pull), number: (pull.index ?? pull.number) as number, branch, draft };
    } catch (error) {
      if (error instanceof HostApiError && error.status === 400 && /no changes|nothing to compare/i.test(error.message)) return { ok: false, reason: "failed", message: `${branch} has no changes against the default branch.` };
      if (error instanceof HostApiError && error.status === 404 && /branch/i.test(error.message)) return { ok: false, reason: "not-found", message: `Push ${branch} to gitboy first, then open the pull request.` };
      const result = failed(error, ctx.domain);
      return { ok: false, reason: result.reason ?? "failed", message: result.message ?? "gitboy refused the pull request." };
    }
  },

  async merge(root, request: MergeRequest, host) {
    const ctx = await context(root, host);
    if (!("api" in ctx)) return { ok: false, reason: ctx.reason, message: ctx.message };
    try {
      const { json } = await call<Json>(ctx, `/pulls/${request.number}/merge`, { method: "POST", body: {
        method: request.method, ...(request.expectedHeadSha ? { expected_head_sha: request.expectedHeadSha } : {}) } });
      const result = obj(json);
      return { ok: true, number: request.number, method: request.method, ...(typeof result.merge_commit_sha === "string" ? { mergeCommit: result.merge_commit_sha } : {}) };
    } catch (error) {
      if (error instanceof HostApiError && (error.status === 409 || error.status === 422 || error.status === 400)) {
        return { ok: false, reason: "blocked", message: error.message.replace(/^.*? answered \d+:? ?/, "") || "gitboy says it can't be merged yet." };
      }
      if (error instanceof HostApiError && error.status === 403) return { ok: false, reason: "auth", message: "The gitboy token can read but not merge here; it needs write:repo, and your account needs merge rights on the branch." };
      const result = failed(error, ctx.domain);
      return { ok: false, reason: result.reason ?? "failed", message: result.message ?? "gitboy refused the merge." };
    }
  },

  async whoami(root, host, token) {
    if (!host.domain) throw new HostApiError("failed", "This repository has no gitboy remote.");
    const api = await apiRoot(root, host.domain, `https://${host.domain}/api/v1`);
    const { json } = await hostJson<Json>(`${api}/user`, { token, scheme: "bearer" });
    return { user: String(obj(json).username ?? "") };
  },
};
