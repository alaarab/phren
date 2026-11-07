/**
 * Dreaming on the Hook: a ticker that starts a dream (docs/dreaming.md) for
 * each project whose `dreaming` config makes one due, one project at a time.
 *
 * Why not `schedules.ts`: a schedule there is a prompt typed into a new agent
 * pane on a fixed timing, recorded in `schedules.yaml` and launched through
 * Herdr. A dream is no pane and no prompt: it is a headless pass whose timing
 * depends on per-project config, on whether anyone is working in the project
 * and on its own last-run marker. So this is a small module of its own that
 * borrows schedules.ts's shape (an injected clock, a non-reentrant `tick`, a
 * timer in server.ts) rather than a schedule entry.
 *
 * Each dream runs as `phren dream run --project <p> --scheduled` in a child
 * process at low CPU priority, so the dream engine and its helper (`claude -p`,
 * which inherits the niceness) never block or crash the Hook, and the CLI
 * records `dreams/last-run.json` the same way for manual and scheduled runs.
 */

import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_DREAMING_CONFIG, getDreamingConfig, insideDreamWindow, parseDreamWindow, type DreamingConfig } from "../config/dreaming.js";
import { storeAwareProjectPath } from "../store-routing.js";
import { getProjectDirs } from "../phren-paths.js";
import { detectProject } from "../shared/index.js";
import { effectivePaneEvidence } from "./session-evidence.js";
import { resolveEffectiveStatus } from "./session-activity.js";
import { paneChatState } from "./herdr.js";
import type { AgentHooks } from "./agent-hooks.js";
import type { CodexQuestions } from "./questions.js";
import { paneProject } from "./approval-summary.js";

export const DREAM_TICK_MS = 10 * 60_000;
/** After starting a dream for a project, the ticker leaves it alone this long, whatever the outcome. */
export const DREAM_RETRY_MS = 60 * 60_000;
/** A scheduled dream that runs longer than this is stopped. */
export const DREAM_CHILD_TIMEOUT_MS = 45 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Only confirmed resting states permit a dream beside an open session. */
const SAFE_STATUSES = new Set(["idle", "done"]);

/** One live agent session as the Hook sees it. */
export interface DreamSession { project?: string; status?: string }

export { readLastRun, type DreamLastRun } from "../dream/apply.js";
import { pendingDreamProposals, readLastRun, type DreamLastRun } from "../dream/apply.js";

export function dreamsDir(phrenPath: string, project: string): string | null {
  return storeAwareProjectPath(phrenPath, project, "dreams");
}

/**
 * Per-status counts from a dream result, read loosely so the engine's result
 * shape can grow: `counts` if it reports one, else its per-change `outcomes`
 * (or `changes`) tallied by `status`/`outcome`.
 */
export function dreamOutcomeCounts(result: unknown): Record<string, number> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  if (record.counts && typeof record.counts === "object" && !Array.isArray(record.counts)) {
    const counts = Object.fromEntries(Object.entries(record.counts).filter(([, n]) => typeof n === "number")) as Record<string, number>;
    if (Object.keys(counts).length) return counts;
  }
  const list = [record.outcomes, record.changes].find(Array.isArray) as unknown[] | undefined;
  if (!list) return undefined;
  const counts: Record<string, number> = {};
  for (const item of list) {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const key = typeof row.status === "string" ? row.status : typeof row.outcome === "string" ? row.outcome : "total";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// ── Eligibility ──────────────────────────────────────────────────────────────

function windowOf(config: DreamingConfig) {
  return parseDreamWindow(config.window) ?? parseDreamWindow(DEFAULT_DREAMING_CONFIG.window)!;
}

function atMinute(day: Date, minute: number): Date {
  const date = new Date(day);
  date.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return date;
}

/** The latest local start of the window at or before `now`. */
export function windowStartAtOrBefore(config: DreamingConfig, now: Date): Date {
  const start = atMinute(now, windowOf(config).start);
  if (start.getTime() > now.getTime()) start.setDate(start.getDate() - 1);
  return start;
}

/** The first local start of the window after `now`. */
export function nextWindowStart(config: DreamingConfig, now: Date): Date {
  const start = atMinute(now, windowOf(config).start);
  if (start.getTime() <= now.getTime()) start.setDate(start.getDate() + 1);
  return start;
}

export interface DreamEligibilityInput {
  config: DreamingConfig;
  now: Date;
  lastRunAt?: Date;
  /** Live sessions in this project only. Undefined when the caller cannot see sessions (CLI status). */
  sessions?: DreamSession[];
  /** For the idle cadence: when the Hook last saw a live session in this project. */
  lastSeenAt?: Date;
}

export interface DreamEligibility {
  eligible: boolean;
  /** Plain-English why (not). */
  reason: string;
  /** When a dream could next start, when that can be known. */
  nextEligibleAt?: Date;
}

/** Whether a scheduled dream may start for one project now. Pure; tested directly. */
export function dreamEligibility(input: DreamEligibilityInput): DreamEligibility {
  const { config, now, lastRunAt, sessions, lastSeenAt } = input;
  if (!config.enabled) return { eligible: false, reason: "Dreaming is off for this project." };
  if (config.cadence === "manual") return { eligible: false, reason: "Cadence is manual: dreams run only with `phren dream run`." };

  let timing: DreamEligibility;
  if (config.cadence === "idle") {
    const idleMs = config.idleMinutes * 60_000;
    if (sessions && sessions.length) {
      timing = { eligible: false, reason: `A live agent session is open in the project; waits until ${config.idleMinutes} minutes after it closes.` };
    } else if (!lastSeenAt) {
      timing = { eligible: false, reason: "No session seen in the project since the Hook started; an idle dream follows work." };
    } else if (lastRunAt && lastRunAt.getTime() >= lastSeenAt.getTime()) {
      timing = { eligible: false, reason: "Nothing new since the last dream; waits for the next session to end." };
    } else if (now.getTime() - lastSeenAt.getTime() < idleMs) {
      timing = { eligible: false, reason: `Waiting for ${config.idleMinutes} idle minutes.`, nextEligibleAt: new Date(lastSeenAt.getTime() + idleMs) };
    } else {
      timing = { eligible: true, reason: `No live session for ${config.idleMinutes}+ minutes.` };
    }
  } else {
    const inside = insideDreamWindow(config.window, now);
    const currentStart = windowStartAtOrBefore(config, now);
    // A run counts for this window when it finished after the window opened (nightly), or less
    // than six days before it (weekly: once in any seven consecutive windows).
    const cutoff = config.cadence === "weekly" ? new Date(currentStart.getTime() - 6 * DAY_MS) : currentStart;
    const ranThisPeriod = lastRunAt !== undefined && lastRunAt.getTime() >= cutoff.getTime();
    if (ranThisPeriod) {
      const next = config.cadence === "weekly"
        ? new Date(windowStartAtOrBefore(config, lastRunAt!).getTime() + 7 * DAY_MS)
        : nextWindowStart(config, now);
      timing = { eligible: false, reason: `Already dreamed ${config.cadence === "weekly" ? "this week" : "in this window"}.`,
        nextEligibleAt: next.getTime() > now.getTime() ? next : nextWindowStart(config, now) };
    } else if (!inside) {
      timing = { eligible: false, reason: `Outside the ${config.window} window.`, nextEligibleAt: nextWindowStart(config, now) };
    } else {
      timing = { eligible: true, reason: `Inside the ${config.window} window.` };
    }
  }
  if (!timing.eligible) return timing;
  if (sessions?.some((session) => !SAFE_STATUSES.has(String(session.status)))) {
    return { eligible: false, reason: "An agent is working in the project; a dream never runs beside one." };
  }
  return timing.eligible && !timing.nextEligibleAt ? { ...timing, nextEligibleAt: now } : timing;
}

/** What `phren dream status` and `dream_status` report for one project. */
export interface DreamStatus {
  project: string;
  enabled: boolean;
  mode: DreamingConfig["mode"];
  cadence: DreamingConfig["cadence"];
  window: string;
  lastRun?: DreamLastRun;
  /** Null when no scheduled dream will start (off or manual). */
  nextEligibleAt: string | null;
  reason: string;
  lastOutcome?: Record<string, number>;
  /** The helper account and model a dream would use, or why there is none. */
  runsOn?: string;
  pendingProposals: number;
}

/**
 * The status of one project from config and the last-run marker. Live sessions
 * are not consulted (that needs the Hook), so "eligible now" means as far as
 * timing goes; the Hook still waits for working agents.
 */
export function dreamStatus(phrenPath: string, project: string, now = new Date()): DreamStatus {
  const config = getDreamingConfig(phrenPath, project);
  const lastRun = readLastRun(phrenPath, project);
  const lastRunAt = lastRun ? new Date(lastRun.at) : undefined;
  // Idle timing depends on the Hook's view of sessions, so only its rule is reported.
  const idle = config.enabled && config.cadence === "idle";
  const decision: DreamEligibility = idle
    ? { eligible: false, reason: `After ${config.idleMinutes} minutes with no live agent session in the project (the Hook checks every 10 minutes).` }
    : dreamEligibility({ config, now, lastRunAt });
  return {
    project,
    enabled: config.enabled,
    pendingProposals: pendingDreamProposals(phrenPath, project),
    mode: config.mode,
    cadence: config.cadence,
    window: config.window,
    ...(lastRun ? { lastRun } : {}),
    nextEligibleAt: !config.enabled || config.cadence === "manual" || idle ? null : (decision.nextEligibleAt ?? now).toISOString(),
    reason: decision.reason,
    ...(lastRun?.counts ? { lastOutcome: { ...lastRun.counts } } : {}),
  };
}

// ── The ticker ───────────────────────────────────────────────────────────────

export interface DreamSchedulerDeps {
  now: () => Date;
  /** Project names in the store the Hook serves. */
  projects: () => string[];
  config: (project: string) => DreamingConfig;
  lastRun: (project: string) => DreamLastRun | undefined;
  /** This computer's live agent sessions with their project. Rejects when unknown; the tick is then skipped. */
  liveSessions: () => Promise<DreamSession[]>;
  /** Start one dream and resolve when it ends. */
  run: (project: string) => Promise<void>;
}

export class DreamScheduler {
  private ticking = false;
  /** When a live session was last seen in each project (for the idle cadence). */
  private readonly lastSeen = new Map<string, Date>();
  /** When the ticker last started a dream for each project, so a failing run is not retried every tick. */
  private readonly lastAttempt = new Map<string, Date>();

  constructor(private readonly deps: DreamSchedulerDeps) {}

  private observe(sessions: DreamSession[], now: Date): void {
    for (const session of sessions) if (session.project) this.lastSeen.set(session.project, now);
  }

  private decide(project: string, sessions: DreamSession[], now: Date): DreamEligibility {
    const config = this.deps.config(project);
    const lastRun = this.deps.lastRun(project);
    const attempted = this.lastAttempt.get(project);
    if (attempted && now.getTime() - attempted.getTime() < DREAM_RETRY_MS) {
      return { eligible: false, reason: "A dream started for this project within the last hour." };
    }
    return dreamEligibility({ config, now, lastRunAt: lastRun ? new Date(lastRun.at) : undefined,
      sessions: sessions.filter((session) => !session.project || session.project === project), lastSeenAt: this.lastSeen.get(project) });
  }

  /** Projects whose dream would start now, given these sessions. Exposed for tests and diagnostics. */
  due(sessions: DreamSession[], now = this.deps.now()): string[] {
    return this.deps.projects().filter((project) => this.decide(project, sessions, now).eligible);
  }

  async tick(): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const started: string[] = [];
    try {
      let sessions = await this.deps.liveSessions();
      this.observe(sessions, this.deps.now());
      for (const project of this.deps.projects()) {
        if (!this.decide(project, sessions, this.deps.now()).eligible) continue;
        // An earlier dream in this tick may have taken minutes: look again before starting.
        if (started.length) {
          sessions = await this.deps.liveSessions();
          this.observe(sessions, this.deps.now());
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

/**
 * The agent panes of one terminal snapshot (the Hook's `{ tabs, panes }`
 * shape) as dream sessions: the project from the pane's folder, the status
 * from the pane or, when the terminal reports none per pane, its tab.
 */
export function dreamSessionsFromSnapshot(snapshot: unknown, projectOf: (cwd: string | undefined) => string | undefined): DreamSession[] {
  const record = snapshot && typeof snapshot === "object" ? snapshot as Record<string, unknown> : {};
  const rows = (value: unknown) => (Array.isArray(value) ? value : []).filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
  const tabStatus = new Map(rows(record.tabs).map((tab) => [`${String(tab.workspace_id)}/${String(tab.tab_id)}`, tab.agent_status]));
  return rows(record.panes).filter((pane) => typeof pane.agent === "string" && pane.agent).map((pane) => {
    const cwd = typeof pane.foreground_cwd === "string" && pane.foreground_cwd ? pane.foreground_cwd : typeof pane.cwd === "string" ? pane.cwd : undefined;
    const status = pane.agent_status ?? tabStatus.get(`${String(pane.workspace_id)}/${String(pane.tab_id)}`);
    const project = projectOf(cwd);
    return { ...(project ? { project } : {}), ...(typeof status === "string" ? { status } : {}) };
  });
}

/**
 * A pane folder's project: the registered project whose checkout (or a
 * worktree of it) holds the folder, else the folder's name, so a session is
 * never missed when deciding that nobody is working.
 */
export function dreamProjectOf(store: string, profile?: string): (cwd: string | undefined) => string | undefined {
  return (cwd) => {
    if (!cwd) return undefined;
    try { const found = detectProject(store, cwd, profile); if (found) return found; } catch { /* fall back to the folder name */ }
    return paneProject(cwd, store);
  };
}

/** Projects in the store the Hook serves, skipping `global`. */
export function dreamStoreProjects(store: string, profile?: string): string[] {
  try { return getProjectDirs(store, profile).map((dir) => path.basename(dir)).filter((name) => name !== "global"); }
  catch { return []; }
}

/** Off with `PHREN_DREAMING=off`; otherwise the ticker runs and each project's config decides. */
export function dreamTickerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PHREN_DREAMING?.trim().toLowerCase() !== "off";
}

/** The command that runs a dream; `PHREN_DREAM_COMMAND` points it at a specific phren binary. */
export function dreamCommand(project: string, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  return { command: env.PHREN_DREAM_COMMAND?.trim() || "phren", args: ["dream", "run", "--project", project, "--scheduled"] };
}

/** Run one scheduled dream as a low-priority child process of the Hook. */
export function runDreamChild(store: string, project: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { command, args } = dreamCommand(project, env);
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
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* gone */ } }, DREAM_CHILD_TIMEOUT_MS);
    timer.unref();
    const done = () => { clearTimeout(timer); resolve(); };
    child.once("error", done);
    child.once("exit", done);
  });
}

/** Resolve the same evidence used by the live overview before deciding a project is idle. */
export async function effectiveDreamSessions(server: string, snapshot: unknown, projectOf: (cwd: string | undefined) => string | undefined,
  hooks?: AgentHooks, questions?: CodexQuestions): Promise<DreamSession[]> {
  const record = snapshot && typeof snapshot === "object" ? snapshot as Record<string, unknown> : {};
  const panes = (Array.isArray(record.panes) ? record.panes : []).filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && !!p.agent);
  const resolved = await Promise.all(panes.map(async pane => {
    const chat = await paneChatState(server, pane, { tokenWhenIdentified: false });
    const session = typeof chat.sessionId === "string" ? chat.sessionId : undefined;
    const evidence = session ? await effectivePaneEvidence(server, pane, session, hooks, questions) : undefined;
    return { ...pane, agent_status: evidence ? resolveEffectiveStatus(evidence) ?? "unknown" : "unknown" };
  }));
  return dreamSessionsFromSnapshot({ ...record, panes: resolved }, projectOf);
}
