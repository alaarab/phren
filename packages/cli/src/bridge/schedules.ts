import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { codexHome } from "../home-paths.js";
import path from "node:path";
import { finished as streamFinished } from "node:stream/promises";
import * as yaml from "js-yaml";
import { z } from "zod";
import { publicAssistant } from "./dispatch-reports.js";
import { fanoutRoot } from "./fanouts.js";
import { findPane, paneIdentity, rpc, servers, snapshot } from "./herdr.js";
import { readPaneText } from "./pane-text.js";
import type { SchedulePush, SchedulePushKind, SchedulePushResult } from "./push.js";
import { atomic, atomicInPrivateDir, BridgeError, bridgeRoot, object, objects, type Json } from "./protocol.js";
import { transcriptPath } from "./transcripts.js";
import { logger } from "../logger.js";
import { getProjectSourcePath } from "../project-config.js";
import { defaultPhrenPath, getProjectDirs } from "../shared.js";
import { stripTerminal } from "../terminal-text.js";

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

export type ScheduleLauncher = ((context: ScheduleLaunchContext) => Promise<ScheduleLaunchResult>) & { close?: () => void };
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
const runningStatuses = new Set<ScheduleRunStatus>(["launched", "running", "blocked"]);
const MAX_SCHEDULES = 64;
const MAX_RUNS = 2000;
export const STARTUP_BLOCK_WINDOW_MS = 90_000;
export const STARTUP_BLOCK_WINDOW_OPEN_MS = 5_000;
const STARTUP_LATE_TRANSCRIPT_MS = 30_000;
const STARTUP_PANE_READ_LIMIT = 3;
const STARTUP_PROMPT_TAIL_LINES = 12;
const STARTUP_BLOCK_STATUSES = ["blocked", "waiting"];
const STARTUP_PROMPT_MARKER = /[?❯]|\(y\/?n\)|^\s*\d+[.)]\s/m;
const CLAUDE_SCHEDULE_SETTINGS = JSON.stringify({ enableAllProjectMcpServers: true });

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

export class Scheduler {
  private readonly now: () => Date;
  private readonly store: string;
  private readonly launch: ScheduleLauncher;
  private readonly runsFile: string;
  private readonly computer: () => string;
  private readonly locateProject: (project: string) => Promise<string | undefined>;
  private readonly push?: SchedulePushSender;
  private readonly log: (message: string) => void;
  private serial: Promise<void> = Promise.resolve();
  private ticking = false;
  /** When the scheduler last looked for due work; a health read shows it. */
  lastTickAt?: Date;

  constructor(options: { now: () => Date; store: string; launch: ScheduleLauncher; runsFile: string; computer?: string | (() => string);
    locateProject?: (project: string) => Promise<string | undefined>; push?: SchedulePushSender; log?: (message: string) => void }) {
    this.now = options.now; this.store = options.store; this.launch = options.launch; this.runsFile = options.runsFile;
    if (typeof options.computer === "function") this.computer = options.computer;
    else { const computer = options.computer; this.computer = () => computer ?? hostname(); }
    this.locateProject = options.locateProject ?? (async () => undefined);
    this.push = options.push;
    this.log = options.log ?? (message => console.error(message));
  }

  private projectDirectories(): string[] { return getProjectDirs(this.store); }

  private projectDirectory(project: string): string {
    const found = this.projectDirectories().find(directory => path.basename(directory).toLowerCase() === project.toLowerCase());
    if (!found) throw new BridgeError(404, `Unknown project "${project}".`);
    return found;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  async statuses(): Promise<{ computer: string; timeZone: string; schedules: ScheduleStatus[] }> {
    const runs = await readScheduleRuns(this.runsFile), result: ScheduleStatus[] = [], computer = this.computer();
    for (const directory of this.projectDirectories()) {
      let schedules: Schedule[];
      try { schedules = (await readScheduleDocument(directory)).schedules; } catch { continue; }
      const project = path.basename(directory);
      for (const schedule of schedules) {
        const matching = runs.filter(run => run.project === project && run.scheduleId === schedule.id);
        const last = matching.at(-1), running = matching.some(run => runningStatuses.has(run.status));
        const due = computerMatches(schedule.computer, computer) ? nextRun(schedule, last) : null;
        result.push({ ...schedule, project, nextRun: due?.toISOString() ?? null,
          lastRun: last ? { startedAt: last.startedAt, ...(last.finishedAt ? { finishedAt: last.finishedAt } : {}), status: last.status,
            ...(last.reason ? { reason: last.reason } : {}),
            ...(last.blockedStartupPrompt ? { blockedStartupPrompt: last.blockedStartupPrompt } : {}),
            ...(last.blockNotified !== undefined ? { blockNotified: last.blockNotified } : {}), launch: last.launch } : null, running });
      }
    }
    return { computer, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, schedules: result };
  }

  async history(filters: { project?: string; id?: string; limit?: number } = {}): Promise<ScheduleRun[]> {
    const limit = Math.min(500, Math.max(1, filters.limit ?? 50));
    return (await readScheduleRuns(this.runsFile)).filter(run => (!filters.project || run.project.toLowerCase() === filters.project.toLowerCase())
      && (!filters.id || run.scheduleId === filters.id)).slice(-limit).reverse();
  }

  async launchNow(projectName: string, id: string): Promise<ScheduleRun> {
    const prepared = await this.exclusive(async () => {
      const projectDir = this.projectDirectory(projectName), project = path.basename(projectDir);
      const file = await readScheduleDocument(projectDir), schedule = file.schedules.find(item => item.id === id);
      if (!schedule) throw new BridgeError(404, `Schedule "${id}" was not found in ${project}.`);
      if (!computerMatches(schedule.computer, this.computer())) throw new BridgeError(409, `${schedule.computer} owns this schedule; run it from that computer.`);
      const runs = await readScheduleRuns(this.runsFile);
      if (runs.some(run => run.project === project && run.scheduleId === id && runningStatuses.has(run.status))) {
        throw new BridgeError(409, `Schedule "${schedule.name}" is already running.`);
      }
      const run: ScheduleRun = { id: randomUUID(), scheduleId: id, project, startedAt: this.now().toISOString(), status: "launched", launch: { mode: "headless" } };
      await writeScheduleRuns(this.runsFile, [...runs, run]);
      if (schedule.every === "once" && schedule.enabled) {
        const updatedAt = this.now().toISOString();
        const schedules = file.schedules.map(item => item.id === id ? { ...item, enabled: false, updatedAt } : item);
        await writeScheduleDocument(projectDir, schedules, file.document);
      }
      const source = getProjectSourcePath(this.store, project);
      return { projectDir, project, schedule, run, cwd: source ?? await this.locateProject(project) ?? projectDir };
    });

    try {
      const launched = await this.launch({ schedule: prepared.schedule, project: prepared.project, projectDir: prepared.projectDir,
        cwd: prepared.cwd, runId: prepared.run.id,
        blockedStartup: promptText => this.recordBlockedStartup(prepared.run.id, prepared.schedule, promptText) });
      const running = await this.updateRun(prepared.run.id, { status: "running", launch: launched.launch });
      const notified = this.notifyRun(running, prepared.schedule, "scheduleStarted");
      if (launched.completion) void launched.completion.then(async result => {
        await this.finishRun(prepared.run.id, prepared.schedule, result.status, result.reason, notified);
      }).catch(async error => {
        await this.finishRun(prepared.run.id, prepared.schedule, "failed",
          error instanceof Error ? error.message : "The scheduled agent failed.", notified);
      }).catch(error => this.log(`[schedule] Could not finish run ${prepared.run.id}: ${String(error)}`));
      await notified;
      return running;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The scheduled agent could not start.";
      await this.finishRun(prepared.run.id, prepared.schedule, "failed", reason);
      throw error instanceof BridgeError ? error : new BridgeError(503, reason);
    }
  }

  private async updateRun(id: string, patch: Partial<ScheduleRun>): Promise<ScheduleRun> {
    return this.exclusive(async () => {
      const runs = await readScheduleRuns(this.runsFile), index = runs.findIndex(run => run.id === id);
      if (index < 0) throw new Error("The schedule run record disappeared.");
      runs[index] = { ...runs[index], ...patch };
      await writeScheduleRuns(this.runsFile, runs);
      return runs[index];
    });
  }

  private async finishRun(id: string, schedule: Schedule, status: ScheduleRunOutcome["status"], reason?: string,
    previousNotification?: Promise<unknown>): Promise<void> {
    const run = await this.updateRun(id, { status, finishedAt: this.now().toISOString(), ...(reason ? { reason } : {}) });
    await previousNotification;
    if (run.blockedStartupPrompt && run.blockNotified) return;
    await this.notifyRun(run, schedule, status === "failed" ? "scheduleFailed" : "scheduleFinished");
  }

  private async recordBlockedStartup(id: string, schedule: Schedule, promptText: string): Promise<void> {
    try {
      const prompt = promptText.slice(0, 4000);
      const run = await this.updateRun(id, { status: "blocked", blockedStartupPrompt: prompt });
      const delivered = await this.notifyRun(run, schedule, "scheduleBlocked", `Blocked at startup: ${prompt}`);
      if (delivered) await this.updateRun(id, { blockNotified: true });
    } catch (error) {
      this.log(`[schedule] blocked-at-startup record for run ${id} failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  private async notifyRun(run: ScheduleRun, schedule: Schedule, kind: SchedulePushKind, reason?: string): Promise<boolean> {
    const preference: ScheduleNotify = kind === "scheduleStarted" ? "start" : kind === "scheduleFinished" ? "finish" : "failure";
    if (!scheduleNotifications(schedule).has(preference)) return false;
    const route = scheduleSessionRoute(schedule, run.launch);
    const text = reason ?? run.reason;
    const value: SchedulePush = { kind, scheduleId: schedule.id, project: run.project, name: schedule.name,
      computer: schedule.computer, runId: run.id,
      status: kind === "scheduleStarted" ? "running" : kind === "scheduleFinished" ? (run.status === "needs-you" ? "needs-you" : "finished")
        : kind === "scheduleBlocked" ? "blocked" : "failed",
      ...(text ? { reason: text } : {}), ...(route ? { route } : {}) };
    let result: SchedulePushResult;
    try { result = this.push ? await this.push.notify(value) : { notified: false, reason: "no push config" }; }
    catch { result = { notified: false, reason: "push delivery failed" }; }
    try {
      await this.updateRun(run.id, { notified: result.notified, ...(result.reason ? { notifyReason: result.reason } : { notifyReason: undefined }) });
    } catch (error) {
      this.log(`[schedule] ${kind} notification result for run ${run.id} could not be recorded: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (!result.notified) this.log(`[schedule] ${kind} notification for run ${run.id}: ${result.reason ?? "not delivered"}`);
    return result.notified;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.lastTickAt = this.now();
    try {
      const status = await this.statuses(), now = this.now();
      for (const schedule of status.schedules) {
        if (!schedule.enabled || schedule.running || !schedule.nextRun || new Date(schedule.nextRun) > now) continue;
        await this.launchNow(schedule.project, schedule.id).catch(() => {});
      }
    } finally { this.ticking = false; }
  }

  close(): void { this.launch.close?.(); }
}

type HerdrLauncher = (server: string, data: Json) => Promise<Json>;

export function createScheduleLauncher(launchHerdr: HerdrLauncher, store = defaultPhrenPath()): ScheduleLauncher {
  const abort = new AbortController(), children = new Set<ChildProcess>();
  const launcher: ScheduleLauncher = async context => {
    const live = await servers();
    if (live.length) return launchInHerdr(String(live[0].session), context, launchHerdr, abort.signal);
    return launchHeadless(context, store, child => { children.add(child); child.once("exit", () => children.delete(child)); });
  };
  launcher.close = () => { abort.abort(); for (const child of children) child.kill("SIGTERM"); children.clear(); };
  return launcher;
}

async function launchInHerdr(server: string, context: ScheduleLaunchContext, launchHerdr: HerdrLauncher, signal: AbortSignal): Promise<ScheduleLaunchResult> {
  const launched = await launchHerdr(server, { cwd: context.cwd, label: context.schedule.name, kind: context.schedule.harness, model: context.schedule.model });
  const workspaceId = String(launched.workspaceId), tabId = String(launched.tabId), paneId = String(launched.paneId);
  await promptWhenReady(server, paneId, context.schedule.prompt, signal);
  let sessionId = typeof launched.sessionId === "string" ? launched.sessionId : undefined;
  for (let attempt = 0; attempt < 10 && !sessionId; attempt++) {
    const pane = findPane(await snapshot(server), { workspace: workspaceId, tab: tabId, pane: paneId });
    if (pane) sessionId = await paneIdentity(server, pane).catch(() => undefined);
    if (!sessionId) await new Promise(resolve => setTimeout(resolve, 200));
  }
  const launch: ScheduleLaunchRecord = { mode: "herdr", server, workspaceId, tabId, paneId,
    ...(sessionId ? { sessionId } : {}) };
  return { launch, completion: watchHerdrRun(server, { workspaceId, tabId, paneId }, signal,
    { source: context.schedule.harness, startedAt: Date.now(), sessionId, onBlocked: context.blockedStartup }) };
}

/** Herdr refuses a prompt until the agent has finished starting; a run
 * launched a moment ago waits for it rather than failing on the first try. */
async function promptWhenReady(server: string, paneId: string, text: string, signal: AbortSignal, waitMs = 60_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { await rpc(server, "agent.prompt", { target: paneId, text }, signal); return; }
    catch (error) {
      const starting = error instanceof BridgeError && error.details?.herdrCode === "agent_not_ready";
      if (!starting || signal.aborted) throw error;
      if (Date.now() >= deadline) throw new BridgeError(409, `The agent in ${paneId} never became ready for the prompt; it may be waiting at a startup screen on the computer.`);
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }
}

export function classifyStartupBlock(input: { elapsedMs: number; transcriptActive: boolean; status: unknown; lines: readonly string[] }): string | undefined {
  if (input.elapsedMs < STARTUP_BLOCK_WINDOW_MS || input.elapsedMs > STARTUP_BLOCK_WINDOW_MS + STARTUP_BLOCK_WINDOW_OPEN_MS) return undefined;
  if (input.transcriptActive) return undefined;
  if (!STARTUP_BLOCK_STATUSES.includes(String(input.status))) return undefined;
  const lines = input.lines.map(line => stripTerminal(line).trim()).filter(Boolean);
  const text = lines.slice(-STARTUP_PROMPT_TAIL_LINES).join("\n");
  if (!text || !STARTUP_PROMPT_MARKER.test(text)) return undefined;
  return text.slice(0, 4000);
}

async function paneRecentLines(server: string, paneId: string): Promise<string[]> {
  const text = await readPaneText(server, paneId, { method: "pane.read", source: "recent", lines: 40, what: "Scheduled run pane read" });
  return text ? text.split(/\r?\n/) : [];
}

/** The watch loop's own words for a failure, instead of assuming Herdr went away. */
export function watchFailureReason(error: unknown): string {
  const first = (error instanceof Error ? error.message : String(error)).split("\n")[0].replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 200);
  return `Watching the scheduled prompt failed: ${first || "unknown error"}`;
}

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
  transcriptStamp?: (source: ScheduleHarness, sessionId: string | undefined) => Promise<{ size: number; mtimeMs: number } | undefined>;
  panes?: (server: string) => Promise<Json[]>;
  finalTurn?: (source: ScheduleHarness, sessionId: string | undefined) => Promise<FinalTurn | undefined>;
}

export interface FinalTurn { completed: boolean; lastAssistant?: string }

const FINAL_TURN_TAIL_BYTES = 512 * 1024;

/** A turn's end as the harness writes it: Claude's end_turn reply or its
 * turn_duration record, Codex's task_complete, opencode's end_turn step. */
function turnEnded(raw: Json, source: ScheduleHarness): boolean {
  const payload = object(raw.payload), message = object(raw.message), data = object(raw.data);
  if (source === "claude") return (raw.type === "assistant" && message.stop_reason === "end_turn")
    || (raw.type === "system" && raw.subtype === "turn_duration");
  if (source === "codex") return raw.type === "event_msg" && ["task_complete", "task_completed"].includes(String(payload.type));
  return data.stop_reason === "end_turn";
}

/** The last assistant reply in a transcript and whether its turn finished.
 * A person's message after the reply opens a new turn, so it clears both. */
export function finalTurnFromLines(lines: readonly string[], source: ScheduleHarness): FinalTurn {
  let completed = false, lastAssistant: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: Json;
    try { raw = object(JSON.parse(line)); } catch { continue; }
    const payload = object(raw.payload);
    const userTurn = source === "claude" ? raw.type === "user" && !raw.isMeta && typeof object(raw.message).content === "string"
      : source === "codex" ? raw.type === "response_item" && payload.type === "message" && payload.role === "user"
      : raw.type === "user/message";
    if (userTurn) { completed = false; lastAssistant = undefined; continue; }
    const text = publicAssistant(raw, source);
    if (text) { lastAssistant = text; completed = false; }
    if (turnEnded(raw, source)) completed = true;
  }
  return { completed, ...(lastAssistant ? { lastAssistant } : {}) };
}

async function realFinalTurn(source: ScheduleHarness, sessionId: string | undefined): Promise<FinalTurn | undefined> {
  if (!sessionId) return undefined;
  const file = await transcriptPath(source, sessionId).catch(() => undefined);
  if (!file) return undefined;
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - FINAL_TURN_TAIL_BYTES), buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    return finalTurnFromLines(start > 0 ? lines.slice(1) : lines, source);
  } catch { return undefined; } finally { await handle.close().catch(() => undefined); }
}

const OPTION_LINE = /^\s*(?:[-*]\s+)?\(?\d{1,2}[.)]\s+\S/;
const CHOICE_WORDS = /\b(?:choose|pick|which|options?|prefer|want|should I|shall I|let me know|decide|approve|confirm|go ahead)\b/i;

function plainLine(line: string): string {
  return line.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** When a finished reply ends by asking the owner something (a question, or
 * numbered options introduced as a choice), the question's first line. */
export function ownerQuestion(text: string): string | undefined {
  const lines = text.replace(/\r/g, "").split("\n").map(line => line.trimEnd());
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  if (!lines.length) return undefined;
  let end = lines.length;
  while (end > 0 && OPTION_LINE.test(lines[end - 1])) end--;
  if (lines.length - end >= 2) {
    let intro = end - 1;
    while (intro >= 0 && !lines[intro].trim()) intro--;
    const line = intro >= 0 ? plainLine(lines[intro]) : "";
    return line && (line.endsWith("?") || (line.endsWith(":") && CHOICE_WORDS.test(line))) ? line : undefined;
  }
  const last = plainLine(lines.at(-1)!);
  if (!/\?\)?$/.test(last)) return undefined;
  let first = lines.length - 1;
  while (first > 0 && lines[first - 1].trim() && !OPTION_LINE.test(lines[first - 1])) first--;
  return plainLine(lines[first]) || last;
}

async function realTranscriptStamp(source: ScheduleHarness, sessionId: string | undefined): Promise<{ size: number; mtimeMs: number } | undefined> {
  if (!sessionId) return undefined;
  const file = await transcriptPath(source, sessionId).catch(() => undefined);
  const metadata = file ? await stat(file).catch(() => undefined) : undefined;
  return metadata ? { size: metadata.size, mtimeMs: metadata.mtimeMs } : undefined;
}

export async function watchHerdrRun(server: string, target: { workspaceId: string; tabId: string; paneId: string }, signal: AbortSignal,
  startup: StartupWatch, env: StartupWatchEnv = {}): Promise<ScheduleRunOutcome> {
  const now = env.now ?? Date.now;
  const pause = env.pause ?? ((ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref(); }));
  const readPane = env.readPane ?? paneRecentLines;
  const resolveSession = env.resolveSession ?? ((name: string, pane: Json) => paneIdentity(name, pane).catch(() => undefined));
  const transcriptStamp = env.transcriptStamp ?? realTranscriptStamp;
  const listPanes = env.panes ?? (async (name: string) => objects((await snapshot(name)).panes));
  const finalTurn = env.finalTurn ?? realFinalTurn;
  let sessionId = startup.sessionId;
  let transcriptActive = false;
  let stamp: { size: number; mtimeMs: number } | undefined;
  let recordedBlock = false;
  let paneReads = 0;
  while (!signal.aborted) {
    await pause(1000);
    if (signal.aborted) break;
    try {
      const pane = findPane({ panes: await listPanes(server) }, { workspace: target.workspaceId, tab: target.tabId, pane: target.paneId });
      if (!pane) return { status: "failed", reason: "The Herdr pane closed before the scheduled prompt finished." };
      const status = String(pane.agent_status);
      // Herdr reports a finished turn as idle, or as done until someone looks
      // at the pane. Either one is the agent stopping on its own.
      if (status === "idle" || status === "done") {
        if (!sessionId) sessionId = await resolveSession(server, pane);
        const turn = await finalTurn(startup.source, sessionId).catch(() => undefined);
        const question = turn?.completed && turn.lastAssistant ? ownerQuestion(turn.lastAssistant) : undefined;
        return question ? { status: "needs-you", reason: question } : { status: "finished" };
      }
      if (!["working", "starting", "blocked", "waiting", "unknown"].includes(status)) {
        return { status: "failed", reason: "The scheduled agent stopped before the prompt finished." };
      }
      const elapsedMs = now() - startup.startedAt;
      const withinWindow = elapsedMs <= STARTUP_BLOCK_WINDOW_MS + STARTUP_BLOCK_WINDOW_OPEN_MS;
      if (!transcriptActive && startup.onBlocked && !recordedBlock && withinWindow) {
        if (!sessionId) sessionId = await resolveSession(server, pane);
        const next = await transcriptStamp(startup.source, sessionId);
        if (next) {
          if (!stamp) {
            stamp = next;
            if (elapsedMs > STARTUP_LATE_TRANSCRIPT_MS) transcriptActive = true;
          } else if (next.size !== stamp.size || next.mtimeMs !== stamp.mtimeMs) {
            stamp = next;
            transcriptActive = true;
          }
        }
      }
      if (!recordedBlock && startup.onBlocked && withinWindow && !transcriptActive
          && elapsedMs >= STARTUP_BLOCK_WINDOW_MS && STARTUP_BLOCK_STATUSES.includes(status)
          && paneReads < STARTUP_PANE_READ_LIMIT) {
        paneReads++;
        const lines = await readPane(server, target.paneId);
        const prompt = classifyStartupBlock({ elapsedMs, transcriptActive, status, lines });
        if (prompt) {
          recordedBlock = true;
          await Promise.resolve(startup.onBlocked(prompt)).catch(() => undefined);
        }
      }
    } catch (error) { return { status: "failed", reason: watchFailureReason(error) }; }
  }
  return { status: "failed", reason: "Phren Hook stopped while the scheduled prompt was running." };
}

async function launchHeadless(context: ScheduleLaunchContext, store: string, started: (child: ChildProcess) => void): Promise<ScheduleLaunchResult> {
  const root = fanoutRoot({ ...process.env, PHREN_PATH: store }), jobDir = path.join(root, context.runId);
  await mkdir(jobDir, { recursive: true, mode: 0o700 });
  const eventLog = "events.jsonl", now = new Date().toISOString();
  const manifest: Record<string, unknown> = { schemaVersion: 1, id: context.runId, provider: context.schedule.harness,
    taskLabel: context.schedule.name, cwd: context.cwd, worktree: context.cwd, ...(context.schedule.model ? { model: context.schedule.model } : {}),
    eventLog, createdAt: now, startedAt: now, updatedAt: now, status: "queued", schedule: { id: context.schedule.id, project: context.project } };
  await writeManifest(jobDir, manifest);
  const command = headlessCommand(context.schedule, context.cwd);
  // An untrusted directory only costs Codex a prompt; the run still starts, and the log says why.
  if (context.schedule.harness === "codex") await ensureCodexDirTrusted(context.cwd).catch(error =>
    logger.warn("schedule", `Could not mark ${path.basename(context.cwd)} trusted for Codex (run ${context.runId}): ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`));
  let child: ChildProcess;
  try { child = spawn(command.file, command.args, { cwd: command.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] }); }
  catch (error) { await writeManifest(jobDir, { ...manifest, status: "failed", updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }); throw error; }
  started(child);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const output = createWriteStream(path.join(jobDir, eventLog), { flags: "a", mode: 0o600 });
  const errors = createWriteStream(path.join(jobDir, "stderr.log"), { flags: "a", mode: 0o600 });
  const streamsFinished = Promise.all([streamFinished(output), streamFinished(errors)]).then(() => undefined).catch(() => undefined);
  child.stdin?.on("error", () => { /* A child that exits before reading is reported by close. */ });
  child.stdout?.pipe(output); child.stderr?.pipe(errors); child.stdin?.end(context.schedule.prompt);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  }).catch(async error => {
    output.end(); errors.end();
    await writeManifest(jobDir, { ...manifest, status: "failed", updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
    throw error;
  });
  await writeManifest(jobDir, { ...manifest, status: "running", updatedAt: new Date().toISOString() });
  const completion = closed.then(async ({ code, signal }): Promise<ScheduleRunOutcome> => {
    await streamsFinished;
    const finishedAt = new Date().toISOString(), ok = code === 0;
    await writeManifest(jobDir, { ...manifest, status: ok ? "completed" : "failed", updatedAt: finishedAt, finishedAt,
      ...(typeof code === "number" ? { exitCode: code } : {}) }).catch(() => {});
    return ok ? { status: "finished" } : { status: "failed", reason: signal ? `The scheduled agent exited after ${signal}.` : `The scheduled agent exited with code ${code ?? "unknown"}.` };
  });
  return { launch: { mode: "headless", jobDir }, completion };
}

export function headlessCommand(schedule: Schedule, cwd: string): { file: string; args: string[]; cwd: string } {
  const model = schedule.model ? ["--model", schedule.model] : [];
  if (schedule.harness === "codex") return { file: "codex", cwd, args: ["exec", ...model, "--sandbox", "workspace-write", "-C", cwd,
    "--skip-git-repo-check", "--json", "-"] };
  if (schedule.harness === "opencode") return { file: "opencode", cwd, args: ["run", "--format", "json", "--dir", cwd, ...model] };
  return { file: "claude", cwd, args: ["-p", "--output-format", "stream-json", "--settings", CLAUDE_SCHEDULE_SETTINGS, ...model] };
}

function tomlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function ensureCodexDirTrusted(cwd: string): Promise<void> {
  const directory = codexHome();
  const file = path.join(directory, "config.toml");
  let text = "";
  try { text = await readFile(file, "utf8"); }
  // An unreadable config is left untouched; the caller logs why.
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const header = `[projects.${tomlQuote(cwd)}]`;
  const trustLine = 'trust_level = "trusted"';
  let next: string;
  const at = text.indexOf(header);
  if (at >= 0) {
    const bodyStart = at + header.length;
    const rest = text.slice(bodyStart);
    const nextTable = rest.search(/^\s*\[/m);
    const section = nextTable >= 0 ? rest.slice(0, nextTable) : rest;
    if (new RegExp(`trust_level\\s*=\\s*"trusted"`).test(section)) return;
    const existing = /^[ \t]*trust_level\s*=.*$/m.exec(section);
    if (existing) {
      const replaced = section.replace(existing[0], existing[0].match(/^[ \t]*/)![0] + trustLine);
      next = text.slice(0, bodyStart) + replaced + rest.slice(section.length);
    } else {
      const newline = section.startsWith("\n") || section.startsWith("\r\n") ? "" : "\n";
      next = text.slice(0, bodyStart) + newline + trustLine + (section.startsWith("\n") || section.startsWith("\r\n") ? section : "\n" + section) + rest.slice(section.length);
    }
  } else {
    const separator = text && !text.endsWith("\n") ? "\n\n" : text ? "\n" : "";
    next = text + `${separator}${header}\n${trustLine}\n`;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await stat(file).catch(() => undefined);
  const mode = metadata ? metadata.mode & 0o777 : 0o600;
  await atomic(file, next, mode);
}

async function writeManifest(jobDir: string, manifest: Record<string, unknown>): Promise<void> {
  await atomicInPrivateDir(path.join(jobDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

export function newScheduleId(existing: Iterable<string>): string {
  const ids = new Set(existing);
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!ids.has(id)) return id;
  }
}

export function scheduleRunsFile(): string { return path.join(bridgeRoot(), "schedule-runs.jsonl"); }
