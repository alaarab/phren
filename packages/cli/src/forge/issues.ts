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
  checklistChanges?: { done: number[]; added: string[] };
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
  /** Assign to the signed-in user if another computer has no claim. Release only acts on this computer's label. */
  claim(ref: IssueRef, computer: string, release?: boolean): Promise<Issue>;
  close(ref: IssueRef, comment?: string): Promise<Issue>;
}

export function providerFor(repo: RepoRef): IssueProvider {
  return repoParts(repo).kind === "gitboy" ? gitboyIssues : githubIssues;
}

export interface IssueListFailure { repo: RepoRef; code: ForgeError["code"]; error: string }
export interface IssueList { issues: Issue[]; errors: IssueListFailure[] }

export class IssueListError extends ForgeError {
  constructor(public errors: [IssueListFailure, ...IssueListFailure[]]) {
    const first = errors[0];
    super(first.code, errors.length === 1 ? first.error : `Could not list issues from any of the ${errors.length} repositories.`);
    this.name = "IssueListError";
  }
}

export async function listAcross(query: IssueQuery): Promise<IssueList> {
  const repos = new Map<string, RepoRef>();
  const errors: IssueListFailure[] = [];
  for (const input of query.repos ?? []) {
    let repo = "(invalid repository)";
    try {
      repo = parseRepo(input);
      forgeKind(repo.split("/")[0]);
      repos.set(repo.toLowerCase(), repo);
    } catch {
      errors.push({ repo, code: "invalid", error: "Use a github.com or gitboy repository." });
    }
  }
  const pending = repos.values();
  const issues: Issue[] = [];
  let successful = 0;
  await Promise.all(Array.from({ length: Math.min(4, repos.size) }, async () => {
    for (const repo of pending) {
      try {
        issues.push(...await providerFor(repo).list({ ...query, repos: [repo] }));
        successful++;
      } catch (error) {
        const failure = error instanceof ForgeError ? error : forgeFailure(0);
        errors.push({ repo, code: failure.code, error: failure.message });
      }
    }
  }));
  const [first, ...rest] = errors.sort((a, b) => a.repo.localeCompare(b.repo));
  if (!successful && first) throw new IssueListError([first, ...rest]);
  return { issues: orderIssues(issues).slice(0, issueLimit(query.limit)), errors };
}
