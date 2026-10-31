import path from "node:path";
import type { ComputerResources, ProcessRow } from "./resources.js";

/**
 * Named machine health findings from numbers the resource monitor already
 * reads (load, memory, swap, disk, the process table): no extra scans. Each
 * finding has a stable `id` (check plus subject) so clients and the conductor
 * can track it across reads, a severity, and a suggested fix in plain words.
 * Trends come from a short in-memory history of samples, one per
 * `SAMPLE_EVERY_MS`, so a leak or a filling disk shows before the threshold.
 */

export type HealthSeverity = "info" | "warn" | "high";
export type HealthCheck = "swap" | "disk" | "load" | "memory-hog" | "memory-leak" | "orphan" | "simulator-clones" | "uptime"
  // Slow platform probes (machine-probes.ts).
  | "restart-loop" | "failed-units" | "backup" | "os-updates" | "crashes" | "oom" | "journal" | "gpu" | "stale-lock";

export interface HealthFinding {
  id: string;
  check: HealthCheck;
  severity: HealthSeverity;
  title: string;
  detail: string;
  fix: string;
}

export interface HealthSample {
  at: number;
  swapUsedBytes?: number;
  diskFreeBytes?: number;
  /** Resident bytes of the largest processes, by program name. */
  rss: Record<string, number>;
}

const GB = 1024 ** 3;
const HOUR = 3_600_000;
export const SAMPLE_EVERY_MS = 5 * 60_000;
/** Two hours of samples. */
export const HISTORY_SAMPLES = 24;

const gb = (bytes: number) => `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;
const age = (ms: number) => ms >= 86_400_000 ? `${Math.floor(ms / 86_400_000)}d` : `${Math.max(1, Math.floor(ms / HOUR))}h`;
const name = (row: ProcessRow) => path.basename(row.command) || row.command;
const rank: Record<HealthSeverity, number> = { high: 0, warn: 1, info: 2 };

/** Processes the OS or an app spawns many of; per-process RSS on these is not a leak signal. */
const NOT_A_DAEMON = /^(launchd_sim|Simulator|qemu-system|java|node|Electron|Google Chrome Helper.*)$/;

/** Patterns of programs that should never outlive whoever started them. */
const ORPHANS: Array<{ subject: string; match: (row: ProcessRow) => boolean; minAgeMs: number; fix: string }> = [
  { subject: "simctl-record", match: r => /simctl\b.*\brecordVideo\b/.test(r.args), minAgeMs: HOUR,
    fix: "End it: pkill -f 'simctl.*recordVideo'." },
  { subject: "desktop-reh", match: r => /desktop-reh|reh-server|server-main\.js/.test(r.args) && /phren|desktop/.test(r.args), minAgeMs: 6 * HOUR,
    fix: "End the stray editor servers: pkill -f desktop-reh." },
  { subject: "test-postgres", match: r => name(r) === "postgres" && /(\/tmp\/|\/var\/folders\/|test|pglite|embedded)/i.test(r.args), minAgeMs: 6 * HOUR,
    fix: "Stop the leftover test database (pg_ctl stop -D <dir>, or kill the postmaster)." },
  { subject: "test-runner", match: r => /\b(vitest|jest|playwright|xctest)\b/i.test(r.args), minAgeMs: 6 * HOUR,
    fix: "End the leftover test run; nothing is waiting on it." },
];

/** One sample from a resource read, keeping the eight largest resident programs. */
export function healthSample(value: ComputerResources, rows: readonly ProcessRow[], at: number): HealthSample {
  const byName = new Map<string, number>();
  for (const row of rows) {
    const key = name(row);
    if (NOT_A_DAEMON.test(key)) continue;
    byName.set(key, Math.max(byName.get(key) ?? 0, row.rssKB * 1024));
  }
  const rss = Object.fromEntries([...byName].sort((a, b) => b[1] - a[1]).slice(0, 8));
  return { at, ...(value.memory.swapUsedBytes !== undefined ? { swapUsedBytes: value.memory.swapUsedBytes } : {}),
    ...(value.disk ? { diskFreeBytes: value.disk.freeBytes } : {}), rss };
}

/** The findings for one read, worst first. `history` is oldest first and may be empty. */
export function assessHealth(value: ComputerResources, rows: readonly ProcessRow[], history: readonly HealthSample[], now: number): HealthFinding[] {
  const out: HealthFinding[] = [];
  const add = (check: HealthCheck, subject: string, severity: HealthSeverity, title: string, detail: string, fix: string) =>
    out.push({ id: subject ? `${check}:${subject}` : check, check, severity, title, detail, fix });
  const oldest = history.find(s => now - s.at >= 30 * 60_000);
  const hours = oldest ? (now - oldest.at) / HOUR : 0;

  const swap = value.memory.swapUsedBytes;
  if (swap !== undefined) {
    const grew = oldest?.swapUsedBytes !== undefined ? swap - oldest.swapUsedBytes : 0;
    if (swap >= 20 * GB) add("swap", "", "high", `Swap at ${gb(swap)}`, "The system is paging heavily; everything slows and the disk fills.", "Find the process holding the most memory and restart it.");
    else if (swap >= 8 * GB) add("swap", "", "warn", `Swap at ${gb(swap)}`, "Memory is overcommitted.", "Close or restart the largest memory users.");
    else if (grew >= 4 * GB) add("swap", "", "warn", `Swap grew ${gb(grew)} in ${age(now - oldest!.at)}`, `Now ${gb(swap)}.`, "Look for a process whose memory keeps climbing.");
  }

  const free = value.disk?.freeBytes;
  if (free !== undefined) {
    const rate = oldest?.diskFreeBytes !== undefined && hours > 0 ? (oldest.diskFreeBytes - free) / hours : 0;
    const fix = "Free space: clear simulator clones (xcrun simctl delete unavailable), DerivedData, caches and old swap.";
    if (free < 10 * GB) add("disk", "", "high", `${gb(free)} free on the home volume`, "Builds, swap and the store will start failing.", fix);
    else if (free < 20 * GB) add("disk", "", "warn", `${gb(free)} free on the home volume`, "Getting close to the 10 GB floor.", fix);
    else if (rate >= 2 * GB) add("disk", "", "warn", `Disk filling at ${gb(rate)}/h`, `${gb(free)} free, about ${Math.round(free / rate)}h left at this rate.`, "Find what is writing: swap growth, logs, or a runaway build.");
  }

  const { cores, loadPerCore, load1 } = value.cpu;
  if (loadPerCore > 2 && rows.length) {
    const busyCores = rows.reduce((sum, r) => sum + r.cpu, 0) / 100;
    if (busyCores < cores * 0.5) add("load", "pileup", "warn", `Load ${load1} with CPU ${Math.round(busyCores / cores * 100)}% busy`,
      "Load far above CPU use means threads waiting on disk I/O or locks, not real work (often many parallel simulators or tests).",
      "Cut parallelism (fewer simulators or test workers) and check for a process stuck on I/O.");
    else add("load", "cpu", loadPerCore > 4 ? "high" : "warn", `Load ${load1} on ${cores} cores`, "The CPU is saturated.", "Pause or stop the heaviest jobs listed under Heavy.");
  }

  const total = value.memory.totalBytes;
  const biggest = new Map<string, ProcessRow>();
  for (const row of rows) {
    const key = name(row);
    if (NOT_A_DAEMON.test(key)) continue;
    if ((biggest.get(key)?.rssKB ?? 0) < row.rssKB) biggest.set(key, row);
  }
  for (const [key, row] of biggest) {
    const bytes = row.rssKB * 1024;
    const before = oldest?.rss[key];
    if (total && bytes >= Math.max(8 * GB, total * 0.25)) {
      add("memory-hog", key, bytes >= total * 0.5 ? "high" : "warn", `${key} holds ${gb(bytes)}`, `pid ${row.pid}, ${Math.round(bytes / total * 100)}% of memory.`,
        `Restart it (kill ${row.pid}; launchd or systemd brings system daemons back).`);
    } else if (before !== undefined && bytes - before >= 2 * GB) {
      add("memory-leak", key, "warn", `${key} grew ${gb(bytes - before)} in ${age(now - oldest!.at)}`, `pid ${row.pid}, now ${gb(bytes)}.`,
        `Likely a leak; restart it before it pushes the system into swap (kill ${row.pid}).`);
    }
  }

  for (const pattern of ORPHANS) {
    const stale = rows.filter(r => r.ppid === 1 && pattern.match(r) && r.startedAt !== undefined && now - r.startedAt >= pattern.minAgeMs);
    if (!stale.length) continue;
    const oldestStart = Math.min(...stale.map(r => r.startedAt!));
    add("orphan", pattern.subject, stale.length >= 10 || now - oldestStart >= 7 * 86_400_000 ? "high" : "warn",
      `${stale.length} orphaned ${pattern.subject} process${stale.length === 1 ? "" : "es"}`,
      `Oldest running ${age(now - oldestStart)} with no parent (pid ${stale.slice(0, 5).map(r => r.pid).join(", ")}).`, pattern.fix);
  }

  const clones = rows.filter(r => name(r) === "launchd_sim" && /XCTestDevices/.test(r.args)).length;
  if (clones >= 8) add("simulator-clones", "", clones >= 30 ? "high" : "warn", `${clones} simulator test clones running`,
    "Parallel UI testing left clones booted; each holds memory and threads.",
    "xcrun simctl --set testing shutdown all && xcrun simctl --set testing delete all");

  const days = value.uptimeSeconds / 86_400;
  if (days >= 30) add("uptime", "", "info", `Up ${Math.floor(days)} days`, "Long uptimes accumulate leaks and defer OS updates.", "Restart at a convenient time.");

  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Keeps the sample history and assesses each read, adding the slow probes' cached findings. */
export class MachineHealth {
  private history: HealthSample[] = [];
  constructor(private readonly probes?: { current(): HealthFinding[] }) {}
  assess(value: ComputerResources, rows: readonly ProcessRow[], now: number): HealthFinding[] {
    const findings = [...assessHealth(value, rows, this.history, now), ...(this.probes?.current() ?? [])]
      .sort((a, b) => rank[a.severity] - rank[b.severity]);
    const last = this.history.at(-1);
    if (!last || now - last.at >= SAMPLE_EVERY_MS) {
      this.history.push(healthSample(value, rows, now));
      if (this.history.length > HISTORY_SAMPLES) this.history.shift();
    }
    return findings;
  }
}
