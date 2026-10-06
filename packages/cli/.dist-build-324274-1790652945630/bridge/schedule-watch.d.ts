import { type Json, type Provider } from "./protocol.js";
import type { ScheduleHarness, ScheduleRunOutcome } from "./schedule-format.js";
/** Watching a scheduled run in its Herdr pane: how it ended, whether the final
 * reply asks the owner something, and a startup screen that blocked it. */
export declare const STARTUP_BLOCK_WINDOW_MS = 90000;
export declare const STARTUP_BLOCK_WINDOW_OPEN_MS = 5000;
export declare function classifyStartupBlock(input: {
    elapsedMs: number;
    transcriptActive: boolean;
    status: unknown;
    lines: readonly string[];
}): string | undefined;
/** The watch loop's own words for a failure, instead of assuming Herdr went away. */
export declare function watchFailureReason(error: unknown): string;
interface StartupWatch {
    source: ScheduleHarness;
    startedAt: number;
    sessionId?: string;
    onBlocked?: (promptText: string) => void | Promise<void>;
}
export interface StartupWatchEnv {
    now?: () => number;
    pause?: (ms: number) => Promise<void>;
    readPane?: (server: string, paneId: string) => Promise<string[]>;
    resolveSession?: (server: string, pane: Json) => Promise<string | undefined>;
    transcriptStamp?: (source: ScheduleHarness, sessionId: string | undefined) => Promise<{
        size: number;
        mtimeMs: number;
    } | undefined>;
    panes?: (server: string) => Promise<Json[]>;
    finalTurn?: (source: ScheduleHarness, sessionId: string | undefined) => Promise<FinalTurn | undefined>;
}
/** `error`: the harness ended the turn on an error (Codex's usage limit) instead of a reply.
 * `interrupted`: the owner stopped the last turn (Claude's "[Request interrupted by user]",
 * Codex's turn_aborted); the harness sends no Stop for it.
 * `background`: Claude Code background tasks (shells, subagents, monitors) started in
 * the transcript's tail with no task-notification or TaskStop ending them yet. */
export interface FinalTurn {
    completed: boolean;
    lastAssistant?: string;
    error?: string;
    interrupted?: boolean;
    background?: number;
}
/** The public text of one assistant row, without reasoning or tool output. */
export declare function publicAssistant(raw: Json, source: Provider): string | undefined;
/** The last assistant reply in a transcript and whether its turn finished.
 * A person's message after the reply opens a new turn, so it clears both. */
export declare function finalTurnFromLines(lines: readonly string[], source: ScheduleHarness): FinalTurn;
/** The final turn of a conversation, read from the tail of its transcript. */
export declare function readFinalTurn(source: ScheduleHarness, sessionId: string | undefined): Promise<FinalTurn | undefined>;
/** When a finished reply ends by asking the owner something (a question, or
 * numbered options introduced as a choice), the question's first line. */
export declare function ownerQuestion(text: string): string | undefined;
export declare function watchHerdrRun(server: string, target: {
    workspaceId: string;
    tabId: string;
    paneId: string;
}, signal: AbortSignal, startup: StartupWatch, env?: StartupWatchEnv): Promise<ScheduleRunOutcome>;
export {};
