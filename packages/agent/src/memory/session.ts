import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { PhrenContext } from "./context.js";

interface SessionState {
  sessionId: string;
  project?: string;
  startedAt: string;
  endedAt?: string;
  findingsAdded: number;
  tasksCompleted: number;
  tasksAdded: number;
  hookCreated?: boolean;
  agentCreated?: boolean;
}

function sessionsDir(phrenPath: string): string {
  const dir = path.join(phrenPath, ".runtime", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionFile(phrenPath: string, sessionId: string): string {
  return path.join(sessionsDir(phrenPath), `session-${sessionId}.json`);
}

/**
 * Simple file-based lock for synchronizing read-modify-write on session files.
 * Uses a .lock file alongside the target, with stale lock detection.
 */
function withFileLock<T>(lockPath: string, fn: () => T, timeoutMs = 3000): T {
  const start = Date.now();
  while (fs.existsSync(lockPath)) {
    if (Date.now() - start > timeoutMs) {
      // Stale lock — force release
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
      break;
    }
    // Busy wait with small sleep (sync context)
    const end = Date.now() + 50;
    while (Date.now() < end) { /* spin */ }
  }
  fs.writeFileSync(lockPath, String(process.pid));
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

export function startSession(ctx: PhrenContext, sessionName?: string): string {
  const sessionId = crypto.randomUUID();
  const state: SessionState & { sessionName?: string } = {
    sessionId,
    project: ctx.project || undefined,
    startedAt: new Date().toISOString(),
    findingsAdded: 0,
    tasksCompleted: 0,
    tasksAdded: 0,
    agentCreated: true,
  };
  if (sessionName) {
    state.sessionName = sessionName;
  }
  const file = sessionFile(ctx.phrenPath, sessionId);
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
  return sessionId;
}

export function endSession(ctx: PhrenContext, sessionId: string, summary?: string, sessionName?: string): void {
  const file = sessionFile(ctx.phrenPath, sessionId);
  if (!fs.existsSync(file)) return;
  const lockPath = file + ".lock";
  try {
    withFileLock(lockPath, () => {
      const state: SessionState = JSON.parse(fs.readFileSync(file, "utf-8"));
      state.endedAt = new Date().toISOString();
      if (summary) {
        // Also write to last-summary.json for fast pickup by next session_start
        const summaryFile = path.join(sessionsDir(ctx.phrenPath), "last-summary.json");
        const summaryData: Record<string, unknown> = {
          summary,
          sessionId,
          project: state.project,
          endedAt: state.endedAt,
        };
        if (sessionName) {
          summaryData.sessionName = sessionName;
        }
        fs.writeFileSync(summaryFile, JSON.stringify(summaryData, null, 2) + "\n");
      }
      fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
    });
  } catch { /* best effort */ }
}

export function incrementSessionCounter(phrenPath: string, sessionId: string, counter: "findingsAdded" | "tasksCompleted" | "tasksAdded"): void {
  const file = sessionFile(phrenPath, sessionId);
  if (!fs.existsSync(file)) return;
  const lockPath = file + ".lock";
  try {
    withFileLock(lockPath, () => {
      const state: SessionState = JSON.parse(fs.readFileSync(file, "utf-8"));
      state[counter] = (state[counter] ?? 0) + 1;
      fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
    });
  } catch { /* best effort */ }
}

/** Read the most recent session summary for prior context. */
export function getPriorSummary(ctx: PhrenContext): string | null {
  try {
    const summaryFile = path.join(sessionsDir(ctx.phrenPath), "last-summary.json");
    if (!fs.existsSync(summaryFile)) return null;
    const data = JSON.parse(fs.readFileSync(summaryFile, "utf-8"));
    return data.summary || null;
  } catch {
    return null;
  }
}

// --- Session resume ---

interface SerializedMessage {
  role: string;
  content: unknown;
}

// messagesDir is identical to sessionsDir — reuse it
const messagesDir = sessionsDir;

/** Save session messages for later resume. */
export function saveSessionMessages(phrenPath: string, sessionId: string, messages: SerializedMessage[]): void {
  const file = path.join(messagesDir(phrenPath), `session-${sessionId}-messages.json`);
  fs.writeFileSync(file, JSON.stringify(messages, null, 2) + "\n");
}

/** Load the last session's messages for resume. Returns null if none found. */
export function loadLastSessionMessages(phrenPath: string): SerializedMessage[] | null {
  try {
    const dir = messagesDir(phrenPath);
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith("-messages.json"))
      .map(f => ({
        name: f,
        mtime: fs.statSync(path.join(dir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;

    const data = fs.readFileSync(path.join(dir, files[0].name), "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** Save session messages under a named session for later resume by name. */
export function saveNamedSessionMessages(phrenPath: string, sessionName: string, messages: SerializedMessage[]): void {
  const safeName = sessionName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const file = path.join(messagesDir(phrenPath), `named-${safeName}-messages.json`);
  fs.writeFileSync(file, JSON.stringify(messages, null, 2) + "\n");
}

/** Load a named session's messages for resume. Returns null if none found. */
export function loadNamedSessionMessages(phrenPath: string, sessionName: string): SerializedMessage[] | null {
  try {
    const safeName = sessionName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const file = path.join(messagesDir(phrenPath), `named-${safeName}-messages.json`);
    if (!fs.existsSync(file)) return null;
    const data = fs.readFileSync(file, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// --- Session picker support ---

export interface SessionInfo {
  id: string;
  name?: string;
  timestamp: string;
  summary: string;
  turnCount?: number;
}

/**
 * List recent sessions with their IDs, names, timestamps, and summary snippets.
 * Reads session JSON files from the sessions directory, sorted newest first.
 */
export function listRecentSessions(phrenPath: string, limit = 10): SessionInfo[] {
  try {
    const dir = sessionsDir(phrenPath);
    // Find session state files (not message files or named files)
    const files = fs.readdirSync(dir)
      .filter(f => /^session-[0-9a-f-]+\.json$/.test(f))
      .map(f => {
        const fullPath = path.join(dir, f);
        return { name: f, fullPath, mtime: fs.statSync(fullPath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);

    const results: SessionInfo[] = [];

    // Pre-load last-summary.json once (instead of per-session)
    let lastSummaryData: Record<string, unknown> | null = null;
    const summaryFile = path.join(dir, "last-summary.json");
    if (fs.existsSync(summaryFile)) {
      try { lastSummaryData = JSON.parse(fs.readFileSync(summaryFile, "utf-8")); } catch { /* ignore */ }
    }

    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(file.fullPath, "utf-8"));
        const sessionId: string = raw.sessionId || "";
        if (!sessionId) continue;

        // Try to load the summary from cached last-summary.json
        let summary = "";
        if (lastSummaryData && lastSummaryData.sessionId === sessionId && lastSummaryData.summary) {
          summary = lastSummaryData.summary as string;
        }

        // Count turns from messages file if available
        const msgFile = path.join(dir, `session-${sessionId}-messages.json`);
        let turnCount: number | undefined;
        if (fs.existsSync(msgFile)) {
          try {
            const msgs = JSON.parse(fs.readFileSync(msgFile, "utf-8"));
            if (Array.isArray(msgs)) {
              turnCount = msgs.filter((m: SerializedMessage) => m.role === "assistant").length;
            }
          } catch { /* ignore */ }
        }

        // Build a summary snippet if we don't have one
        if (!summary) {
          const parts: string[] = [];
          if (raw.project) parts.push(`project: ${raw.project}`);
          if (raw.findingsAdded) parts.push(`${raw.findingsAdded} findings`);
          if (raw.tasksCompleted) parts.push(`${raw.tasksCompleted} tasks done`);
          summary = parts.join(", ") || "(no summary)";
        }

        // Truncate summary for display
        if (summary.length > 120) {
          summary = summary.slice(0, 117) + "...";
        }

        const info: SessionInfo = {
          id: sessionId,
          name: raw.sessionName || undefined,
          timestamp: raw.startedAt || new Date(file.mtime).toISOString(),
          summary,
          turnCount,
        };

        results.push(info);
      } catch { /* skip malformed session files */ }
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Load messages for a session identified by name.
 * Tries named session files first, then falls back to searching session state
 * files for a matching sessionName field.
 */
export function loadSessionMessagesByName(phrenPath: string, name: string): SerializedMessage[] | null {
  // Try named session file first (exact match)
  const named = loadNamedSessionMessages(phrenPath, name);
  if (named) return named;

  // Fall back to scanning session state files for a matching sessionName
  try {
    const dir = sessionsDir(phrenPath);
    const files = fs.readdirSync(dir)
      .filter(f => /^session-[0-9a-f-]+\.json$/.test(f));

    for (const f of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
        if (raw.sessionName === name && raw.sessionId) {
          const msgFile = path.join(dir, `session-${raw.sessionId}-messages.json`);
          if (fs.existsSync(msgFile)) {
            return JSON.parse(fs.readFileSync(msgFile, "utf-8"));
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }

  return null;
}
