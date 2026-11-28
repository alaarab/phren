import path from "node:path";
import { ChecklistIndexError } from "../forge/checklist.js";
import {
  ForgeError,
  listAcross,
  parseRepoForProject,
  providerFor,
  repoForProject,
  type Issue,
  type IssueEdit,
  type IssueQuery,
  type IssueRef,
  type RepoRef,
} from "../forge/issues.js";
import { getProjectDirs } from "../phren-paths.js";
import { detectProject } from "../shared/index.js";

/** A bad command line: the caller fixes its arguments and retries (exit 1). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set(["--json", "--release"]);

/**
 * Flags take a value (`--repo r` or `--repo=r`), except the booleans above.
 * `--` ends flag parsing so a comment that starts with `--` still works.
 */
export function parseIssueArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const add = (name: string, value: string) => {
    const values = flags.get(name);
    if (values) values.push(value);
    else flags.set(name, [value]);
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals > 0) {
      add(arg.slice(0, equals), arg.slice(equals + 1));
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      add(arg, "true");
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`${arg} needs a value.`);
    add(arg, value);
    index++;
  }
  return { positionals, flags };
}

function only(flags: Map<string, string[]>, allowed: readonly string[]): void {
  for (const name of flags.keys()) if (!allowed.includes(name)) throw new UsageError(`Unknown option ${name}.`);
}

function one(flags: Map<string, string[]>, name: string): string | undefined {
  const values = flags.get(name);
  if (!values?.length) return undefined;
  if (values.length > 1) throw new UsageError(`${name} may appear once.`);
  return values[0];
}

function many(flags: Map<string, string[]>, name: string): string[] {
  return (flags.get(name) ?? []).map(value => value.trim()).filter(Boolean);
}

function has(flags: Map<string, string[]>, name: string): boolean {
  return flags.has(name);
}

function positiveInteger(text: string, label: string): number {
  if (!/^[1-9]\d*$/.test(text.trim())) throw new UsageError(`${label} must be a positive whole number.`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new UsageError(`${label} must be a positive whole number.`);
  return value;
}

/**
 * Split `repo#N` (repo may be a URL or a bare owner/name), a full issue URL ending
 * `/issues/N`, or `#N`. The repository part is not normalized here.
 */
export function splitIssueRef(text: string): { repo?: string; number: number } {
  const input = text.trim();
  if (!input) throw new UsageError("An issue reference is required: repo#N, a URL, or #N with --repo or --project.");
  const url = /^((?:https?:\/\/)?\S+?)\/issues\/(\d+)\/?(?:#\S*)?$/i.exec(input);
  if (url) return { repo: url[1], number: positiveInteger(url[2], "The issue number") };
  const hash = /^(.*)#(\d+)$/.exec(input);
  if (hash) {
    const repo = hash[1].trim();
    return { ...(repo ? { repo } : {}), number: positiveInteger(hash[2], "The issue number") };
  }
  throw new UsageError("Use an issue reference like repo#12, a URL, or #12 with --repo or --project.");
}

interface RefOptions { repo?: string; project?: string; store: string }

/** Resolve a `<ref>` argument to a forge repository and issue number. */
export async function resolveIssueRef(text: string, options: RefOptions): Promise<IssueRef> {
  const parsed = splitIssueRef(text);
  if (parsed.repo) return { repo: await parseRepoForProject(parsed.repo, options.project, options.store), number: parsed.number };
  if (options.repo) return { repo: await parseRepoForProject(options.repo, options.project, options.store), number: parsed.number };
  if (options.project) return { repo: await requireProjectRepo(options.project, options.store), number: parsed.number };
  throw new UsageError("Use an issue reference like repo#12, a URL, or #12 with --repo or --project.");
}

/** The one `<ref>` a subcommand takes; anything after it is a mistake. */
function singleRef(positionals: string[]): string {
  if (positionals.length > 1) throw new UsageError(`Unexpected argument "${positionals[1]}".`);
  return positionals[0] ?? "";
}

async function requireProjectRepo(project: string, store: string): Promise<RepoRef> {
  const repo = await repoForProject(project, store);
  if (!repo) throw new UsageError(`No issue repository for project "${project}". Set issues: in its phren.project.yaml or pass --repo.`);
  return repo;
}

/** The repositories `list` reads: the flags, else the project around the
 * working directory, else every project with a resolvable repository. */
export async function listRepos(options: { repo: string[]; project?: string; store: string; cwd?: string; profile?: string }): Promise<RepoRef[]> {
  if (options.repo.length) {
    const repos = await Promise.all(options.repo.map(repo => parseRepoForProject(repo, options.project, options.store)));
    return [...new Set(repos)];
  }
  if (options.project) return [await requireProjectRepo(options.project, options.store)];
  const current = detectProject(options.store, options.cwd ?? process.cwd(), options.profile);
  if (current) {
    const repo = await repoForProject(current, options.store);
    if (repo) return [repo];
  }
  const repos = new Set<RepoRef>();
  for (const directory of getProjectDirs(options.store)) {
    const repo = await repoForProject(path.basename(directory), options.store).catch(() => undefined);
    if (repo) repos.add(repo);
  }
  if (!repos.size) throw new UsageError("No project has an issue repository. Pass --repo.");
  return [...repos];
}

function claimedLabel(issue: Issue): string {
  return issue.claimedBy?.computer ? `working-on:${issue.claimedBy.computer}` : "";
}

function labelsLine(issue: Issue): string {
  const labels = issue.labels.filter(label => !label.toLowerCase().startsWith("working-on:"));
  return labels.length ? ` [${labels.join(", ")}]` : "";
}

/** `repo#N` is enough to identify an issue in a table; the URL is in `show`. */
function row(issue: Issue): { repo: string; number: string; state: string; updated: string; title: string } {
  const assignees = issue.assignees.length ? ` @${issue.assignees.join(", @")}` : "";
  const computer = issue.claimedBy?.computer ? ` · ${claimedLabel(issue)}` : "";
  return {
    repo: issue.repo,
    number: `#${issue.number}`,
    state: issue.state,
    updated: issue.updatedAt.slice(0, 10) || "-",
    title: `${issue.title}${assignees}${computer}${labelsLine(issue)}`,
  };
}

function renderList(issues: Issue[], errors: { repo: RepoRef; error: string }[]): void {
  if (!issues.length) {
    console.log("No issues.");
  } else {
    const rows = issues.map(row);
    const width = (values: string[]) => Math.max(0, ...values.map(value => value.length));
    const repo = width([...rows.map(entry => entry.repo), "REPOSITORY"]);
    const number = width([...rows.map(entry => entry.number), "ISSUE"]);
    const state = width([...rows.map(entry => entry.state), "STATE"]);
    const updated = width([...rows.map(entry => entry.updated), "UPDATED"]);
    console.log(`${"REPOSITORY".padEnd(repo)}  ${"ISSUE".padStart(number)}  ${"STATE".padEnd(state)}  ${"UPDATED".padEnd(updated)}  TITLE`);
    for (const entry of rows) {
      console.log(`${entry.repo.padEnd(repo)}  ${entry.number.padStart(number)}  ${entry.state.padEnd(state)}  ${entry.updated.padEnd(updated)}  ${entry.title}`);
    }
  }
  for (const error of errors) console.log(`! ${error.repo}: ${error.error}`);
}

function renderIssue(issue: Issue): void {
  console.log(`${issue.repo}#${issue.number}  ${issue.state}`);
  console.log(issue.title);
  console.log(issue.url);
  if (issue.labels.length) console.log(`labels: ${issue.labels.join(", ")}`);
  if (issue.assignees.length) console.log(`assignees: ${issue.assignees.join(", ")}`);
  if (issue.claimedBy?.computer) console.log(`claim: ${issue.claimedBy.computer}`);
  const created = issue.createdAt.slice(0, 10) || "-";
  const updated = issue.updatedAt.slice(0, 10) || "-";
  console.log(`created ${created} · updated ${updated}`);
  if (issue.body.trim()) console.log(`\n${issue.body}`);
  if (issue.checklist.length) {
    console.log("\nchecklist:");
    for (const [index, item] of issue.checklist.entries()) console.log(`  ${index + 1}. [${item.done ? "x" : " "}] ${item.text}`);
  }
}

function renderWrite(issue: Issue, verb: string): void {
  console.log(`${verb} ${issue.repo}#${issue.number}`);
  console.log(issue.title);
  console.log(issue.url);
}

function json(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function list(args: ParsedArgs, store: string, profile: string): Promise<void> {
  only(args.flags, ["--repo", "--project", "--state", "--assignee", "--label", "--search", "--limit", "--json"]);
  const state = (one(args.flags, "--state") ?? "open") as NonNullable<IssueQuery["state"]>;
  if (!["open", "closed", "all"].includes(state)) throw new UsageError("--state must be open, closed or all.");
  const limitText = one(args.flags, "--limit");
  const repos = await listRepos({ repo: many(args.flags, "--repo"), project: one(args.flags, "--project"), store, profile });
  const query: IssueQuery = {
    repos,
    state,
    ...(one(args.flags, "--assignee") ? { assignee: one(args.flags, "--assignee") } : {}),
    ...(one(args.flags, "--label") ? { label: one(args.flags, "--label") } : {}),
    ...(one(args.flags, "--search") ? { search: one(args.flags, "--search") } : {}),
    ...(limitText !== undefined ? { limit: positiveInteger(limitText, "--limit") } : {}),
  };
  const result = await listAcross(query);
  if (has(args.flags, "--json")) json(result);
  else renderList(result.issues, result.errors);
}

async function showIssue(args: ParsedArgs, store: string): Promise<void> {
  only(args.flags, ["--repo", "--project", "--json"]);
  const ref = await resolveIssueRef(singleRef(args.positionals), { repo: one(args.flags, "--repo"), project: one(args.flags, "--project"), store });
  const issue = await providerFor(ref.repo).get(ref);
  if (has(args.flags, "--json")) json(issue);
  else renderIssue(issue);
}

async function create(args: ParsedArgs, store: string): Promise<void> {
  only(args.flags, ["--repo", "--project", "--title", "--body", "--check", "--label", "--json"]);
  if (args.positionals.length) throw new UsageError(`Unexpected argument "${args.positionals[0]}". Use --title for the title.`);
  const repoFlag = one(args.flags, "--repo");
  const project = one(args.flags, "--project");
  const repo = repoFlag
    ? await parseRepoForProject(repoFlag, project, store)
    : project ? await requireProjectRepo(project, store)
    : (() => { throw new UsageError("Provide --repo or --project."); })();
  const title = one(args.flags, "--title")?.trim();
  if (!title) throw new UsageError("--title is required.");
  const body = one(args.flags, "--body");
  const checklist = many(args.flags, "--check");
  const labels = many(args.flags, "--label");
  const issue = await providerFor(repo).create({
    repo,
    title,
    ...(body !== undefined ? { body } : {}),
    ...(checklist.length ? { checklist } : {}),
    ...(labels.length ? { labels } : {}),
  });
  if (has(args.flags, "--json")) json(issue);
  else renderWrite(issue, "Created");
}

async function edit(args: ParsedArgs, store: string): Promise<void> {
  only(args.flags, ["--repo", "--project", "--title", "--body", "--check-done", "--check-add", "--json"]);
  const ref = await resolveIssueRef(singleRef(args.positionals), { repo: one(args.flags, "--repo"), project: one(args.flags, "--project"), store });
  const edit: IssueEdit = {};
  const title = one(args.flags, "--title");
  const body = one(args.flags, "--body");
  if (title !== undefined) edit.title = title;
  if (body !== undefined) edit.body = body;
  const done = many(args.flags, "--check-done").map(text => positiveInteger(text, "--check-done"));
  const added = many(args.flags, "--check-add");
  if (done.length || added.length) edit.checklistChanges = { done, added };
  if (!Object.keys(edit).length) throw new UsageError("Pass --title, --body, --check-done or --check-add.");
  const issue = await providerFor(ref.repo).edit(ref, edit);
  if (has(args.flags, "--json")) json(issue);
  else renderWrite(issue, "Updated");
}

async function claim(args: ParsedArgs, store: string): Promise<void> {
  only(args.flags, ["--repo", "--project", "--release", "--json"]);
  const ref = await resolveIssueRef(singleRef(args.positionals), { repo: one(args.flags, "--repo"), project: one(args.flags, "--project"), store });
  const release = has(args.flags, "--release");
  // The Hook's own name for this computer, loaded only when a claim is made.
  const { computerDisplayName } = await import("../bridge/pair.js");
  const computer = await computerDisplayName();
  const issue = await providerFor(ref.repo).claim(ref, computer, release);
  if (has(args.flags, "--json")) json(issue);
  else renderWrite(issue, release ? `Released (${computer}):` : `Claimed for ${computer}:`);
}

async function comment(args: ParsedArgs, store: string): Promise<void> {
  only(args.flags, ["--repo", "--project", "--json"]);
  if (args.positionals.length < 2) throw new UsageError("Comment text is required: phren issue comment <ref> <text>.");
  const text = args.positionals.slice(1).join(" ").trim();
  const ref = await resolveIssueRef(args.positionals[0] ?? "", { repo: one(args.flags, "--repo"), project: one(args.flags, "--project"), store });
  const result = await providerFor(ref.repo).comment(ref, text);
  if (has(args.flags, "--json")) json(result);
  else console.log(`Commented on ${ref.repo}#${ref.number}: ${result.url}`);
}

async function close(args: ParsedArgs, store: string): Promise<void> {
  only(args.flags, ["--repo", "--project", "--comment", "--json"]);
  const ref = await resolveIssueRef(singleRef(args.positionals), { repo: one(args.flags, "--repo"), project: one(args.flags, "--project"), store });
  const issue = await providerFor(ref.repo).close(ref, one(args.flags, "--comment"));
  if (has(args.flags, "--json")) json(issue);
  else renderWrite(issue, "Closed");
}

const USAGE = "Usage: phren issue <list|show|new|edit|claim|comment|close> [options]";

/** `phren issue`: 0 on success, 1 on a usage error, 2 when the forge refuses. */
export async function handleIssueCommand(args: string[], store: string, profile = ""): Promise<number> {
  const [action, ...rest] = args;
  try {
    const parsed = parseIssueArgs(rest);
    if (action === "list" || action === undefined) await list(parsed, store, profile);
    else if (action === "show") await showIssue(parsed, store);
    else if (action === "new") await create(parsed, store);
    else if (action === "edit") await edit(parsed, store);
    else if (action === "claim") await claim(parsed, store);
    else if (action === "comment") await comment(parsed, store);
    else if (action === "close") await close(parsed, store);
    else throw new UsageError(USAGE);
    return 0;
  } catch (error) {
    if (error instanceof UsageError || error instanceof ChecklistIndexError) {
      console.error(error.message);
      return 1;
    }
    if (error instanceof ForgeError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}
