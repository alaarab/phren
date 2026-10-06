import { type Json } from "./protocol.js";
import type { Schedule, ScheduleLauncher, ScheduleRun, ScheduleRunOutcome } from "./schedule-format.js";
import { watchHerdrRun } from "./schedule-watch.js";
type HerdrLauncher = (server: string, data: Json) => Promise<Json>;
export declare function createScheduleLauncher(launchHerdr: HerdrLauncher, store?: string): ScheduleLauncher;
/**
 * The outcome of a run a previous Hook process launched and never saw finish
 * (a restart or crash mid-run). A Herdr pane is followed again to its real
 * end; a headless job's manifest says how it ended, if it got that far. A run
 * whose end cannot be known fails with that reason rather than staying open,
 * since an open run blocks its schedule for good.
 */
export declare function resumeScheduleRun(run: ScheduleRun, schedule: Schedule, signal: AbortSignal, watch?: typeof watchHerdrRun): Promise<ScheduleRunOutcome>;
/** The environment a headless run gets: this Hook's, plus the chosen Claude account's config directory. */
export declare function headlessEnv(schedule: Schedule, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function headlessCommand(schedule: Schedule, cwd: string): {
    file: string;
    args: string[];
    cwd: string;
};
export {};
