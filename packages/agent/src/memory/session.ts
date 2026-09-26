import {
  endSessionRecord,
  findMostRecentSummaryWithProject,
  incrementSessionStateCounter,
  loadLastSessionMessages as loadSharedLastSessionMessages,
  loadLastSessionSnapshot as loadSharedLastSessionSnapshot,
  saveSessionMessages as saveSharedSessionMessages,
  startSessionRecord,
  type SerializedSessionMessage,
} from "@phren/cli/session/artifacts";
import { addNote } from "@phren/cli/data/notes";
import type { PhrenContext } from "./context.js";

type SessionCounterField = "findingsAdded" | "tasksCompleted";

export interface SessionResumeSnapshot {
  sessionId: string;
  project?: string;
  savedAt: string;
  messages: SerializedSessionMessage[];
}

export function startSession(ctx: PhrenContext): string {
  return startSessionRecord(ctx.phrenPath, {
    project: ctx.project ?? undefined,
    agentCreated: true,
  });
}

export function endSession(ctx: PhrenContext, sessionId: string, summary?: string): void {
  endSessionRecord(ctx.phrenPath, sessionId, summary);
}

function truncateLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Mirror a session summary into the project's notes. Notes are FTS-indexed
 * but non-injectable — past sessions become searchable via phren_search with
 * zero prompt-leak risk. Best effort, never throws.
 */
export function writeSessionNote(
  ctx: PhrenContext,
  opts: { sessionId?: string | null; task?: string; outcome?: string },
): void {
  if (!ctx.project) return;
  try {
    const parts = [`[agent session${opts.sessionId ? ` ${opts.sessionId.slice(0, 8)}` : ""}]`];
    if (opts.task) parts.push(`task: ${truncateLine(opts.task, 200)}`);
    if (opts.outcome) parts.push(`outcome: ${truncateLine(opts.outcome, 500)}`);
    if (parts.length === 1) return;
    addNote(ctx.phrenPath, ctx.project, parts.join(" — "));
  } catch {
    // best effort
  }
}

export function incrementSessionCounter(phrenPath: string, sessionId: string, counter: SessionCounterField): void {
  incrementSessionStateCounter(phrenPath, sessionId, counter);
}

export interface PriorSummary {
  summary: string;
  project?: string;
  endedAt?: string;
}

export function getPriorSummary(ctx: PhrenContext): PriorSummary | null {
  const lookup = findMostRecentSummaryWithProject(ctx.phrenPath, ctx.project ?? undefined);
  if (!lookup.summary) return null;
  // The CLI lookup falls back to the most recent summary from ANY project when
  // the current project has none. A different project's session summary is more
  // likely to mislead than help, so drop it rather than inject it unlabeled.
  if (ctx.project && lookup.project && lookup.project !== ctx.project) return null;
  return { summary: lookup.summary, project: lookup.project, endedAt: lookup.endedAt };
}

export function saveSessionMessages(
  phrenPath: string,
  sessionId: string,
  messages: SerializedSessionMessage[],
  project?: string,
): void {
  saveSharedSessionMessages(phrenPath, sessionId, messages, project);
}

export function loadLastSessionSnapshot(phrenPath: string, project?: string): SessionResumeSnapshot | null {
  const snapshot = loadSharedLastSessionSnapshot(phrenPath, project);
  if (!snapshot) return null;
  return {
    sessionId: snapshot.sessionId,
    project: snapshot.project,
    savedAt: snapshot.savedAt,
    messages: snapshot.messages,
  };
}

export function loadLastSessionMessages(phrenPath: string, project?: string): SerializedSessionMessage[] | null {
  return loadSharedLastSessionMessages(phrenPath, project);
}
