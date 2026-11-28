import { setTimeout as delay } from "node:timers/promises";
import type { Json } from "../bridge/protocol.js";
import { editChecklist, parseChecklist, rewriteChecklist } from "./checklist.js";
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
  changeLabels?(number: number, add: string[], remove: string[]): Promise<void>;
  unassign?(number: number, user: string): Promise<void>;
  lockClaim(name: string): Promise<(() => Promise<void>) | undefined>;
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

async function changeClaimLabels(backend: IssueBackend, issue: Issue, add: string[], remove: string[]): Promise<void> {
  if (backend.changeLabels) return backend.changeLabels(issue.number, add, remove);
  // Gitboy replaces the whole set. Preserve the labels we read outside the claim change.
  const labels = unique([...issue.labels.filter(name => !hasName(remove, name)), ...add]);
  await backend.edit(issue.number, { labels });
}

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
  const body = edit.checklistChanges
    ? editChecklist(base, edit.checklistChanges.done, edit.checklistChanges.added)
    : edit.checklist ? rewriteChecklist(base, edit.checklist) : base;
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
      if (!computer.trim() || /[\r\n]/.test(computer)) throw new ForgeError("invalid", "Use a valid computer name.");
      const location = issueRef(ref);
      const { repo } = location;
      const { number } = ref;
      const backend = await connect(location);
      const read = async () => normalize(repo, await backend.get(number));
      const otherClaim = (name: string) => workingOn(name) && !sameName(name, label);
      function assertUnclaimed(issue: Issue) {
        const other = issue.labels.find(otherClaim);
        if (other) throw new ForgeError("conflict", `claimed by ${other.slice(WORKING_ON.length)}`);
      }
      // Neither forge makes a conditional issue-label write available. Atomic
      // creation of a uniquely named repository label serializes the fresh read
      // and mutation across processes and computers using the same forge.
      const lockName = `phren:claim-lock:${number}`;
      let unlock: (() => Promise<void>) | undefined;
      const deadline = Date.now() + 2_000;
      do {
        unlock = await backend.lockClaim(lockName);
        if (unlock) break;
        const current = await read();
        if (!release) assertUnclaimed(current);
        await delay(100);
      } while (Date.now() < deadline);
      if (!unlock) throw new ForgeError("conflict", `Issue claim is busy (${lockName}).`);

      try {
        let current = await read();
        if (release) {
          if (!hasName(current.labels, label)) return current;
          const user = current.claimedBy?.user;
          for (let attempt = 0; attempt < 2; attempt++) {
            const ownLabel = current.labels.find(name => sameName(name, label));
            if (ownLabel) await changeClaimLabels(backend, current, [], [ownLabel]);
            current = await read();
            if (current.labels.some(otherClaim)) return current;
            if (current.labels.some(workingOn)) continue;
            if (!user || !hasName(current.assignees, user)) return current;
            if (backend.unassign) await backend.unassign(number, user);
            else await backend.edit(number, { assignees: current.assignees.filter(name => !sameName(name, user)) });
            current = await read();
            if (current.labels.some(otherClaim)
              || (!current.labels.some(workingOn) && !hasName(current.assignees, user))) return current;
          }
          throw new ForgeError("conflict", `Issue claim conflict for ${label}. The release did not settle after two attempts.`);
        }

        assertUnclaimed(current);
        const user = await backend.currentUser();
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!hasName(current.labels, label)) await changeClaimLabels(backend, current, [label], []);
          if (!hasName(current.assignees, user)) await backend.edit(number, { assignees: [user] });
          current = await read();
          assertUnclaimed(current);
          if (hasName(current.labels, label) && hasName(current.assignees, user)) return current;
        }
        throw new ForgeError("conflict", `Issue claim conflict for ${label}. The assignee and claim label did not settle after two attempts.`);
      } finally {
        await unlock();
      }
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
