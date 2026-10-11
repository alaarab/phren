import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { gitPulls } from "./git.js";
import { gitHostToken, gitMergeRequest, gitPullRequest } from "./git-publish.js";

const execFileAsync = promisify(execFile);

/** One request the fake host saw. */
interface Seen { method: string; path: string; headers: IncomingMessage["headers"]; body: unknown }
type Route = (seen: Seen) => { status?: number; json: unknown } | undefined;

/** A stand-in for a GitLab or gitboy server: answers from a route table and
 * records every request, so the tests assert what the Hook sent and how it
 * read the host's own JSON. */
async function fakeHost(route: Route) {
  const seen: Seen[] = [];
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const entry: Seen = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    seen.push(entry);
    const answer = route(entry) ?? { status: 404, json: { message: "404 Not Found" } };
    res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.json));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

describe("GitLab and gitboy providers", () => {
  let created: string | undefined;
  let host: Awaited<ReturnType<typeof fakeHost>> | undefined;
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, PHREN_BRIDGE_HOME: process.env.PHREN_BRIDGE_HOME, GITLAB_TOKEN: process.env.GITLAB_TOKEN, GITLAB_HOST: process.env.GITLAB_HOST, GITBOY_TOKEN: process.env.GITBOY_TOKEN, GITBOY_HOST: process.env.GITBOY_HOST };
  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await host?.close(); host = undefined;
    if (created) await rm(created, { recursive: true, force: true });
    created = undefined;
  });

  /** A repository on `feature` (one commit ahead of main) whose origin is
   * `remote`, with the host's API pointed at the fake through the real
   * `phren.<domain>.api` override, and a private Hook directory. */
  async function repository(remote: string, domain: string, api: string) {
    const root = created = await realpath(await mkdtemp(path.join(tmpdir(), "phren-host-providers-")));
    process.env.GIT_CONFIG_GLOBAL = path.join(root, "global.gitconfig");
    process.env.PHREN_BRIDGE_HOME = path.join(root, "bridge");
    for (const key of ["GITLAB_TOKEN", "GITLAB_HOST", "GITBOY_TOKEN", "GITBOY_HOST"]) delete process.env[key];
    const repo = path.join(root, "repo");
    const git = async (...args: string[]) => (await execFileAsync("git", ["-C", repo, ...args])).stdout;
    await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
    await git("config", "user.email", "sam@example.com"); await git("config", "user.name", "Sam");
    await git("commit", "-q", "--allow-empty", "-m", "Start");
    await git("remote", "add", "origin", remote);
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-q", "-b", "feature");
    await git("commit", "-q", "--allow-empty", "-m", "Cache the stats run", "-m", "One run serves every key.");
    await git("config", "--global", `phren.${domain}.api`, api);
    return repo;
  }

  describe("GitLab", () => {
    const mr = { iid: 12, title: "Cache the stats run", source_branch: "feature", target_branch: "main", author: { username: "sam" },
      web_url: "https://gitlab.example.com/team/app/-/merge_requests/12", draft: false, state: "opened", updated_at: "2026-10-10T01:00:00Z" };

    it("lists merge requests and reads the branch's pipeline jobs, approvals and merge state", async () => {
      host = await fakeHost(({ path: p }) => {
        if (p.startsWith("/api/v4/projects/team%2Fapp/merge_requests?state=opened")) return { json: [mr, { ...mr, iid: 9, source_branch: "other", draft: true }] };
        if (p.startsWith("/api/v4/projects/team%2Fapp/merge_requests?source_branch=feature")) return { json: [mr] };
        if (p === "/api/v4/projects/team%2Fapp/merge_requests/12") return { json: { ...mr, detailed_merge_status: "ci_must_pass", user_notes_count: 3,
          head_pipeline: { id: 77, status: "failed", web_url: "https://gitlab.example.com/team/app/-/pipelines/77" } } };
        if (p === "/api/v4/projects/team%2Fapp/merge_requests/12/approvals") return { json: { approved: false, approvals_required: 1, approvals_left: 1, approved_by: [] } };
        if (p.startsWith("/api/v4/projects/team%2Fapp/pipelines/77/jobs")) return { json: [
          { name: "lint", stage: "test", status: "success", web_url: "https://gitlab.example.com/j/1", duration: 12.4 },
          { name: "flaky", stage: "test", status: "failed", allow_failure: true, web_url: "https://gitlab.example.com/j/2" },
          { name: "unit", stage: "test", status: "failed", web_url: "https://gitlab.example.com/j/3" },
          { name: "deploy", stage: "deploy", status: "manual" },
        ] };
        return undefined;
      });
      const repo = await repository("git@gitlab.example.com:team/app.git", "gitlab.example.com", `${host.origin}/api/v4`);
      process.env.GITLAB_HOST = "gitlab.example.com"; process.env.GITLAB_TOKEN = "glpat-test";

      const list = await gitPulls(repo);
      expect(list).toMatchObject({ available: true, branch: "feature", account: { source: "environment" }, host: { kind: "gitlab", terms: { short: "MR", ref: "!" } } });
      expect(list.pulls).toEqual([
        { number: 12, title: "Cache the stats run", head: "feature", base: "main", author: "sam", url: mr.web_url, draft: false, state: "OPEN", updated: mr.updated_at },
        expect.objectContaining({ number: 9, head: "other", draft: true }),
      ]);
      expect(list.current).toMatchObject({ number: 12, checks: "failing", reviewDecision: "REVIEW_REQUIRED", mergeState: "BLOCKED",
        mergeDetail: "Waiting for the pipeline to pass", comments: 3, approvals: { given: 0, required: 1 },
        pipeline: { id: 77, state: "failing", url: "https://gitlab.example.com/team/app/-/pipelines/77" } });
      // Failing first; an allowed failure and a manual job never fail the request.
      expect((list.current as { checkRuns: { name: string; state: string }[] }).checkRuns.map(run => [run.name, run.state]))
        .toEqual([["unit", "failing"], ["lint", "passing"], ["flaky", "neutral"], ["deploy", "neutral"]]);
      expect(host.seen.every(s => s.headers["private-token"] === "glpat-test")).toBe(true);
    });

    it("opens a draft from the branch's one commit, and answers with the request that already exists", async () => {
      let exists = false;
      host = await fakeHost(({ method, path: p }) => {
        if (p === "/api/v4/projects/team%2Fapp/repository/branches/feature") return { json: { name: "feature" } };
        if (p === "/api/v4/projects/team%2Fapp") return { json: { default_branch: "main" } };
        if (method === "POST" && p === "/api/v4/projects/team%2Fapp/merge_requests") return exists
          ? { status: 409, json: { message: ["Another open merge request already exists for this source branch: !12"] } }
          : { status: 201, json: { iid: 12, web_url: mr.web_url } };
        if (p.startsWith("/api/v4/projects/team%2Fapp/merge_requests?source_branch=feature&state=opened")) return { json: [mr] };
        return undefined;
      });
      const repo = await repository("https://gitlab.example.com/team/app.git", "gitlab.example.com", `${host.origin}/api/v4`);
      process.env.GITLAB_HOST = "gitlab.example.com"; process.env.GITLAB_TOKEN = "glpat-test";

      expect(await gitPullRequest(repo, true)).toMatchObject({ ok: true, url: mr.web_url, number: 12, draft: true });
      expect(host.seen.find(s => s.method === "POST")?.body).toEqual({ source_branch: "feature", target_branch: "main",
        title: "Draft: Cache the stats run", description: "One run serves every key.", remove_source_branch: true });
      exists = true;
      expect(await gitPullRequest(repo, false)).toMatchObject({ ok: true, url: mr.web_url, existing: true });
    });

    it("merges only at the head it was shown, and passes GitLab's refusal on as blocked", async () => {
      let refuse = false;
      host = await fakeHost(({ method, path: p }) => {
        if (method === "PUT" && p === "/api/v4/projects/team%2Fapp/merge_requests/12/merge") return refuse
          ? { status: 406, json: { message: "Branch cannot be merged" } }
          : { json: { ...mr, state: "merged" } };
        return undefined;
      });
      const repo = await repository("git@gitlab.example.com:team/app.git", "gitlab.example.com", `${host.origin}/api/v4`);
      process.env.GITLAB_HOST = "gitlab.example.com"; process.env.GITLAB_TOKEN = "glpat-test";

      expect(await gitMergeRequest(repo, { number: 12, method: "squash", expectedHeadSha: "abc1234" })).toMatchObject({ ok: true, state: "MERGED" });
      expect(host.seen[0].body).toEqual({ squash: true, sha: "abc1234" });
      refuse = true;
      expect(await gitMergeRequest(repo, { number: 12 })).toMatchObject({ ok: false, reason: "blocked", message: "Branch cannot be merged" });
    });
  });

  describe("gitboy", () => {
    const head = "1111111111111111111111111111111111111111";
    const pull = { index: 7, title: "Cache the stats run", state: "open", author_username: "sam", head_branch: "feature", base_branch: "main",
      head_sha: head, updated_at: "2026-10-10T01:00:00Z", status: "mergeable", merged_at: null };

    it("finds the branch's pull request and reads reviews on the head commit, the newest job attempts and the merge blockers", async () => {
      host = await fakeHost(({ path: p }) => {
        if (p === "/api/v1/repos/sam/app/pulls?state=open&limit=50") return { json: [pull] };
        if (p === "/api/v1/repos/sam/app/pulls?state=all&limit=100") return { json: [{ ...pull, index: 3, head_branch: "older", state: "closed" }, pull] };
        if (p === "/api/v1/repos/sam/app/pulls/7") return { json: { ...pull, comment_count: 2, commits_behind: 1,
          merge_blockers: ["A successful pipeline is required"],
          reviews: [
            { reviewer_username: "ada", state: "approved", commit_sha: "0000000000000000000000000000000000000000", created_at: "2026-10-09T00:00:00Z" },
            { reviewer_username: "lin", state: "approved", commit_sha: head, created_at: "2026-10-10T00:00:00Z" },
            { reviewer_username: "sam", state: "approved", commit_sha: head, created_at: "2026-10-10T00:01:00Z" },
          ] } };
        if (p === "/api/v1/repos/sam/app/pipelines?branch=feature&limit=20") return { json: [{ iid: 4, sha: "old" }, { iid: 5, sha: head, status: "failed" }] };
        if (p === "/api/v1/repos/sam/app/pipelines/5") return { json: { iid: 5, status: "failed", jobs: [
          { id: "j1", name: "test", stage: "test", status: "failed", attempt: 1, failure_reason: "exit 1" },
          { id: "j2", name: "test", stage: "test", status: "success", attempt: 2, started_at: "2026-10-10T00:00:00Z", finished_at: "2026-10-10T00:01:30Z" },
          { id: "j3", name: "build", stage: "build", status: "running", attempt: 1 },
        ] } };
        return undefined;
      });
      const repo = await repository("git@gitboy.example.com:sam/app.git", "gitboy.example.com", `${host.origin}/api/v1`);
      process.env.GITBOY_HOST = "gitboy.example.com"; process.env.GITBOY_TOKEN = "gbp_test";

      const list = await gitPulls(repo);
      expect(list).toMatchObject({ available: true, host: { kind: "gitboy", terms: { short: "PR", ref: "#" } } });
      expect(list.pulls).toEqual([{ number: 7, title: "Cache the stats run", head: "feature", base: "main", author: "sam",
        url: `${host.origin}/sam/app/pulls/7`, draft: false, state: "OPEN", updated: pull.updated_at }]);
      // Only lin's approval counts: ada's is on an older commit and sam wrote the PR.
      expect(list.current).toMatchObject({ number: 7, checks: "pending", reviewDecision: "APPROVED", approvals: { given: 1 },
        mergeState: "BLOCKED", mergeDetail: "A successful pipeline is required", blockers: ["A successful pipeline is required"],
        comments: 2, behind: 1, headSha: head, pipeline: { id: 5, url: `${host.origin}/sam/app/pipelines/5` } });
      expect((list.current as { checkRuns: unknown[] }).checkRuns).toEqual([
        { name: "build", state: "pending", workflow: "build", url: `${host.origin}/sam/app/pipelines/5?job=j3` },
        { name: "test", state: "passing", workflow: "test", url: `${host.origin}/sam/app/pipelines/5?job=j2`, seconds: 90 },
      ]);
      expect(host.seen.every(s => s.headers.authorization === "Bearer gbp_test")).toBe(true);
    });

    it("opens a pull request unless the branch has one, and merges with gitboy's own refusal passed on", async () => {
      let open: unknown[] = [];
      host = await fakeHost(({ method, path: p }) => {
        if (p === "/api/v1/repos/sam/app/pulls?state=open&limit=100") return { json: open };
        if (p === "/api/v1/repos/sam/app") return { json: { default_branch: "main" } };
        if (method === "POST" && p === "/api/v1/repos/sam/app/pulls") return { status: 201, json: pull };
        if (method === "POST" && p === "/api/v1/repos/sam/app/pulls/7/merge") return { status: 409, json: { error: "1 approval(s) required for main" } };
        return undefined;
      });
      const repo = await repository("git@gitboy.example.com:sam/app.git", "gitboy.example.com", `${host.origin}/api/v1`);
      process.env.GITBOY_HOST = "gitboy.example.com"; process.env.GITBOY_TOKEN = "gbp_test";

      expect(await gitPullRequest(repo, false)).toMatchObject({ ok: true, number: 7, url: `${host.origin}/sam/app/pulls/7` });
      expect(host.seen.find(s => s.method === "POST")?.body).toEqual({ head_branch: "feature", base_branch: "main", title: "Cache the stats run", body: "One run serves every key." });
      open = [pull];
      expect(await gitPullRequest(repo, false)).toMatchObject({ ok: true, number: 7, existing: true });

      expect(await gitMergeRequest(repo, { number: 7, method: "rebase", expectedHeadSha: head })).toMatchObject({ ok: false, reason: "blocked", message: "1 approval(s) required for main" });
      expect(host.seen.at(-1)?.body).toEqual({ method: "rebase", expected_head_sha: head });
    });
  });

  it("never sends a token to an API address a repository's own config names", async () => {
    host = await fakeHost(() => ({ json: [] }));
    const repo = await repository("git@gitlab.example.com:team/app.git", "gitlab.example.com", "https://gitlab.invalid/api/v4");
    await execFileAsync("git", ["-C", repo, "config", "phren.gitlab.example.com.api", `${host.origin}/api/v4`]);
    process.env.GITLAB_HOST = "gitlab.example.com"; process.env.GITLAB_TOKEN = "glpat-test";
    expect(await gitPulls(repo)).toMatchObject({ available: false, reason: "unreachable" });
    expect(host.seen).toEqual([]);
  });

  it("connects a host only with a token it accepts, stores it privately with the account, and disconnects", async () => {
    host = await fakeHost(({ path: p, headers }) => {
      if (p === "/api/v1/user") return headers.authorization === "Bearer gbp_good" ? { json: { username: "sam" } } : { status: 401, json: { error: "unauthorized" } };
      if (p.startsWith("/api/v1/repos/sam/app/pulls")) return { json: [] };
      return undefined;
    });
    const repo = await repository("git@gitboy.example.com:sam/app.git", "gitboy.example.com", `${host.origin}/api/v1`);
    const file = path.join(process.env.PHREN_BRIDGE_HOME!, "git-hosts.json");

    expect(await gitHostToken(repo, { token: "gbp_bad" })).toMatchObject({ ok: false, reason: "auth" });
    await expect(stat(file)).rejects.toThrow();
    expect(await gitHostToken(repo, { token: "gbp_good" })).toMatchObject({ ok: true, user: "sam", kind: "gitboy" });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8")).hosts["gitboy.example.com"]).toMatchObject({ kind: "gitboy", token: "gbp_good", user: "sam" });
    expect(await gitPulls(repo)).toMatchObject({ available: true, account: { source: "file", user: "sam" } });

    expect(await gitHostToken(repo, { token: "" })).toMatchObject({ ok: true, disconnected: true });
    expect(await gitPulls(repo)).toMatchObject({ available: false, reason: "auth" });
  });
});
