import { listAllProjects } from "../store-routing.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse, resolveStoreForProject } from "./types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { debugLog, isMemoryScopeVisible, normalizeMemoryScope } from "../shared.js";
import { withFileLock } from "../shared/governance.js";
import { isValidProjectName, } from "../utils.js";
import { runCustomHooks } from "../hooks.js";
import { readExtractedFacts } from "./extract-facts.js";
import { resolveFindingSessionId } from "../finding/context.js";
import { readFindings, FINDINGS_FILENAME } from "../data/access.js";
import {
  findMostRecentSummaryWithProject as findMostRecentSummaryRecord,
  writeLastSummary,
} from "../session/artifacts.js";
import {
  debugError, scanSessionFiles,
  type SessionState, runtimeSessionsDir, isSessionId, sessionFileForId,
  readSessionStateFile, writeSessionStateFile,
} from "../session/utils.js";
import { getRuntimeHealth } from "../governance/policy.js";

const STALE_SESSION_MS = 24 * 60 * 60 * 1000; // 24 hours

const MAX_SESSION_MAP_ENTRIES = 200;
const _sessionMap = new Map<string, string>();

function findMostRecentSession(phrenPath: string): { file: string; state: SessionState } | null {
  const dir = runtimeSessionsDir(phrenPath);
  const results = scanSessionFiles<SessionState>(
    dir,
    readSessionStateFile,
    (state) => !state.endedAt,
    { errorScope: "findMostRecentSession" },
  );

  if (results.length === 0) return null;
  const best = results[0]; // already sorted newest-mtime-first
  return { file: best.fullPath, state: best.data };
}

export function resolveActiveSessionScope(phrenPath: string, project?: string): string | undefined {
  // PHREN_SCOPE env var takes priority over session-derived scope
  const envScope = normalizeMemoryScope(process.env.PHREN_SCOPE);
  if (envScope) return envScope;

  const dir = runtimeSessionsDir(phrenPath);
  const results = scanSessionFiles<SessionState>(
    dir,
    readSessionStateFile,
    (state) => {
      if (state.endedAt) return false;
      if (project && state.project && state.project !== project) return false;
      return true;
    },
    { includeMtime: false, errorScope: "resolveActiveSessionScope" },
  );

  let bestState: SessionState | null = null;
  let bestStartedAt = 0;
  for (const { data: state } of results) {
    const startedAt = Date.parse(state.startedAt || "");
    const candidate = Number.isNaN(startedAt) ? 0 : startedAt;
    if (!bestState || candidate >= bestStartedAt) {
      bestState = state;
      bestStartedAt = candidate;
    }
  }
  return normalizeMemoryScope(bestState?.agentScope);
}

/** Find the most recent session with a summary (including ended sessions).
 * @internal Exported for tests. */
export function findMostRecentSummary(phrenPath: string): string | null {
  return findMostRecentSummaryWithProject(phrenPath).summary;
}

/** Find the most recent session with a summary and project context. */
function findMostRecentSummaryWithProject(phrenPath: string): { summary: string | null; project?: string; endedAt?: string } {
  const result = findMostRecentSummaryRecord(phrenPath);
  return {
    summary: result.summary,
    project: result.project,
    endedAt: result.endedAt,
  };
}

/** Resolve session file from an explicit sessionId or a previously-bound connectionId. */
function resolveSessionFile(phrenPath: string, sessionId?: string, connectionId?: string): { file: string; state: SessionState } | null {
  const effectiveId = sessionId ?? (connectionId ? _sessionMap.get(connectionId) : undefined);
  if (effectiveId) {
    // An id that is not one of ours names no session.
    if (!isSessionId(effectiveId)) return null;
    const file = sessionFileForId(phrenPath, effectiveId);
    const state = readSessionStateFile(file);
    if (!state) return null;
    // Always reject ended sessions — prevents double session_end and stale session_context.
    if (state.endedAt) return null;
    return { file, state };
  }
  return null;
}

/** Remove session files older than 24 hours. */
function cleanupStaleSessions(phrenPath: string): number {
  const dir = runtimeSessionsDir(phrenPath);
  // Scan all session files (keep all, we'll filter and unlink manually)
  const results = scanSessionFiles<SessionState | null>(
    dir,
    (filePath) => readSessionStateFile(filePath) ?? null,
    () => true, // accept everything — we decide inside the loop
    { includeMtime: false, errorScope: "cleanupStaleSessions" },
  );

  let cleaned = 0;
  for (const { fullPath, data: state } of results) {
    try {
      // Only clean up sessions that have ended (have endedAt). Active sessions
      // (no endedAt) should never be removed regardless of age.
      if (state && !state.endedAt) continue;

      // For ended sessions, age out by end time rather than start time so
      // long-running sessions do not disappear immediately after they finish.
      const expirationAnchor = state?.endedAt || state?.startedAt;
      const ageMs = expirationAnchor
        ? Date.now() - new Date(expirationAnchor).getTime()
        : Date.now() - fs.statSync(fullPath).mtimeMs;
      if (ageMs > STALE_SESSION_MS) {
        fs.unlinkSync(fullPath);
        cleaned++;
      }
    } catch (err: unknown) {
      debugError("cleanupStaleSessions entry", err);
    }
  }
  return cleaned;
}

/** Increment the findingsAdded counter for a session. Falls back to the most relevant active session for the project. */
export function incrementSessionFindings(phrenPath: string, count = 1, sessionId?: string, project?: string): void {
  incrementSessionCounter(phrenPath, "findingsAdded", count, sessionId, project);
}

function incrementSessionCounter(
  phrenPath: string,
  field: "findingsAdded",
  count = 1,
  sessionId?: string,
  project?: string,
): void {
  try {
    const effectiveSessionId = project
      ? resolveFindingSessionId(phrenPath, project, sessionId)
      : sessionId;
    if (!effectiveSessionId) {
      debugLog(`${field} increment called without a resolvable sessionId — skipping`);
      return;
    }
    const resolved = resolveSessionFile(phrenPath, effectiveSessionId);
    if (!resolved) return;
    const { file } = resolved;
    withFileLock(file, () => {
      const current = readSessionStateFile(file);
      if (!current) return;
      const nextValue = Number.isFinite(current[field]) ? current[field] + count : count;
      writeSessionStateFile(file, {
        ...current,
        [field]: nextValue,
      });
    });
  } catch (err: unknown) {
    debugError(`incrementSessionCounter(${field})`, err);
  }
}

/** Summary of a session for history listing. */
interface SessionHistoryEntry {
  sessionId: string;
  project?: string;
  agentScope?: string;
  startedAt: string;
  endedAt?: string;
  durationMins?: number;
  summary?: string;
  findingsAdded: number;
  status: "active" | "ended";
}

/** List all sessions (both active and ended) from the sessions directory, sorted newest first. */
export function listAllSessions(phrenPath: string, limit = 50): SessionHistoryEntry[] {
  const dir = runtimeSessionsDir(phrenPath);
  // scanSessionFiles returns results sorted by mtime (newest first)
  const results = scanSessionFiles<SessionState>(
    dir,
    readSessionStateFile,
    () => true,
    { errorScope: "listAllSessions" },
  );

  const entries: SessionHistoryEntry[] = [];
  for (const { data: state } of results) {
    if (entries.length >= limit) break;
    const durationMs = state.endedAt
      ? new Date(state.endedAt).getTime() - new Date(state.startedAt).getTime()
      : Date.now() - new Date(state.startedAt).getTime();
    entries.push({
      sessionId: state.sessionId,
      project: state.project,
      agentScope: state.agentScope,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      durationMins: Math.round(durationMs / 60000),
      summary: state.summary,
      findingsAdded: Number.isFinite(state.findingsAdded) ? state.findingsAdded : 0,
      status: state.endedAt ? "ended" : "active",
    });
  }

  // Already sorted by mtime, but re-sort by startedAt for accuracy
  entries.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return entries;
}

export function getSessionFindings(phrenPath: string, sessionId: string, project?: string) {
  return listAllProjects(phrenPath).flatMap(({ store, projectName }) => {
    if (project && projectName !== project) return [];
    const result = readFindings(store.path, projectName, { includeArchived: true });
    if (!result.ok) return [];
    return result.data.filter(finding => finding.sessionId === sessionId)
      .map(finding => ({ project: projectName, id: finding.stableId ?? finding.id, date: finding.date, text: finding.text }));
  });
}

/** Compute what changed since the last session ended. */
function computeSessionDiff(phrenPath: string, project: string, lastSessionEnd: string): {
  newFindings: number;
  superseded: number;
} {
  const projectDir = path.join(phrenPath, project);
  const findingsPath = path.join(projectDir, FINDINGS_FILENAME);
  if (!fs.existsSync(findingsPath)) return { newFindings: 0, superseded: 0 };

  const content = fs.readFileSync(findingsPath, "utf8");
  const lines = content.split("\n");
  let currentDate: string | null = null;
  let newFindings = 0;
  let superseded = 0;
  const cutoff = lastSessionEnd.slice(0, 10);

  for (const line of lines) {
    const dateMatch = line.match(/^## (\d{4}-\d{2}-\d{2})$/);
    if (dateMatch) { currentDate = dateMatch[1]; continue; }
    if (!line.startsWith("- ") || !currentDate) continue;
    if (currentDate >= cutoff) {
      newFindings++;
      if (line.includes('status "superseded"')) superseded++;
    }
  }

  return { newFindings, superseded };
}

export function register(server: McpServer, ctx: McpContext): void {
  const { phrenPath } = ctx;

  server.registerTool("session_start", {
    title: "◆ phren · session start",
    description: "Mark the start of a new session and retrieve context from prior sessions. Call this at the start of a conversation when not using hooks. Returns prior session summary and recent project findings. The returned sessionId should be passed to session_end and session_context to avoid cross-client collisions.",
    inputSchema: z.object({
      project: z.string().optional().describe("Project to load context for."),
      agentScope: z.string().optional().describe("Optional memory scope for this agent session (for example 'researcher' or 'builder')."),
      connectionId: z.string().optional().describe("Optional stable identifier for this client connection. When provided, session_end/session_context can resolve the session without an explicit sessionId."),
    }),
  }, async ({ project, agentScope, connectionId }) => {
    // Clean up stale sessions (>24h)
    cleanupStaleSessions(phrenPath);

    const normalizedAgentScope = agentScope === undefined ? undefined : normalizeMemoryScope(agentScope);
    if (agentScope !== undefined && !normalizedAgentScope) {
      return mcpResponse({ ok: false, error: `Invalid agentScope: "${agentScope}". Use lowercase letters/numbers with '-' or '_' (max 64 chars).` });
    }

    // Find most recent prior session for context.
    // When no explicit project is provided, prefer the last ENDED session's
    // project (completed context) over an active session from a different client.
    const priorEnded = findMostRecentSummaryWithProject(phrenPath);
    const priorResult = findMostRecentSession(phrenPath);
    const prior = priorResult?.state ?? null;
    const priorSummary = priorEnded?.summary ?? prior?.summary ?? null;
    const priorProject = priorEnded?.project ?? prior?.project;
    const priorEndedAt = priorEnded?.endedAt ?? prior?.endedAt;

    // Create new session with unique ID in its own file
    const sessionId = crypto.randomUUID();
    const next: SessionState = {
      sessionId,
      project: project ?? priorProject,
      agentScope: normalizedAgentScope,
      startedAt: new Date().toISOString(),
      findingsAdded: 0,
    };
    const newFile = sessionFileForId(phrenPath, sessionId);
    writeSessionStateFile(newFile, next);
    if (connectionId) {
      _sessionMap.set(connectionId, sessionId);
      if (_sessionMap.size > MAX_SESSION_MAP_ENTRIES) {
        const oldest = _sessionMap.keys().next().value;
        if (oldest !== undefined) _sessionMap.delete(oldest);
      }
    }

    const parts: string[] = [];

    if (priorSummary) {
      parts.push(`## Last session\n${priorSummary}`);
    }

    const activeProject = project ?? priorProject;
    const activeScope = normalizedAgentScope;
    if (activeProject && isValidProjectName(activeProject)) {
      const projectStorePath = (() => {
        try { return resolveStoreForProject(ctx, activeProject, "read").phrenPath; } catch { return phrenPath; }
      })();
      try {
        const findings = readFindings(projectStorePath, activeProject);
        if (findings.ok) {
          const bullets = findings.data
            .filter((entry) => isMemoryScopeVisible(normalizeMemoryScope(entry.scope), activeScope))
            .slice(-5)
            .map((entry) => `- ${entry.text}`);
          if (bullets.length > 0) {
            parts.push(`## Recent findings (${activeProject})\n${bullets.join("\n")}`);
          }
        }
      } catch (err: unknown) {
        debugError("session_start findingsRead", err);
      }
      // Surface extracted preferences/facts for this project
      try {
        const facts = readExtractedFacts(projectStorePath, activeProject).slice(-10);
        if (facts.length > 0) {
          parts.push(`## Preferences (${activeProject})\n${facts.map(f => `- ${f.fact}`).join("\n")}`);
        }
      } catch (err: unknown) {
        debugError("session_start factsRead", err);
      }

    }

    // Compute context diff since last session
    if (activeProject && isValidProjectName(activeProject) && priorEndedAt) {
      try {
        const diff = computeSessionDiff(phrenPath, activeProject, priorEndedAt);
        if (diff.newFindings > 0 || diff.superseded > 0) {
          const diffParts: string[] = [];
          if (diff.newFindings > 0) diffParts.push(`${diff.newFindings} new finding${diff.newFindings === 1 ? "" : "s"}`);
          if (diff.superseded > 0) diffParts.push(`${diff.superseded} superseded`);
          parts.push(`## Since last session\n${diffParts.join(", ")}.`);
        }
      } catch (err: unknown) {
        debugError("session_start contextDiff", err);
      }
    }

    // ── Surface sync/health warnings ────────────────────────────────────
    const sessionWarnings: string[] = [];
    try {
      const health = getRuntimeHealth(phrenPath);
      if (health.lastAutoSave?.status === "error") {
        sessionWarnings.push(`Last auto-save failed: ${health.lastAutoSave.detail ?? "unknown"}`);
      }
      if (health.lastSync?.lastPushStatus === "error") {
        sessionWarnings.push(`Last push failed: ${health.lastSync.lastPushDetail ?? "unknown"}`);
      }
      const unsynced = health.lastSync?.unsyncedCommits;
      if (typeof unsynced === "number" && unsynced > 0) {
        sessionWarnings.push(`${unsynced} unsynced commit${unsynced === 1 ? "" : "s"} — run 'phren doctor' or check git remote`);
      }
    } catch (err: unknown) {
      debugError("session_start runtimeHealth", err);
    }
    if (sessionWarnings.length > 0) {
      parts.push(`## Sync warnings\n${sessionWarnings.map(w => `- ${w}`).join("\n")}`);
    }

    const message = parts.length > 0
      ? `Session started (${sessionId.slice(0, 8)}).\n\n${parts.join("\n\n")}`
      : `Session started (${sessionId.slice(0, 8)}). No prior context found.`;

    return mcpResponse({ ok: true, message, data: { sessionId, project: activeProject, agentScope: activeScope, warnings: sessionWarnings.length > 0 ? sessionWarnings : undefined } });
  });

  server.registerTool("session_end", {
    title: "◆ phren · session end",
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
    const resolved = resolveSessionFile(phrenPath, sessionId, connectionId);
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
      writeLastSummary(phrenPath, { summary: effectiveSummary, sessionId: state.sessionId, project: endedState.project });
    }

    const durationMs = new Date(endedState.endedAt!).getTime() - new Date(state.startedAt).getTime();
    const durationMins = Math.round(durationMs / 60000);

    runCustomHooks(phrenPath, "post-session-end", {
      PHREN_SESSION_ID: state.sessionId,
      PHREN_DURATION_MINS: String(durationMins),
      PHREN_FINDINGS_ADDED: String(endedState.findingsAdded),
      ...(endedState.project ? { PHREN_PROJECT: endedState.project } : {}),
    });

    return mcpResponse({
      ok: true,
      message: `Session ended. Duration: ~${durationMins} min. ${endedState.findingsAdded} finding(s) added.${summary ? " Summary saved for next session." : ""}`,
      data: {
        sessionId: state.sessionId,
        durationMins,
        findingsAdded: endedState.findingsAdded,
      },
    });
  });

  server.registerTool("session_context", {
    title: "◆ phren · session context",
    description: "Get the current session context -- active project, session duration, findings added, and prior session summary. Pass the sessionId returned by session_start, or a stable connectionId bound at session_start.",
    inputSchema: z.object({
      sessionId: z.string().optional().describe("Session ID to query (returned by session_start)."),
      connectionId: z.string().optional().describe("Connection ID passed to session_start. Used to resolve the session when sessionId is not provided."),
    }),
  }, async ({ sessionId, connectionId }) => {
    if (!sessionId && !connectionId) {
      return mcpResponse({ ok: false, error: "Pass sessionId or connectionId. Implicit process-global session fallback has been removed." });
    }
    const resolved = resolveSessionFile(phrenPath, sessionId, connectionId);
    if (!resolved) return mcpResponse({ ok: false, error: "No active session. Call session_start first.", data: null });

    const { state } = resolved;
    const durationMs = Date.now() - new Date(state.startedAt).getTime();
    const durationMins = Math.round(durationMs / 60000);

    const parts = [
      `Session: ${state.sessionId.slice(0, 8)}`,
      `Project: ${state.project ?? "none"}`,
      `Agent scope: ${state.agentScope ?? "none"}`,
      `Started: ${state.startedAt}`,
      `Duration: ~${durationMins} min`,
      `Findings added: ${state.findingsAdded}`,
    ];
    if (state.summary) parts.push(`Prior summary: ${state.summary}`);

    return mcpResponse({ ok: true, message: parts.join("\n"), data: state });
  });

  server.registerTool("session_history", {
    title: "◆ phren · session history",
    description: "List past sessions with their duration, findings count, and summary. Optionally drill into a specific session to see all artifacts created during it.",
    inputSchema: z.object({
      limit: z.number().optional().describe("Max sessions to return (default 20)."),
      sessionId: z.string().optional().describe("If provided, return full session artifacts for this session instead of listing all sessions."),
      project: z.string().optional().describe("Filter sessions and artifacts by project."),
    }),
  }, async ({ limit, sessionId: targetSessionId, project }) => {
    if (targetSessionId) {
      // Drill into a specific session
      const sessions = listAllSessions(phrenPath, 200);
      const session = sessions.find(s => s.sessionId === targetSessionId || s.sessionId.startsWith(targetSessionId));
      if (!session) return mcpResponse({ ok: false, error: `Session ${targetSessionId} not found.` });

      const findings = getSessionFindings(phrenPath, session.sessionId, project);
      const parts = [
        `Session: ${session.sessionId.slice(0, 8)}`,
        `Project: ${session.project ?? "none"}`,
        `Started: ${session.startedAt}`,
        `Status: ${session.status}`,
        `Duration: ~${session.durationMins ?? 0} min`,
      ];
      if (session.summary) parts.push(`\nSummary: ${session.summary}`);
      return mcpResponse({ ok: true, message: parts.join("\n"), data: { session, findings } });
    }

    // List sessions
    const sessions = listAllSessions(phrenPath, limit ?? 20);
    const filtered = project ? sessions.filter(s => s.project === project) : sessions;
    if (filtered.length === 0) return mcpResponse({ ok: true, message: "No sessions found.", data: [] });

    const lines = filtered.map(s => {
      const id = s.sessionId.slice(0, 8);
      const proj = s.project ?? "—";
      const dur = s.durationMins != null ? `${s.durationMins}m` : "?";
      const status = s.status === "active" ? " ●" : "";
      const findings = s.findingsAdded > 0 ? ` ${s.findingsAdded}f` : "";
      const date = s.startedAt.slice(0, 16).replace("T", " ");
      return `${id}${status}  ${date}  ${dur}${findings}  ${proj}${s.summary ? "  " + s.summary.slice(0, 60) : ""}`;
    });

    return mcpResponse({
      ok: true,
      message: `${filtered.length} session(s):\n\n${lines.join("\n")}`,
      data: filtered,
    });
  });
}
