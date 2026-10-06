export declare function materializedRoot(): string;
export declare function materializedPath(session: string): string;
/** A working pane whose projection cursor stopped at an unfinished turn can
 * keep accepting input even though none of it will be readable again. */
export declare function threadHealth(session: string, agentStatus: unknown): Promise<{
    stalled: boolean;
    since?: string;
}>;
export declare function codexThreadPreview(session: string): Promise<{
    turnStartedAt: string;
    text: string;
} | undefined>;
/** Bring the materialized file up to date with the store. Returns the file
 * when the thread exists there, undefined otherwise. Safe to call often:
 * an unchanged thread costs one aggregate query. */
export declare function materializeCodexThread(session: string): Promise<string | undefined>;
/** The pending queued question as the pane's choice shape: the asking
 * sentence and one numbered option per choice (Codex answers with number
 * keys once alt+up has opened the queue). Undefined when nothing answerable
 * remains. */
export declare function queuedQuestion(session: string): Promise<{
    title: string;
    options: {
        label: string;
        key: string;
    }[];
} | undefined>;
