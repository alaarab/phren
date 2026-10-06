import { type SessionState } from "./utils.js";
export type SessionCounterField = "findingsAdded" | "tasksCompleted";
export interface SessionSummaryRecord {
    summary: string;
    sessionId: string;
    project?: string;
    endedAt?: string;
}
export interface SessionSummaryLookup {
    summary: string | null;
    sessionId?: string;
    project?: string;
    endedAt?: string;
}
export interface SerializedSessionMessage {
    role: string;
    content: unknown;
}
export interface SessionMessagesSnapshot {
    schemaVersion: 1;
    sessionId: string;
    project?: string;
    savedAt: string;
    messages: SerializedSessionMessage[];
}
interface StartSessionOptions {
    sessionId?: string;
    project?: string;
    agentScope?: string;
    hookCreated?: boolean;
    agentCreated?: boolean;
}
export declare function lastSummaryPath(phrenPath: string): string;
export declare function readLastSummary(phrenPath: string): SessionSummaryRecord | null;
export declare function writeLastSummary(phrenPath: string, record: SessionSummaryRecord): void;
export declare function findMostRecentSummaryWithProject(phrenPath: string, project?: string): SessionSummaryLookup;
export declare function startSessionRecord(phrenPath: string, options?: StartSessionOptions): string;
export declare function readSessionState(phrenPath: string, sessionId: string): SessionState | null;
export declare function endSessionRecord(phrenPath: string, sessionId: string, summary?: string): void;
export declare function incrementSessionStateCounter(phrenPath: string, sessionId: string, field: SessionCounterField, count?: number): void;
export declare function saveSessionMessages(phrenPath: string, sessionId: string, messages: SerializedSessionMessage[], project?: string): void;
export declare function loadLastSessionSnapshot(phrenPath: string, project?: string): SessionMessagesSnapshot | null;
export declare function loadLastSessionMessages(phrenPath: string, project?: string): SerializedSessionMessage[] | null;
export {};
