import { execFile } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { codexHome } from "../home-paths.js";
import { countIdentity } from "./metrics.js";
import { object, sessionId, type Json } from "./protocol.js";

/** Codex 0.157 runs its conversations in a shared background daemon
 * (`codex app-server --listen … --managed-daemon`, reparented to launchd or
 * init), not in the pane's own `codex` process. The pane's TUI holds no
 * rollout, and Codex's lifecycle hooks run inside the daemon with the
 * environment of whichever pane first started it. This module is what the
 * Hook can still prove about such a conversation: which rollouts the daemon
 * holds, the folder and time each began, and when each pane's TUI started. */

const exec = promisify(execFile);
const DAEMON_COMMAND = /(?:^|\/)codex\s+app-server(?:\s|$)/;
const ROLLOUT = /rollout-[^/]*-([a-f0-9-]{36})\.jsonl$/i;
const CACHE_MS = 2_000, META_BYTES = 65_536, MAX_ROLLOUTS = 32, MAX_DAEMONS = 4;
/** A conversation begins as its TUI starts; allow for clock rounding. */
export const START_SLACK_MS = 5_000;

export interface ProcessRow { pid: number; ppid: number; startedAt: number; command: string }
export interface DaemonRollout { id: string; cwd: string; startedAt: number; activeAt: number; held: boolean }

/** `ps` etime: `[[dd-]hh:]mm:ss`, in milliseconds. */
export function parseElapsed(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return undefined;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

let table: { at: number; rows: Promise<ProcessRow[]> } | undefined;
/** Every process with its parent, start time and command line, from one `ps`. */
export function processTable(now = Date.now()): Promise<ProcessRow[]> {
  if (table && now - table.at < CACHE_MS) return table.rows;
  countIdentity("ps");
  const rows = exec("ps", ["-Aww", "-o", "pid=,ppid=,etime=,command="], { timeout: 3000, maxBuffer: 8_388_608 }).then(({ stdout }) => {
    const out: ProcessRow[] = [];
    for (const line of String(stdout).split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      const elapsed = match ? parseElapsed(match[3]) : undefined;
      if (match && elapsed !== undefined) out.push({ pid: Number(match[1]), ppid: Number(match[2]), startedAt: now - elapsed, command: match[4].slice(0, 4096) });
    }
    return out;
  }, () => [] as ProcessRow[]);
  table = { at: now, rows };
  return rows;
}

export function isCodexDaemon(command: string): boolean { return DAEMON_COMMAND.test(command); }

/** When a pane's agent started: its oldest foreground process. */
export function startedAt(rows: ProcessRow[], pids: number[]): number | undefined {
  const times = rows.filter(row => pids.includes(row.pid)).map(row => row.startedAt);
  return times.length ? Math.min(...times) : undefined;
}

/** True when this process runs under a Codex app-server daemon: a hook the
 * daemon ran carries the environment of the pane that started the daemon,
 * which is not the pane of the conversation it reports. */
export async function underCodexDaemon(env: NodeJS.ProcessEnv = process.env, pid = process.pid): Promise<boolean> {
  // Set only in the daemon's environment by Codex 0.157; a hint, not a contract.
  if (env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED !== undefined) return true;
  if (process.platform === "win32") return false;
  const rows = await processTable(), byPid = new Map(rows.map(row => [row.pid, row]));
  let current = byPid.get(pid)?.ppid ?? process.ppid;
  for (let depth = 0; depth < 8 && current > 1; depth++) {
    const row = byPid.get(current);
    if (!row) return false;
    if (isCodexDaemon(row.command)) return true;
    current = row.ppid;
  }
  return false;
}

/** The session_meta fields identity needs, from a rollout's first line read
 * at most META_BYTES deep. Codex 0.157 writes its whole base instructions into
 * that line, so a cut line is read field by field instead of parsed. */
export async function rolloutMeta(file: string): Promise<{ id: string; cwd: string; startedAt: number; subagent: boolean } | undefined> {
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return undefined;
  let text: string;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(META_BYTES), 0, META_BYTES, 0);
    text = buffer.subarray(0, bytesRead).toString("utf8");
  } catch { return undefined; } finally { await handle.close(); }
  const newline = text.indexOf("\n");
  let payload: Json | undefined;
  if (newline >= 0) {
    try {
      const raw = object(JSON.parse(text.slice(0, newline)));
      if (raw.type !== "session_meta") return undefined;
      payload = object(raw.payload);
    } catch { /* fall through to field reads */ }
  }
  if (!payload) {
    // The row's own type comes before its payload.
    if (!text.slice(0, 256).includes('"type":"session_meta"')) return undefined;
    payload = {};
    for (const key of ["id", "session_id", "timestamp", "cwd", "thread_source"]) {
      // An unescaped `"key":"` is a JSON key: inside a string its quotes are escaped.
      const match = new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`).exec(text);
      if (match) try { payload[key] = JSON.parse(match[1]); } catch { /* ignore */ }
    }
    if (/"source":\{"subagent"/.test(text)) payload.source = { subagent: true };
  }
  const id = String(payload.id ?? payload.session_id ?? ""), fromName = ROLLOUT.exec(file)?.[1];
  const at = Date.parse(String(payload.timestamp ?? ""));
  if (!sessionId.safeParse(id).success || (fromName && fromName.toLowerCase() !== id.toLowerCase()) || typeof payload.cwd !== "string" || !path.isAbsolute(payload.cwd) || !Number.isFinite(at)) return undefined;
  const subagent = !!object(payload.source).subagent || (typeof payload.thread_source === "string" && /sub.?agent/i.test(payload.thread_source));
  return { id, cwd: payload.cwd, startedAt: at, subagent };
}

/** Today's and yesterday's rollouts, newest first by name, capped. */
async function recentRollouts(now: number): Promise<string[]> {
  const files: string[] = [];
  for (const offset of [0, 1]) {
    const day = new Date(now - offset * 86_400_000);
    const folder = path.join(codexHome(), "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    const names = (await readdir(folder).catch(() => [] as string[])).filter(name => ROLLOUT.test(name)).sort().reverse();
    files.push(...names.slice(0, MAX_ROLLOUTS).map(name => path.join(folder, name)));
  }
  return files.slice(0, MAX_ROLLOUTS);
}

let rollouts: { at: number; value: Promise<DaemonRollout[]> } | undefined;
/**
 * The conversations a running Codex daemon holds open (by `openFiles`, the
 * caller's lsof or /proc read), else, when it holds none, the recent rollouts
 * in Codex's sessions folder. Empty when no daemon runs: a TUI that runs its
 * own conversation holds its rollout itself.
 */
export function daemonRollouts(openFiles: (pids: number[]) => Promise<string[]>, now = Date.now()): Promise<DaemonRollout[]> {
  if (rollouts && now - rollouts.at < CACHE_MS) return rollouts.value;
  const value = (async () => {
    const daemons = (await processTable(now)).filter(row => isCodexDaemon(row.command)).map(row => row.pid).slice(0, MAX_DAEMONS);
    if (!daemons.length) return [];
    countIdentity("codex-daemon");
    const held = (await openFiles(daemons).catch(() => [] as string[])).filter(file => ROLLOUT.test(file)).slice(0, MAX_ROLLOUTS);
    const files = held.length ? held : await recentRollouts(now);
    const out: DaemonRollout[] = [];
    for (const file of files) {
      const meta = await rolloutMeta(file);
      if (!meta || meta.subagent) continue;
      const info = await stat(file).catch(() => undefined);
      out.push({ id: meta.id, cwd: meta.cwd, startedAt: meta.startedAt, activeAt: info?.mtimeMs ?? meta.startedAt, held: held.length > 0 });
    }
    return out;
  })().catch(() => [] as DaemonRollout[]);
  rollouts = { at: now, value };
  return value;
}

export function resetCodexDaemonCache(): void { table = undefined; rollouts = undefined; }

const real = async (dir: string) => realpath(dir).catch(() => path.resolve(dir));
export async function sameDirectory(a: unknown, b: unknown): Promise<boolean> {
  if (typeof a !== "string" || typeof b !== "string" || !path.isAbsolute(a) || !path.isAbsolute(b)) return false;
  return path.resolve(a) === path.resolve(b) || await real(a) === await real(b);
}

/**
 * Which daemon conversation a Codex pane shows, given the conversations in
 * its folder, when its TUI started, which ones other panes' processes hold,
 * and when every other Codex pane in that folder started.
 *
 * With no other Codex pane in the folder, the pane shows the most recently
 * active conversation begun since its TUI started, so a later /new or
 * /resume follows. With several, the latest-started pane chooses first (ties
 * by pane key), each taking the earliest conversation begun after it started.
 */
export interface CodexPaneStart { key: string; start: number }
export function assignDaemonConversation(here: DaemonRollout[], self: CodexPaneStart, claimed: Set<string>, rivals: CodexPaneStart[], now = Date.now()): string | undefined {
  const open = here.filter(r => !claimed.has(r.id) && r.startedAt <= now + 60_000);
  const after = (from: number) => open.filter(r => r.startedAt >= from - START_SLACK_MS);
  if (!rivals.length) {
    const pool = after(self.start);
    const held = pool.filter(r => r.held);
    return (held.length ? held : pool).sort((a, b) => b.activeAt - a.activeAt)[0]?.id;
  }
  const order = [...rivals, self].sort((a, b) => b.start - a.start || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  const taken = new Set<string>();
  for (const pane of order) {
    const pick = after(pane.start).filter(r => !taken.has(r.id)).sort((a, b) => a.startedAt - b.startedAt)[0];
    if (pane === self) return pick?.id;
    if (pick) taken.add(pick.id);
  }
  return undefined;
}
