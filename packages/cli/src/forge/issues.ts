import { forgeFailure, ForgeError } from "./errors.js";
import { gitboyIssues } from "./gitboy.js";
import { githubIssues } from "./github.js";
import { issueLimit, orderIssues } from "./provider.js";
import { forgeKind, parseRepo, repoParts } from "./repositories.js";

export { ForgeError } from "./errors.js";
export { parseRepo, parseRepoForProject, repoForProject } from "./repositories.js";

export type ForgeKind = "gitboy" | "github";
/** A repository in the form domain/owner/name. */
export type RepoRef = string;
export interface IssueRef { repo: RepoRef; number: number }
export interface ChecklistItem { text: string; done: boolean }
export interface Issue {
  repo: RepoRef;
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
  checklist: ChecklistItem[];
  claimedBy?: { user?: string; computer?: string };
  updatedAt: string;
  createdAt: string;
}
export interface IssueQuery {
  repos?: RepoRef[];
  state?: "open" | "closed" | "all";
  assignee?: string;
  label?: string;
  search?: string;
  /** Defaults to 50 and caps at 200. */
  limit?: number;
}
export interface NewIssue { repo: RepoRef; title: string; body?: string; checklist?: string[]; labels?: string[] }
export interface IssueEdit {
  title?: string;
  body?: string;
  checklist?: ChecklistItem[];
  addLabels?: string[];
  removeLabels?: string[];
  state?: "open" | "closed";
}
export interface IssueProvider {
  readonly kind: ForgeKind;
  list(query: IssueQuery & { repos: RepoRef[] }): Promise<Issue[]>;
  get(ref: IssueRef): Promise<Issue>;
  create(input: NewIssue): Promise<Issue>;
  edit(ref: IssueRef, edit: IssueEdit): Promise<Issue>;
  comment(ref: IssueRef, body: string): Promise<{ url: string }>;
  /** Assign to the signed-in user and replace any working-on label. Release only acts on this computer's label. */
  claim(ref: IssueRef, computer: string, release?: boolean): Promise<Issue>;
  close(ref: IssueRef, comment?: string): Promise<Issue>;
}

export function providerFor(repo: RepoRef): IssueProvider {
  return repoParts(repo).kind === "gitboy" ? gitboyIssues : githubIssues;
}

export async function listAcross(query: IssueQuery): Promise<{ issues: Issue[]; errors: { repo: RepoRef; error: string }[] }> {
  const repos = new Map<string, RepoRef>();
  const errors: { repo: RepoRef; error: string }[] = [];
  for (const input of query.repos ?? []) {
    let repo = "(invalid repository)";
    try {
      repo = parseRepo(input);
      forgeKind(repo.split("/")[0]);
      repos.set(repo.toLowerCase(), repo);
    } catch {
      errors.push({ repo, error: "Use a github.com or gitboy repository." });
    }
  }
  const pending = repos.values();
  const issues: Issue[] = [];
  await Promise.all(Array.from({ length: Math.min(4, repos.size) }, async () => {
    for (const repo of pending) {
      try {
        issues.push(...await providerFor(repo).list({ ...query, repos: [repo] }));
      } catch (error) {
        errors.push({ repo, error: error instanceof ForgeError ? error.message : forgeFailure(0).message });
      }
    }
  }));
  return { issues: orderIssues(issues).slice(0, issueLimit(query.limit)), errors };
}
