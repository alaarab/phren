// Sample open pull requests for Home's Pull requests card: three projects on two computers.
// phren (GitHub) and website (GitHub) are on "This computer"; website again and api (GitLab) are on "Mac mini",
// so the same repository is seen from two computers and must be listed once.
import type { FakeHookHandler } from "../src/testing/fake-hook.js";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const GITHUB_TERMS = { short: "PR", long: "pull request", ref: "#" };
const GITLAB_TERMS = { short: "MR", long: "merge request", ref: "!" };
export const PEER = "Mac mini";

const host = (kind: "github" | "gitlab", repo: string) => kind === "github"
  ? { kind, name: "GitHub", domain: "github.com", webUrl: `https://github.com/you/${repo}`, remote: "origin", source: "url", terms: GITHUB_TERMS, supported: true }
  : { kind, name: "GitLab", domain: "gitlab.com", webUrl: `https://gitlab.com/you/${repo}`, remote: "origin", source: "url", terms: GITLAB_TERMS, supported: true };

const answer = (kind: "github" | "gitlab", repo: string, pulls: object[]) => ({ project: repo, directory: `/Users/you/${repo}`, branch: "main", available: true, host: host(kind, repo), current: null, account: { user: "you", source: "cli" }, pulls });
const reply = (json: object): FakeHookHandler => () => ({ status: 200, json });

export const PHREN_PULLS = [
  { number: 20, title: "Bump dependencies", author: "dependabot", updated: ago(20), checks: "pending", url: "https://github.com/you/phren/pull/20" },
  { number: 15, title: "Document the Hook routes", author: "you", updated: ago(200), checks: "passing", reviewDecision: "APPROVED", mergeState: "CLEAN", url: "https://github.com/you/phren/pull/15" },
  { number: 12, title: "Split the router", author: "ada", updated: ago(120), checks: "passing", mergeState: "DIRTY", conflicts: true, url: "https://github.com/you/phren/pull/12" },
  { number: 2, title: "Tidy the old scripts", author: "you", updated: ago(5000), url: "https://github.com/you/phren/pull/2" },
  { number: 9, title: "Add search to the shell", author: "you", updated: ago(300), checks: "failing", url: "https://github.com/you/phren/pull/9" },
];
export const WEBSITE_PULLS = [
  { number: 8, title: "New footer", author: "you", draft: true, updated: ago(10), url: "https://github.com/you/website/pull/8" },
  { number: 7, title: "Optimise the hero image", author: "grace", updated: ago(400), reviewDecision: "CHANGES_REQUESTED", checks: "passing", url: "https://github.com/you/website/pull/7" },
];
export const API_PULLS = [
  { number: 5, title: "Paginate the list endpoint", author: "linus", updated: ago(45), checks: "pending", url: "https://gitlab.com/you/api/-/merge_requests/5" },
  { number: 3, title: "Rate limit sign-ins", author: "you", updated: ago(600), checks: "failing", url: "https://gitlab.com/you/api/-/merge_requests/3" },
];

const repos = (...names: string[]) => ({ repos: names.map((name) => ({ name, directory: `/Users/you/${name}`, registered: true, lastSeen: "2026-10-15T12:00:00Z" })) });

/** Routes for "This computer": phren and website, both on GitHub. */
export const localRoutes = (): Record<string, FakeHookHandler> => ({
  "GET /v1/projects/repos": reply(repos("phren", "website")),
  "GET /v1/projects/phren/git": reply(answer("github", "phren", PHREN_PULLS)),
  "GET /v1/projects/website/git": reply(answer("github", "website", WEBSITE_PULLS)),
});

/** Routes for the second computer: website again (a thinner read of the same repository) and api on GitLab. */
export const peerRoutes = (): Record<string, FakeHookHandler> => ({
  "GET /v1/projects/repos": reply(repos("website", "api")),
  "GET /v1/projects/website/git": reply(answer("github", "website", WEBSITE_PULLS.map(({ title, number, url, updated }) => ({ title, number, url, updated })))),
  "GET /v1/projects/api/git": reply(answer("gitlab", "api", API_PULLS)),
});
