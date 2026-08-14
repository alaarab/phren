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
