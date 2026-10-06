/** The status a lifecycle event leaves the agent in; undefined for events that say nothing about it. */
export declare function eventStatus(event: unknown): string | undefined;
/** Records the status of the agent in `pane`, which runs in terminal instance
 * `terminal`, and answers it with its sequence number. */
export declare function notePaneStatus(server: string, pane: string, terminal: string, status: string, at?: number): {
    status: string;
    seq: number;
};
/** A blocked pane whose dialog is gone was answered in the terminal: the
 * agent went back to work. Only after `minimumMs`, so a request whose
 * dialog is still being drawn is not settled early. */
export declare function settleBlockedPane(server: string, pane: string, minimumMs?: number): void;
/** The pane's last known status while `terminal` still runs there: from
 * memory, else from the binding file the last lifecycle event wrote. */
export declare function paneStatus(server: string, pane: string, terminal: string): Promise<{
    status: string;
    seq: number;
} | undefined>;
/** Whether `screen` (a pane's visible lines, with or without colors) shows a
 * dialog waiting for `agent`'s owner. Stricter than the readers that answer
 * a dialog, because it runs while the agent is still writing: Claude's and
 * phren-agent's numbered rows count only with their "Esc to cancel" footer,
 * OpenCode's only as its own permission prompt. */
export declare function screenDialog(agent: string, screen: string): boolean;
/** The status of a pane after a look at its screen: blocked while a working
 * agent shows a dialog there (`screenDialog`), else `base` unchanged. `read`
 * answers the pane's visible lines; it runs only for a working pane, at most
 * once per DIALOG_READ_MS per pane. */
export declare function dialogStatus(server: string, pane: string, terminal: string, agent: string, base: {
    status: string;
    seq: number;
} | undefined, read: () => Promise<string>): Promise<{
    status: string;
    seq: number;
} | undefined>;
/** For tests. */
export declare function resetPaneStatus(): void;
