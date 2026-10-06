import { type ProactivityLevel } from "../proactivity.js";
export type TaskMode = "off" | "manual" | "suggest" | "auto";
interface TaskPromptLifecycleResult {
    mode: TaskMode;
    noticeLines: string[];
}
/** What the person typed: the prompt without pasted blocks. */
export declare function typedPromptText(prompt: string): string;
/** A frame from another agent or the harness, or a message relayed from one,
 *  rather than something the person asked. */
export declare function isAgentFramePrompt(prompt: string): boolean;
export declare function handleTaskPromptLifecycle(args: {
    phrenPath: string;
    prompt: string;
    project: string | null;
    sessionId?: string;
    intent: string;
    taskLevel?: ProactivityLevel;
}): TaskPromptLifecycleResult;
export declare function finalizeTaskSession(args: {
    phrenPath: string;
    sessionId?: string;
    status: "clean" | "saved-local" | "saved-pushed" | "no-upstream" | "error";
    detail: string;
}): void;
export declare function isTransientGitFailure(detail: string): boolean;
/**
 * Return the active TaskItem tracked for a session+project, if any.
 * Used by mcp-finding.ts to link findings to active tasks.
 */
export declare function getActiveTaskForSession(phrenPath: string, sessionId: string, project: string): import("../data/tasks.js").TaskItem | null;
export {};
