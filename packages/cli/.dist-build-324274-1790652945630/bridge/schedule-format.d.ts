import type { SchedulePush, SchedulePushResult } from "./push.js";
/** The schedules.yaml store: the schedule and run record shapes, validation,
 * the five timing forms evaluated in local time, and the run history file. */
export declare const SCHEDULE_EVERY: readonly ["interval", "daily", "weekly", "once", "cron"];
export declare const SCHEDULE_HARNESSES: readonly ["claude", "codex", "opencode"];
export declare const SCHEDULE_NOTIFY: readonly ["start", "finish", "failure"];
export declare const WEEKDAYS: readonly ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export type ScheduleEvery = typeof SCHEDULE_EVERY[number];
export type ScheduleHarness = typeof SCHEDULE_HARNESSES[number];
export type ScheduleNotify = typeof SCHEDULE_NOTIFY[number];
export type Weekday = typeof WEEKDAYS[number];
export declare const SCHEDULE_RUN_STATUSES: readonly ["launched", "running", "blocked", "finished", "needs-you", "failed", "skipped"];
export type ScheduleRunStatus = typeof SCHEDULE_RUN_STATUSES[number];
/** How a run ended: done, done but waiting on the owner's answer, or not done. */
export interface ScheduleRunOutcome {
    status: "finished" | "needs-you" | "failed";
    reason?: string;
}
export interface Schedule {
    id: string;
    name: string;
    enabled: boolean;
    computer: string;
    harness: ScheduleHarness;
    model?: string;
    /** Claude account id (a slug) the run uses; absent means the default account. */
    account?: string;
    notify?: ScheduleNotify[];
    every: ScheduleEvery;
    at?: string;
    days?: Weekday[];
    interval?: string;
    once?: string;
    cron?: string;
    prompt: string;
    createdAt: string;
    updatedAt: string;
    [key: string]: unknown;
}
export interface ScheduleLaunchRecord {
    mode: "herdr" | "headless";
    workspaceId?: string;
    tabId?: string;
    paneId?: string;
    sessionId?: string;
    server?: string;
    jobDir?: string;
}
export interface ScheduleRun {
    id: string;
    scheduleId: string;
    project: string;
    startedAt: string;
    finishedAt?: string;
    status: ScheduleRunStatus;
    reason?: string;
    blockedStartupPrompt?: string;
    blockNotified?: boolean;
    notified?: boolean;
    notifyReason?: string;
    launch: ScheduleLaunchRecord;
}
export interface ScheduleLaunchResult {
    launch: ScheduleLaunchRecord;
    completion?: Promise<ScheduleRunOutcome>;
}
export interface ScheduleLaunchContext {
    schedule: Schedule;
    project: string;
    projectDir: string;
    cwd: string;
    runId: string;
    blockedStartup?: (promptText: string) => void | Promise<void>;
}
export type ScheduleLauncher = ((context: ScheduleLaunchContext) => Promise<ScheduleLaunchResult>) & {
    close?: () => void;
    /** Follows a run a previous Hook process launched and never saw finish. */
    resume?: (run: ScheduleRun, schedule: Schedule) => Promise<ScheduleRunOutcome>;
};
export interface SchedulePushSender {
    notify(value: SchedulePush): Promise<SchedulePushResult>;
}
export interface ScheduleStatus extends Schedule {
    project: string;
    nextRun: string | null;
    lastRun: Omit<ScheduleRun, "id" | "scheduleId" | "project"> | null;
    running: boolean;
}
interface ScheduleDocument {
    document: Record<string, unknown>;
    schedules: Schedule[];
}
export declare const runningStatuses: Set<"blocked" | "failed" | "finished" | "launched" | "needs-you" | "running" | "skipped">;
export declare function intervalMilliseconds(value: string): number;
export declare function parseSchedule(value: unknown): Schedule;
export declare function readScheduleDocument(projectDir: string): Promise<ScheduleDocument>;
export declare function writeScheduleDocument(projectDir: string, schedules: Schedule[], original?: Record<string, unknown>): Promise<void>;
export declare function canonicalComputer(value: string): string;
export declare function computerMatches(wanted: string, current: string): boolean;
export declare function scheduleNotifications(schedule: Schedule): Set<ScheduleNotify>;
export declare function scheduleSessionRoute(schedule: Schedule, launch: ScheduleLaunchRecord): string | undefined;
export declare function nextRun(schedule: Schedule, lastRun?: ScheduleRun): Date | null;
export declare function readScheduleRuns(file: string): Promise<ScheduleRun[]>;
export declare function writeScheduleRuns(file: string, runs: ScheduleRun[]): Promise<void>;
export declare function newScheduleId(existing: Iterable<string>): string;
export declare function scheduleRunsFile(): string;
export {};
