import type { ChildProcess } from "node:child_process";
import type { LaunchOptions } from "./adapters/types.js";
export declare const DENIED_FEEDBACK = "The owner denied this request from the phone. Do not retry it; continue without it and say in your final report what you could not do because of it.";
export declare const UNANSWERED_FEEDBACK = "Nobody answered this permission request in time. Do not retry it; continue without it and say in your final report what you could not do because of it.";
export interface DriveOptions extends LaunchOptions {
    store: string;
    label: string;
    prompt: string;
    jobId: string;
    password: string;
    /** One `opencode run --format json` event line for the job's event log. */
    emit(line: string): void;
    /** The worker's session, as soon as it exists. */
    session(id: string): void;
}
/** Drives one fan-out worker through `opencode serve` and its HTTP API rather
 * than `opencode run`, which rejects every permission ask on its own. The
 * events it writes are the ones `opencode run --format json` prints, so the
 * Hook's transcript readers and the loop watchdog read them unchanged. A
 * permission ask becomes the same request file the Phren plugin writes for a
 * pane, the Hook shows it on the phone under the worker's parent, and the
 * owner's answer resumes the same session: Allow runs the call, Deny rejects it
 * with feedback so the worker carries on and reports the refusal. */
export declare function driveOpencode(child: ChildProcess, o: DriveOptions): Promise<number>;
