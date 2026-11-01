// What a pane's agent last said about its own turns, from its lifecycle hooks:
// when a prompt was submitted, when the turn stopped, what it stopped with and
// whether the harness still had background work in flight. Dispatch returns
// answer from this record first (dispatch-returns.ts `workerStates`): a
// worker is done only once a Stop arrived after its prompt, never because it
// has looked idle for a while.
//
// Claude, Codex, Copilot and phren-agent send SessionStart, UserPromptSubmit
// and Stop to the Hook (agent-hooks.ts), which records them here, one small
// file per pane beside its binding. OpenCode has no such hooks; phren's
// OpenCode plugin stamps its turns into the per-PID status file instead
// (`opencodeTurn`).
//
// The record is keyed by pane and holds the latest conversation there, with
// the dispatch id (PHREN_DISPATCH_ID) its SessionStart or first prompt named,
// so a dispatch placed on this computer is matched by id as well as by pane
// and conversation.
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { opencodeTurnStamps } from "./harness-status.js";
import { briefId } from "./launch-brief.js";
import { atomicInPrivateDir, bridgeRoot, provider, serverName, sessionId, type Provider } from "./protocol.js";

/** Longest final reply kept from a Stop payload, in UTF-8 bytes (the receipt's limit). */
export const TURN_REPLY_LIMIT = 4000;
/** Most background tasks a record keeps from one Stop, running ones first. */
export const STOP_TASKS_LIMIT = 256;
// Room for a typical full task list beside the reply and cwd; a record still larger sheds tasks (`fitRecord`).
const MAX_RECORD_BYTES = 65_536;

// Not strict: a field a newer Hook adds (as `stop.cwd` was) is dropped on
// read here, never a reason to throw the pane's record away.
const stamp = z.object({ seq: z.number().int().min(0), at: z.string().datetime() });
const taskId = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const turnRecordSchema = z.object({
  terminal: z.string().min(1).max(200), source: provider, session: sessionId,
  /** Climbs with every recorded event, so prompt and stop are ordered without trusting the clock. */
  seq: z.number().int().min(0),
  /** The dispatch this conversation was launched for, as its hooks named it. */
  dispatch: briefId.optional(),
  startedAt: z.string().datetime().optional(),
  prompt: stamp.optional(),
  stop: stamp.extend({
    /** Background tasks (shells, subagents, monitors) the harness still ran when the turn stopped. */
    background: z.number().int().min(0).max(999).optional(),
    reply: z.string().max(TURN_REPLY_LIMIT).optional(), truncated: z.boolean().optional(),
    /** The agent's working directory when the turn stopped: where its uncommitted work would be. */
    cwd: z.string().max(4096).optional(),
    /** Claude: the background tasks the Stop listed, by id (a sub-agent's is its agent id), still running
     * or finished. The child tree trusts it over its quiet-transcript guess (transcript-claude.ts).
     * `truncated`: the Stop listed more than STOP_TASKS_LIMIT; finished ones were dropped first. */
    tasks: z.object({ running: z.array(taskId).max(STOP_TASKS_LIMIT), finished: z.array(taskId).max(STOP_TASKS_LIMIT),
      truncated: z.boolean().optional() }).refine(tasks => tasks.running.length + tasks.finished.length <= STOP_TASKS_LIMIT).optional(),
  }).optional(),
  at: z.string().datetime(),
});
export type TurnRecord = z.infer<typeof turnRecordSchema>;

export interface TurnEvent {
  event: string; terminal: string; source: Provider; session: string;
  /** SessionStart / UserPromptSubmit: the dispatch id the worker's hook named. */
  dispatch?: string;
  /** SessionStart only: how the session started, as the harness names it (Claude: startup, resume, clear, compact). */
  start?: string;
  /** Stop only: the harness's count of in-flight background tasks, when it reports one. */
  background?: number;
  /** Stop only: the background tasks it listed, `{id, running}` each (validated here). */
  backgroundTasks?: unknown;
  /** Stop only: the harness's last assistant message, when it reports one. */
  reply?: string;
  /** Stop only: the agent's working directory, as its hook payload names it. */
  cwd?: string;
  at?: number;
}

export const turnPath = (server: string, pane: string) =>
  path.join(bridgeRoot(), "turns", encodeURIComponent(serverName.parse(server)), encodeURIComponent(pane) + ".json");

/** `value` cut to at most `limit` UTF-8 bytes on a character boundary. */
export function truncateUtf8(value: string, limit = TURN_REPLY_LIMIT): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return { text: value, truncated: false };
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/** A Stop's background task list as ids still running and ids finished; undefined when it sent none.
 * Past STOP_TASKS_LIMIT, finished ids go before running ones and the list says it was cut. */
function stopTasks(value: unknown): { running: string[]; finished: string[]; truncated?: true } | undefined {
  if (!Array.isArray(value)) return undefined;
  const running: string[] = [], finished: string[] = [];
  for (const task of value) {
    const { id, running: live } = (task ?? {}) as { id?: unknown; running?: unknown };
    if (typeof id !== "string" || !taskId.safeParse(id).success || typeof live !== "boolean") continue;
    (live ? running : finished).push(id);
  }
  if (running.length + finished.length <= STOP_TASKS_LIMIT) return { running, finished };
  const kept = running.slice(0, STOP_TASKS_LIMIT);
  return { running: kept, finished: finished.slice(0, STOP_TASKS_LIMIT - kept.length), truncated: true };
}

/** The record after one lifecycle event; undefined for events that say nothing about turns.
 * Another conversation or terminal in the pane starts a fresh record. */
export function nextTurn(previous: TurnRecord | undefined, event: TurnEvent): TurnRecord | undefined {
  if (!["SessionStart", "UserPromptSubmit", "Stop"].includes(event.event)) return undefined;
  const at = new Date(event.at ?? Date.now()).toISOString();
  const same = previous && previous.terminal === event.terminal && previous.source === event.source && previous.session === event.session;
  const record: TurnRecord = same ? structuredClone(previous) : { terminal: event.terminal, source: event.source, session: event.session, seq: 0, at };
  record.seq++; record.at = at;
  if (event.dispatch && briefId.safeParse(event.dispatch).success) record.dispatch ??= event.dispatch;
  if (event.event === "SessionStart") {
    record.startedAt ??= at;
    // A resumed or cleared conversation in the same terminal no longer runs the background agents its
    // last Stop counted; a compaction keeps them.
    if ((event.start === "resume" || event.start === "clear") && record.stop) { delete record.stop.background; delete record.stop.tasks; }
  }
  else if (event.event === "UserPromptSubmit") record.prompt = { seq: record.seq, at };
  else {
    const reply = event.reply?.trim() ? truncateUtf8(event.reply.trim()) : undefined;
    const tasks = stopTasks(event.backgroundTasks);
    record.stop = { seq: record.seq, at, ...(event.background !== undefined ? { background: Math.min(999, Math.max(0, Math.floor(event.background))) } : {}),
      ...(tasks ? { tasks } : {}),
      ...(reply ? { reply: reply.text, ...(reply.truncated ? { truncated: true } : {}) } : {}),
      ...(event.cwd && path.isAbsolute(event.cwd) && event.cwd.length <= 4096 ? { cwd: event.cwd } : {}) };
  }
  return fitRecord(record);
}

/** `record` within MAX_RECORD_BYTES, which readRecord would otherwise throw away whole: its Stop's
 * finished tasks go first, then running ones, and the list says it was cut. */
function fitRecord(record: TurnRecord): TurnRecord {
  const tasks = record.stop?.tasks;
  while (tasks && Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES && (tasks.finished.length || tasks.running.length)) {
    const over = Buffer.byteLength(JSON.stringify(record)) - MAX_RECORD_BYTES, drop = Math.max(1, Math.ceil(over / 64));
    const list = tasks.finished.length ? tasks.finished : tasks.running;
    list.splice(Math.max(0, list.length - drop));
    tasks.truncated = true;
  }
  return record;
}

export type TurnPhase =
  | { phase: "unprompted" }
  | { phase: "working"; since: string }
  | { phase: "ended"; at: string; background?: number; reply?: string; truncated?: boolean };

/** Where the recorded conversation is: no prompt yet, a prompt with no Stop
 * after it, or a turn that stopped. A Stop with no recorded prompt (hooks
 * installed mid-conversation) still ended a turn. */
export function turnPhase(record: TurnRecord): TurnPhase {
  const { prompt, stop } = record;
  if (prompt && (!stop || stop.seq < prompt.seq)) return { phase: "working", since: prompt.at };
  if (!stop) return { phase: "unprompted" };
  return { phase: "ended", at: stop.at, ...(stop.background ? { background: stop.background } : {}),
    ...(stop.reply ? { reply: stop.reply, ...(stop.truncated ? { truncated: true } : {}) } : {}) };
}

/** The background tasks of a Stop at `stoppedAt` still running: the Stop's
 * count less the tasks whose finish the transcript recorded after it
 * (`FinalTurn.finishedTasks`). No turn ran since that Stop, so every task
 * finishing after it is one the count included; a finish does not always
 * bring a new Stop (its notification can wait in an idle session's queue). */
export function backgroundLeft(count: number | undefined, stoppedAt: string, finishedTasks: readonly string[] = []): number {
  if (!count) return 0;
  const stopped = Date.parse(stoppedAt);
  return Math.max(0, count - finishedTasks.filter(at => Date.parse(at) >= stopped).length);
}

async function readRecord(file: string): Promise<TurnRecord | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_RECORD_BYTES) return undefined;
    const parsed = turnRecordSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

let writes: Promise<unknown> = Promise.resolve();

/** Record one lifecycle event for `pane`. Writes run one at a time, so a Stop
 * and the next prompt arriving together keep their order. */
export function noteTurn(server: string, pane: string, event: TurnEvent): Promise<TurnRecord | undefined> {
  const run = writes.then(async () => {
    const file = turnPath(server, pane);
    const next = nextTurn(await readRecord(file), event);
    if (next) await atomicInPrivateDir(file, turnRecordSchema.parse(next));
    return next;
  });
  writes = run.catch(() => undefined);
  return run;
}

/** The recorded turns of `pane`'s latest conversation, if its hooks reported any. */
export function readTurn(server: string, pane: string): Promise<TurnRecord | undefined> {
  return readRecord(turnPath(server, pane));
}

export interface StopTasks { seq: number; at: string; running: string[]; finished: string[]; truncated?: boolean }
const STOP_TASKS_CACHE_MS = 2_000;
let stopTasksCache: { at: number; root: string; bySession: Promise<Map<string, StopTasks>> } | undefined;

/** The background tasks the latest Stop of conversation `session` listed, from whichever pane's record
 * holds it (the child tree knows the conversation, not its pane); undefined when no Stop listed any. */
export async function latestStopTasks(source: Provider, session: string): Promise<StopTasks | undefined> {
  const root = path.join(bridgeRoot(), "turns"), now = Date.now();
  if (!stopTasksCache || stopTasksCache.root !== root || now - stopTasksCache.at >= STOP_TASKS_CACHE_MS) {
    stopTasksCache = { at: now, root, bySession: (async () => {
      // The conversation's newest record decides, list or none: a resume in another pane (whose agents died
      // with the old process) outdates the list a closed pane's record still holds.
      // Panes are read in name order, and a record written in the same millisecond as another wins only when
      // its last event came after its own Stop (the pane that went on), so a tie never depends on directory order.
      const newest = new Map<string, TurnRecord>();
      for (const server of (await readdir(root).catch(() => [] as string[])).sort()) {
        for (const name of (await readdir(path.join(root, server)).catch(() => [] as string[])).filter(name => name.endsWith(".json")).sort()) {
          const record = await readRecord(path.join(root, server, name));
          if (!record) continue;
          const key = `${record.source}\0${record.session}`, previous = newest.get(key);
          const at = Date.parse(record.at), before = previous ? Date.parse(previous.at) : -Infinity;
          if (at > before || (at === before && record.stop?.seq !== record.seq && previous?.stop?.seq === previous?.seq)) newest.set(key, record);
        }
      }
      const found = new Map<string, StopTasks>();
      for (const [key, record] of newest) if (record.stop?.tasks) found.set(key, { seq: record.stop.seq, at: record.stop.at, ...record.stop.tasks });
      return found;
    })() };
  }
  return (await stopTasksCache.bySession).get(`${source}\0${session}`);
}

/** OpenCode's turns for a pane running `pids`, from the stamps phren's OpenCode
 * plugin writes on session.status busy / session.idle; undefined for an older
 * plugin that writes none. `terminal` is the pane's, since the PIDs are. */
export async function opencodeTurn(pids: number[], terminal: string): Promise<TurnRecord | undefined> {
  const stamps = await opencodeTurnStamps(pids);
  if (!stamps) return undefined;
  const busy = stamps.busyAt ? Date.parse(stamps.busyAt) : NaN, idle = stamps.idleAt ? Date.parse(stamps.idleAt) : NaN;
  const idleAt = stamps.idleAt;
  let stopSeq: number | undefined;
  if (typeof idleAt === "string" && Number.isFinite(idle) && !(idle < busy)) {
    stopSeq = await opencodeStopSeq(stamps.session, idleAt);
    // An older stamp describes a turn already recorded: do not turn it into a working prompt.
    if (stopSeq === undefined) return undefined;
  }
  const parsed = turnRecordSchema.safeParse({ terminal, source: "opencode", session: stamps.session, seq: stopSeq ?? 2, at: stamps.at,
    ...(Number.isFinite(busy) ? { prompt: { seq: stopSeq !== undefined ? stopSeq - 1 : 1, at: stamps.busyAt } } : {}),
    // The plugin stamps idle after busy; an idle stamp older than the busy one belongs to an earlier turn.
    ...(stopSeq !== undefined ? { stop: { seq: stopSeq, at: idleAt } } : {}) });
  return parsed.success ? parsed.data : undefined;
}

const OPENCODE_SEQ_START = 2;
const opencodeSeqSchema = z.object({ session: sessionId, idleAt: z.string().datetime(), seq: z.number().int().min(OPENCODE_SEQ_START) });
type OpencodeSeq = z.infer<typeof opencodeSeqSchema>;

/** The advancing Stop sequence for OpenCode conversation `session`, keyed by
 * its latest idle stamp: a new idle stamp is a new turn, and the sequence is
 * persisted so a Hook restart keeps the same completion ids. */
const opencodeSeqPath = (session: string) => path.join(bridgeRoot(), "opencode-turns", encodeURIComponent(session) + ".json");

async function readOpencodeSeq(file: string): Promise<OpencodeSeq | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 1_024) return undefined;
    const parsed = opencodeSeqSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

let opencodeWrites: Promise<unknown> = Promise.resolve();

function opencodeStopSeq(session: string, idleAt: string): Promise<number | undefined> {
  const run = opencodeWrites.then(async () => {
    const file = opencodeSeqPath(session), previous = await readOpencodeSeq(file);
    if (previous?.session !== session) {
      await atomicInPrivateDir(file, { session, idleAt, seq: OPENCODE_SEQ_START });
      return OPENCODE_SEQ_START;
    }
    const previousAt = Date.parse(previous.idleAt), incomingAt = Date.parse(idleAt);
    if (incomingAt === previousAt) return previous.seq;
    // An overlapping read can enqueue an older stamp after a newer one: it is not a new turn.
    if (incomingAt < previousAt) return undefined;
    const seq = previous.seq + 2;
    await atomicInPrivateDir(file, { session, idleAt, seq });
    return seq;
  });
  opencodeWrites = run.catch(() => undefined);
  return run;
}
