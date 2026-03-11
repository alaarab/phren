import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { resolveFindingsPath, debugLog } from "./shared.js";
import { withFileLock } from "./shared-governance.js";
import { isValidProjectName } from "./utils.js";
import { runCustomHooks } from "./hooks.js";
import { readExtractedFacts } from "./mcp-extract-facts.js";
import { resolveFindingSessionId } from "./finding-context.js";
import { resolveTaskFilePath } from "./data-tasks.js";

interface SessionState {
  sessionId: string;
  project?: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  findingsAdded: number;
}

const STALE_SESSION_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Per-connection session map keyed by arbitrary connection ID (if provided). */
const _sessionMap = new Map<string, string>();

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
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] readSessionStateFile: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
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
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] findMostRecentSession readdir: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }

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
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] findMostRecentSession statFile: ${err instanceof Error ? err.message : String(err)}\n`);
    }
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
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] writeLastSummary: ${err instanceof Error ? err.message : String(err)}\n`);
  }
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
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] findMostRecentSummaryWithProject fastPath: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // Slow path: scan all session files
  const dir = sessionsDir(cortexPath);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] findMostRecentSummaryWithProject readdir: ${err instanceof Error ? err.message : String(err)}\n`);
    return { summary: null };
  }

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
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] findMostRecentSummaryWithProject statFile: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  return { summary: bestSummary, project: bestProject };
}

/** Resolve session file from an explicit sessionId or a previously-bound connectionId. */
function resolveSessionFile(cortexPath: string, sessionId?: string, connectionId?: string): { file: string; state: SessionState } | null {
  const effectiveId = sessionId ?? (connectionId ? _sessionMap.get(connectionId) : undefined);
  if (effectiveId) {
    const file = sessionFileForId(cortexPath, effectiveId);
    const state = readSessionStateFile(file);
    if (!state) return null;
    // Always reject ended sessions — prevents double session_end and stale session_context.
    if (state.endedAt) return null;
    return { file, state };
  }
  return null;
}

/** Remove session files older than 24 hours. */
function cleanupStaleSessions(cortexPath: string): number {
  const dir = sessionsDir(cortexPath);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] cleanupStaleSessions readdir: ${err instanceof Error ? err.message : String(err)}\n`);
    return 0;
  }

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
        fs.unlinkSync(fullPath);
        cleaned++;
      }
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] cleanupStaleSessions statFile: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return cleaned;
}

/** Increment the findingsAdded counter for a session. Falls back to the most relevant active session for the project. */
export function incrementSessionFindings(cortexPath: string, count = 1, sessionId?: string, project?: string): void {
  try {
    const effectiveSessionId = project
      ? resolveFindingSessionId(cortexPath, project, sessionId)
      : sessionId;
    if (!effectiveSessionId) {
      debugLog("incrementSessionFindings called without a resolvable sessionId — skipping");
      return;
    }
    const resolved = resolveSessionFile(cortexPath, effectiveSessionId);
    if (!resolved) return;
    const { file } = resolved;
    withFileLock(file, () => {
      const current = readSessionStateFile(file);
      if (!current) return;
      writeSessionStateFile(file, { ...current, findingsAdded: current.findingsAdded + count });
    });
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] incrementSessionFindings: ${err instanceof Error ? err.message : String(err)}\n`);
  }
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
        } catch (err: unknown) {
          if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] session_start findingsRead: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      const taskPath = resolveTaskFilePath(cortexPath, activeProject);
      if (taskPath) {
        try {
          const content = fs.readFileSync(taskPath, "utf-8");
          const queueStart = content.indexOf("## Queue");
          if (queueStart >= 0) {
            const queueItems = content.slice(queueStart).split("\n").filter(l => l.startsWith("- [ ]")).slice(0, 5);
            if (queueItems.length > 0) {
              parts.push(`## Active task (${activeProject})\n${queueItems.join("\n")}`);
            }
          }
        } catch (err: unknown) {
          if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] session_start taskRead: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      // Surface extracted preferences/facts for this project
      try {
        const facts = readExtractedFacts(cortexPath, activeProject).slice(-10);
        if (facts.length > 0) {
          parts.push(`## Preferences (${activeProject})\n${facts.map(f => `- ${f.fact}`).join("\n")}`);
        }
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] session_start factsRead: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    const message = parts.length > 0
      ? `Session started (${sessionId.slice(0, 8)}).\n\n${parts.join("\n\n")}`
      : `Session started (${sessionId.slice(0, 8)}). No prior context found.`;

    return mcpResponse({ ok: true, message, data: { sessionId, project: activeProject } });
  });

  server.registerTool("session_end", {
    title: "◆ cortex · session end",
    description: "Mark the end of a session and save a summary for the next session to pick up. Call this before ending a conversation to preserve context. Pass the sessionId returned by session_start, or a stable connectionId bound at session_start.",
    inputSchema: z.object({
      summary: z.string().optional().describe("What was accomplished this session. Shown at the start of the next session."),
      sessionId: z.string().optional().describe("Session ID to end (returned by session_start)."),
      connectionId: z.string().optional().describe("Connection ID passed to session_start. Used to resolve the session when sessionId is not provided."),
    }),
  }, async ({ summary, sessionId, connectionId }) => {
    if (!sessionId && !connectionId) {
      return mcpResponse({ ok: false, error: "Pass sessionId or connectionId. Implicit process-global session fallback has been removed." });
    }
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

    if (connectionId) {
      _sessionMap.delete(connectionId);
    }
    // Also remove from _sessionMap by value (in case connectionId wasn't provided but was used at start)
    for (const [key, val] of _sessionMap) {
      if (val === state.sessionId) _sessionMap.delete(key);
    }

    // Write fast-path summary file for next session_start — also persist project so
    // session_start can restore project context even after a normal session_end.
    const effectiveSummary = endedState.summary;
    if (effectiveSummary) {
      writeLastSummary(cortexPath, effectiveSummary, state.sessionId, endedState.project);
    }

    const durationMs = new Date(endedState.endedAt!).getTime() - new Date(state.startedAt).getTime();
    const durationMins = Math.round(durationMs / 60000);

    runCustomHooks(cortexPath, "post-session-end", {
      CORTEX_SESSION_ID: state.sessionId,
      CORTEX_DURATION_MINS: String(durationMins),
      CORTEX_FINDINGS_ADDED: String(state.findingsAdded),
      ...(endedState.project ? { CORTEX_PROJECT: endedState.project } : {}),
    });

    return mcpResponse({
      ok: true,
      message: `Session ended. Duration: ~${durationMins} min. ${state.findingsAdded} finding(s) added.${summary ? " Summary saved for next session." : ""}`,
      data: { sessionId: state.sessionId, durationMins, findingsAdded: state.findingsAdded },
    });
  });

  server.registerTool("session_context", {
    title: "◆ cortex · session context",
    description: "Get the current session context -- active project, session duration, findings added, and prior session summary. Pass the sessionId returned by session_start, or a stable connectionId bound at session_start.",
    inputSchema: z.object({
      sessionId: z.string().optional().describe("Session ID to query (returned by session_start)."),
      connectionId: z.string().optional().describe("Connection ID passed to session_start. Used to resolve the session when sessionId is not provided."),
    }),
  }, async ({ sessionId, connectionId }) => {
    if (!sessionId && !connectionId) {
      return mcpResponse({ ok: false, error: "Pass sessionId or connectionId. Implicit process-global session fallback has been removed." });
    }
    const resolved = resolveSessionFile(cortexPath, sessionId, connectionId);
    if (!resolved) return mcpResponse({ ok: false, error: "No active session. Call session_start first.", data: null });

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
