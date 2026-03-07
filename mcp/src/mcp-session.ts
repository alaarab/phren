import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { runtimeFile } from "./shared.js";
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



function sessionStateFile(cortexPath: string): string {
  return runtimeFile(cortexPath, "session-state.json");
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

function withSessionStateLock<T>(cortexPath: string, fn: (file: string) => T): T {
  const file = sessionStateFile(cortexPath);
  return withFileLock(file, () => fn(file));
}

function updateSessionState(cortexPath: string, updater: (state: SessionState | null) => SessionState | null): SessionState | null {
  return withSessionStateLock(cortexPath, (file) => {
    const next = updater(readSessionStateFile(file));
    if (next) writeSessionStateFile(file, next);
    return next;
  });
}

function readSessionStateLocked(cortexPath: string): SessionState | null {
  return withSessionStateLock(cortexPath, (file) => readSessionStateFile(file));
}

/** Increment the findingsAdded counter for the current session. Call from add_finding handlers. */
export function incrementSessionFindings(cortexPath: string, count = 1): void {
  try {
    updateSessionState(cortexPath, (state) => {
      if (!state) return null;
      return { ...state, findingsAdded: state.findingsAdded + count };
    });
  } catch { /* non-fatal */ }
}

export function register(server: McpServer, ctx: McpContext): void {
  const { cortexPath } = ctx;

  server.registerTool("session_start", {
    title: "◆ cortex · session start",
    description: "Mark the start of a new session and retrieve context from prior sessions. Call this at the start of a conversation when not using hooks. Returns prior session summary and recent project findings.",
    inputSchema: z.object({
      project: z.string().optional().describe("Project to load context for."),
    }),
  }, async ({ project }) => {
    const started = withSessionStateLock(cortexPath, (file) => {
      const prior = readSessionStateFile(file);
      const next: SessionState = {
        sessionId: crypto.randomUUID(),
        project: project ?? prior?.project,
        startedAt: new Date().toISOString(),
        findingsAdded: 0,
      };
      writeSessionStateFile(file, next);
      return { prior, next };
    });
    const prior = started.prior;
    const startedSession = started.next;

    const parts: string[] = [];

    if (prior?.summary) {
      parts.push(`## Last session\n${prior.summary}`);
    }

    const activeProject = project ?? prior?.project;
    if (activeProject && isValidProjectName(activeProject)) {
      const findingsPath = path.join(cortexPath, activeProject, "FINDINGS.md");
      if (fs.existsSync(findingsPath)) {
        const content = fs.readFileSync(findingsPath, "utf-8");
        const bullets = content.split("\n").filter(l => l.startsWith("- ")).slice(-5);
        if (bullets.length > 0) {
          parts.push(`## Recent findings (${activeProject})\n${bullets.join("\n")}`);
        }
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
      ? `Session started (${startedSession.sessionId.slice(0, 8)}).\n\n${parts.join("\n\n")}`
      : `Session started (${startedSession.sessionId.slice(0, 8)}). No prior context found.`;

    return mcpResponse({ ok: true, message, data: { sessionId: startedSession.sessionId, project: activeProject } });
  });

  server.registerTool("session_end", {
    title: "◆ cortex · session end",
    description: "Mark the end of a session and save a summary for the next session to pick up. Call this before ending a conversation to preserve context.",
    inputSchema: z.object({
      summary: z.string().optional().describe("What was accomplished this session. Shown at the start of the next session."),
    }),
  }, async ({ summary }) => {
    const ended = withSessionStateLock(cortexPath, (file) => {
      const state = readSessionStateFile(file);
      if (!state) return null;
      const next: SessionState = {
        ...state,
        endedAt: new Date().toISOString(),
        summary: summary ?? state.summary,
      };
      writeSessionStateFile(file, next);
      return { state, next };
    });
    if (!ended) return mcpResponse({ ok: false, error: "No active session. Call session_start first." });
    const { state, next: endedState } = ended;

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
    inputSchema: z.object({}),
  }, async () => {
    const state = readSessionStateLocked(cortexPath);
    if (!state) return mcpResponse({ ok: true, message: "No active session. Call session_start to begin.", data: null });

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
