import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { localNames, stableComputerName } from "./computer-names.js";
import path from "node:path";
import type { SchedulePush, SchedulePushKind, SchedulePushResult } from "./push.js";
import { BridgeError } from "./protocol.js";
import { getProjectSourcePath } from "../project-config.js";
import { getProjectDirs } from "../shared.js";
import {
  computerMatches, latestScheduleBatch, nextRun, readScheduleDocument, readScheduleRuns, runningStatuses, scheduleNotifications, scheduleSessionRoute,
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
  /** Every name this computer answers to; a schedule names one of them. */
  private readonly names: () => string[];
  private readonly locateProject: (project: string) => Promise<string | undefined>;
  private readonly push?: SchedulePushSender;
  private readonly log: (message: string) => void;
  private serial: Promise<void> = Promise.resolve();
  private ticking = false;
  private readonly dispatching = new Set<string>();
  /** Runs this process launched; any other open run was left by an earlier Hook. */
  private readonly own = new Set<string>();
  private recovered = false;
  /** When the scheduler last looked for due work; a health read shows it. */
  lastTickAt?: Date;

  constructor(options: { now: () => Date; store: string; launch: ScheduleLauncher; runsFile: string; computer?: string | (() => string);
    /** Further names this computer answers to, such as its Hook computer id. */
    aliases?: string[];
    locateProject?: (project: string) => Promise<string | undefined>; push?: SchedulePushSender; log?: (message: string) => void }) {
    this.now = options.now; this.store = options.store; this.launch = options.launch; this.runsFile = options.runsFile;
    if (typeof options.computer === "function") this.computer = options.computer;
    else { const computer = options.computer; this.computer = () => computer ?? stableComputerName(); }
    const aliases = options.aliases ?? [];
    this.names = options.computer === undefined ? () => [...localNames(), ...aliases] : () => [this.computer(), ...aliases];
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

  private owns(schedule: Schedule, names = this.names()): boolean {
    return names.some(name => computerMatches(schedule.computer, name));
  }

  async statuses(): Promise<{ computer: string; timeZone: string; schedules: ScheduleStatus[] }> {
    const runs = await readScheduleRuns(this.runsFile), result: ScheduleStatus[] = [], computer = this.computer(), names = this.names();
    for (const directory of this.projectDirectories()) {
      let schedules: Schedule[];
      try { schedules = (await readScheduleDocument(directory)).schedules; } catch { continue; }
      const project = path.basename(directory);
      for (const schedule of schedules) {
        const matching = runs.filter(run => (run.scheduleProject ?? run.project) === project && run.scheduleId === schedule.id);
        const { lastRun: last, lastRuns } = latestScheduleBatch(matching);
        const running = matching.some(run => runningStatuses.has(run.status));
        const due = this.owns(schedule, names) ? nextRun(schedule, last) : null;
        const owned = this.owns(schedule, names);
        result.push({ ...schedule, project, lastRuns, owned, nextRun: due?.toISOString() ?? null,
          lastRun: last ? { startedAt: last.startedAt, ...(last.finishedAt ? { finishedAt: last.finishedAt } : {}), status: last.status,
            ...(last.batchId ? { batchId: last.batchId, scheduleProject: last.scheduleProject } : {}),
            ...(last.reason ? { reason: last.reason } : {}),
            ...(last.blockedStartupPrompt ? { blockedStartupPrompt: last.blockedStartupPrompt } : {}),
            ...(last.blockNotified !== undefined ? { blockNotified: last.blockNotified } : {}), launch: last.launch } : null, running });
      }
    }
    return { computer, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, schedules: result };
  }

  async history(filters: { project?: string; id?: string; limit?: number } = {}): Promise<ScheduleRun[]> {
    const limit = Math.min(500, Math.max(1, filters.limit ?? 50));
    return (await readScheduleRuns(this.runsFile)).filter(run => (!filters.project || (run.scheduleProject ?? run.project).toLowerCase() === filters.project.toLowerCase())
      && (!filters.id || run.scheduleId === filters.id)).slice(-limit).reverse();
  }

  async launchNow(projectName: string, id: string, onlyIfDue = false, expectedUpdatedAt?: string): Promise<ScheduleRun[]> {
    const key = `${projectName.toLowerCase()}/${id}`;
    if (this.dispatching.has(key)) throw new BridgeError(409, "This schedule is already launching.");
    this.dispatching.add(key);
    try { return await this.prepareAndLaunch(projectName, id, onlyIfDue, expectedUpdatedAt); }
    finally { this.dispatching.delete(key); }
  }

  private async prepareAndLaunch(projectName: string, id: string, onlyIfDue: boolean, expectedUpdatedAt?: string): Promise<ScheduleRun[]> {
    const prepared = await this.exclusive(async () => {
      const projectDir = this.projectDirectory(projectName), project = path.basename(projectDir);
      const file = await readScheduleDocument(projectDir), schedule = file.schedules.find(item => item.id === id);
      if (!schedule) throw new BridgeError(404, `Schedule "${id}" was not found in ${project}.`);
      if (expectedUpdatedAt !== undefined && Date.parse(expectedUpdatedAt) !== Date.parse(schedule.updatedAt)) {
        throw new BridgeError(409, "This computer has a different schedule revision. Wait for store sync to finish, refresh the schedule, and try Run now again.");
      }
      if (!this.owns(schedule)) throw new BridgeError(409, `${schedule.computer} owns this schedule; run it from that computer.`);
      const runs = await readScheduleRuns(this.runsFile);
      const matching = runs.filter(run => (run.scheduleProject ?? run.project) === project && run.scheduleId === id);
      if (matching.some(run => runningStatuses.has(run.status))) {
        throw new BridgeError(409, `Schedule "${schedule.name}" is already running.`);
      }
      // Recheck a tick's snapshot after a concurrent Run now or schedule edit.
      const due = nextRun(schedule, matching.at(-1));
      if (onlyIfDue && (!schedule.enabled || !due || due > this.now())) return undefined;
      const targets = [];
      for (const name of schedule.projects ?? [project]) {
        const targetDir = this.projectDirectory(name), target = path.basename(targetDir);
        const source = getProjectSourcePath(this.store, target) ?? await this.locateProject(target);
        if (!source && schedule.projects) throw new BridgeError(409, `No source directory for project "${target}" on this computer.`);
        const cwd = source ?? targetDir;
        if (!await stat(cwd).then(info => info.isDirectory()).catch(() => false)) {
          throw new BridgeError(409, `Source directory for project "${target}" is unavailable: ${cwd}`);
        }
        targets.push({ project: target, projectDir: targetDir, cwd });
      }
      const batchId = randomUUID(), startedAt = this.now().toISOString();
      const children = targets.map(target => ({ ...target, run: {
        id: randomUUID(), scheduleId: id, project: target.project, scheduleProject: project, batchId,
        startedAt, status: "launched", launch: { mode: "headless" },
      } as ScheduleRun }));
      // One atomic replacement reserves every target before any external launch.
      await writeScheduleRuns(this.runsFile, [...runs, ...children.map(child => child.run)]);
      for (const child of children) this.own.add(child.run.id);
      if (schedule.every === "once" && schedule.enabled) {
        const schedules = file.schedules.map(item => item.id === id ? { ...item, enabled: false, updatedAt: startedAt } : item);
        try { await writeScheduleDocument(projectDir, schedules, file.document); }
        catch (error) {
          // The durable batch already consumes the occurrence. A YAML write
          // failure must not strand pending children in this running process.
          this.log(`[schedule] Could not disable consumed once schedule ${project}/${id}: ${String(error)}`);
        }
      }
      return { schedule, children };
    });
    if (!prepared) return [];
    // Independent attempts: one target's startup failure never cancels siblings.
    return Promise.all(prepared.children.map(async child => {
      try {
        const launched = await this.launch({ schedule: prepared.schedule, project: child.project, projectDir: child.projectDir,
          cwd: child.cwd, runId: child.run.id,
          blockedStartup: promptText => this.recordBlockedStartup(child.run.id, prepared.schedule, promptText) });
        const running = await this.updateRun(child.run.id, { status: "running", launch: launched.launch });
        const notified = this.notifyRun(running, prepared.schedule, "scheduleStarted");
        if (launched.completion) void launched.completion.then(async result => {
          await this.finishRun(child.run.id, prepared.schedule, result.status, result.reason, notified);
        }).catch(async error => {
          await this.finishRun(child.run.id, prepared.schedule, "failed",
            error instanceof Error ? error.message : "The scheduled agent failed.", notified);
        }).catch(error => this.log(`[schedule] Could not finish run ${child.run.id}: ${String(error)}`));
        await notified;
        return running;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "The scheduled agent could not start.";
        return this.finishRun(child.run.id, prepared.schedule, "failed", reason);
      }
    }));
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
    previousNotification?: Promise<unknown>): Promise<ScheduleRun> {
    const run = await this.updateRun(id, { status, finishedAt: this.now().toISOString(), ...(reason ? { reason } : {}) });
    await previousNotification;
    if (run.blockedStartupPrompt && run.blockNotified) return run;
    await this.notifyRun(run, schedule, status === "failed" ? "scheduleFailed" : "scheduleFinished");
    return run;
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
    const open = await this.exclusive(async () => {
      const pending = (await readScheduleRuns(this.runsFile)).filter(run => runningStatuses.has(run.status) && !this.own.has(run.id));
      for (const run of pending) this.own.add(run.id);
      return pending;
    });
    for (const run of open) {
      let schedule: Schedule | undefined;
      try { schedule = (await readScheduleDocument(this.projectDirectory(run.scheduleProject ?? run.project))).schedules.find(item => item.id === run.scheduleId); }
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
        await this.launchNow(schedule.project, schedule.id, true).catch(() => {});
      }
    } finally { this.ticking = false; }
  }

  close(): void { this.launch.close?.(); }
}
