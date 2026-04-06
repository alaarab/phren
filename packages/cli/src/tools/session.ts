import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse, resolveStoreForProject } from "./types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { debugLog, getProjectDirs, isMemoryScopeVisible, normalizeMemoryScope } from "../shared.js";
import { withFileLock } from "../shared/governance.js";
import { isValidProjectName, errorMessage } from "../utils.js";
import { runCustomHooks } from "../hooks.js";
import { readExtractedFacts } from "./extract-facts.js";
import { resolveFindingSessionId } from "../finding/context.js";
import { readTasks } from "../data/tasks.js";
import { readFindings, FINDINGS_FILENAME } from "../data/access.js";
import { getActiveTaskForSession } from "../task/lifecycle.js";
import { listTaskCheckpoints, writeTaskCheckpoint } from "../session/checkpoints.js";
import {
  findMostRecentSummaryWithProject as findMostRecentSummaryRecord,
  writeLastSummary as writeLastSummaryRecord,
} from "../session/artifacts.js";
import { markImpactEntriesCompletedForSession } from "../finding/impact.js";
import {
  debugError, scanSessionFiles,
  type SessionState, sessionsDir, sessionFileForId,
  readSessionStateFile, writeSessionStateFile,
} from "../session/utils.js";
import { getRuntimeHealth } from "../governance/policy.js";
import { getProjectSourcePath, readProjectConfig } from "../project-config.js";

const STALE_SESSION_MS = 24 * 60 * 60 * 1000; // 24 hours

function collectGitStatusSnapshot(cwd: string): { gitStatus: string; editedFiles: string[] } {
  try {
    const output = execFileSync("git", ["status", "--short"], { cwd, encoding: "utf8" }).trim();
    if (!output) return { gitStatus: "", editedFiles: [] };
    const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
    const editedFiles = lines.map((line) => line.replace(/^[ MADRCU?!]{1,2}\s+/, "").trim()).filter(Boolean);
    return { gitStatus: output, editedFiles };
  } catch (err: unknown) {
    debugLog(`session checkpoint git status failed: ${errorMessage(err)}`);
    return { gitStatus: "", editedFiles: [] };
  }
}

function extractFailingTests(summary?: string, fallbackContext?: string): string[] {
  const text = [summary || "", fallbackContext || ""].join("\n").trim();
  if (!text) return [];
  const tests = new Set<string>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const failLine = trimmed.match(/^FAIL(?:ED)?\s+(.+)$/i);
    if (failLine?.[1]) tests.add(failLine[1].trim());

    const vitestLine = trimmed.match(/^(?:\u00d7|\u2716)\s+(.+)$/);
    if (vitestLine?.[1]) tests.add(vitestLine[1].trim());

    const named = trimmed.match(/(?:failing tests?|failed tests?)\s*:\s*(.+)$/i);
    if (named?.[1]) {
      for (const part of named[1].split(/[;,]/)) {
        const candidate = part.trim();
        if (candidate) tests.add(candidate);
      }
    }

    const junitStyle = trimmed.match(/test(?:\s+case)?\s+["'`](.+?)["'`]\s+failed/i);
    if (junitStyle?.[1]) tests.add(junitStyle[1].trim());
  }

  return [...tests];
}

function extractResumptionHint(
  summary: string | undefined,
  fallbackNextStep: string,
  fallbackLastAttempt: string,
): { lastAttempt: string; nextStep: string } {
  const normalizedSummary = (summary || "").trim();
  if (!normalizedSummary) {
    return {
      lastAttempt: fallbackLastAttempt.trim() || "No prior attempt captured",
      nextStep: fallbackNextStep.trim() || "Resume implementation",
    };
  }

  const lines = normalizedSummary
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const nextPattern = /^(?:next(?:\s+step)?|next up|todo|to do|follow-up|follow up|remaining)\s*[:\-]\s*(.+)$/i;
  let nextStep: string | null = null;
  const lastAttemptLines: string[] = [];

  for (const line of lines) {
    const nextMatch = line.match(nextPattern);
    if (nextMatch?.[1]) {
      if (!nextStep) nextStep = nextMatch[1].trim();
      continue;
    }
    lastAttemptLines.push(line);
  }

  const lastAttempt = (lastAttemptLines.join(" ").trim() || normalizedSummary).trim();
  return {
    lastAttempt: lastAttempt || fallbackLastAttempt.trim() || "No prior attempt captured",
    nextStep: nextStep || fallbackNextStep.trim() || "Resume implementation",
  };
}

/** Per-connection session map keyed by arbitrary connection ID (if provided). */
const MAX_SESSION_MAP_ENTRIES = 200;
const _sessionMap = new Map<string, string>();


/** Find the most recent *active* (not ended) session file by mtime. */
function findMostRecentSession(phrenPath: string): { file: string; state: SessionState } | null {
  const dir = sessionsDir(phrenPath);
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

  const dir = sessionsDir(phrenPath);
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

/** Write the last summary for fast retrieval by next session_start. */
function writeLastSummary(phrenPath: string, summary: string, sessionId: string, project?: string): void {
  writeLastSummaryRecord(phrenPath, { summary, sessionId, project, endedAt: new Date().toISOString() });
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
  const dir = sessionsDir(phrenPath);
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

export function incrementSessionTasksCompleted(phrenPath: string, count = 1, sessionId?: string, project?: string): void {
  incrementSessionCounter(phrenPath, "tasksCompleted", count, sessionId, project);
}

function incrementSessionCounter(
  phrenPath: string,
  field: "findingsAdded" | "tasksCompleted",
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
        findingsAdded: Number.isFinite(current.findingsAdded) ? current.findingsAdded : 0,
        tasksCompleted: Number.isFinite(current.tasksCompleted) ? current.tasksCompleted : 0,
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
  tasksCompleted: number;
  status: "active" | "ended";
}

/** List all sessions (both active and ended) from the sessions directory, sorted newest first. */
export function listAllSessions(phrenPath: string, limit = 50): SessionHistoryEntry[] {
  const dir = sessionsDir(phrenPath);
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
      tasksCompleted: Number.isFinite(state.tasksCompleted) ? state.tasksCompleted : 0,
      status: state.endedAt ? "ended" : "active",
    });
  }

  // Already sorted by mtime, but re-sort by startedAt for accuracy
  entries.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return entries;
}

/** Get findings and tasks that belong to a specific session. */
interface SessionArtifactFinding {
  project: string;
  id: string;
  date: string;
  text: string;
}

interface SessionArtifactTask {
  project: string;
  id: string;
  text: string;
  section: string;
  checked: boolean;
}

export async function getSessionArtifacts(
  phrenPath: string,
  sessionId: string,
  project?: string,
): Promise<{ findings: SessionArtifactFinding[]; tasks: SessionArtifactTask[] }> {
  const findings: SessionArtifactFinding[] = [];
  const tasks: SessionArtifactTask[] = [];
  const shortId = sessionId.slice(0, 8);

  try {
    // Primary store projects
    const projectDirs = getProjectDirs(phrenPath);
    const targetProjects = project ? [project] : projectDirs.map((d) => path.basename(d));
    const seen = new Set<string>();

    const readProjectArtifacts = (storePath: string, proj: string) => {
      if (seen.has(proj)) return;
      seen.add(proj);

      // Findings with matching sessionId
      const findingsResult = readFindings(storePath, proj);
      if (findingsResult.ok) {
        for (const f of findingsResult.data) {
          if (f.sessionId && (f.sessionId === sessionId || f.sessionId.startsWith(shortId))) {
            findings.push({
              project: proj,
              id: f.id,
              date: f.date,
              text: f.text,
            });
          }
        }
      }
      // Tasks with matching sessionId
      const tasksResult = readTasks(storePath, proj);
      if (tasksResult.ok) {
        for (const section of ["Active", "Queue", "Done"] as const) {
          for (const t of tasksResult.data.items[section]) {
            if (t.sessionId && (t.sessionId === sessionId || t.sessionId.startsWith(shortId))) {
              tasks.push({
                project: proj,
                id: t.id,
                text: t.line,
                section,
                checked: t.checked,
              });
            }
          }
        }
      }
    };

    for (const proj of targetProjects) {
      readProjectArtifacts(phrenPath, proj);
    }

    // Team store projects
    try {
      const { getNonPrimaryStores, getStoreProjectDirs } = await import("../store-registry.js");
      for (const store of getNonPrimaryStores(phrenPath)) {
        if (!fs.existsSync(store.path)) continue;
        const storeDirs = getStoreProjectDirs(store).map((d: string) => path.basename(d)).filter((p: string) => p !== "global");
        const storeTargetProjects = project ? (storeDirs.includes(project) ? [project] : []) : storeDirs;
        for (const proj of storeTargetProjects) {
          readProjectArtifacts(store.path, proj);
        }
      }
    } catch { /* store-registry not available */ }
  } catch (err: unknown) {
    debugLog(`getSessionArtifacts error: ${errorMessage(err)}`);
  }

  return { findings, tasks };
}

async function hasCompletedTasksInSession(phrenPath: string, sessionId: string, project?: string): Promise<boolean> {
  const artifacts = await getSessionArtifacts(phrenPath, sessionId, project);
  return artifacts.tasks.some((task) => task.section === "Done" && task.checked);
}

/** Compute what changed since the last session ended. */
function computeSessionDiff(phrenPath: string, project: string, lastSessionEnd: string): {
  newFindings: number;
  superseded: number;
  tasksCompleted: number;
} {
  const projectDir = path.join(phrenPath, project);
  const findingsPath = path.join(projectDir, FINDINGS_FILENAME);
  if (!fs.existsSync(findingsPath)) return { newFindings: 0, superseded: 0, tasksCompleted: 0 };

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

  // Count tasks completed since last session by checking Done items with recent activity dates
  let tasksCompleted = 0;
  const tasksResult = readTasks(phrenPath, project);
  if (tasksResult.ok) {
    for (const item of tasksResult.data.items.Done) {
      // lastActivity is updated on completion; fall back to createdAt
      const itemDate = item.lastActivity?.slice(0, 10) ?? item.createdAt?.slice(0, 10);
      if (itemDate && itemDate >= cutoff) {
        tasksCompleted++;
      }
    }
  }

  return { newFindings, superseded, tasksCompleted };
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
      tasksCompleted: 0,
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
        try { return resolveStoreForProject(ctx, activeProject).phrenPath; } catch { return phrenPath; }
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
      try {
        const tasks = readTasks(projectStorePath, activeProject);
        if (tasks.ok) {
          const activeItems = tasks.data.items.Active
            .filter((entry) => isMemoryScopeVisible(normalizeMemoryScope(entry.scope), activeScope))
            .slice(0, 5)
            .map((entry) => `- [ ] ${entry.line}`);
          if (activeItems.length > 0) {
            parts.push(`## Active task (${activeProject})\n${activeItems.join("\n")}`);
          }
        }
      } catch (err: unknown) {
        debugError("session_start taskRead", err);
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

      try {
          const checkpoints = listTaskCheckpoints(projectStorePath, activeProject).slice(0, 3);
        if (checkpoints.length > 0) {
          const lines: string[] = [];
          for (const checkpoint of checkpoints) {
            lines.push(`- ${(checkpoint.taskText || checkpoint.taskLine).trim()} (task: ${checkpoint.taskId})`);
            lines.push(`  Last attempt: ${checkpoint.resumptionHint.lastAttempt}`);
            lines.push(`  Next step: ${checkpoint.resumptionHint.nextStep}`);
            if (checkpoint.editedFiles.length > 0) {
              lines.push(`  Edited files: ${checkpoint.editedFiles.slice(0, 5).join(", ")}${checkpoint.editedFiles.length > 5 ? ", ..." : ""}`);
            }
            if (checkpoint.failingTests.length > 0) {
              lines.push(`  Failing tests: ${checkpoint.failingTests.slice(0, 3).join(", ")}${checkpoint.failingTests.length > 3 ? ", ..." : ""}`);
            }
          }
          parts.push(`## Continue where you left off? (${activeProject})\n${lines.join("\n")}`);
        }
      } catch (err: unknown) {
        debugError("session_start checkpointsRead", err);
      }
    }

    // Compute context diff since last session
    if (activeProject && isValidProjectName(activeProject) && priorEndedAt) {
      try {
        const diff = computeSessionDiff(phrenPath, activeProject, priorEndedAt);
        if (diff.newFindings > 0 || diff.superseded > 0 || diff.tasksCompleted > 0) {
          const diffParts: string[] = [];
          if (diff.newFindings > 0) diffParts.push(`${diff.newFindings} new finding${diff.newFindings === 1 ? "" : "s"}`);
          if (diff.superseded > 0) diffParts.push(`${diff.superseded} superseded`);
          if (diff.tasksCompleted > 0) diffParts.push(`${diff.tasksCompleted} task${diff.tasksCompleted === 1 ? "" : "s"} in done`);
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
      writeLastSummary(phrenPath, effectiveSummary, state.sessionId, endedState.project);
    }

    if (endedState.project && isValidProjectName(endedState.project)) {
      const projectStorePath = (() => {
        if (!endedState.project) return phrenPath;
        try { return resolveStoreForProject(ctx, endedState.project).phrenPath; } catch { return phrenPath; }
      })();
      try {
        const trackedActiveTask = getActiveTaskForSession(projectStorePath, state.sessionId, endedState.project);
        const activeTask = trackedActiveTask ?? (() => {
          const tasks = readTasks(projectStorePath, endedState.project!);
          if (!tasks.ok) return null;
          return tasks.data.items.Active[0] ?? null;
        })();
        if (activeTask) {
          const taskId = activeTask.stableId || activeTask.id;
          const projectConfig = readProjectConfig(projectStorePath, endedState.project);
          const snapshotRoot =
            getProjectSourcePath(projectStorePath, endedState.project, projectConfig) ||
            path.join(projectStorePath, endedState.project);
          const { gitStatus, editedFiles } = collectGitStatusSnapshot(snapshotRoot);
          const resumptionHint = extractResumptionHint(
            effectiveSummary,
            activeTask.line,
            activeTask.context || "No prior attempt captured",
          );
          writeTaskCheckpoint(phrenPath, {
            project: endedState.project,
            taskId,
            taskText: activeTask.line,
            taskLine: activeTask.line,
            sessionId: state.sessionId,
            createdAt: new Date().toISOString(),
            resumptionHint,
            gitStatus,
            editedFiles,
            failingTests: extractFailingTests(effectiveSummary, activeTask.context),
          });
        }
      } catch (err: unknown) {
        debugLog(`session checkpoint write failed: ${errorMessage(err)}`);
      }
    }

    try {
      const tasksCompleted = Number.isFinite(endedState.tasksCompleted) ? endedState.tasksCompleted : 0;
      if (tasksCompleted > 0 || await hasCompletedTasksInSession(phrenPath, state.sessionId, endedState.project)) {
        markImpactEntriesCompletedForSession(phrenPath, state.sessionId, endedState.project);
      }
    } catch (err: unknown) {
      debugLog(`impact scoring update failed: ${errorMessage(err)}`);
    }

    const durationMs = new Date(endedState.endedAt!).getTime() - new Date(state.startedAt).getTime();
    const durationMins = Math.round(durationMs / 60000);

    runCustomHooks(phrenPath, "post-session-end", {
      PHREN_SESSION_ID: state.sessionId,
      PHREN_DURATION_MINS: String(durationMins),
      PHREN_FINDINGS_ADDED: String(endedState.findingsAdded),
      PHREN_TASKS_COMPLETED: String(Number.isFinite(endedState.tasksCompleted) ? endedState.tasksCompleted : 0),
      ...(endedState.project ? { PHREN_PROJECT: endedState.project } : {}),
    });

    return mcpResponse({
      ok: true,
      message: `Session ended. Duration: ~${durationMins} min. ${endedState.findingsAdded} finding(s) added, ${Number.isFinite(endedState.tasksCompleted) ? endedState.tasksCompleted : 0} task(s) completed.${summary ? " Summary saved for next session." : ""}`,
      data: {
        sessionId: state.sessionId,
        durationMins,
        findingsAdded: endedState.findingsAdded,
        tasksCompleted: Number.isFinite(endedState.tasksCompleted) ? endedState.tasksCompleted : 0,
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
      `Tasks completed: ${Number.isFinite(state.tasksCompleted) ? state.tasksCompleted : 0}`,
    ];
    if (state.summary) parts.push(`Prior summary: ${state.summary}`);

    return mcpResponse({ ok: true, message: parts.join("\n"), data: state });
  });

  server.registerTool("session_history", {
    title: "◆ phren · session history",
    description: "List past sessions with their duration, findings count, and summary. Optionally drill into a specific session to see all findings and tasks created during it.",
    inputSchema: z.object({
      limit: z.number().optional().describe("Max sessions to return (default 20)."),
      sessionId: z.string().optional().describe("If provided, return full artifacts (findings + tasks) for this session instead of listing all sessions."),
      project: z.string().optional().describe("Filter sessions and artifacts by project."),
    }),
  }, async ({ limit, sessionId: targetSessionId, project }) => {
    if (targetSessionId) {
      // Drill into a specific session
      const sessions = listAllSessions(phrenPath, 200);
      const session = sessions.find(s => s.sessionId === targetSessionId || s.sessionId.startsWith(targetSessionId));
      if (!session) return mcpResponse({ ok: false, error: `Session ${targetSessionId} not found.` });

      const artifacts = await getSessionArtifacts(phrenPath, session.sessionId, project);
      const parts = [
        `Session: ${session.sessionId.slice(0, 8)}`,
        `Project: ${session.project ?? "none"}`,
        `Started: ${session.startedAt}`,
        `Status: ${session.status}`,
        `Duration: ~${session.durationMins ?? 0} min`,
        `Findings: ${artifacts.findings.length}`,
        `Tasks: ${artifacts.tasks.length}`,
      ];
      if (session.summary) parts.push(`\nSummary: ${session.summary}`);
      if (artifacts.findings.length > 0) {
        parts.push("\n## Findings");
        for (const f of artifacts.findings) {
          parts.push(`- [${f.project}] ${f.text}`);
        }
      }
      if (artifacts.tasks.length > 0) {
        parts.push("\n## Tasks");
        for (const t of artifacts.tasks) {
          parts.push(`- [${t.project}/${t.section}] ${t.text}`);
        }
      }
      return mcpResponse({ ok: true, message: parts.join("\n"), data: { session, ...artifacts } });
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
      const tasks = s.tasksCompleted > 0 ? ` ${s.tasksCompleted}t` : "";
      const date = s.startedAt.slice(0, 16).replace("T", " ");
      return `${id}${status}  ${date}  ${dur}${findings}${tasks}  ${proj}${s.summary ? "  " + s.summary.slice(0, 60) : ""}`;
    });

    return mcpResponse({
      ok: true,
      message: `${filtered.length} session(s):\n\n${lines.join("\n")}`,
      data: filtered,
    });
  });
}
