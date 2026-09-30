import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicInPrivateDir, bridgeRoot } from "./protocol.js";

/**
 * A small registry of the process groups this computer started for or by a
 * dispatched worker. It answers two questions the plain process table cannot:
 *
 * 1. Which agent owns a heavy process? A worker's helpers, a detached server
 *    (`nohup … &`, reparented to PID 1) and a build in a new process group are
 *    matched by the registered process group as well as by ancestry, so the
 *    resources report names the owning agent instead of guessing from a lone
 *    `node`.
 * 2. May a leftover process group be ended? Only a group the Hook registered
 *    and whose owning pane is gone is ever signalled; the Hook's own service,
 *    the owner's sessions and anything unregistered are never touched.
 *
 * A job is recorded when the Hook launches a worker in a pane. The process
 * group is filled in on the next read, because a pane's process does not exist
 * until the multiplexer has started it; matching the pane's shell in the
 * process table resolves it. Records are small and kept briefly.
 */

/** The pane that owns a job, structurally the shape the terminal provider reports. */
export interface JobPane { server: string; workspace?: string; pane: string; agent?: string; label?: string }

/** The fields of a process table row this registry reads; `ProcessRow` satisfies it. */
export interface ProcessLike { pid: number; ppid: number; pgid: number; command: string; args: string }

const paneSchema = z.object({
  server: z.string().min(1).max(200),
  workspace: z.string().max(200).optional(),
  pane: z.string().min(1).max(200),
  agent: z.string().max(60).optional(),
  label: z.string().max(200).optional(),
}).strict();

const jobSchema = z.object({
  /** The worker's process group, once the process table has shown it. */
  pgid: z.number().int().positive().optional(),
  pane: paneSchema.optional(),
  session: z.string().min(1).max(200).optional(),
  agent: z.string().max(60).optional(),
  label: z.string().max(200).optional(),
  /** The Harness/executable the Hook started, for display and a reuse check. */
  command: z.string().min(1).max(500),
  /** Epoch ms. */
  startedAt: z.number().int().nonnegative(),
}).strict();
export type TrackedJob = z.infer<typeof jobSchema>;

const stateSchema = z.object({ version: z.literal(1), jobs: z.array(jobSchema).max(1024) }).strict();

/** The identity of a job: its pane while one exists, else its session, else its group. */
export const paneKey = (pane: JobPane): string => `${pane.server}\0${pane.pane}`;
export function jobKey(job: TrackedJob): string {
  if (job.pane) return `pane:${paneKey(job.pane)}`;
  if (job.session) return `session:${job.session}`;
  if (job.pgid !== undefined) return `pgid:${job.pgid}`;
  return `command:${job.command}`;
}

/** The registered jobs by their process group, for attribution. */
export function jobPgids(jobs: readonly TrackedJob[]): Map<number, TrackedJob> {
  const byPgid = new Map<number, TrackedJob>();
  for (const job of jobs) if (job.pgid !== undefined && !byPgid.has(job.pgid)) byPgid.set(job.pgid, job);
  return byPgid;
}

/**
 * Fill each job's process group from the pane it owns: a job registered before
 * its terminal started has no pgid until the process table shows the pane's
 * shell (or an already-detached process) in a group. Never invents a group.
 */
export function resolveJobGroups(jobs: readonly TrackedJob[], rows: readonly ProcessLike[], owners: ReadonlyMap<number, JobPane>): TrackedJob[] {
  const byPane = new Map<string, number>();
  for (const row of rows) {
    const pane = owners.get(row.pid);
    if (pane && row.pgid > 1 && !byPane.has(paneKey(pane))) byPane.set(paneKey(pane), row.pgid);
  }
  return jobs.map(job => {
    if (job.pgid !== undefined || !job.pane) return job;
    const pgid = byPane.get(paneKey(job.pane));
    return pgid !== undefined ? { ...job, pgid } : job;
  });
}

/** How long a job's process group is left alone after its pane was requested,
 * so a launch that is still coming up is never signalled. */
export const CLEANUP_LEASE_MS = 5 * 60_000;
/** How long a finished or reused record is kept before it is dropped. */
export const CLEANUP_RETAIN_MS = 24 * 60 * 60_000;

export interface CleanupOptions {
  now?: number;
  leaseMs?: number;
  retainMs?: number;
  /** The Hook's own pid; its process group is never signalled. */
  selfPid?: number;
  /** False when the caller could not read the live panes: nothing is ended. */
  panesKnown?: boolean;
  /** When given, unresolved jobs are matched to their panes before planning. */
  owners?: ReadonlyMap<number, JobPane>;
  kill?: (pgid: number, signal: NodeJS.Signals) => void;
}
export interface CleanupPlan {
  kill: TrackedJob[];
  keep: Array<{ job: TrackedJob; reason: string }>;
  forget: TrackedJob[];
}

/** Whether a process in a job's group still looks like the command the Hook started. */
function commandMatches(job: TrackedJob, row: ProcessLike): boolean {
  return path.basename(row.command) === path.basename(job.command) || row.args.includes(job.command);
}

/**
 * Decide which registered process groups may be ended. A job is ended only when
 * every one of these holds: it has a resolved group above 1, its owning pane is
 * not in `live`, its group still has processes, none of them is the Hook itself,
 * the lease has passed, and a process still matches the command the Hook
 * started. Anything else is kept (with a reason) or, when the group is gone or
 * the record is old, forgotten. A caller that could not read the live panes
 * passes `panesKnown: false`, so a failed snapshot never triggers a kill.
 */
export function planCleanup(
  jobs: readonly TrackedJob[],
  rows: readonly ProcessLike[],
  live: ReadonlySet<string>,
  options: CleanupOptions = {},
): CleanupPlan {
  const now = options.now ?? Date.now(), leaseMs = options.leaseMs ?? CLEANUP_LEASE_MS, retainMs = options.retainMs ?? CLEANUP_RETAIN_MS;
  const self = options.selfPid ?? process.pid;
  const panesKnown = options.panesKnown ?? true;
  const byPgid = new Map<number, ProcessLike[]>();
  for (const row of rows) {
    const list = byPgid.get(row.pgid);
    if (list) list.push(row); else byPgid.set(row.pgid, [row]);
  }
  // The Hook's own process group, whatever its pid: never a target.
  const ownGroup = rows.find(row => row.pid === self)?.pgid;
  const kill: TrackedJob[] = [], keep: CleanupPlan["keep"] = [], forget: TrackedJob[] = [];
  for (const job of jobs) {
    const kept = (reason: string) => keep.push({ job, reason });
    if (!panesKnown) { kept("unknown"); continue; }
    if (job.pgid === undefined) {
      // No group recorded: nothing may be signalled. A record whose pane has
      // been gone past the lease cannot resolve any more, so it is dropped;
      // a fresh one is kept while its launch comes up.
      if (job.pane && !live.has(paneKey(job.pane)) && now - job.startedAt > leaseMs) forget.push(job);
      else kept("unresolved");
      continue;
    }
    if (job.pgid <= 1 || job.pgid === ownGroup) { kept("reserved"); continue; }
    // Only a job pinned to a pane is ever ended: a session-only record has no
    // pane to prove gone, so it is never signalled.
    if (!job.pane) { kept("no-pane"); continue; }
    if (live.has(paneKey(job.pane))) { kept("pane-alive"); continue; }
    const group = byPgid.get(job.pgid);
    if (!group || group.length === 0) { forget.push(job); continue; }
    if (group.some(row => row.pid === self)) { kept("self"); continue; }
    if (now - job.startedAt < leaseMs) { kept("lease"); continue; }
    if (!group.some(row => commandMatches(job, row))) {
      // The group id was reused by an unrelated program: the worker's group is
      // gone and this record no longer describes anything safe to end.
      if (now - job.startedAt > retainMs) forget.push(job); else kept("reused");
      continue;
    }
    kill.push(job);
  }
  return { kill, keep, forget };
}

export interface CleanupReport {
  killed: number[];
  kept: Array<{ pgid?: number; reason: string }>;
  forgotten: number[];
}

/** What the resources report needs from a registry; `JobRegistry` implements it, tests can stub it. */
export interface JobSource {
  list(): Promise<TrackedJob[]>;
  reconcile(rows: readonly ProcessLike[], owners: ReadonlyMap<number, JobPane>): Promise<TrackedJob[]>;
  cleanup(rows: readonly ProcessLike[], live: ReadonlySet<string>, options?: CleanupOptions): Promise<CleanupReport>;
}

/** The registry file: one JSON object, written atomically like the Hook's other state. */
const defaultFile = () => path.join(bridgeRoot(), "jobs.json");

/**
 * The on-disk job registry. The Hook is the only writer, so the file is read
 * whole; a damaged file reads as no jobs rather than failing a report.
 */
export class JobRegistry {
  constructor(private readonly file: string = defaultFile(), private readonly now: () => number = Date.now) {}

  async list(): Promise<TrackedJob[]> {
    try {
      const parsed = stateSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      return parsed.success ? parsed.data.jobs : [];
    } catch { return []; }
  }

  private async replace(jobs: TrackedJob[]): Promise<void> {
    await atomicInPrivateDir(this.file, JSON.stringify({ version: 1, jobs }, null, 2) + "\n");
  }

  /** Record (or refresh) one worker's job, keyed by its pane. */
  async register(job: Omit<TrackedJob, "startedAt"> & { startedAt?: number }): Promise<TrackedJob> {
    const entry: TrackedJob = { ...job, startedAt: job.startedAt ?? this.now() };
    const key = jobKey(entry);
    const jobs = await this.list();
    await this.replace([...jobs.filter(existing => jobKey(existing) !== key), entry].slice(-1024));
    return entry;
  }

  /** Resolve process groups against the current table and persist any change. */
  async reconcile(rows: readonly ProcessLike[], owners: ReadonlyMap<number, JobPane>): Promise<TrackedJob[]> {
    const jobs = await this.list();
    const resolved = resolveJobGroups(jobs, rows, owners);
    if (JSON.stringify(resolved) !== JSON.stringify(jobs)) await this.replace(resolved);
    return resolved;
  }

  /**
   * End every registered process group that is safe to end (`planCleanup`) and
   * drop the records that are gone. `live` is the set of pane keys the caller
   * still sees; a caller whose snapshot failed passes `panesKnown: false`, and
   * nothing is ended.
   */
  async cleanup(rows: readonly ProcessLike[], live: ReadonlySet<string>, options: CleanupOptions = {}): Promise<CleanupReport> {
    const jobs = options.owners ? await this.reconcile(rows, options.owners) : await this.list();
    const plan = planCleanup(jobs, rows, live, { ...options, ...(options.now === undefined ? { now: this.now() } : {}) });
    const signal = options.kill ?? ((pgid: number, value: NodeJS.Signals) => { process.kill(-pgid, value); });
    const killed: number[] = [];
    for (const job of plan.kill) {
      try { signal(job.pgid!, "SIGTERM"); killed.push(job.pgid!); } catch { /* Already gone between the plan and the signal. */ }
    }
    const done = new Set([...plan.forget, ...plan.kill].map(jobKey));
    const remaining = jobs.filter(job => !done.has(jobKey(job)));
    if (remaining.length !== jobs.length) await this.replace(remaining);
    return {
      killed,
      kept: plan.keep.map(({ job, reason }) => ({ ...(job.pgid !== undefined ? { pgid: job.pgid } : {}), reason })),
      forgotten: plan.forget.flatMap(job => (job.pgid !== undefined ? [job.pgid] : [])),
    };
  }
}
