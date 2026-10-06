import { type CanaryResult } from "./health.js";
import { type Json } from "./protocol.js";
/** The label every canary workspace carries, so cleanup finds only its own. */
export declare const CANARY_LABEL = "phren canary";
export interface CanaryOptions {
    trigger: "manual" | "daily";
    store: string;
    /** Starts an agent the way the phone's launch route does; the Hook passes launchSession. */
    launch: (server: string, data: Json) => Promise<Json>;
    /** The Hook's scheduler, when the schedules module runs it. */
    scheduler?: {
        lastTickAt?: Date;
    };
    server?: string;
    root?: string;
}
/** Where the canary's conductor starts: Herdr's default server, else the
 * first Herdr server running; on a computer without Herdr, tmux's hidden
 * server, so nothing opens where the owner is working. Undefined with neither. */
export declare function canaryServer(): Promise<string | undefined>;
/** Exercise the real launch, schedule, transcript and session paths once and
 * save the outcome to canary.json. Everything it opens is closed again, even on
 * failure; it never sends input to an existing pane and never runs or edits the
 * owner's schedules or tasks. */
export declare function runCanary(options: CanaryOptions): Promise<CanaryResult>;
/** Whether the daily canary is on: `PHREN_CANARY_DAILY=1`, or `phren canary --daily on`. */
export declare function dailyCanaryEnabled(root?: string): Promise<boolean>;
/** A daily canary is due when none has run in the last day. */
export declare function dailyCanaryDue(root?: string, now?: number): Promise<boolean>;
/** `phren canary [--daily on|off]`: run the canary through this computer's Hook, or switch the daily run. */
export declare function runCanaryCommand(args: string[]): Promise<number>;
