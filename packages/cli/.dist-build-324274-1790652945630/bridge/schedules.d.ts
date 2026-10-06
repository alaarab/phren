import { type ScheduleLauncher, type ScheduleRun, type SchedulePushSender, type ScheduleStatus } from "./schedule-format.js";
export * from "./schedule-format.js";
export * from "./schedule-launch.js";
export * from "./schedule-watch.js";
export declare class Scheduler {
    private readonly now;
    private readonly store;
    private readonly launch;
    private readonly runsFile;
    private readonly computer;
    private readonly locateProject;
    private readonly push?;
    private readonly log;
    private serial;
    private ticking;
    /** Runs this process launched; any other open run was left by an earlier Hook. */
    private readonly own;
    private recovered;
    /** When the scheduler last looked for due work; a health read shows it. */
    lastTickAt?: Date;
    constructor(options: {
        now: () => Date;
        store: string;
        launch: ScheduleLauncher;
        runsFile: string;
        computer?: string | (() => string);
        locateProject?: (project: string) => Promise<string | undefined>;
        push?: SchedulePushSender;
        log?: (message: string) => void;
    });
    private projectDirectories;
    private projectDirectory;
    private exclusive;
    statuses(): Promise<{
        computer: string;
        timeZone: string;
        schedules: ScheduleStatus[];
    }>;
    history(filters?: {
        project?: string;
        id?: string;
        limit?: number;
    }): Promise<ScheduleRun[]>;
    launchNow(projectName: string, id: string): Promise<ScheduleRun>;
    private updateRun;
    private finishRun;
    private recordBlockedStartup;
    private notifyRun;
    /**
     * Settles the runs an earlier Hook process left open (a restart or crash
     * mid-run). Each is followed to its real end where the launcher can, and
     * otherwise failed with the reason, since an open run blocks its schedule
     * for good. Runs once, on the first tick, with a launcher that can resume.
     */
    recoverOpenRuns(): Promise<void>;
    tick(): Promise<void>;
    close(): void;
}
