import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHost } from "./git-hosts.js";
import { gitlab, gitlabMergeState, gitlabRollup, gitlabState, MERGE_TERMS } from "./git-host-gitlab.js";

interface Seen { url: string; method: string; headers: Record<string, string>; body?: unknown }
interface Answer { status?: number; json?: unknown; text?: string }

const ROOT = process.cwd();

/** A stand-in for the network boundary: answers from a route table and records
 * every request, so a test can assert the URL GitLab was called on. */
function fakeFetch(route: (seen: Seen) => Answer | undefined) {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const entry: Seen = { url, method: init?.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) };
    seen.push(entry);
    const answer = route(entry) ?? { status: 404, json: { message: "404 Not Found" } };
    const text = answer.text ?? JSON.stringify(answer.json ?? null);
    return { status: answer.status ?? 200, headers: new Headers({ "content-type": "application/json" }), text: async () => text } as unknown as Response;
  });
  return seen;
}

function host(webUrl: string | null, domain: string | null = "gitlab.example.com"): GitHost {
  return { kind: "gitlab", name: "GitLab", domain, webUrl, remote: "origin", source: "url", terms: MERGE_TERMS, supported: true };
}

function token(domain = "gitlab.example.com") {
  vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(tmpdir(), `phren-gitlab-test-${process.pid}.gitconfig`));
  vi.stubEnv("PHREN_BRIDGE_HOME", path.join(tmpdir(), `phren-gitlab-test-bridge-${process.pid}`));
  vi.stubEnv("GITLAB_HOST", domain);
  vi.stubEnv("GITLAB_TOKEN", "glpat-test");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const mr = { iid: 12, title: "Cache the stats run", source_branch: "feature", target_branch: "main",
  author: { username: "sam" }, web_url: "https://gitlab.example.com/team/sub/app/-/merge_requests/12",
  draft: false, state: "opened", updated_at: "2026-10-10T01:00:00Z" };
const BASE = "https://gitlab.example.com/api/v4/projects/team%2Fsub%2Fapp";

describe("GitLab requests", () => {
  it("lists an encoded nested project path, within the provider's own limits", async () => {
    token();
    const seen = fakeFetch(({ url }) => {
      if (url === `${BASE}/merge_requests?state=opened&order_by=updated_at&per_page=50`) return { json: [mr] };
      if (url === `${BASE}/merge_requests?source_branch=feature&state=all&order_by=updated_at&per_page=5`) return { json: [mr] };
      if (url === `${BASE}/merge_requests/12`) return { json: { ...mr, detailed_merge_status: "mergeable",
        head_pipeline: { id: 77, status: "success", web_url: "https://gitlab.example.com/team/sub/app/-/pipelines/77" } } };
      if (url === `${BASE}/merge_requests/12/approvals`) return { json: { approved: true, approvals_required: 1, approvals_left: 0, approved_by: [{ username: "ada" }] } };
      if (url === `${BASE}/pipelines/77/jobs?per_page=100&include_retried=false`) return { json: [{ name: "lint", stage: "test", status: "success" }] };
      return undefined;
    });

    const result = await gitlab.list(ROOT, "feature", host("https://gitlab.example.com/team/sub/app"));

    expect(result).toMatchObject({ available: true, account: { source: "environment" } });
    expect(seen.map(entry => entry.url).sort()).toEqual([
      `${BASE}/merge_requests/12`,
      `${BASE}/merge_requests/12/approvals`,
      `${BASE}/merge_requests?source_branch=feature&state=all&order_by=updated_at&per_page=5`,
      `${BASE}/merge_requests?state=opened&order_by=updated_at&per_page=50`,
      `${BASE}/pipelines/77/jobs?per_page=100&include_retried=false`,
    ].sort());
    expect(seen.every(entry => entry.headers["private-token"] === "glpat-test")).toBe(true);
  });

  it("reads the open request among the branch's recent ones, with a slash in the branch encoded", async () => {
    token();
    const closed = { ...mr, iid: 7, state: "closed", updated_at: "2026-10-11T01:00:00Z" };
    const open = { ...mr, iid: 8, source_branch: "feature/api", updated_at: "2026-10-10T01:00:00Z" };
    const seen = fakeFetch(({ url }) => {
      if (url === `${BASE}/merge_requests?state=opened&order_by=updated_at&per_page=50`) return { json: [open] };
      if (url === `${BASE}/merge_requests?source_branch=feature%2Fapi&state=all&order_by=updated_at&per_page=5`) return { json: [closed, open] };
      if (url === `${BASE}/merge_requests/8`) return { json: { ...open, detailed_merge_status: "conflict" } };
      if (url === `${BASE}/merge_requests/8/approvals`) return { json: {} };
      return undefined;
    });

    const result = await gitlab.list(ROOT, "feature/api", host("https://gitlab.example.com/team/sub/app"));

    expect(result.current).toMatchObject({ number: 8, state: "OPEN", mergeState: "DIRTY", mergeDetail: "Has merge conflicts" });
    expect(seen.map(entry => entry.url)).toContain(`${BASE}/merge_requests?source_branch=feature%2Fapi&state=all&order_by=updated_at&per_page=5`);
  });

  it("reads whoami from the given API root over GitLab's private-token header", async () => {
    const seen = fakeFetch(({ url }) => url === "https://gitlab.internal:8443/api/v4/user" ? { json: { username: "sam" } } : undefined);

    expect(await gitlab.whoami(ROOT, host("https://gitlab.internal/team/app", "gitlab.internal"), "glpat-test", "https://gitlab.internal:8443/api/v4"))
      .toEqual({ user: "sam" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "https://gitlab.internal:8443/api/v4/user", headers: { "private-token": "glpat-test" } });
  });
});

describe("GitLab mapping", () => {
  it("maps opened, merged and closed merge requests, draft states and authors into the shared shape", async () => {
    token();
    const rows = [
      { iid: 1, title: "Open", source_branch: "one", target_branch: "main", author: { username: "sam" },
        web_url: "https://gitlab.example.com/team/sub/app/-/merge_requests/1", draft: false, state: "opened", updated_at: "2026-10-10T01:00:00Z" },
      { iid: 2, title: "Merged", source_branch: "two", target_branch: "release", author: { name: "Ada Lovelace" },
        web_url: "javascript:alert(1)", state: "merged", updated_at: "2026-10-10T02:00:00Z" },
      { iid: 3, title: "Draft", source_branch: "three", target_branch: "main", author: { username: "lin" },
        web_url: "https://gitlab.example.com/team/sub/app/-/merge_requests/3", draft: true, state: "closed", updated_at: "2026-10-10T03:00:00Z" },
      { iid: 4, title: "WIP", source_branch: "four", target_branch: "main", work_in_progress: true, state: "locked", updated_at: "2026-10-10T04:00:00Z" },
    ];
    fakeFetch(({ url }) => url.includes("/merge_requests?state=opened") ? { json: rows } : undefined);

    const result = await gitlab.list(ROOT, "", host("https://gitlab.example.com/team/sub/app"));

    expect(result.pulls).toEqual([
      { number: 1, title: "Open", head: "one", base: "main", author: "sam",
        url: "https://gitlab.example.com/team/sub/app/-/merge_requests/1", draft: false, state: "OPEN", updated: "2026-10-10T01:00:00Z" },
      { number: 2, title: "Merged", head: "two", base: "release", author: "Ada Lovelace",
        url: "", draft: false, state: "MERGED", updated: "2026-10-10T02:00:00Z" },
      { number: 3, title: "Draft", head: "three", base: "main", author: "lin",
        url: "https://gitlab.example.com/team/sub/app/-/merge_requests/3", draft: true, state: "CLOSED", updated: "2026-10-10T03:00:00Z" },
      { number: 4, title: "WIP", head: "four", base: "main", author: "",
        url: "", draft: true, state: "CLOSED", updated: "2026-10-10T04:00:00Z" },
    ]);
  });

  it("treats canceled and allowed-failure jobs as neutral and rolls up failing over pending", () => {
    expect(gitlabState("canceled")).toBe("failing");
    expect(gitlabState("canceled", true)).toBe("neutral");
    expect(gitlabState("running")).toBe("pending");
    expect(gitlabRollup([])).toBeNull();
    expect(gitlabRollup(["passing", "skipped"])).toBe("passing");
    expect(gitlabRollup(["passing", "pending"])).toBe("pending");
    expect(gitlabRollup(["pending", "failing"])).toBe("failing");
  });

  it("speaks an unknown merge status as an UNKNOWN state without the underscores", () => {
    expect(gitlabMergeState("need_rebase")).toEqual({ mergeState: "BEHIND", mergeDetail: "Needs a rebase onto the target branch" });
    expect(gitlabMergeState("something_new")).toEqual({ mergeState: "UNKNOWN", mergeDetail: "something new" });
    expect(gitlabMergeState(undefined)).toEqual({});
  });
});

describe("GitLab failures", () => {
  it.each([
    { status: 401, reason: "auth" },
    { status: 403, reason: "auth" },
    { status: 404, reason: "not-found" },
  ])("maps a $status refusal to $reason and leaves an empty list", async ({ status, reason }) => {
    token();
    fakeFetch(() => ({ status, json: { message: `refused ${status}` } }));

    const result = await gitlab.list(ROOT, "", host("https://gitlab.example.com/team/sub/app"));

    expect(result).toMatchObject({ available: false, reason, pulls: [], current: null });
    if (reason === "auth") expect(result.message).toContain("Phren has no GitLab token for gitlab.example.com");
  });

  it("reports a non-JSON server error as failed with the host and status", async () => {
    token();
    fakeFetch(() => ({ status: 500, text: "<html>boom</html>" }));

    const result = await gitlab.list(ROOT, "", host("https://gitlab.example.com/team/sub/app"));

    expect(result).toMatchObject({ available: false, reason: "failed", message: "gitlab.example.com answered 500", pulls: [], current: null });
  });

  it("reports a missing remote or token without asking the host", async () => {
    const seen = fakeFetch(() => ({ json: [] }));

    expect(await gitlab.list(ROOT, "feature", host(null, "gitlab.example.com")))
      .toMatchObject({ available: false, reason: "unknown-host", message: "This repository has no GitLab remote." });
    expect(await gitlab.list(ROOT, "feature", host(null, null)))
      .toMatchObject({ available: false, reason: "unknown-host" });

    token("gitlab.unconfigured.invalid");
    vi.stubEnv("GITLAB_TOKEN", "");
    vi.stubEnv("GL_TOKEN", "");
    const domain = "gitlab.unconfigured.invalid";
    const denied = await gitlab.list(ROOT, "feature", host(`https://${domain}/team/app`, domain));
    expect(denied).toMatchObject({ available: false, reason: "auth", pulls: [], current: null });
    expect(denied.message).toContain(`Phren has no GitLab token for ${domain}`);
    expect(denied.message).toContain("glab auth login");
    expect(seen).toEqual([]);
  });

  it("passes GitLab's merge refusals on as blocked, and a missing token as auth", async () => {
    token();
    let answer: Answer = { status: 409, json: { message: "Branch cannot be merged" } };
    fakeFetch(({ method, url }) => method === "PUT" && url === `${BASE}/merge_requests/12/merge` ? answer : undefined);

    expect(await gitlab.merge(ROOT, { number: 12, method: "merge" }, host("https://gitlab.example.com/team/sub/app")))
      .toMatchObject({ ok: false, reason: "blocked", message: "The merge request has new commits since you looked; refresh and check them first." });
    answer = { status: 422, json: { message: "Branch cannot be merged" } };
    expect(await gitlab.merge(ROOT, { number: 12, method: "merge" }, host("https://gitlab.example.com/team/sub/app")))
      .toMatchObject({ ok: false, reason: "blocked", message: "Branch cannot be merged" });
    answer = { status: 401, json: { message: "401 Unauthorized" } };
    const denied = await gitlab.merge(ROOT, { number: 12, method: "merge" }, host("https://gitlab.example.com/team/sub/app"));
    expect(denied).toMatchObject({ ok: false, reason: "auth" });
    expect(denied.message).toContain("Phren has no GitLab token for gitlab.example.com");
  });
});
