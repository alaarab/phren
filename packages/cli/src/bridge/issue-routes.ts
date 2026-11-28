import { z } from "zod";
import { listAcross, ForgeError, IssueListError, parseRepo, providerFor, repoForProject, type Issue, type IssueEdit, type IssueList, type IssueQuery, type IssueRef, type NewIssue, type RepoRef } from "../forge/issues.js";
import { listAllProjects } from "../store-routing.js";
import { BridgeError, type Json } from "./protocol.js";

/**
 * The phone's forge issue routes (docs/phren-hook.md#issues-from-the-phone):
 * a list and an item read, and the five writes. Every route is owner-only; the
 * writes also go through owner-proof.ts. All forge work lives in ../forge/.
 */

/** A list body is trimmed to this many characters; /v1/issues/item has the whole body. */
export const LIST_BODY_LIMIT = 2_000;
/** The phone drops off Tailscale on big bursts, so one list answer stays under this. */
export const ISSUES_RESPONSE_LIMIT = 256 * 1024;
const DEFAULT_REPO_TTL_MS = 5 * 60_000;

const issueNumber = z.number().int().min(1).max(2_147_483_647);
const repoRef = z.string().trim().min(3).max(300);
const issueText = z.string().max(100_000);

export const issueListQuerySchema = z.object({
  repos: z.array(repoRef).max(64).optional(),
  state: z.enum(["open", "closed", "all"]).optional(),
  assignee: z.string().trim().min(1).max(200).optional(),
  label: z.string().trim().min(1).max(200).optional(),
  search: z.string().trim().min(1).max(300).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

export const issueItemQuerySchema = z.object({ repo: repoRef, number: issueNumber }).strict();

/** The bodies mirror the MCP issue tools (../forge/issues.ts types). */
export const issueCreateSchema = z.object({
  repo: repoRef,
  title: z.string().trim().min(1).max(1_000),
  body: issueText.optional(),
  checklist: z.array(z.string().trim().min(1).max(1_000)).max(200).optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
}).strict();

export const issueEditSchema = z.object({
  repo: repoRef,
  number: issueNumber,
  title: z.string().trim().min(1).max(1_000).optional(),
  body: issueText.optional(),
  checklist: z.array(z.object({ text: z.string().trim().min(1).max(1_000), done: z.boolean() }).strict()).max(200).optional(),
  addLabels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  removeLabels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  state: z.enum(["open", "closed"]).optional(),
}).strict();

export const issueCommentSchema = z.object({ repo: repoRef, number: issueNumber, body: z.string().trim().min(1).max(100_000) }).strict();
/** `computer` defaults to the Hook's own computer name. */
export const issueClaimSchema = z.object({ repo: repoRef, number: issueNumber, computer: z.string().trim().min(1).max(253).optional(), release: z.boolean().optional() }).strict();
export const issueCloseSchema = z.object({ repo: repoRef, number: issueNumber, comment: z.string().trim().min(1).max(100_000).optional() }).strict();

/** Forge failures reach the phone as stable HTTP statuses and `forge-<code>` codes. */
const FORGE_STATUS: Record<ForgeError["code"], number> = {
  auth: 502, "not-found": 404, forbidden: 403, "rate-limited": 429, unavailable: 503, invalid: 400, conflict: 409,
};

function forgeBridgeError(error: unknown): never {
  if (error instanceof ForgeError) throw new BridgeError(FORGE_STATUS[error.code], error.message, {
    code: `forge-${error.code}`,
    ...(error instanceof IssueListError ? { issues: [], errors: error.errors } : {}),
  });
  throw error;
}

async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { return forgeBridgeError(error); }
}

export interface IssueRouteDeps {
  list(query: IssueQuery): Promise<IssueList>;
  get(ref: IssueRef): Promise<Issue>;
  create(input: NewIssue): Promise<Issue>;
  edit(ref: IssueRef, edit: IssueEdit): Promise<Issue>;
  comment(ref: IssueRef, body: string): Promise<{ url: string }>;
  claim(ref: IssueRef, computer: string, release?: boolean): Promise<Issue>;
  close(ref: IssueRef, comment?: string): Promise<Issue>;
  /** Every project this Hook's stores hold, as store-qualified references. */
  projects(store: string): Promise<string[]>;
  repoFor(project: string, store: string): Promise<RepoRef | undefined>;
  now(): number;
}

const forgeDeps: IssueRouteDeps = {
  list: query => listAcross(query),
  get: ref => providerFor(ref.repo).get(ref),
  create: input => providerFor(input.repo).create(input),
  edit: (ref, edit) => providerFor(ref.repo).edit(ref, edit),
  comment: (ref, body) => providerFor(ref.repo).comment(ref, body),
  claim: (ref, computer, release) => providerFor(ref.repo).claim(ref, computer, release),
  close: (ref, comment) => providerFor(ref.repo).close(ref, comment),
  projects: async store => listAllProjects(store).map(entry => `${entry.store.name}/${entry.projectName}`),
  repoFor: (project, store) => repoForProject(project, store),
  now: Date.now,
};

let deps: IssueRouteDeps = forgeDeps;
let defaultRepos: { store: string; at: number; repos: RepoRef[] } | undefined;

/** Tests swap the forge for a fake; the default repo cache goes with it. */
export function setIssueRouteDeps(overrides: Partial<IssueRouteDeps>): () => void {
  const previous = deps;
  deps = { ...forgeDeps, ...overrides };
  defaultRepos = undefined;
  return () => { deps = previous; defaultRepos = undefined; };
}

export function resetIssueRouteCache(): void { defaultRepos = undefined; }

/** Put the real forge back, for tests. */
export function resetIssueRouteDeps(): void { deps = forgeDeps; defaultRepos = undefined; }

/**
 * Every store project whose repository resolves, cached for five minutes: the
 * phone never names the repos, so this walk runs once per burst. Four projects
 * at a time, never one `git config` per project all at once.
 */
export async function defaultIssueRepos(store: string): Promise<RepoRef[]> {
  const now = deps.now();
  if (defaultRepos?.store === store && now - defaultRepos.at < DEFAULT_REPO_TTL_MS) return defaultRepos.repos;
  const projects = await deps.projects(store);
  const found: (RepoRef | undefined)[] = new Array(projects.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, projects.length) }, async () => {
    while (next < projects.length) {
      const index = next++;
      found[index] = await deps.repoFor(projects[index], store).catch(() => undefined);
    }
  }));
  const repos = [...new Set(found.filter((repo): repo is RepoRef => Boolean(repo)))];
  defaultRepos = { store, at: now, repos };
  return repos;
}

/** One list row: the body capped, and marked when it was cut. */
function listIssue(issue: Issue): Json {
  if (issue.body.length <= LIST_BODY_LIMIT) return issue as unknown as Json;
  return { ...issue, body: issue.body.slice(0, LIST_BODY_LIMIT), truncated: true };
}

function boundedList(result: IssueList): Json {
  const rows = result.issues.map(listIssue);
  // The envelope and errors are paid for first, so the whole answer, not just
  // the rows, stays under the cap.
  const reserve = Buffer.byteLength(JSON.stringify({ issues: [], errors: result.errors, truncated: true }));
  const kept: Json[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (kept.length > 0 && reserve + bytes + size > ISSUES_RESPONSE_LIMIT) break;
    kept.push(row);
    bytes += size;
  }
  return { issues: kept, errors: result.errors, truncated: kept.length < rows.length };
}

function reposFrom(url: URL): string[] {
  return url.searchParams.getAll("repos")
    .flatMap(value => value.split(","))
    .map(value => value.trim())
    .filter(Boolean);
}

/** A query value, with an empty one read as absent. */
function param(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value === "" ? undefined : value;
}

function numberParam(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : (value as unknown as number);
}

/** `GET /v1/issues`: every named repo, or every store project's repo. */
export async function issueListRoute(url: URL, store: string): Promise<Json> {
  const repos = reposFrom(url);
  const state = param(url, "state"), assignee = param(url, "assignee"), label = param(url, "label");
  const search = param(url, "search"), limit = numberParam(param(url, "limit"));
  const query = issueListQuerySchema.parse({
    ...(repos.length ? { repos } : {}),
    ...(state === undefined ? {} : { state }),
    ...(assignee === undefined ? {} : { assignee }),
    ...(label === undefined ? {} : { label }),
    ...(search === undefined ? {} : { search }),
    ...(limit === undefined ? {} : { limit }),
  });
  const resolved = query.repos?.length ? query : { ...query, repos: await defaultIssueRepos(store) };
  return boundedList(await mapped(() => deps.list(resolved)));
}

/** `GET /v1/issues/item`: one issue with its full body. */
export async function issueItemRoute(url: URL): Promise<Json> {
  const query = issueItemQuerySchema.parse({ repo: param(url, "repo"), number: numberParam(param(url, "number")) });
  const issue = await mapped(() => deps.get({ repo: parseRepo(query.repo), number: query.number }));
  return { issue };
}

/** `POST /v1/issues/{create,edit,comment,claim,close}` */
export async function issueWriteRoute(pathname: string, data: Json, computer: string): Promise<Json> {
  switch (pathname) {
    case "/v1/issues/create": {
      const input = issueCreateSchema.parse(data);
      const issue = await mapped(() => deps.create({
        repo: parseRepo(input.repo), title: input.title,
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.checklist === undefined ? {} : { checklist: input.checklist }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
      }));
      return { ok: true, issue };
    }
    case "/v1/issues/edit": {
      const input = issueEditSchema.parse(data);
      const { repo, number, ...edit } = input;
      const issue = await mapped(() => deps.edit({ repo: parseRepo(repo), number }, edit));
      return { ok: true, issue };
    }
    case "/v1/issues/comment": {
      const input = issueCommentSchema.parse(data);
      const url = await mapped(() => deps.comment({ repo: parseRepo(input.repo), number: input.number }, input.body));
      return { ok: true, url: url.url };
    }
    case "/v1/issues/claim": {
      const input = issueClaimSchema.parse(data);
      const issue = await mapped(() => deps.claim({ repo: parseRepo(input.repo), number: input.number }, input.computer ?? computer, input.release));
      return { ok: true, issue };
    }
    case "/v1/issues/close": {
      const input = issueCloseSchema.parse(data);
      const issue = await mapped(() => deps.close({ repo: parseRepo(input.repo), number: input.number }, input.comment));
      return { ok: true, issue };
    }
    default: throw new BridgeError(404, "Unknown Phren Hook route.");
  }
}
