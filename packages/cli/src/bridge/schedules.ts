import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { finished as streamFinished } from "node:stream/promises";
import * as yaml from "js-yaml";
import { z } from "zod";
import { fanoutRoot } from "./fanouts.js";
import { paneIdentity, rpc, servers, snapshot } from "./herdr.js";
import { BridgeError, bridgeRoot, objects, type Json } from "./protocol.js";
import { getProjectSourcePath } from "../project-config.js";
import { defaultPhrenPath, getProjectDirs } from "../shared.js";

export const SCHEDULE_EVERY = ["interval", "daily", "weekly", "once", "cron"] as const;
export const SCHEDULE_HARNESSES = ["claude", "codex", "opencode"] as const;
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export type ScheduleEvery = typeof SCHEDULE_EVERY[number];
export type ScheduleHarness = typeof SCHEDULE_HARNESSES[number];
export type Weekday = typeof WEEKDAYS[number];
export type ScheduleRunStatus = "launched" | "running" | "finished" | "failed" | "skipped";

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  computer: string;
  harness: ScheduleHarness;
  model?: string;
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
  launch: ScheduleLaunchRecord;
}

export interface ScheduleLaunchResult {
  launch: ScheduleLaunchRecord;
  completion?: Promise<{ status: "finished" | "failed"; reason?: string }>;
}

export interface ScheduleLaunchContext {
  schedule: Schedule;
  project: string;
  projectDir: string;
  cwd: string;
  runId: string;
}

export type ScheduleLauncher = ((context: ScheduleLaunchContext) => Promise<ScheduleLaunchResult>) & { close?: () => void };

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
const runningStatuses = new Set<ScheduleRunStatus>(["launched", "running"]);
const MAX_SCHEDULES = 64;
const MAX_RUNS = 2000;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

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
  const raw = record(value);
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
  const document = record(yaml.load(text, { schema: yaml.CORE_SCHEMA }));
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
  await atomicWrite(schedulePath(projectDir), text);
}

async function atomicWrite(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${randomUUID()}`;
  await writeFile(temporary, text, { mode: 0o600 });
  try { await rename(temporary, file); } finally { await unlink(temporary).catch(() => {}); }
}

export function canonicalComputer(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.endsWith(".local") ? normalized.slice(0, -".local".length) : normalized;
}

export function computerMatches(wanted: string, current: string): boolean {
  return canonicalComputer(wanted) === canonicalComputer(current);
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
      const raw = record(JSON.parse(line));
      const launch = record(raw.launch);
      if (typeof raw.id !== "string" || typeof raw.scheduleId !== "string" || typeof raw.project !== "string"
          || typeof raw.startedAt !== "string" || !["launched", "running", "finished", "failed", "skipped"].includes(String(raw.status))
          || !["herdr", "headless"].includes(String(launch.mode))) continue;
      runs.push(raw as unknown as ScheduleRun);
    } catch { /* A torn final line does not hide older history. */ }
  }
  return runs;
}

export async function writeScheduleRuns(file: string, runs: ScheduleRun[]): Promise<void> {
  const kept = runs.slice(-MAX_RUNS);
  await atomicWrite(file, kept.map(run => JSON.stringify(run)).join("\n") + (kept.length ? "\n" : ""));
}

export class Scheduler {
  private readonly now: () => Date;
  private readonly store: string;
  private readonly launch: ScheduleLauncher;
  private readonly runsFile: string;
  private readonly computer: () => string;
  private readonly locateProject: (project: string) => Promise<string | undefined>;
  private serial: Promise<void> = Promise.resolve();
  private ticking = false;

  constructor(options: { now: () => Date; store: string; launch: ScheduleLauncher; runsFile: string; computer?: string | (() => string);
    locateProject?: (project: string) => Promise<string | undefined> }) {
    this.now = options.now; this.store = options.store; this.launch = options.launch; this.runsFile = options.runsFile;
    if (typeof options.computer === "function") this.computer = options.computer;
    else { const computer = options.computer; this.computer = () => computer ?? hostname(); }
    this.locateProject = options.locateProject ?? (async () => undefined);
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

  async statuses(): Promise<{ computer: string; schedules: ScheduleStatus[] }> {
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
            ...(last.reason ? { reason: last.reason } : {}), launch: last.launch } : null, running });
      }
    }
    return { computer, schedules: result };
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
        cwd: prepared.cwd, runId: prepared.run.id });
      const running = await this.updateRun(prepared.run.id, { status: "running", launch: launched.launch });
      if (launched.completion) void launched.completion.then(result => this.finishRun(prepared.run.id, result.status, result.reason))
        .catch(error => this.finishRun(prepared.run.id, "failed", error instanceof Error ? error.message : "The scheduled agent failed."));
      return running;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The scheduled agent could not start.";
      await this.finishRun(prepared.run.id, "failed", reason);
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

  private async finishRun(id: string, status: "finished" | "failed", reason?: string): Promise<void> {
    await this.updateRun(id, { status, finishedAt: this.now().toISOString(), ...(reason ? { reason } : {}) });
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
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
  await rpc(server, "agent.prompt", { target: paneId, text: context.schedule.prompt });
  let sessionId = typeof launched.sessionId === "string" ? launched.sessionId : undefined;
  for (let attempt = 0; attempt < 10 && !sessionId; attempt++) {
    const pane = objects((await snapshot(server)).panes).find(item => item.workspace_id === workspaceId && item.tab_id === tabId && item.pane_id === paneId);
    if (pane) sessionId = await paneIdentity(server, pane).catch(() => undefined);
    if (!sessionId) await new Promise(resolve => setTimeout(resolve, 200));
  }
  const launch: ScheduleLaunchRecord = { mode: "herdr", workspaceId, tabId, paneId,
    ...(sessionId ? { sessionId } : {}) };
  return { launch, completion: watchHerdrRun(server, { workspaceId, tabId, paneId }, signal) };
}

async function watchHerdrRun(server: string, target: { workspaceId: string; tabId: string; paneId: string }, signal: AbortSignal): Promise<{ status: "finished" | "failed"; reason?: string }> {
  while (!signal.aborted) {
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, 1000); timer.unref(); });
    if (signal.aborted) break;
    try {
      const pane = objects((await snapshot(server)).panes).find(item => item.workspace_id === target.workspaceId
        && item.tab_id === target.tabId && item.pane_id === target.paneId);
      if (!pane) return { status: "failed", reason: "The Herdr pane closed before the scheduled prompt finished." };
      const status = String(pane.agent_status);
      if (status === "idle") return { status: "finished" };
      if (!["working", "starting", "blocked", "waiting", "unknown"].includes(status)) {
        return { status: "failed", reason: "The scheduled agent stopped before the prompt finished." };
      }
    } catch { return { status: "failed", reason: "Herdr disconnected while the scheduled prompt was running." }; }
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
  let child: ChildProcess;
  try { child = spawn(command.file, command.args, { cwd: context.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] }); }
  catch (error) { await writeManifest(jobDir, { ...manifest, status: "failed", updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }); throw error; }
  started(child);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const output = createWriteStream(path.join(jobDir, eventLog), { flags: "a", mode: 0o600 });
  const errors = createWriteStream(path.join(jobDir, "stderr.log"), { flags: "a", mode: 0o600 });
  const streamsFinished = Promise.all([streamFinished(output), streamFinished(errors)]).then(() => undefined).catch(() => undefined);
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
  const completion = closed.then(async ({ code, signal }): Promise<{ status: "finished" | "failed"; reason?: string }> => {
    await streamsFinished;
    const finishedAt = new Date().toISOString(), ok = code === 0;
    await writeManifest(jobDir, { ...manifest, status: ok ? "completed" : "failed", updatedAt: finishedAt, finishedAt,
      ...(typeof code === "number" ? { exitCode: code } : {}) }).catch(() => {});
    return ok ? { status: "finished" } : { status: "failed", reason: signal ? `The scheduled agent exited after ${signal}.` : `The scheduled agent exited with code ${code ?? "unknown"}.` };
  });
  return { launch: { mode: "headless", jobDir }, completion };
}

function headlessCommand(schedule: Schedule, cwd: string): { file: string; args: string[] } {
  const model = schedule.model ? ["--model", schedule.model] : [];
  if (schedule.harness === "codex") return { file: "codex", args: ["exec", ...model, "--sandbox", "workspace-write", "-C", cwd, "--json", "-"] };
  if (schedule.harness === "opencode") return { file: "opencode", args: ["run", "--format", "json", "--dir", cwd, ...model] };
  return { file: "claude", args: ["-p", "--output-format", "stream-json", ...model] };
}

async function writeManifest(jobDir: string, manifest: Record<string, unknown>): Promise<void> {
  await atomicWrite(path.join(jobDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

export function newScheduleId(existing: Iterable<string>): string {
  const ids = new Set(existing);
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!ids.has(id)) return id;
  }
}

export function scheduleRunsFile(): string { return path.join(bridgeRoot(), "schedule-runs.jsonl"); }
