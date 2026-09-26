import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";
import { z } from "zod";
import type { SchedulePush, SchedulePushResult } from "./push.js";
import { atomicInPrivateDir, bridgeRoot, object } from "./protocol.js";

/** The schedules.yaml store: the schedule and run record shapes, validation,
 * the five timing forms evaluated in local time, and the run history file. */

export const SCHEDULE_EVERY = ["interval", "daily", "weekly", "once", "cron"] as const;
export const SCHEDULE_HARNESSES = ["claude", "codex", "opencode"] as const;
export const SCHEDULE_NOTIFY = ["start", "finish", "failure"] as const;
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export type ScheduleEvery = typeof SCHEDULE_EVERY[number];
export type ScheduleHarness = typeof SCHEDULE_HARNESSES[number];
export type ScheduleNotify = typeof SCHEDULE_NOTIFY[number];
export type Weekday = typeof WEEKDAYS[number];
export const SCHEDULE_RUN_STATUSES = ["launched", "running", "blocked", "finished", "needs-you", "failed", "skipped"] as const;
export type ScheduleRunStatus = typeof SCHEDULE_RUN_STATUSES[number];
/** How a run ended: done, done but waiting on the owner's answer, or not done. */
export interface ScheduleRunOutcome { status: "finished" | "needs-you" | "failed"; reason?: string }

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  computer: string;
  harness: ScheduleHarness;
  model?: string;
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
export interface SchedulePushSender { notify(value: SchedulePush): Promise<SchedulePushResult> }

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

const scheduleId = z.string().regex(/^[a-f0-9]{8}$/);
const plain = (max: number) => z.string().min(1).max(max).refine(value => !/[\x00-\x08\x0b-\x1f\x7f]/.test(value));
const singleLine = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value));
const scheduleName = singleLine(80);
const timestamp = z.string().datetime({ offset: true });
const localTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const schedulePath = (projectDir: string) => path.join(projectDir, "schedules.yaml");
export const runningStatuses = new Set<ScheduleRunStatus>(["launched", "running", "blocked"]);
const MAX_SCHEDULES = 64;
const MAX_RUNS = 2000;

function validateLocalTimestamp(value: string): string {
  localTimestamp.parse(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value)!;
  const parts = match.slice(1).map(Number), date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
  if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== parts[1] - 1 || date.getUTCDate() !== parts[2]
      || date.getUTCHours() !== parts[3] || date.getUTCMinutes() !== parts[4] || date.getUTCSeconds() !== parts[5]) {
    throw new Error(`Invalid local schedule time: ${value}`);
  }
  return value;
}

export function intervalMilliseconds(value: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(value);
  if (!match || Number(match[1]) < 1) throw new Error("Interval must look like 30m, 6h, or 2d.");
  const unit = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  const milliseconds = Number(match[1]) * unit;
  if (!Number.isSafeInteger(milliseconds)) throw new Error("Schedule interval is too large.");
  return milliseconds;
}

export function parseSchedule(value: unknown): Schedule {
  const raw = object(value);
  const every = z.enum(SCHEDULE_EVERY).parse(raw.every);
  const computer = singleLine(200).parse(raw.computer);
  if (canonicalComputer(computer) === "any") throw new Error('Schedule computer "any" is not supported.');
  const schedule: Schedule = {
    ...raw,
    id: scheduleId.parse(raw.id),
    name: scheduleName.parse(raw.name),
    enabled: z.boolean().parse(raw.enabled),
    computer,
    harness: z.enum(SCHEDULE_HARNESSES).parse(raw.harness),
    every,
    prompt: plain(8000).parse(raw.prompt),
    createdAt: timestamp.parse(raw.createdAt),
    updatedAt: timestamp.parse(raw.updatedAt),
  };
  if (raw.model !== undefined) schedule.model = singleLine(200).parse(raw.model);
  if (raw.notify !== undefined) schedule.notify = z.array(z.enum(SCHEDULE_NOTIFY)).max(3).parse(raw.notify)
    .filter((kind, index, kinds) => kinds.indexOf(kind) === index);
  if (every === "daily" || every === "weekly") schedule.at = clockTime.parse(raw.at);
  if (every === "weekly") schedule.days = z.array(z.enum(WEEKDAYS)).min(1).max(7).parse(raw.days).filter((day, index, days) => days.indexOf(day) === index);
  if (every === "interval") { schedule.interval = singleLine(32).parse(raw.interval); intervalMilliseconds(schedule.interval); }
  if (every === "once") schedule.once = validateLocalTimestamp(singleLine(32).parse(raw.once));
  if (every === "cron") { schedule.cron = singleLine(200).parse(raw.cron); parseCron(schedule.cron); }
  return schedule;
}

export async function readScheduleDocument(projectDir: string): Promise<ScheduleDocument> {
  let text: string;
  try { text = await readFile(schedulePath(projectDir), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { document: { version: 1 }, schedules: [] };
    throw error;
  }
  const document = object(yaml.load(text, { schema: yaml.CORE_SCHEMA }));
  if (document.version !== 1) throw new Error("schedules.yaml must have version: 1.");
  if (!Array.isArray(document.schedules)) throw new Error("schedules.yaml must contain a schedules list.");
  if (document.schedules.length > MAX_SCHEDULES) throw new Error(`A project can have at most ${MAX_SCHEDULES} schedules.`);
  const schedules = document.schedules.map(parseSchedule);
  if (new Set(schedules.map(item => item.id)).size !== schedules.length) throw new Error("Schedule IDs must be unique within a project.");
  return { document, schedules };
}

export async function writeScheduleDocument(projectDir: string, schedules: Schedule[], original: Record<string, unknown> = { version: 1 }): Promise<void> {
  if (schedules.length > MAX_SCHEDULES) throw new Error(`A project can have at most ${MAX_SCHEDULES} schedules.`);
  schedules.forEach(parseSchedule);
  const text = yaml.dump({ ...original, version: 1, schedules }, { lineWidth: 1000, noRefs: true, sortKeys: false });
  await atomicInPrivateDir(schedulePath(projectDir), text);
}

export function canonicalComputer(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.endsWith(".local") ? normalized.slice(0, -".local".length) : normalized;
}

export function computerMatches(wanted: string, current: string): boolean {
  return canonicalComputer(wanted) === canonicalComputer(current);
}

export function scheduleNotifications(schedule: Schedule): Set<ScheduleNotify> {
  return new Set(schedule.notify ?? ["finish", "failure"]);
}

export function scheduleSessionRoute(schedule: Schedule, launch: ScheduleLaunchRecord): string | undefined {
  if (launch.mode !== "herdr" || !launch.server || !launch.workspaceId || !launch.tabId || !launch.paneId) return undefined;
  const route = Buffer.from(JSON.stringify({ server: launch.server, workspace: launch.workspaceId, tab: launch.tabId,
    pane: launch.paneId, source: schedule.harness })).toString("base64url");
  return `phren://session?route=${encodeURIComponent(route)}`;
}

interface CronField { values: number[]; wildcard: boolean }
interface ParsedCron { minute: CronField; hour: CronField; day: CronField; month: CronField; weekday: CronField }

function parseCronField(text: string, minimum: number, maximum: number, sunday = false): CronField {
  const values = new Set<number>(), wildcard = text === "*" || text.startsWith("*/");
  for (const part of text.split(",")) {
    const [rangeText, stepText] = part.split("/");
    if (part.split("/").length > 2 || stepText !== undefined && !/^\d+$/.test(stepText)) throw new Error(`Invalid cron field: ${text}`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) throw new Error(`Invalid cron step: ${text}`);
    let start: number, end: number;
    if (rangeText === "*") { start = minimum; end = maximum; }
    else if (/^\d+$/.test(rangeText)) start = end = Number(rangeText);
    else {
      const range = /^(\d+)-(\d+)$/.exec(rangeText);
      if (!range) throw new Error(`Invalid cron field: ${text}`);
      start = Number(range[1]); end = Number(range[2]);
    }
    if (start < minimum || end > maximum || start > end) throw new Error(`Cron field is out of range: ${text}`);
    for (let value = start; value <= end; value += step) values.add(sunday && value === 7 ? 0 : value);
  }
  return { values: [...values].sort((left, right) => left - right), wildcard };
}

function parseCron(value: string): ParsedCron {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron schedules need five fields.");
  return {
    minute: parseCronField(fields[0], 0, 59), hour: parseCronField(fields[1], 0, 23),
    day: parseCronField(fields[2], 1, 31), month: parseCronField(fields[3], 1, 12),
    weekday: parseCronField(fields[4], 0, 7, true),
  };
}

function cronDayMatches(cron: ParsedCron, date: Date): boolean {
  const day = cron.day.values.includes(date.getDate()), weekday = cron.weekday.values.includes(date.getDay());
  if (cron.day.wildcard && cron.weekday.wildcard) return true;
  if (cron.day.wildcard) return weekday;
  if (cron.weekday.wildcard) return day;
  return day || weekday;
}

function nextCron(schedule: Schedule, after: Date): Date | null {
  const cron = parseCron(schedule.cron!);
  const day = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  for (let offset = 0; offset < 366 * 8; offset++) {
    const date = new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset);
    if (!cron.month.values.includes(date.getMonth() + 1) || !cronDayMatches(cron, date)) continue;
    for (const hour of cron.hour.values) for (const minute of cron.minute.values) {
      const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute);
      if (candidate.getHours() === hour && candidate.getMinutes() === minute && candidate > after) return candidate;
    }
  }
  return null;
}

function nextDailyOrWeekly(schedule: Schedule, after: Date): Date | null {
  const [hour, minute] = schedule.at!.split(":").map(Number);
  const allowed = schedule.every === "weekly" ? new Set(schedule.days!.map(day => WEEKDAYS.indexOf(day))) : undefined;
  for (let offset = 0; offset < 370; offset++) {
    const candidate = new Date(after.getFullYear(), after.getMonth(), after.getDate() + offset, hour, minute);
    if (candidate.getHours() !== hour || candidate.getMinutes() !== minute || candidate <= after) continue;
    if (!allowed || allowed.has(candidate.getDay())) return candidate;
  }
  return null;
}

function localDate(value: string): Date | null {
  validateLocalTimestamp(value);
  const parts = value.match(/\d+/g)!.map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  return date.getFullYear() === parts[0] && date.getMonth() === parts[1] - 1 && date.getDate() === parts[2]
    && date.getHours() === parts[3] && date.getMinutes() === parts[4] && date.getSeconds() === parts[5] ? date : null;
}

export function nextRun(schedule: Schedule, lastRun?: ScheduleRun): Date | null {
  if (schedule.every === "once") return lastRun ? null : localDate(schedule.once!);
  const after = new Date(lastRun?.startedAt ?? schedule.createdAt);
  if (!Number.isFinite(after.getTime())) return null;
  if (schedule.every === "interval") return new Date(after.getTime() + intervalMilliseconds(schedule.interval!));
  if (schedule.every === "cron") return nextCron(schedule, after);
  return nextDailyOrWeekly(schedule, after);
}

export async function readScheduleRuns(file: string): Promise<ScheduleRun[]> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const runs: ScheduleRun[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const raw = object(JSON.parse(line));
      const launch = object(raw.launch);
      if (typeof raw.id !== "string" || typeof raw.scheduleId !== "string" || typeof raw.project !== "string"
          || typeof raw.startedAt !== "string" || !(SCHEDULE_RUN_STATUSES as readonly string[]).includes(String(raw.status))
          || !["herdr", "headless"].includes(String(launch.mode))) continue;
      runs.push(raw as unknown as ScheduleRun);
    } catch { /* A torn final line does not hide older history. */ }
  }
  return runs;
}

export async function writeScheduleRuns(file: string, runs: ScheduleRun[]): Promise<void> {
  const kept = runs.slice(-MAX_RUNS);
  await atomicInPrivateDir(file, kept.map(run => JSON.stringify(run)).join("\n") + (kept.length ? "\n" : ""));
}

export function newScheduleId(existing: Iterable<string>): string {
  const ids = new Set(existing);
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!ids.has(id)) return id;
  }
}

export function scheduleRunsFile(): string { return path.join(bridgeRoot(), "schedule-runs.jsonl"); }
