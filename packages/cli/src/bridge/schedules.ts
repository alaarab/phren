import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import type { SchedulePush, SchedulePushKind, SchedulePushResult } from "./push.js";
import { BridgeError } from "./protocol.js";
import { getProjectSourcePath } from "../project-config.js";
import { getProjectDirs } from "../shared.js";
import {
  computerMatches, nextRun, readScheduleDocument, readScheduleRuns, runningStatuses, scheduleNotifications, scheduleSessionRoute,
  writeScheduleDocument, writeScheduleRuns,
  type Schedule, type ScheduleLauncher, type ScheduleNotify, type ScheduleRun, type ScheduleRunOutcome, type SchedulePushSender, type ScheduleStatus,
} from "./schedule-format.js";

export * from "./schedule-format.js";
export * from "./schedule-launch.js";
export * from "./schedule-watch.js";

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
  /** Runs this process launched; any other open run was left by an earlier Hook. */
  private readonly own = new Set<string>();
  private recovered = false;
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
      this.own.add(run.id);
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

  /**
   * Settles the runs an earlier Hook process left open (a restart or crash
   * mid-run). Each is followed to its real end where the launcher can, and
   * otherwise failed with the reason, since an open run blocks its schedule
   * for good. Runs once, on the first tick, with a launcher that can resume.
   */
  async recoverOpenRuns(): Promise<void> {
    const resume = this.launch.resume;
    if (this.recovered || !resume) return;
    this.recovered = true;
    const open = (await readScheduleRuns(this.runsFile)).filter(run => runningStatuses.has(run.status) && !this.own.has(run.id));
    for (const run of open) {
      this.own.add(run.id);
      let schedule: Schedule | undefined;
      try { schedule = (await readScheduleDocument(this.projectDirectory(run.project))).schedules.find(item => item.id === run.scheduleId); }
      catch { schedule = undefined; }
      if (!schedule) {
        await this.updateRun(run.id, { status: "failed", finishedAt: this.now().toISOString(),
          reason: "Phren Hook restarted during this run, and its schedule no longer exists." })
          .catch(error => this.log(`[schedule] Could not close run ${run.id}: ${String(error)}`));
        continue;
      }
      const known = schedule;
      this.log(`[schedule] Following run ${run.id} of "${known.name}", left ${run.status} by an earlier Hook process.`);
      void resume(run, known)
        .catch((error): ScheduleRunOutcome => ({ status: "failed", reason: error instanceof Error ? error.message : "The scheduled agent failed." }))
        .then(result => this.finishRun(run.id, known, result.status, result.reason))
        .catch(error => this.log(`[schedule] Could not finish run ${run.id}: ${String(error)}`));
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.lastTickAt = this.now();
    try {
      await this.recoverOpenRuns().catch(error => this.log(`[schedule] Recovering open runs failed: ${String(error)}`));
      const status = await this.statuses(), now = this.now();
      for (const schedule of status.schedules) {
        if (!schedule.enabled || schedule.running || !schedule.nextRun || new Date(schedule.nextRun) > now) continue;
        await this.launchNow(schedule.project, schedule.id).catch(() => {});
      }
    } finally { this.ticking = false; }
  }

  close(): void { this.launch.close?.(); }
}
