/**
 * JSONL persistence for the session event log.
 *
 * One line per event, appended as it happens — replaces the whole-file
 * snapshot rewrite (O(n) per turn, O(n^2) per session) for durability.
 * The v1 message snapshot is still written once at session end for
 * consumers that read it (see memory/session.ts).
 */
import * as fs from "fs";
import * as path from "path";
import { sessionsDir } from "@phren/cli/session/utils";
import {
  SessionLog,
  SessionLogError,
  forkSessionEvents,
  validateEvents,
  type SessionEvent,
  type SessionLogHeader,
  type SessionLogSink,
} from "./log.js";

export function eventLogPath(phrenPath: string, sessionId: string): string {
  return path.join(sessionsDir(phrenPath), `session-${sessionId}.events.jsonl`);
}

/**
 * A sink that appends each line to the session's .events.jsonl.
 * Failures are swallowed after a one-time warning: persistence must never
 * take down a running turn.
 */
export function fileSink(phrenPath: string, sessionId: string): SessionLogSink {
  const file = eventLogPath(phrenPath, sessionId);
  let warned = false;
  return (line) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line + "\n", "utf8");
    } catch (err: unknown) {
      if (!warned) {
        warned = true;
        process.stderr.write(
          `[session] event log write failed (${err instanceof Error ? err.message : String(err)}); continuing without persistence\n`,
        );
      }
    }
  };
}

export interface LoadedSessionLog {
  header: SessionLogHeader;
  events: SessionEvent[];
  /** True when a truncated final line (crash artifact) was dropped. */
  repairedTail: boolean;
}

/**
 * Load and validate a persisted event log. Exactly one truncated final line
 * is tolerated (a crash mid-append); anything else malformed fails closed.
 */
export function loadEventLog(file: string): LoadedSessionLog {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) throw new SessionLogError(`empty event log: ${file}`);

  let repairedTail = false;
  const parsed: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      parsed.push(JSON.parse(lines[i]));
    } catch {
      if (i === lines.length - 1) {
        repairedTail = true;
        process.stderr.write(`[session] dropped truncated final event line in ${path.basename(file)}\n`);
        break;
      }
      throw new SessionLogError(`malformed event log line ${i + 1} in ${file}`);
    }
  }

  const header = parsed[0] as SessionLogHeader;
  if (!header || header.type !== "header" || typeof header.sessionId !== "string") {
    throw new SessionLogError(`event log missing header line: ${file}`);
  }
  const events = parsed.slice(1) as SessionEvent[];
  validateEvents(events);
  return { header, events, repairedTail };
}

/** Restore a live SessionLog from disk, re-attaching an append sink. */
export function restoreSessionLog(phrenPath: string, file: string): SessionLog {
  const { header, events } = loadEventLog(file);
  return SessionLog.restore(header, events, fileSink(phrenPath, header.sessionId));
}

/**
 * Fork a parent log into a new persisted session: the child file starts with
 * the parent's full event history as its seed and appends from there.
 */
export function persistFork(phrenPath: string, parent: SessionLog, childSessionId: string): SessionLog {
  const { header, events } = forkSessionEvents(parent, parent.length - 1, childSessionId);
  const sink = fileSink(phrenPath, childSessionId);
  sink(JSON.stringify(header));
  for (const event of events) sink(JSON.stringify(event));
  return SessionLog.restore(header, events, sink);
}

export interface SessionListing {
  sessionId: string;
  file: string;
  mtimeMs: number;
  project?: string;
  cwd?: string;
  /** Model-visible message count after replaying the log. */
  messages: number;
  /** First user prompt, trimmed to one line. */
  title: string;
}

/** Recent sessions, newest first; unreadable logs are skipped. */
export function listEventLogs(phrenPath: string, opts: { project?: string; limit?: number } = {}): SessionListing[] {
  const dir = sessionsDir(phrenPath);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".events.jsonl"));
  } catch {
    return [];
  }
  const stats = entries
    .map((entry) => {
      const file = path.join(dir, entry);
      try {
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((e): e is { file: string; mtimeMs: number } => e !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: SessionListing[] = [];
  for (const { file, mtimeMs } of stats) {
    if (out.length >= (opts.limit ?? 20)) break;
    try {
      const { header, events } = loadEventLog(file);
      if (opts.project && header.project !== opts.project) continue;
      const log = SessionLog.restore(header, events, () => {});
      const msgs = log.getMessages();
      if (msgs.length === 0) continue;
      const first = msgs.find((m) => m.role === "user" && typeof m.content === "string");
      const title = typeof first?.content === "string" ? first.content.replace(/\s+/g, " ").trim().slice(0, 80) : "";
      out.push({
        sessionId: header.sessionId,
        file,
        mtimeMs,
        ...(header.project ? { project: header.project } : {}),
        ...(header.cwd ? { cwd: header.cwd } : {}),
        messages: msgs.length,
        title,
      });
    } catch {
      // corrupt logs are not listed
    }
  }
  return out;
}

/**
 * The event log whose session id starts with `idPrefix`.
 * Throws when the prefix matches no session or more than one.
 */
export function findEventLogById(phrenPath: string, idPrefix: string): string {
  const dir = sessionsDir(phrenPath);
  const prefix = idPrefix.replace(/^session-/, "");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.startsWith(`session-${prefix}`) && f.endsWith(".events.jsonl"));
  } catch {
    // no sessions directory
  }
  if (entries.length === 0) throw new SessionLogError(`no session matches "${idPrefix}"`);
  if (entries.length > 1) {
    const ids = entries.slice(0, 5).map((f) => f.slice("session-".length, -".events.jsonl".length));
    throw new SessionLogError(`"${idPrefix}" matches ${entries.length} sessions (${ids.join(", ")}${entries.length > 5 ? ", …" : ""}); give more of the id`);
  }
  return path.join(dir, entries[0]);
}

/**
 * Newest event log for resume, optionally filtered by project.
 * @returns the file path, or null when none exist.
 */
export function findLatestEventLog(phrenPath: string, project?: string): string | null {
  const dir = sessionsDir(phrenPath);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".events.jsonl"));
  } catch {
    return null;
  }
  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    const file = path.join(dir, entry);
    try {
      if (project) {
        const { header } = loadEventLog(file);
        if (header.project !== project) continue;
      }
      candidates.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      // unreadable/corrupt log is skipped for resume selection, not fatal
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.file ?? null;
}
