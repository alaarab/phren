/** What phren's OpenCode plugin last recorded for any of `pids`, newest first. */
export declare function opencodeProcessStatus(pids: number[], root?: string): Promise<string | undefined>;
type TurnStamps = {
    session: string;
    at: string;
    busyAt?: string;
    idleAt?: string;
};
/** The turn stamps phren's OpenCode plugin last recorded for any of `pids`,
 * newest first: when the session went busy and when it went idle after that.
 * Undefined when no file has them (an older plugin). */
export declare function opencodeTurnStamps(pids: number[], root?: string): Promise<TurnStamps | undefined>;
/** The status a Copilot session log's lines leave the session in; undefined
 * when none of them says. Copilot writes a turn_start/turn_end pair per model
 * call, so only the turn that carried the final answer ends the work. */
export declare function copilotStatusFromEvents(lines: string[]): string | undefined;
/** The status of the Copilot conversation a process shows, from the tail of
 * its session log; unchanged files are not read again. */
export declare function copilotProcessStatus(pids: number[], home?: string): Promise<string | undefined>;
/** The status `agent`'s own records give for a pane running `pids`, for the
 * harnesses whose lifecycle hooks say nothing about turns. */
export declare function harnessStatus(agent: string, pids: number[]): Promise<string | undefined>;
export {};
