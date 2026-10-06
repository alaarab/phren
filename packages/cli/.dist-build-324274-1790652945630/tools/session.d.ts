import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext } from "./types.js";
export declare function resolveActiveSessionScope(phrenPath: string, project?: string): string | undefined;
/** Find the most recent session with a summary (including ended sessions).
 * @internal Exported for tests. */
export declare function findMostRecentSummary(phrenPath: string): string | null;
/** Increment the findingsAdded counter for a session. Falls back to the most relevant active session for the project. */
export declare function incrementSessionFindings(phrenPath: string, count?: number, sessionId?: string, project?: string): void;
export declare function incrementSessionTasksCompleted(phrenPath: string, count?: number, sessionId?: string, project?: string): void;
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
export declare function listAllSessions(phrenPath: string, limit?: number): SessionHistoryEntry[];
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
export declare function getSessionArtifacts(phrenPath: string, sessionId: string, project?: string): Promise<{
    findings: SessionArtifactFinding[];
    tasks: SessionArtifactTask[];
}>;
export declare function register(server: McpServer, ctx: McpContext): void;
export {};
