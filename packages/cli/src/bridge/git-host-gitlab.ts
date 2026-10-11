import type { GitHost, GitHostProvider, HostTerms, MergeRequest, RequestList } from "./git-hosts.js";
import { resolveHostToken } from "./git-host-auth.js";
import { apiRoot, HostApiError, hostJson, safeLink } from "./git-host-http.js";
import { git } from "./projects.js";
import type { Json } from "./protocol.js";

/** GitLab, gitlab.com or self-hosted, over its REST API (v4). The token is
 * GITLAB_TOKEN, the Hook's stored one, or glab's own sign-in, so glab itself
 * is optional. Merge requests come back in the same shape as GitHub's pull
 * requests; pipeline jobs are the checks, and the stage reads as the workflow. */

export const MERGE_TERMS: HostTerms = { short: "MR", long: "merge request", ref: "!" };

type Order = "failing" | "pending" | "passing" | "skipped" | "neutral";
const ORDER: Record<Order, number> = { failing: 0, pending: 1, passing: 2, skipped: 3, neutral: 4 };

/** A pipeline or job status as one state word. An allowed failure is neutral:
 * it doesn't block the merge request. */
export function gitlabState(status: unknown, allowFailure = false): Order {
  switch (String(status ?? "").toLowerCase()) {
    case "success": return "passing";
    case "failed": return allowFailure ? "neutral" : "failing";
    case "canceled": case "canceling": return allowFailure ? "neutral" : "failing";
    case "skipped": return "skipped";
    case "manual": return "neutral";
    default: return "pending"; // created, waiting_for_resource, preparing, pending, running, scheduled
  }
}

export function gitlabRollup(states: Order[]): "passing" | "failing" | "pending" | null {
  if (!states.length) return null;
  if (states.includes("failing")) return "failing";
  return states.includes("pending") ? "pending" : "passing";
}

/** What `detailed_merge_status` means, in GitHub's mergeStateStatus words
 * (which the clients already colour) plus GitLab's own sentence. */
export function gitlabMergeState(detail: unknown): { mergeState?: string; mergeDetail?: string } {
  const value = String(detail ?? "");
  const map: Record<string, [string, string]> = {
    mergeable: ["CLEAN", "Ready to merge"],
    conflict: ["DIRTY", "Has merge conflicts"],
    need_rebase: ["BEHIND", "Needs a rebase onto the target branch"],
    ci_must_pass: ["BLOCKED", "Waiting for the pipeline to pass"],
    ci_still_running: ["BLOCKED", "Pipeline still running"],
    not_approved: ["BLOCKED", "Needs approval"],
    discussions_not_resolved: ["BLOCKED", "Has unresolved threads"],
    draft_status: ["DRAFT", "Draft"],
    blocked_status: ["BLOCKED", "Blocked by another merge request"],
    requested_changes: ["BLOCKED", "Changes requested"],
    jira_association_missing: ["BLOCKED", "Needs a Jira issue"],
    merge_request_blocked: ["BLOCKED", "Blocked"],
    external_status_checks: ["BLOCKED", "Waiting for external status checks"],
    not_open: ["UNKNOWN", "Not open"],
    checking: ["UNKNOWN", "Checking mergeability"],
    unchecked: ["UNKNOWN", "Not checked yet"],
    preparing: ["UNKNOWN", "Preparing"],
  };
  const hit = map[value];
  return hit ? { mergeState: hit[0], mergeDetail: hit[1] } : value ? { mergeState: "UNKNOWN", mergeDetail: value.replace(/_/g, " ") } : {};
}

function upper(state: unknown): string {
  const value = String(state ?? "").toLowerCase();
  return value === "opened" ? "OPEN" : value === "locked" ? "CLOSED" : value.toUpperCase();
}

function obj(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function projectPath(host: GitHost): string | null {
  if (!host.webUrl || !host.domain) return null;
  const path = host.webUrl.replace(/^https?:\/\/[^/]+\//, "");
  return path || null;
}

const SIGN_IN = (domain: string) =>
  `Phren has no GitLab token for ${domain}. Connect it from the desktop's Changes pane, run phren bridge git-host set ${domain} gitlab on this computer, or sign in with glab auth login.`;

interface Ctx { base: string; token: string; project: string; domain: string; account: { source: string; user?: string } }

async function context(root: string, host: GitHost): Promise<Ctx | RequestList> {
  const path = projectPath(host);
  if (!host.domain || !path) return { available: false, reason: "unknown-host", message: "This repository has no GitLab remote.", pulls: [], current: null };
  const token = await resolveHostToken("gitlab", host.domain);
  if (!token) return { available: false, reason: "auth", message: SIGN_IN(host.domain), pulls: [], current: null };
  const base = await apiRoot(root, host.domain, `https://${host.domain}/api/v4`);
  return { base, token: token.token, project: encodeURIComponent(path), domain: host.domain, account: { source: token.source, ...(token.user ? { user: token.user } : {}) } };
}

function call<T = unknown>(ctx: Ctx, path: string, init: { method?: "GET" | "POST" | "PUT"; body?: Json } = {}) {
  return hostJson<T>(`${ctx.base}/projects/${ctx.project}${path}`, { token: ctx.token, scheme: "private-token", ...init });
}

function listed(mr: Json): Json {
  const author = obj(mr.author);
  return { number: mr.iid, title: String(mr.title ?? ""), head: String(mr.source_branch ?? ""), base: String(mr.target_branch ?? ""),
    author: String(author.username ?? author.name ?? ""), url: safeLink(mr.web_url) ?? "", draft: mr.draft === true || mr.work_in_progress === true,
    state: upper(mr.state), updated: String(mr.updated_at ?? "") };
}

/** The branch's merge request with its pipeline jobs, approvals and merge state. */
async function currentRequest(ctx: Ctx, branch: string): Promise<Json | null> {
  if (!branch) return null;
  const { json: found } = await call<unknown[]>(ctx, `/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all&order_by=updated_at&per_page=5`);
  const first = (Array.isArray(found) ? found : []).map(obj).sort((a, b) => Number(upper(b.state) === "OPEN") - Number(upper(a.state) === "OPEN"))[0];
  if (!first || typeof first.iid !== "number") return null;
  const [{ json: detail }, approvals] = await Promise.all([
    call<Json>(ctx, `/merge_requests/${first.iid}`),
    call<Json>(ctx, `/merge_requests/${first.iid}/approvals`).then(r => obj(r.json)).catch(() => null),
  ]);
  const mr = obj(detail);
  const pipeline = obj(mr.head_pipeline ?? mr.pipeline);
  let checkRuns: Json[] = [];
  if (typeof pipeline.id === "number") {
    const { json: jobs } = await call<unknown[]>(ctx, `/pipelines/${pipeline.id}/jobs?per_page=100&include_retried=false`).catch(() => ({ json: [] as unknown[] }));
    checkRuns = (Array.isArray(jobs) ? jobs : []).map(obj).map(job => {
      const state = gitlabState(job.status, job.allow_failure === true);
      const url = safeLink(job.web_url);
      return { name: String(job.name ?? "Job").slice(0, 200), state, ...(job.stage ? { workflow: String(job.stage).slice(0, 200) } : {}), ...(url ? { url } : {}),
        ...(typeof job.duration === "number" ? { seconds: Math.round(job.duration) } : {}) };
    }).sort((a, b) => ORDER[a.state] - ORDER[b.state]).slice(0, 100);
  }
  const given = Array.isArray(approvals?.approved_by) ? approvals!.approved_by.length : 0;
  const left = typeof approvals?.approvals_left === "number" ? approvals.approvals_left : undefined;
  const required = typeof approvals?.approvals_required === "number" ? approvals.approvals_required : undefined;
  const reviewDecision = approvals?.approved === true && (left ?? 0) === 0 && (required ?? given) > 0 ? "APPROVED"
    : (left ?? 0) > 0 ? "REVIEW_REQUIRED" : undefined;
  const pipelineState = typeof pipeline.status === "string" ? gitlabState(pipeline.status) : null;
  const checks = checkRuns.length ? gitlabRollup(checkRuns.map(run => run.state as Order)) : pipelineState === "neutral" || pipelineState === "skipped" ? "passing" : pipelineState;
  const pipelineUrl = safeLink(pipeline.web_url);
  return { ...listed(mr), checks, checkRuns,
    ...(reviewDecision ? { reviewDecision } : {}),
    ...gitlabMergeState(mr.detailed_merge_status ?? mr.merge_status),
    ...(typeof pipeline.id === "number" ? { pipeline: { id: pipeline.id, state: pipelineState, ...(pipelineUrl ? { url: pipelineUrl } : {}) } } : {}),
    ...(given || required !== undefined ? { approvals: { given, ...(required !== undefined ? { required } : {}) } } : {}),
    ...(typeof mr.user_notes_count === "number" ? { comments: mr.user_notes_count } : {}),
    ...(mr.has_conflicts === true ? { conflicts: true } : {}) };
}

function failed(error: unknown, domain: string): RequestList {
  if (error instanceof HostApiError) {
    const message = error.reason === "auth" ? `${error.message} ${SIGN_IN(domain)}` : error.message;
    return { available: false, reason: error.reason, message, pulls: [], current: null };
  }
  return { available: false, reason: "failed", message: error instanceof Error ? error.message : String(error), pulls: [], current: null };
}

/** gh's --fill: one commit gives the title and body; several give a title from
 * the branch and a body listing them. */
export async function fillFromCommits(root: string, baseRef: string, branch: string): Promise<{ title: string; body: string }> {
  const raw = await git(root, "log", "--reverse", "--format=%s%x1f%b%x1e", `${baseRef}..${branch}`).catch(() => "");
  const commits = raw.split("\x1e").map(entry => entry.trim()).filter(Boolean).map(entry => { const [subject, body = ""] = entry.split("\x1f"); return { subject: subject.trim(), body: body.trim() }; });
  if (commits.length === 1) return { title: commits[0].subject, body: commits[0].body };
  const words = branch.replace(/^[^/]+\//, "").replace(/[-_]+/g, " ").trim();
  const title = words ? words[0].toUpperCase() + words.slice(1) : branch;
  return { title, body: commits.map(commit => `- ${commit.subject}`).join("\n") };
}

export const gitlab: GitHostProvider = {
  kind: "gitlab",
  name: "GitLab",
  terms: MERGE_TERMS,
  supported: true,

  async list(root, branch, host) {
    const ctx = await context(root, host);
    if (!("base" in ctx)) return ctx;
    try {
      const [{ json }, current] = await Promise.all([
        call<unknown[]>(ctx, "/merge_requests?state=opened&order_by=updated_at&per_page=50"),
        currentRequest(ctx, branch),
      ]);
      return { available: true, pulls: (Array.isArray(json) ? json : []).map(obj).map(listed), current, account: ctx.account };
    } catch (error) { return failed(error, ctx.domain); }
  },

  async open(root, branch, draft, host) {
    const ctx = await context(root, host);
    if (!("base" in ctx)) return { ok: false, reason: ctx.reason, message: ctx.message };
    try {
      await call(ctx, `/repository/branches/${encodeURIComponent(branch)}`).catch(error => {
        if (error instanceof HostApiError && error.reason === "not-found") throw new HostApiError("not-found", `Push ${branch} to GitLab first, then open the merge request.`, 404);
        throw error;
      });
      const { json: project } = await call<Json>(ctx, "");
      const target = String(obj(project).default_branch ?? "main");
      const fill = await fillFromCommits(root, `${host.remote ?? "origin"}/${target}`, branch);
      const title = draft && !/^draft:/i.test(fill.title) ? `Draft: ${fill.title}` : fill.title;
      try {
        const { json } = await call<Json>(ctx, "/merge_requests", { method: "POST", body: { source_branch: branch, target_branch: target, title, description: fill.body, remove_source_branch: true } });
        return { ok: true, url: safeLink(obj(json).web_url) ?? "", number: obj(json).iid as number, branch, draft };
      } catch (error) {
        if (error instanceof HostApiError && error.status === 409) {
          const { json } = await call<unknown[]>(ctx, `/merge_requests?source_branch=${encodeURIComponent(branch)}&state=opened&per_page=1`);
          const existing = (Array.isArray(json) ? json : []).map(obj)[0];
          if (existing) return { ok: true, url: safeLink(existing.web_url) ?? "", number: existing.iid as number, branch, existing: true };
        }
        throw error;
      }
    } catch (error) {
      const result = failed(error, ctx.domain);
      return { ok: false, reason: result.reason ?? "failed", message: result.message ?? "GitLab refused the merge request." };
    }
  },

  async merge(root, request: MergeRequest, host) {
    const ctx = await context(root, host);
    if (!("base" in ctx)) return { ok: false, reason: ctx.reason, message: ctx.message };
    try {
      // GitLab merges, or rebases, by the project's own merge method; squash is per request.
      const { json } = await call<Json>(ctx, `/merge_requests/${request.number}/merge`, { method: "PUT", body: {
        squash: request.method === "squash", ...(request.expectedHeadSha ? { sha: request.expectedHeadSha } : {}),
        ...(request.deleteBranch ? { should_remove_source_branch: true } : {}) } });
      const mr = obj(json);
      return { ok: true, number: request.number, method: request.method, state: upper(mr.state), ...(safeLink(mr.web_url) ? { url: safeLink(mr.web_url) } : {}) };
    } catch (error) {
      if (error instanceof HostApiError && [405, 406, 409, 422].includes(error.status)) {
        const why = error.status === 409 ? "The merge request has new commits since you looked; refresh and check them first." : error.message.replace(/^.*? answered \d+:? ?/, "") || "GitLab says it can't be merged yet.";
        return { ok: false, reason: "blocked", message: why };
      }
      const result = failed(error, ctx.domain);
      return { ok: false, reason: result.reason ?? "failed", message: result.message ?? "GitLab refused the merge." };
    }
  },

  async whoami(root, host, token) {
    if (!host.domain) throw new HostApiError("failed", "This repository has no GitLab remote.");
    const base = await apiRoot(root, host.domain, `https://${host.domain}/api/v4`);
    const { json } = await hostJson<Json>(`${base}/user`, { token, scheme: "private-token" });
    return { user: String(obj(json).username ?? "") };
  },
};
