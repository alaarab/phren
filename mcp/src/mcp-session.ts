import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { runtimeFile, resolveFindingsPath, debugLog, tryUnlink } from "./shared.js";
import { withFileLock } from "./shared-governance.js";
import { isValidProjectName } from "./utils.js";

interface SessionState {
  sessionId: string;
  project?: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  findingsAdded: number;
}

const STALE_SESSION_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * The session ID created by this process's most recent session_start call.
 *
 * NOTE: This is a module-global singleton and will be overwritten when a new
 * session_start is called.  When multiple clients share the same process, callers
 * should always pass an explicit sessionId to session_end / session_context rather
 * than relying on this fallback.  The sessionId is returned in the session_start
 * response data for this purpose.
 */
let _currentProcessSessionId: string | undefined;

/** Per-connection session map keyed by arbitrary connection ID (if provided). */
const _sessionMap = new Map<string, string>();

/** Get the current process's session ID (set by session_start). */
export function getCurrentSessionId(): string | undefined {
  return _currentProcessSessionId;
}

function sessionsDir(cortexPath: string): string {
  const dir = path.join(cortexPath, ".runtime", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionFileForId(cortexPath: string, sessionId: string): string {
  return path.join(sessionsDir(cortexPath), `session-${sessionId}.json`);
}

function readSessionStateFile(file: string): SessionState | null {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}

function writeSessionStateFile(file: string, state: SessionState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
  fs.renameSync(tempFile, file);
}

/** Find the most recent *active* (not ended) session file by mtime. */
function findMostRecentSession(cortexPath: string): { file: string; state: SessionState } | null {
  const dir = sessionsDir(cortexPath);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return null; }

  let bestFile: string | null = null;
  let bestMtime = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("session-") || !entry.name.endsWith(".json")) continue;
    const fullPath = path.join(dir, entry.name);
    try {
      const state = readSessionStateFile(fullPath);
      // Skip ended sessions — fallback should only return active sessions
      if (!state || state.endedAt) continue;
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        bestFile = fullPath;
      }
    } catch { /* skip unreadable files */ }
  }

  if (!bestFile) return null;
  const state = readSessionStateFile(bestFile);
  if (!state) return null;
  return { file: bestFile, state };
}

/** Path for the last-summary fast-path file. */
function lastSummaryPath(cortexPath: string): string {
  return path.join(sessionsDir(cortexPath), "last-summary.json");
}

/** Write the last summary for fast retrieval by next session_start. */
function writeLastSummary(cortexPath: string, summary: string, sessionId: string, project?: string): void {
  try {
    const data = { summary, sessionId, project, endedAt: new Date().toISOString() };
    fs.writeFileSync(lastSummaryPath(cortexPath), JSON.stringify(data, null, 2));
  } catch { /* best-effort */ }
}

/** Find the most recent session with a summary (including ended sessions). */
export function findMostRecentSummary(cortexPath: string): string | null {
  return findMostRecentSummaryWithProject(cortexPath).summary;
}

/** Find the most recent session with a summary and project context. */
function findMostRecentSummaryWithProject(cortexPath: string): { summary: string | null; project?: string } {
  // Fast path: read from dedicated last-summary file
  try {
    const fastPath = lastSummaryPath(cortexPath);
    if (fs.existsSync(fastPath)) {
      const data = JSON.parse(fs.readFileSync(fastPath, "utf-8")) as { summary?: string; project?: string };
      if (data.summary) return { summary: data.summary, project: data.project };
    }
  } catch { /* fall through to O(n) scan */ }

  // Slow path: scan all session files
  const dir = sessionsDir(cortexPath);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return { summary: null }; }

  let bestSummary: string | null = null;
  let bestProject: string | undefined;
  let bestMtime = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("session-") || !entry.name.endsWith(".json")) continue;
    const fullPath = path.join(dir, entry.name);
    try {
      const state = readSessionStateFile(fullPath);
      if (!state || !state.summary) continue;
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        bestSummary = state.summary;
        bestProject = state.project;
      }
    } catch { /* skip unreadable files */ }
  }

  return { summary: bestSummary, project: bestProject };
}

/** Resolve session file: use provided sessionId, then connectionId lookup, then _currentProcessSessionId, then fall back to most recent active session. */
function resolveSessionFile(cortexPath: string, sessionId?: string, connectionId?: string): { file: string; state: SessionState } | null {
  const effectiveId = sessionId ?? (connectionId ? _sessionMap.get(connectionId) : undefined) ?? _currentProcessSessionId;
  if (effectiveId) {
    const file = sessionFileForId(cortexPath, effectiveId);
    const state = readSessionStateFile(file);
    if (!state) return null;
    // When an explicit sessionId is provided, only return active (not yet ended) sessions.
    // This prevents session_end from being called twice on the same session.
    if (sessionId && state.endedAt) return null;
    return { file, state };
  }
  return findMostRecentSession(cortexPath);
}

/** Remove session files older than 24 hours. */
function cleanupStaleSessions(cortexPath: string): number {
  const dir = sessionsDir(cortexPath);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return 0; }

  const now = Date.now();
  let cleaned = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("session-") || !entry.name.endsWith(".json")) continue;
    const fullPath = path.join(dir, entry.name);
    try {
      // prefer startedAt from the JSON content over mtime (reliable on noatime mounts)
      const state = readSessionStateFile(fullPath);
      const ageMs = state?.startedAt
        ? Date.now() - new Date(state.startedAt).getTime()
        : Date.now() - fs.statSync(fullPath).mtimeMs;
      if (ageMs > STALE_SESSION_MS) {
        tryUnlink(fullPath);
        cleaned++;
      }
    } catch { /* skip */ }
  }
  return cleaned;
}

/** Migrate legacy global session-state.json to per-session file if it exists. */
function migrateLegacySession(cortexPath: string): SessionState | null {
  const legacyFile = path.join(cortexPath, ".runtime", "session-state.json");
  if (!fs.existsSync(legacyFile)) return null;
  try {
    const raw = fs.readFileSync(legacyFile, "utf-8");
    const state = JSON.parse(raw) as SessionState;
    if (state.sessionId) {
      const newFile = sessionFileForId(cortexPath, state.sessionId);
      // Use wx flag so only the first concurrent caller creates the target file
      try {
        const tempFile = `${newFile}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
        fs.renameSync(tempFile, newFile);
      } catch (e: unknown) {
        // If file already exists from another concurrent migration, that's fine
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    tryUnlink(legacyFile);
    return state;
  } catch {
    try { fs.unlinkSync(legacyFile); } catch { /* ignore */ }
    return null;
  }
}

/** Increment the findingsAdded counter for a session. Requires an explicit sessionId; no-ops without one. */
export function incrementSessionFindings(cortexPath: string, count = 1, sessionId?: string): void {
  try {
    if (!sessionId) {
      debugLog("incrementSessionFindings called without explicit sessionId — skipping");
      return;
    }
    const resolved = resolveSessionFile(cortexPath, sessionId);
    if (!resolved) return;
    const { file } = resolved;
    withFileLock(file, () => {
      const current = readSessionStateFile(file);
      if (!current) return;
      writeSessionStateFile(file, { ...current, findingsAdded: current.findingsAdded + count });
    });
  } catch { /* non-fatal */ }
}

export function register(server: McpServer, ctx: McpContext): void {
  const { cortexPath } = ctx;

  server.registerTool("session_start", {
    title: "◆ cortex · session start",
    description: "Mark the start of a new session and retrieve context from prior sessions. Call this at the start of a conversation when not using hooks. Returns prior session summary and recent project findings. The returned sessionId should be passed to session_end and session_context to avoid cross-client collisions.",
    inputSchema: z.object({
      project: z.string().optional().describe("Project to load context for."),
      connectionId: z.string().optional().describe("Optional stable identifier for this client connection. When provided, session_end/session_context can resolve the session without an explicit sessionId."),
    }),
  }, async ({ project, connectionId }) => {
    // Migrate legacy global session file if present
    migrateLegacySession(cortexPath);

    // Clean up stale sessions (>24h)
    cleanupStaleSessions(cortexPath);

    // Find most recent prior session for context
    const priorResult = findMostRecentSession(cortexPath);
    const prior = priorResult?.state ?? null;
    // Also check ended sessions for summaries and project context.
    // findMostRecentSession skips ended sessions, so we need a separate lookup
    // to restore project context after a normal session_end.
    const priorEnded = prior ? null : findMostRecentSummaryWithProject(cortexPath);
    const priorSummary = prior?.summary ?? priorEnded?.summary ?? null;
    const priorProject = prior?.project ?? priorEnded?.project;

    // Create new session with unique ID in its own file
    const sessionId = crypto.randomUUID();
    const next: SessionState = {
      sessionId,
      project: project ?? priorProject,
      startedAt: new Date().toISOString(),
      findingsAdded: 0,
    };
    const newFile = sessionFileForId(cortexPath, sessionId);
    writeSessionStateFile(newFile, next);
    // Store in module-global for single-client compatibility; multi-client callers
    // should use the returned sessionId explicitly on subsequent calls.
    _currentProcessSessionId = sessionId;
    if (connectionId) _sessionMap.set(connectionId, sessionId);

    const parts: string[] = [];

    if (priorSummary) {
      parts.push(`## Last session\n${priorSummary}`);
    }

    const activeProject = project ?? priorProject;
    if (activeProject && isValidProjectName(activeProject)) {
      const findingsPath = resolveFindingsPath(path.join(cortexPath, activeProject));
      if (findingsPath) {
        try {
          const content = fs.readFileSync(findingsPath, "utf-8");
          const bullets = content.split("\n").filter(l => l.startsWith("- ")).slice(-5);
          if (bullets.length > 0) {
            parts.push(`## Recent findings (${activeProject})\n${bullets.join("\n")}`);
          }
        } catch { /* file disappeared between check and read */ }
      }
      const backlogPath = path.join(cortexPath, activeProject, "backlog.md");
      if (fs.existsSync(backlogPath)) {
        const content = fs.readFileSync(backlogPath, "utf-8");
        const queueStart = content.indexOf("## Queue");
        if (queueStart >= 0) {
          const queueItems = content.slice(queueStart).split("\n").filter(l => l.startsWith("- [ ]")).slice(0, 5);
          if (queueItems.length > 0) {
            parts.push(`## Active backlog (${activeProject})\n${queueItems.join("\n")}`);
          }
        }
      }
    }

    const message = parts.length > 0
      ? `Session started (${sessionId.slice(0, 8)}).\n\n${parts.join("\n\n")}`
      : `Session started (${sessionId.slice(0, 8)}). No prior context found.`;

    return mcpResponse({ ok: true, message, data: { sessionId, project: activeProject } });
  });

  server.registerTool("session_end", {
    title: "◆ cortex · session end",
    description: "Mark the end of a session and save a summary for the next session to pick up. Call this before ending a conversation to preserve context. Pass the sessionId returned by session_start to avoid cross-client collisions.",
    inputSchema: z.object({
      summary: z.string().optional().describe("What was accomplished this session. Shown at the start of the next session."),
      sessionId: z.string().optional().describe("Session ID to end (returned by session_start). Preferred over relying on the module-global fallback."),
      connectionId: z.string().optional().describe("Connection ID passed to session_start. Used to resolve the session when sessionId is not provided."),
    }),
  }, async ({ summary, sessionId, connectionId }) => {
    const resolved = resolveSessionFile(cortexPath, sessionId, connectionId);
    if (!resolved) return mcpResponse({ ok: false, error: "No active session. Call session_start first." });

    const { file, state } = resolved;
    const endedState = withFileLock(file, () => {
      const current = readSessionStateFile(file);
      if (!current) return null;
      const next: SessionState = {
        ...current,
        endedAt: new Date().toISOString(),
        summary: summary ?? current.summary,
      };
      writeSessionStateFile(file, next);
      return next;
    });

    if (!endedState) return mcpResponse({ ok: false, error: "No active session. Call session_start first." });

    // Write fast-path summary file for next session_start — also persist project so
    // session_start can restore project context even after a normal session_end.
    const effectiveSummary = endedState.summary;
    if (effectiveSummary) {
      writeLastSummary(cortexPath, effectiveSummary, state.sessionId, endedState.project);
    }

    const durationMs = new Date(endedState.endedAt!).getTime() - new Date(state.startedAt).getTime();
    const durationMins = Math.round(durationMs / 60000);

    return mcpResponse({
      ok: true,
      message: `Session ended. Duration: ~${durationMins} min. ${state.findingsAdded} finding(s) added.${summary ? " Summary saved for next session." : ""}`,
      data: { sessionId: state.sessionId, durationMins, findingsAdded: state.findingsAdded },
    });
  });

  server.registerTool("session_context", {
    title: "◆ cortex · session context",
    description: "Get the current session context -- active project, session duration, findings added, and prior session summary.",
    inputSchema: z.object({
      sessionId: z.string().optional().describe("Session ID to query (returned by session_start). Preferred over relying on the module-global fallback."),
      connectionId: z.string().optional().describe("Connection ID passed to session_start. Used to resolve the session when sessionId is not provided."),
    }),
  }, async ({ sessionId, connectionId }) => {
    const resolved = resolveSessionFile(cortexPath, sessionId, connectionId);
    if (!resolved) return mcpResponse({ ok: true, message: "No active session. Call session_start to begin.", data: null });

    const { state } = resolved;
    const durationMs = Date.now() - new Date(state.startedAt).getTime();
    const durationMins = Math.round(durationMs / 60000);

    const parts = [
      `Session: ${state.sessionId.slice(0, 8)}`,
      `Project: ${state.project ?? "none"}`,
      `Started: ${state.startedAt}`,
      `Duration: ~${durationMins} min`,
      `Findings added: ${state.findingsAdded}`,
    ];
    if (state.summary) parts.push(`Prior summary: ${state.summary}`);

    return mcpResponse({ ok: true, message: parts.join("\n"), data: state });
  });
}
