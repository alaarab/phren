/** Tasks get closed (issue #934): which tasks a session took on and whether
 * each is resolved, the per-agent WIP limit, short titles and staleness.
 *
 * A session's tasks are kept in a small ledger under the primary store's
 * `.runtime/session-tasks/<session>.json`: the MCP task tools record a task
 * there when a session claims it or moves it to Active. The Stop hook
 * (cli/session-stop.ts) and the Hook's dispatch returns read it back and judge
 * each task with `resolutionOf`:
 *
 *   done    the task is in Done
 *   queue   it went back to the Queue
 *   parked  it is still Active, and its context names a `Blocker:` and a `Next:`
 *   open    still Active with neither: the session has to settle it
 *   missing the task or its store is gone (nothing left to settle)
 *
 * Pure apart from the ledger file and task reads. */
import * as fs from "node:fs";
import * as path from "node:path";
import { readTasks, type TaskItem, type TaskSection } from "../data/tasks.js";
import { renameOverSync, runtimeDir } from "../phren-paths.js";

/** Most Active tasks one agent session should hold at once. Soft: a warning, never a refusal. */
export const WIP_LIMIT = 3;
/** Longest task title (the line, without metadata) before add_task suggests a title and context split. */
export const TITLE_LIMIT = 80;
/** An Active task untouched this long is stale: the owner inbox lists it and the nightly dream returns it to the Queue. */
export const STALE_MS = 24 * 60 * 60 * 1000;
/** Most tasks one session ledger keeps; the oldest drop first. */
const LEDGER_LIMIT = 64;
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const STABLE_ID = /^[a-f0-9]{8}$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export interface SessionTaskRef { store: string; project: string; stableId: string; at: string }
export type SessionTaskResolution = "done" | "queue" | "parked" | "open" | "missing";
export interface SessionTaskState {
  store: string; project: string; stableId: string;
  /** The task line without metadata, at most 200 characters; empty when missing. */
  title: string;
  section: TaskSection | "missing";
  resolution: SessionTaskResolution;
}

/** The calling agent's session id: Claude Code's, else Codex's. */
export function currentSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const value of [env.CLAUDE_CODE_SESSION_ID, env.CODEX_THREAD_ID, env.CODEX_SESSION_ID]) {
    const trimmed = value?.trim();
    if (trimmed && SESSION_ID.test(trimmed)) return trimmed;
  }
  return undefined;
}

export function sessionLedgerPath(base: string, session: string): string | undefined {
  return SESSION_ID.test(session) ? path.join(runtimeDir(base), "session-tasks", `${session.replace(/:/g, "_")}.json`) : undefined;
}

export function sessionTaskRefs(base: string, session: string): SessionTaskRef[] {
  const file = sessionLedgerPath(base, session);
  if (!file) return [];
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return (Array.isArray(raw) ? raw : []).filter((row): row is SessionTaskRef => !!row && typeof row === "object"
      && typeof row.store === "string" && path.isAbsolute(row.store) && typeof row.project === "string" && PROJECT.test(row.project)
      && typeof row.stableId === "string" && STABLE_ID.test(row.stableId) && typeof row.at === "string");
  } catch { return []; }
}

/** Record that `session` took on a task. Best effort: a failed write never fails the task tool. */
export function recordSessionTask(base: string, session: string, ref: Omit<SessionTaskRef, "at">, now = new Date()): void {
  const file = sessionLedgerPath(base, session);
  if (!file || !STABLE_ID.test(ref.stableId) || !PROJECT.test(ref.project) || !path.isAbsolute(ref.store)) return;
  try {
    const rows = sessionTaskRefs(base, session).filter(row => !(row.stableId === ref.stableId && row.project === ref.project && row.store === ref.store));
    rows.push({ store: ref.store, project: ref.project, stableId: ref.stableId, at: now.toISOString() });
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(rows.slice(-LEDGER_LIMIT)), { mode: 0o600 });
    renameOverSync(temp, file);
  } catch { /* the ledger is advisory */ }
}

/** A task's context says what blocks it and what comes next. */
export function isParked(item: Pick<TaskItem, "context">): boolean {
  const context = item.context ?? "";
  return /\bblocker:\s*\S/i.test(context) && /\bnext:\s*\S/i.test(context);
}

export function resolutionOf(item: Pick<TaskItem, "section" | "context"> | undefined): SessionTaskResolution {
  if (!item) return "missing";
  if (item.section === "Done") return "done";
  if (item.section === "Queue") return "queue";
  return isParked(item) ? "parked" : "open";
}

/** The task line without the bid comment and priority tags. */
export function taskTitle(line: string): string {
  return line.replace(/<!--[\s\S]*?-->/g, "").replace(/\s*\[(?:high|medium|low|pinned)\]/gi, "").replace(/\s+/g, " ").trim();
}

/** Every task the session took on, as it stands now. */
export function sessionTaskStates(base: string, session: string): SessionTaskState[] {
  const docs = new Map<string, ReturnType<typeof readTasks>>();
  return sessionTaskRefs(base, session).map(ref => {
    const key = `${ref.store}\0${ref.project}`;
    if (!docs.has(key)) docs.set(key, readTasks(ref.store, ref.project));
    const doc = docs.get(key)!;
    const item = doc.ok ? [...doc.data.items.Active, ...doc.data.items.Queue, ...doc.data.items.Done].find(entry => entry.stableId === ref.stableId) : undefined;
    return { store: ref.store, project: ref.project, stableId: ref.stableId, title: item ? taskTitle(item.line).slice(0, 200) : "",
      section: item?.section ?? "missing", resolution: resolutionOf(item) };
  });
}

export function unresolvedTasks(states: readonly SessionTaskState[]): SessionTaskState[] {
  return states.filter(state => state.resolution === "open");
}

/** What the Stop hook tells an agent that leaves tasks open. */
export function resolutionPrompt(open: readonly SessionTaskState[]): string {
  const rows = open.map(task => `- ${task.project} bid:${task.stableId}: ${task.title.slice(0, 100)}`);
  return [`You took on ${open.length === 1 ? "this task" : `these ${open.length} tasks`} this session and ${open.length === 1 ? "it is" : "they are"} still Active:`, ...rows,
    "Before you stop, settle each one with phren: complete it (with the evidence: PR, commit or check that shows it done), "
    + "park it (update_task context \"Blocker: <what blocks it>; Next: <the next step>\") or return it to the Queue (update_task section Queue).",
  ].join("\n");
}

/** Active tasks the session holds right now. */
export function sessionActiveCount(base: string, session: string): number {
  return sessionTaskStates(base, session).filter(state => state.section === "Active").length;
}

/** The WIP warning for a session now holding `count` Active tasks, or undefined within the limit. */
export function wipWarning(count: number): string | undefined {
  return count > WIP_LIMIT
    ? `This session now holds ${count} Active tasks (limit ${WIP_LIMIT}). Finish, park or return one to the Queue before taking more.`
    : undefined;
}

/** A title over TITLE_LIMIT split into a short title and the rest as context, or undefined when it fits.
 * The title ends at the first sentence or clause break past 20 characters that fits, else at a word boundary. */
export function titleAdvice(text: string): { title: string; context: string } | undefined {
  const clean = taskTitle(text);
  if (clean.length <= TITLE_LIMIT) return undefined;
  const head = clean.slice(0, TITLE_LIMIT + 1);
  // Break after a sentence or clause mark, or before " (" and " - ".
  const breaks = [
    ...[...head.matchAll(/[.;:!?](?=\s)/g)].map(match => match.index! + 1),
    ...[...head.matchAll(/\s(?:[-–—]\s|\()/g)].map(match => match.index!),
  ].filter(index => index >= 20 && index <= TITLE_LIMIT).sort((a, b) => a - b);
  const space = head.lastIndexOf(" ");
  const at = breaks[0] ?? (space >= 20 ? space : TITLE_LIMIT);
  const title = clean.slice(0, at).replace(/[\s:;,–—-]+$/, "").trim();
  const context = clean.slice(at).replace(/^[\s.;:!?–—-]+/, "").trim();
  return { title, context };
}

/** When a task was last touched: its last recorded activity, claim or worker update, else when it was created. */
export function taskLastTouched(item: Pick<TaskItem, "lastActivity" | "claim" | "work" | "createdAt">): number | undefined {
  const times = [item.lastActivity, item.claim?.at, item.work?.worker?.at, item.work?.autoClosed?.at]
    .map(value => value ? Date.parse(value) : NaN).filter(Number.isFinite);
  if (times.length) return Math.max(...times);
  const created = item.createdAt ? Date.parse(item.createdAt) : NaN;
  return Number.isFinite(created) ? created : undefined;
}

/** An Active task untouched for STALE_MS. A task with no time at all is never called stale. */
export function isStale(item: Pick<TaskItem, "section" | "lastActivity" | "claim" | "work" | "createdAt">, now = Date.now()): boolean {
  if (item.section !== "Active") return false;
  const touched = taskLastTouched(item);
  return touched !== undefined && now - touched >= STALE_MS;
}
