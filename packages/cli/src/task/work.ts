/** A task's work links: the worker doing it, its branch or worktree, its pull
 * request and its issue, stored under the task in tasks.md as one record:
 *
 *   - [ ] Fix the sync race <!-- bid:c2cc33d0 -->
 *     Work: {"version":1,"worker":{...},"branch":"feat/sync","pr":{"forge":"github","number":877,"url":"https://github.com/o/r/pull/877"}}
 *
 * Only links are stored. CI, mergeability and issue state are read live from
 * the forge (bridge/task-work.ts), so they can't go stale in the file. A
 * record a newer writer made (unknown version or field) fails this schema and
 * stays an opaque continuation, kept verbatim and never written over.
 *
 * Pure: parsing, the brief and pull request references, the status line and
 * the auto-close rule. No I/O here. */
import { z } from "zod";

export const FORGES = ["github", "gitlab", "gitboy"] as const;
export type Forge = typeof FORGES[number];
/** The worker's last known state, as its dispatch saw it. `waiting` is parked
 * on CI, background work or a queue: no one's attention needed. */
export const WORK_WORKER_STATES = ["launching", "working", "waiting", "uncertain", "needs-you", "blocked", "stalled", "done", "failed", "gone", "closed"] as const;
export type WorkWorkerState = typeof WORK_WORKER_STATES[number];
/** The same words a waiting return's notice reads (dispatch-returns.ts
 * `noticeLine`): CI, background work, the queue, work. */
export const WORK_WAITED_ON = { ci: "CI", background: "background work", queue: "the queue", other: "work" } as const;

const line = (max: number) => z.string().min(1).max(max).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const forgeRef = z.object({ forge: z.enum(FORGES), number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  url: z.string().max(2048).regex(/^https:\/\/[^\s"<>]+$/) }).strict();
export const taskWorkSchema = z.object({
  version: z.literal(1),
  worker: z.object({ dispatchId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), computer: line(200), session: line(200).optional(),
    label: line(200).optional(), harness: line(40).optional(), state: z.enum(WORK_WORKER_STATES), at: z.string().datetime(),
    waitingOn: z.enum(["ci", "background", "queue", "other"]).optional().describe("What a waiting worker waits on; the same word its return carries.") }).strict().optional(),
  branch: line(256).optional(),
  worktree: line(4096).optional(),
  pr: forgeRef.optional(),
  issue: forgeRef.optional(),
  /** Set when phren moved the task to Done itself, naming the link that did
   * it. A task the owner reopens keeps it, so that link never closes the task
   * again; another link still can. */
  autoClosed: z.object({ at: z.string().datetime(), reason: line(300), url: z.string().max(2048).optional() }).strict().optional(),
}).strict();
export type TaskWork = z.infer<typeof taskWorkSchema>;
export type ForgeRef = z.infer<typeof forgeRef>;

export function parseTaskWork(raw: string): TaskWork | undefined {
  try { const parsed = taskWorkSchema.safeParse(JSON.parse(raw)); return parsed.success ? parsed.data : undefined; } catch { return undefined; }
}
/** The record to write, or undefined when it holds nothing. */
export function cleanTaskWork(work: TaskWork | undefined): TaskWork | undefined {
  if (!work) return undefined;
  const { version: _version, ...rest } = work;
  const fields = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
  return Object.keys(fields).length ? taskWorkSchema.parse({ version: 1, ...fields }) : undefined;
}

// ---------------------------------------------------------------- forge URLs

export interface ForgeUrl { domain: string; repo: string; kind: "pull" | "issue"; number: number; url: string }
/** A pull request or issue page on any of the three forges: GitHub
 * `/o/r/pull/N` and `/o/r/issues/N`, gitboy `/o/r/pulls/N` and `/o/r/issues/N`,
 * GitLab `/group/r/-/merge_requests/N` and `/-/issues/N`. */
export function parseForgeUrl(value: string): ForgeUrl | undefined {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return undefined;
  const match = /^\/((?:[A-Za-z0-9_.-]+\/)+?[A-Za-z0-9_.-]+)(?:\/-)?\/(pull|pulls|merge_requests|issues)\/([1-9]\d{0,15})\/?$/.exec(url.pathname);
  if (!match) return undefined;
  const repo = match[1], number = Number(match[3]);
  if (!Number.isSafeInteger(number) || repo.split("/").some(part => part === "." || part === "..")) return undefined;
  return { domain: url.host.toLowerCase(), repo, kind: match[2] === "issues" ? "issue" : "pull", number, url: `https://${url.host.toLowerCase()}${url.pathname.replace(/\/$/, "")}` };
}

// ---------------------------------------------------------------- task references

/** gitboy's own rule (packages/shared phren-task-refs.ts): `bid:` and eight
 * lowercase hex digits standing alone, so gitboy and Phren read a pull
 * request or brief the same way. A closing keyword right before it (closes,
 * fixes, resolves; or a list after one: "fixes bid:a, bid:b and bid:c")
 * closes the task; anything else only mentions it ("the Hook half of bid:a"). */
const BID_REFERENCE = /(?<![\w:/.@=?&#-])bid:([0-9a-f]{8})(?![\w-]|[.:/@]\w)/g;
const CLOSING = /(?<![\w-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?[ \t]{1,4}$/i;
const LIST = /^[ \t]*(?:,|&|and|,[ \t]*and)[ \t]*$/i;
export function bidReferences(text: string): { closes: string[]; mentions: string[] } {
  const closes = new Set<string>(), mentions = new Set<string>();
  let previousEnd = -1, previousClosing = false;
  for (const match of (text ?? "").matchAll(BID_REFERENCE)) {
    const closing: boolean = CLOSING.test(text.slice(Math.max(0, match.index - 20), match.index)) || (previousClosing && LIST.test(text.slice(previousEnd, match.index)));
    (closing ? closes : mentions).add(match[1]);
    previousEnd = match.index + match[0].length;
    previousClosing = closing;
  }
  return { closes: [...closes], mentions: [...mentions].filter(id => !closes.has(id)) };
}
/** Stable ids a branch names as a whole segment: `task/c2cc33d0`,
 * `feat/c2cc33d0-work-links`, `agent/work-links-c2cc33d0`. */
export function branchTaskIds(branch: string): string[] {
  return [...new Set([...(branch ?? "").matchAll(/(?<![0-9A-Za-z])([0-9a-f]{8})(?![0-9A-Za-z])/g)].map(match => match[1]))];
}

export interface BriefReferences { closes: string[]; ids: string[]; bareIds: string[]; texts: string[] }
/** What a worker brief says about its task: `bid:` ids, bare stable ids and
 * quoted text (`Phren task (project phren): "Fix the sync race"`). */
export function briefReferences(prompt: string): BriefReferences {
  const { closes, mentions } = bidReferences(prompt);
  const ids = [...closes, ...mentions];
  const bareIds = [...new Set([...prompt.matchAll(/(?<![\w:/.@=?&#-])([0-9a-f]{8})(?![\w-])/g)].map(match => match[1]))].filter(id => !ids.includes(id));
  const texts = [...new Set([...prompt.matchAll(/["“]([^"\n“”]{6,400})["”]/g)].map(match => match[1].trim()))];
  return { closes, ids, bareIds, texts };
}
const comparable = (value: string) => value.replace(/\s*\[(?:high|medium|low|pinned)\]/gi, "").replace(/\s+/g, " ").trim().toLowerCase();
/** A quoted brief text names a task when it is the task's whole line or its
 * title, the part before the first ": ". */
export function textNamesTask(text: string, taskLine: string): boolean {
  const quoted = comparable(text), whole = comparable(taskLine);
  if (!quoted) return false;
  const colon = whole.indexOf(": ");
  return quoted === whole || (colon > 0 && quoted === whole.slice(0, colon));
}

// ---------------------------------------------------------------- live state

export type CheckState = "passing" | "failing" | "pending" | null;
/** One pull request or issue as the forge reports it now. */
export interface ForgeItem {
  state: "open" | "merged" | "closed";
  title?: string;
  draft?: boolean;
  /** Pull requests: the head commit's checks, one word. */
  checks?: CheckState;
  /** Pull requests: clean, blocked, conflicts, behind, draft or unknown. */
  mergeable?: "clean" | "blocked" | "conflicts" | "behind" | "draft" | "unknown";
  mergeDetail?: string;
  head?: string;
  mergedAt?: string;
  closedAt?: string;
}
/** The worker's state as a client groups it. The state `waiting` (parked on
 * CI, background work or a queue) is live: it needs no one's attention,
 * unlike this "waiting" phase's needs-you, blocked and stalled. */
export function workerPhase(state: WorkWorkerState): "live" | "waiting" | "done" {
  if (state === "needs-you" || state === "blocked" || state === "stalled") return "waiting";
  if (state === "done" || state === "failed" || state === "gone" || state === "closed") return "done";
  return "live";
}
/** GitHub's mergeStateStatus and gitboy's derived mergeState as one word. */
export function mergeableWord(mergeState: unknown, draft?: boolean): ForgeItem["mergeable"] {
  if (draft) return "draft";
  switch (String(mergeState ?? "").toUpperCase()) {
    case "CLEAN": case "HAS_HOOKS": case "UNSTABLE": return "clean";
    case "DIRTY": return "conflicts";
    case "BEHIND": return "behind";
    case "BLOCKED": return "blocked";
    case "DRAFT": return "draft";
    default: return "unknown";
  }
}

/** A forge reading: the last successful one (with `error` when the latest
 * refresh failed), the error alone when none succeeded, or null before the first. */
export type LiveForge = (ForgeItem & { checkedAt: string; error?: string }) | { error: string; checkedAt: string } | null;
export interface LiveWork { worker?: { phase: "live" | "waiting" | "done"; state: WorkWorkerState; at: string; source: "dispatch" | "task" };
  pr?: LiveForge; issue?: LiveForge }

/** The one line a Tasks row shows. What needs the owner comes first, then
 * the pull request, then a worker still going, then the issue. */
export function workStatusLine(work: TaskWork | undefined, live: LiveWork): string | undefined {
  if (!work) return undefined;
  const on = work.worker ? ` on ${work.worker.computer}` : "";
  const worker = live.worker;
  if (worker?.phase === "waiting") return worker.state === "blocked" ? `Worker needs approval${on}` : worker.state === "stalled" ? `Worker stalled${on}` : `Worker needs you${on}`;
  const pr = live.pr && "state" in live.pr ? live.pr : undefined;
  const ref = work.pr ? `${work.pr.forge === "gitlab" ? "MR !" : "PR #"}${work.pr.number}` : "";
  if (work.pr && pr) {
    if (pr.state === "merged") return `${ref} merged`;
    if (pr.state === "closed") return `${ref} closed without merging`;
    if (pr.checks === "failing") return `${ref} · checks failing`;
    if (pr.mergeable === "conflicts") return `${ref} · merge conflicts`;
    if (pr.draft) return `${ref} draft${pr.checks === "pending" ? " · checks running" : ""}`;
    if (pr.checks === "pending") return `${ref} · checks running`;
    if (pr.mergeable === "blocked") return `${ref} · blocked`;
    return `${ref} · ${pr.checks === "passing" ? "checks passing" : "open"}${pr.mergeable === "clean" ? " · ready to merge" : ""}`;
  }
  if (worker?.phase === "live") return worker.state === "launching" ? `Worker starting${on}`
    : worker.state === "waiting" ? `Worker waiting on ${WORK_WAITED_ON[work.worker?.waitingOn ?? "other"]}${on}`
    : `Worker working${on}`;
  if (work.pr) return live.pr && "error" in live.pr ? `${ref} · state unknown` : ref;
  if (worker) return `Worker ${worker.state}${on}`;
  const issue = live.issue && "state" in live.issue ? live.issue : undefined;
  if (work.issue) return `Issue #${work.issue.number}${issue ? ` ${issue.state}` : ""}`;
  if (work.branch) return `Branch ${work.branch}`;
  return undefined;
}

/** Why phren may move an open task to Done now, and the link that says so,
 * or nothing. A merged pull request or a closed issue closes it; the link that
 * closed it before (the owner reopened the task since) does not again. A pull
 * request closed without merging closes nothing. */
export function autoCloseReason(work: TaskWork | undefined, live: Pick<LiveWork, "pr" | "issue">): { reason: string; url: string } | undefined {
  if (!work) return undefined;
  const pr = live.pr && "state" in live.pr ? live.pr : undefined;
  const issue = live.issue && "state" in live.issue ? live.issue : undefined;
  const fresh = (url: string) => !work.autoClosed || (work.autoClosed.url !== undefined && work.autoClosed.url !== url);
  if (work.pr && pr?.state === "merged" && fresh(work.pr.url)) return { reason: `PR #${work.pr.number} merged (${work.pr.url})`, url: work.pr.url };
  if (work.issue && issue?.state === "closed" && fresh(work.issue.url)) return { reason: `issue #${work.issue.number} closed (${work.issue.url})`, url: work.issue.url };
  return undefined;
}
