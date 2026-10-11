import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Json } from "./protocol.js";
import { git } from "./projects.js";
import { runCombined } from "./git-publish.js";
import { gitboy } from "./git-host-gitboy.js";
import { gitlab } from "./git-host-gitlab.js";

const exec = promisify(execFile);

/** Where a repository's pull or merge requests live. Phren supports three git
 * hosts: GitHub, GitLab and gitboy (self-hosted, any domain). The host is read
 * from the remote's URL; a self-hosted GitLab or gitboy is named by an
 * override, per remote or per domain, in git config:
 *
 *   git config remote.origin.phrenHost gitlab            # this repository's origin
 *   git config --global phren.git.example.com.host gitboy  # every repo on that domain
 *
 * Each host is a provider with one small interface: list the requests and
 * the checked-out branch's own with its checks, and open one. */

export type HostKind = "github" | "gitlab" | "gitboy";
export const HOST_KINDS: readonly HostKind[] = ["github", "gitlab", "gitboy"];

export interface HostTerms { short: string; long: string; ref: string }

export interface GitHost {
  kind: HostKind | null;
  /** The product name a link reads ("View on GitLab"), or "the git host". */
  name: string;
  /** The remote's domain and the repository's web address, when known. */
  domain: string | null;
  webUrl: string | null;
  remote: string | null;
  /** How the kind was found: from the URL, from an override, or not at all. */
  source: "url" | "remote-override" | "domain-override" | "none";
  terms: HostTerms;
  /** False for a provider that is not built yet (GitLab, gitboy). */
  supported: boolean;
}

export interface RequestList { available: boolean; reason?: string; message?: string; pulls: Json[]; current: Json | null;
  /** Where the token came from and who it signs in as, when the host says. */
  account?: { source: string; user?: string } }

export interface GitHostProvider {
  readonly kind: HostKind;
  readonly name: string;
  readonly terms: HostTerms;
  readonly supported: boolean;
  /** Open requests and the checked-out branch's own (any state) with its checks. */
  list(root: string, branch: string, host: GitHost): Promise<RequestList>;
  /** Open a request from `branch` into the default branch, titled from its commits. */
  open(root: string, branch: string, draft: boolean, host: GitHost): Promise<Json>;
  /** Merge request `number`, only while its head is still `expectedHeadSha`
   * when one is given. The host's own refusal (checks, approvals, conflicts)
   * comes back as `{ ok: false, reason: "blocked", message }`. */
  merge(root: string, request: MergeRequest, host: GitHost): Promise<Json>;
  /** Who a token signs in as, for Connect; HTTP hosts only. */
  whoami?(root: string, host: GitHost, token: string): Promise<{ user: string }>;
}

export type MergeMethod = "merge" | "squash" | "rebase";
export interface MergeRequest { number: number; method: MergeMethod; expectedHeadSha?: string; deleteBranch?: boolean }

const PULL_TERMS: HostTerms = { short: "PR", long: "pull request", ref: "#" };

/** `git@host:owner/repo.git`, `ssh://git@host:2222/owner/repo.git`,
 * `https://user@host/owner/repo` → the domain and the repository path. */
export function parseRemoteUrl(url: string): { domain: string; path: string } | null {
  const text = url.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { domain: scp[1].toLowerCase(), path: clean(scp[2]) };
  try {
    const parsed = new URL(text);
    if (!["http:", "https:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(parsed.protocol) || !parsed.hostname) return null;
    return { domain: parsed.hostname.toLowerCase(), path: clean(parsed.pathname) };
  } catch { return null; }
}

function clean(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
}

/** The kind a domain implies on its own: the public hosts by name, a
 * self-hosted one when its first label says so (`gitlab.example.com`). */
export function kindFromDomain(domain: string): HostKind | null {
  if (domain === "github.com" || domain.endsWith(".github.com") || domain.endsWith(".ghe.com")) return "github";
  if (domain === "gitlab.com") return "gitlab";
  const first = domain.split(".")[0];
  if (first === "gitlab") return "gitlab";
  if (first === "gitboy") return "gitboy";
  if (first === "github") return "github";
  return null;
}

function asKind(value: string): HostKind | null {
  const v = value.trim().toLowerCase();
  return (HOST_KINDS as readonly string[]).includes(v) ? v as HostKind : null;
}

async function config(root: string, key: string): Promise<string> {
  return (await git(root, "config", "--get", key).catch(() => "")).trim();
}

/** The remote a branch's requests belong to: its upstream's, else origin,
 * else the only remote. */
async function remoteFor(root: string, branch: string): Promise<string | null> {
  const remotes = (await git(root, "remote").catch(() => "")).split("\n").map(line => line.trim()).filter(Boolean);
  const upstream = branch ? await config(root, `branch.${branch}.remote`) : "";
  if (upstream && remotes.includes(upstream)) return upstream;
  if (remotes.includes("origin")) return "origin";
  return remotes[0] ?? null;
}

/** Which host a repository's remote is on, overrides first. */
export async function detectHost(root: string, branch: string): Promise<GitHost> {
  const remote = await remoteFor(root, branch);
  const url = remote ? await config(root, `remote.${remote}.url`) : "";
  const parsed = url ? parseRemoteUrl(url) : null;
  let kind: HostKind | null = null;
  let source: GitHost["source"] = "none";
  const remoteOverride = remote ? asKind(await config(root, `remote.${remote}.phrenHost`)) : null;
  const domainOverride = parsed ? asKind(await config(root, `phren.${parsed.domain}.host`)) : null;
  if (remoteOverride) { kind = remoteOverride; source = "remote-override"; }
  else if (domainOverride) { kind = domainOverride; source = "domain-override"; }
  else if (parsed && (kind = kindFromDomain(parsed.domain))) source = "url";
  return hostInfo(kind, { domain: parsed?.domain ?? null, webUrl: parsed ? `https://${parsed.domain}/${parsed.path}` : null, remote, source });
}

export function hostInfo(kind: HostKind | null, where: Pick<GitHost, "domain" | "webUrl" | "remote" | "source">): GitHost {
  const provider = kind ? PROVIDERS[kind] : null;
  return { kind, name: provider?.name ?? "the git host", ...where, terms: provider?.terms ?? PULL_TERMS, supported: provider?.supported ?? false };
}

export function providerFor(host: GitHost): GitHostProvider | null {
  return host.kind ? PROVIDERS[host.kind] : null;
}

/** Why there is no list: an unknown host says how to name it. */
export function unknownHost(host: GitHost): RequestList {
  const domain = host.domain ? ` ${host.domain}` : "";
  return { available: false, reason: "unknown-host", pulls: [], current: null,
    message: host.remote
      ? `Phren cannot tell which git host${domain} is. Name it with: git config remote.${host.remote}.phrenHost github|gitlab|gitboy`
      : "This repository has no remote, so it has no pull or merge requests." };
}

// ---------------------------------------------------------------- GitHub

/** A check rollup as one word: any failure fails, anything unfinished is
 * pending, and only finished successes (or skips) pass. No checks is null. */
export function checkRollup(items: unknown): "passing" | "failing" | "pending" | null {
  if (!Array.isArray(items) || !items.length) return null;
  let pending = false;
  for (const raw of items) {
    const item = raw && typeof raw === "object" ? raw as Json : {};
    const conclusion = String(item.conclusion ?? "").toUpperCase(), state = String(item.state ?? "").toUpperCase();
    const status = String(item.status ?? "").toUpperCase();
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion) || ["FAILURE", "ERROR"].includes(state)) return "failing";
    // A commit status has a state; a check run has a status and, once
    // completed, a conclusion.
    if (state && !status) { if (state !== "SUCCESS") pending = true; }
    else if (status !== "COMPLETED") pending = true;
  }
  return pending ? "pending" : "passing";
}

/** Each check as clients list it: a name, the workflow that ran it, one state
 * word and its page. Check runs and commit statuses read alike; failing
 * first, then pending, then the rest, at most 100. */
export function checkRuns(items: unknown): Json[] {
  if (!Array.isArray(items)) return [];
  const order = { failing: 0, pending: 1, passing: 2, skipped: 3, neutral: 4 } as const;
  const runs = items.map(raw => {
    const item = raw && typeof raw === "object" ? raw as Json : {};
    const conclusion = String(item.conclusion ?? "").toUpperCase(), state = String(item.state ?? "").toUpperCase();
    const status = String(item.status ?? "").toUpperCase();
    let word: keyof typeof order;
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion) || ["FAILURE", "ERROR"].includes(state)) word = "failing";
    else if (state && !status) word = state === "SUCCESS" ? "passing" : "pending";
    else if (status !== "COMPLETED") word = "pending";
    else if (conclusion === "SKIPPED") word = "skipped";
    else if (conclusion === "NEUTRAL" || conclusion === "STALE") word = "neutral";
    else word = "passing";
    const name = String(item.name ?? item.context ?? "").slice(0, 200) || "Check";
    const workflow = typeof item.workflowName === "string" && item.workflowName ? item.workflowName.slice(0, 200) : undefined;
    const url = String(item.detailsUrl ?? item.targetUrl ?? "");
    return { name, state: word, ...(workflow ? { workflow } : {}), ...(/^https:\/\//.test(url) ? { url: url.slice(0, 2048) } : {}) };
  });
  return runs.sort((a, b) => order[a.state] - order[b.state]).slice(0, 100);
}

/** gh never prompts, never nags about updates, and talks to the remote's own
 * domain (a GitHub Enterprise server as much as the public one). */
function ghEnv(host: GitHost): NodeJS.ProcessEnv {
  return { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", ...(host.domain ? { GH_HOST: host.domain } : {}) };
}

const PULL_URL = /https:\/\/[^\s"'<>]+\/pull\/\d+/;

const github: GitHostProvider = {
  kind: "github",
  name: "GitHub",
  terms: PULL_TERMS,
  supported: true,

  async list(root, branch, host) {
    const run = (args: string[]) => exec("gh", args, { cwd: root, timeout: 15_000, maxBuffer: 4_194_304, env: ghEnv(host) });
    const current = async (): Promise<Json | null> => {
      if (!branch) return null;
      try {
        const { stdout } = await run(["pr", "view", "--json", "number,title,url,state,isDraft,headRefName,baseRefName,statusCheckRollup,reviewDecision,mergeStateStatus"]);
        const pull = JSON.parse(stdout || "null");
        // gh falls back to another head's pull request; only this branch's counts.
        if (!pull || typeof pull !== "object" || typeof pull.number !== "number" || pull.headRefName !== branch) return null;
        return { number: pull.number, title: String(pull.title ?? ""), url: String(pull.url ?? ""), head: branch,
          base: String(pull.baseRefName ?? ""), draft: pull.isDraft === true, state: String(pull.state ?? ""), checks: checkRollup(pull.statusCheckRollup),
          checkRuns: checkRuns(pull.statusCheckRollup),
          ...(typeof pull.reviewDecision === "string" && pull.reviewDecision ? { reviewDecision: pull.reviewDecision } : {}),
          ...(typeof pull.mergeStateStatus === "string" && pull.mergeStateStatus ? { mergeState: pull.mergeStateStatus } : {}) };
      } catch { return null; }
    };
    try {
      const [{ stdout }, mine] = await Promise.all([
        run(["pr", "list", "--json", "number,title,headRefName,baseRefName,author,url,isDraft,state,updatedAt", "--limit", "50"]),
        current(),
      ]);
      const parsed = JSON.parse(stdout || "[]");
      const pulls = (Array.isArray(parsed) ? parsed : []).map((pull: Json) => {
        const author = pull.author && typeof pull.author === "object" ? pull.author as Json : {};
        return { number: pull.number, title: pull.title, head: pull.headRefName, base: pull.baseRefName,
          author: String(author.login ?? author.name ?? ""), url: pull.url, draft: pull.isDraft === true, state: pull.state, updated: pull.updatedAt };
      });
      return { available: true, pulls, current: mine };
    } catch {
      return { available: false, reason: "auth", message: "The GitHub CLI (gh) is missing or not signed in on this computer. Install it, then run gh auth login there.", pulls: [], current: null };
    }
  },

  async open(root, branch, draft, host) {
    const env = ghEnv(host);
    const run = (args: string[], timeout: number) => runCombined("gh", args, root, timeout, env);
    const version = await run(["--version"], 10_000);
    if (version.missing || version.code !== 0) {
      return { ok: false, reason: "missing", message: "The GitHub CLI (gh) is not installed on this computer. Install it, then run gh auth login there." };
    }
    const auth = await run(["auth", "status", ...(host.domain ? ["--hostname", host.domain] : [])], 15_000);
    if (auth.code !== 0) {
      return { ok: false, reason: "auth", message: "The GitHub CLI is not signed in on this computer. Run gh auth login there.", output: auth.output };
    }
    const result = await run(["pr", "create", "--fill", "--head", branch, ...(draft ? ["--draft"] : [])], 60_000);
    const url = PULL_URL.exec(result.output)?.[0];
    if (result.code === 0 && url) return { ok: true, url, branch, draft };
    if (url && /already exists/i.test(result.output)) return { ok: true, url, branch, existing: true };
    return { ok: false, reason: "failed", output: result.timedOut ? `${result.output}\n[gh did not finish within 60 seconds]`.trim() : result.output || "gh pr create failed." };
  },

  async merge(root, request, host) {
    // No --delete-branch: gh would also delete and leave the local branch,
    // which may be an agent's checkout.
    const args = ["pr", "merge", String(request.number), `--${request.method}`,
      ...(request.expectedHeadSha ? ["--match-head-commit", request.expectedHeadSha] : [])];
    const result = await runCombined("gh", args, root, 60_000, ghEnv(host));
    if (result.missing) return { ok: false, reason: "missing", message: "The GitHub CLI (gh) is not installed on this computer." };
    if (result.code === 0) return { ok: true, number: request.number, method: request.method };
    const output = result.output.trim();
    if (/not mergeable|required status|review|protected|blocked|head branch was modified|match-head-commit|conflict/i.test(output)) return { ok: false, reason: "blocked", message: output.slice(0, 1000) };
    if (/auth|login|401|403/i.test(output)) return { ok: false, reason: "auth", message: "The GitHub CLI is not signed in on this computer, or the account can't merge here. Run gh auth login there." };
    return { ok: false, reason: "failed", message: output.slice(0, 1000) || "gh pr merge failed." };
  },
};

export const PROVIDERS: Record<HostKind, GitHostProvider> = { github, gitlab, gitboy };
