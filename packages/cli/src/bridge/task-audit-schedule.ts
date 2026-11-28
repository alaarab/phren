/**
 * The weekly per-project task audit on the Hook (issue #934): an hourly ticker
 * that starts one audit (`phren task audit`, bridge → task/audit.ts) for each
 * project whose `dreaming` config is enabled, whose window is open, where no
 * agent is working, and whose last audit is 7+ days old or missing.
 *
 * It borrows dream-schedule.ts's shape (an injected clock, a non-reentrant
 * `tick`, a timer in server.ts) rather than its cadence: an audit is weekly,
 * so the dreaming config is reused only as the on/off and window gate the
 * owner already tuned for offline passes, and `PHREN_TASK_AUDIT=off` stops the
 * ticker alone. Each audit runs as `phren task audit --project <p> --scheduled`
 * in a niced child, so the helper model never blocks the Hook; the CLI records
 * `task-audits/last-run.json` the same way for manual and scheduled runs.
 */

import { spawn } from "node:child_process";
import * as os from "node:os";
import { insideDreamWindow, type DreamingConfig } from "../config/dreaming.js";
import { TASKS_RETIRED } from "../task/retired.js";
import type { DreamSession } from "./dream-schedule.js";

export { readAuditLastRun, type AuditLastRun } from "../task/audit.js";
import type { AuditLastRun } from "../task/audit.js";

export const TASK_AUDIT_TICK_MS = 60 * 60_000;
/** After starting an audit for a project, the ticker leaves it alone this long, whatever the outcome. */
export const TASK_AUDIT_RETRY_MS = 6 * 60 * 60_000;
/** A project is due again this many days after its last audit, whatever that audit's status was. */
export const TASK_AUDIT_INTERVAL_MS = 7 * 24 * 60 * 60_000;
/** A scheduled audit that runs longer than this is stopped. */
export const TASK_AUDIT_CHILD_TIMEOUT_MS = 45 * 60_000;

/** Only confirmed resting states permit an audit beside an open session (dream-schedule's rule). */
const SAFE_STATUSES = new Set(["idle", "done"]);

// ── Eligibility ──────────────────────────────────────────────────────────────

export interface TaskAuditEligibilityInput {
  config: DreamingConfig;
  now: Date;
  lastAuditAt?: Date;
  /** Live sessions in this project only. Undefined when the caller cannot see sessions. */
  sessions?: DreamSession[];
}

export interface TaskAuditEligibility {
  eligible: boolean;
  /** Plain-English why (not). */
  reason: string;
}

/** Whether a scheduled task audit may start for one project now. Pure; tested directly. */
export function taskAuditEligibility(input: TaskAuditEligibilityInput): TaskAuditEligibility {
  const { config, now, lastAuditAt, sessions } = input;
  if (!config.enabled) return { eligible: false, reason: "Dreaming is off for this project, so its weekly task audit is too." };
  if (!insideDreamWindow(config.window, now)) return { eligible: false, reason: `Outside the ${config.window} window.` };
  if (lastAuditAt !== undefined && now.getTime() - lastAuditAt.getTime() < TASK_AUDIT_INTERVAL_MS) {
    const days = Math.max(1, Math.round((now.getTime() - lastAuditAt.getTime()) / (24 * 60 * 60_000)));
    return { eligible: false, reason: `Audited ${days} day${days === 1 ? "" : "s"} ago; the weekly audit is not due yet.` };
  }
  if (sessions?.some((session) => !SAFE_STATUSES.has(String(session.status)))) {
    return { eligible: false, reason: "An agent is working in the project; the audit never runs beside one." };
  }
  return { eligible: true, reason: "The last audit is 7+ days old (or there has never been one)." };
}

// ── The ticker ───────────────────────────────────────────────────────────────

export interface TaskAuditSchedulerDeps {
  now: () => Date;
  /** Project names in the store the Hook serves. */
  projects: () => string[];
  /** The project's dreaming config: only its `enabled` flag and `window` gate the audit. */
  config: (project: string) => DreamingConfig;
  lastRun: (project: string) => AuditLastRun | undefined;
  /** This computer's live agent sessions with their project. Rejects when unknown; the tick is then skipped. */
  liveSessions: () => Promise<DreamSession[]>;
  /** Start one audit and resolve when it ends. */
  run: (project: string) => Promise<void>;
}

export class TaskAuditScheduler {
  private ticking = false;
  /** When the ticker last started an audit for each project, so a failing run is not retried every tick. */
  private readonly lastAttempt = new Map<string, Date>();

  constructor(private readonly deps: TaskAuditSchedulerDeps) {}

  private decide(project: string, sessions: DreamSession[], now: Date): TaskAuditEligibility {
    const attempted = this.lastAttempt.get(project);
    if (attempted && now.getTime() - attempted.getTime() < TASK_AUDIT_RETRY_MS) {
      return { eligible: false, reason: "A task audit started for this project within the last six hours." };
    }
    const lastRun = this.deps.lastRun(project);
    return taskAuditEligibility({
      config: this.deps.config(project),
      now,
      lastAuditAt: lastRun ? new Date(lastRun.at) : undefined,
      sessions: sessions.filter((session) => !session.project || session.project === project),
    });
  }

  /** Projects whose audit would start now, given these sessions. Exposed for tests and diagnostics. */
  due(sessions: DreamSession[], now = this.deps.now()): string[] {
    return this.deps.projects().filter((project) => this.decide(project, sessions, now).eligible);
  }

  async tick(): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const started: string[] = [];
    try {
      let sessions = await this.deps.liveSessions();
      for (const project of this.deps.projects()) {
        if (!this.decide(project, sessions, this.deps.now()).eligible) continue;
        // An earlier audit in this tick may have taken most of an hour: look again before starting.
        if (started.length) {
          sessions = await this.deps.liveSessions();
          if (!this.decide(project, sessions, this.deps.now()).eligible) continue;
        }
        this.lastAttempt.set(project, this.deps.now());
        started.push(project);
        await this.deps.run(project).catch(() => {});
      }
    } catch {
      // Sessions unknown: never guess that nobody is working.
    } finally {
      this.ticking = false;
    }
    return started;
  }
}

// ── The child and its flag ────────────────────────────────────────────────────

/** Off with `PHREN_TASK_AUDIT=off`; otherwise the ticker runs and each project's dreaming config decides. */
export function taskAuditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // tasks retired (0.4.0)
  if (TASKS_RETIRED) return false;
  return env.PHREN_TASK_AUDIT?.trim().toLowerCase() !== "off";
}

/** The command that runs one audit; `PHREN_DREAM_COMMAND` points it at a specific phren binary. */
export function taskAuditCommand(project: string, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  return { command: env.PHREN_DREAM_COMMAND?.trim() || "phren", args: ["task", "audit", "--project", project, "--scheduled"] };
}

/** Run one scheduled audit as a low-priority child process of the Hook. */
export function runTaskAuditChild(store: string, project: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { command, args } = taskAuditCommand(project, env);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { env: { ...env, PHREN_PATH: store }, stdio: "ignore", shell: process.platform === "win32" });
    } catch {
      resolve();
      return;
    }
    // Children (the helper's `claude -p`) inherit this on POSIX.
    try { if (child.pid) os.setPriority(child.pid, 10); } catch { /* Not permitted here; run at normal priority. */ }
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* gone */ } }, TASK_AUDIT_CHILD_TIMEOUT_MS);
    timer.unref();
    const done = () => { clearTimeout(timer); resolve(); };
    child.once("error", done);
    child.once("exit", done);
  });
}
