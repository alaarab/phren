import type { Json } from "../bridge/protocol.js";
import { parseChecklist, rewriteChecklist } from "./checklist.js";
import { forgeFailure, ForgeError } from "./errors.js";
import type { ForgeKind, Issue, IssueEdit, IssueProvider, IssueQuery, IssueRef, RepoRef } from "./issues.js";
import { repoParts } from "./repositories.js";

export interface IssuePatch {
  title?: string;
  body?: string;
  state?: Issue["state"];
  labels?: string[];
  assignees?: string[];
}

export interface IssueBackend {
  pages(state: NonNullable<IssueQuery["state"]>): AsyncIterable<Json[]>;
  get(number: number): Promise<Json>;
  create(title: string, body: string, labels: string[]): Promise<Json>;
  edit(number: number, patch: IssuePatch): Promise<Json>;
  comment(number: number, body: string): Promise<{ url: string }>;
  currentUser(): Promise<string>;
}

const WORKING_ON = "working-on:";
const lower = (value: string) => value.toLowerCase();
const workingOn = (label: string) => lower(label).startsWith(WORKING_ON);
const sameName = (a: string, b: string) => lower(a) === lower(b);
const hasName = (names: string[], name: string) => names.some(candidate => sameName(candidate, name));
const unique = (names: string[]) => [...new Map(names.map(name => [lower(name), name])).values()];
const sameNames = (a: string[], b: string[]) => a.length === b.length && a.every(name => hasName(b, name));

export function issueLimit(limit = 50): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 50;
}

export function orderIssues(issues: Issue[]): Issue[] {
  return issues.sort((a, b) => {
    const byDate = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    return byDate || a.repo.localeCompare(b.repo) || b.number - a.number;
  });
}

export function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw forgeFailure(0);
  return value as Json;
}

export function records(value: unknown): Json[] {
  if (!Array.isArray(value)) throw forgeFailure(0);
  return value.map(record);
}

function names(value: unknown, ...keys: string[]): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (typeof entry === "string") return [entry];
    if (!entry || typeof entry !== "object") return [];
    const name = keys.map(key => (entry as Json)[key]).find(value => typeof value === "string");
    return typeof name === "string" ? [name] : [];
  });
}

function isPull(row: Json): boolean {
  return row.kind === "pr" || Boolean(row.pull_request);
}

export function issueUrl(repo: RepoRef, number: number): string {
  return `https://${repo}/issues/${number}`;
}

function normalize(repo: RepoRef, row: Json): Issue {
  if (isPull(row)) throw forgeFailure(404);
  const number = row.index ?? row.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1
    || typeof row.title !== "string" || (row.state !== "open" && row.state !== "closed")) throw forgeFailure(0);
  const body = typeof row.body === "string" ? row.body : "";
  const labels = names(row.labels, "name");
  const assignees = names(row.assignees, "username", "login");
  const computer = labels.find(workingOn)?.slice(WORKING_ON.length);
  const user = assignees[0];
  return {
    repo, number, url: issueUrl(repo, number), title: row.title, body, state: row.state, labels, assignees,
    checklist: parseChecklist(body),
    ...(computer || user ? { claimedBy: { ...(user ? { user } : {}), ...(computer ? { computer } : {}) } } : {}),
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
  };
}

function matches(issue: Issue, state: NonNullable<IssueQuery["state"]>, label: string | undefined, assignee: string | undefined, search: string): boolean {
  return (state === "all" || issue.state === state)
    && (!label || hasName(issue.labels, label))
    && (!assignee || hasName(issue.assignees, assignee))
    && (!search || lower(issue.title).includes(search) || lower(issue.body).includes(search));
}

function editPatch(current: Issue, edit: IssueEdit): IssuePatch {
  const patch: IssuePatch = {};
  if (edit.title !== undefined && edit.title !== current.title) patch.title = edit.title;
  if (edit.state !== undefined && edit.state !== current.state) patch.state = edit.state;
  const base = edit.body ?? current.body;
  const body = edit.checklist ? rewriteChecklist(base, edit.checklist) : base;
  if (body !== current.body) patch.body = body;
  if (edit.addLabels?.length || edit.removeLabels?.length) {
    const labels = unique([...current.labels.filter(label => !hasName(edit.removeLabels ?? [], label)), ...(edit.addLabels ?? [])]);
    if (!sameNames(labels, current.labels)) patch.labels = labels;
  }
  return patch;
}

export function issueProvider(kind: ForgeKind, connect: (repo: ReturnType<typeof repoParts>) => Promise<IssueBackend>): IssueProvider {
  const writes = new Map<string, Promise<Issue>>();
  const repository = (input: RepoRef) => repoParts(input, kind);
  const issueRef = ({ repo, number }: IssueRef) => {
    if (!Number.isSafeInteger(number) || number < 1) throw new ForgeError("invalid", "Use a positive issue number.");
    return repository(repo);
  };
  // Serialize read/modify/write operations from this process on the same issue.
  async function write(ref: IssueRef, operation: (backend: IssueBackend, current: Issue) => Promise<Issue>): Promise<Issue> {
    const location = issueRef(ref);
    const key = `${lower(location.repo)}#${ref.number}`;
    const pending = (writes.get(key)?.catch(() => {}) ?? Promise.resolve()).then(async () => {
      const backend = await connect(location);
      return operation(backend, normalize(location.repo, await backend.get(ref.number)));
    });
    writes.set(key, pending);
    try { return await pending; }
    finally { if (writes.get(key) === pending) writes.delete(key); }
  }
  async function update(backend: IssueBackend, current: Issue, patch: IssuePatch): Promise<Issue> {
    if (Object.keys(patch).length === 0) return current;
    const updated = normalize(current.repo, await backend.edit(current.number, patch));
    // GitHub can silently discard label or assignee changes for callers without write access.
    if ((patch.labels && !sameNames(patch.labels, updated.labels))
      || (patch.assignees && !sameNames(patch.assignees, updated.assignees))) throw forgeFailure(403);
    return updated;
  }

  return {
    kind,
    async list(query) {
      const limit = issueLimit(query.limit);
      const state = query.state ?? "open";
      const search = lower(query.search?.trim() ?? "");
      const issues: Issue[] = [];
      const repos = new Map(query.repos.map(repository).map(location => [lower(location.repo), location]));
      for (const location of repos.values()) {
        const backend = await connect(location);
        const assignee = query.assignee === "me" ? await backend.currentUser() : query.assignee;
        const found = new Map<number, Issue>();
        for await (const page of backend.pages(state)) {
          for (const row of page) {
            if (isPull(row)) continue;
            const issue = normalize(location.repo, row);
            if (matches(issue, state, query.label, assignee, search)) found.set(issue.number, issue);
          }
          if (found.size >= limit) break;
        }
        issues.push(...orderIssues([...found.values()]).slice(0, limit));
      }
      return orderIssues(issues).slice(0, limit);
    },
    async get(ref) {
      const location = issueRef(ref);
      const backend = await connect(location);
      return normalize(location.repo, await backend.get(ref.number));
    },
    async create(input) {
      const location = repository(input.repo);
      const backend = await connect(location);
      const text = input.body ?? "";
      const body = input.checklist ? rewriteChecklist(text, input.checklist.map(text => ({ text, done: false }))) : text;
      const labels = unique(input.labels ?? []);
      const issue = normalize(location.repo, await backend.create(input.title, body, labels));
      if (labels.some(label => !hasName(issue.labels, label))) {
        throw new ForgeError("forbidden", `Issue #${issue.number} was created. The forge denied its labels.`);
      }
      return issue;
    },
    edit(ref, edit) {
      return write(ref, (backend, current) => update(backend, current, editPatch(current, edit)));
    },
    async comment(ref, body) {
      const location = issueRef(ref);
      const backend = await connect(location);
      normalize(location.repo, await backend.get(ref.number));
      return backend.comment(ref.number, body);
    },
    async claim(ref, computer, release = false) {
      const label = WORKING_ON + computer.trim();
      if (!release && (!computer.trim() || /[\r\n]/.test(computer))) throw new ForgeError("invalid", "Use a valid computer name.");
      return write(ref, async (backend, current) => {
        if (release && !hasName(current.labels, label)) return current;
        const user = release ? current.claimedBy?.user : await backend.currentUser();
        let competingLabels: string[] = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          // A retry may have observed another computer taking over the issue.
          if (!release || hasName(current.labels, label)) {
            const labels = release
              ? current.labels.filter(name => !sameName(name, label))
              : [...current.labels.filter(name => !workingOn(name)), label];
            const assignees = user === undefined ? undefined
              : release ? current.assignees.filter(name => !sameName(name, user)) : [user];
            await backend.edit(current.number, { labels, assignees });
          }

          current = normalize(current.repo, await backend.get(current.number));
          const claims = current.labels.filter(workingOn);
          const ours = hasName(claims, label);
          const assigned = user !== undefined && hasName(current.assignees, user);
          if (release ? !ours && !assigned : ours && claims.length === 1 && assigned) return current;
          const others = claims.filter(name => !sameName(name, label));
          if (others.length) competingLabels = others;
        }
        const conflict = competingLabels.length
          ? `Observed competing labels ${competingLabels.map(name => JSON.stringify(name)).join(", ")}.`
          : "The assignee and claim label did not settle after two attempts.";
        throw new ForgeError("invalid", `Issue claim conflict for ${label}. ${conflict}`);
      });
    },
    close(ref, comment) {
      return write(ref, async (backend, current) => {
        const updated = current.state === "closed" ? current : await update(backend, current, { state: "closed" });
        if (comment !== undefined) await backend.comment(ref.number, comment);
        return updated;
      });
    },
  };
}
