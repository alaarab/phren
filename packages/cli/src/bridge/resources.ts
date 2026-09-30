import { execFile } from "node:child_process";
import { readdir, readFile, statfs } from "node:fs/promises";
import { cpus, loadavg, totalmem, uptime } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { homeDir } from "../home-paths.js";
import { recentServers, sharedSnapshot } from "./herdr.js";
import { JobRegistry, jobPgids, paneKey, type CleanupReport, type JobSource, type ProcessLike, type TrackedJob } from "./job-registry.js";
import { intervalFromEnv } from "./limits.js";
import { objects } from "./protocol.js";

const exec = promisify(execFile);

/**
 * This computer's live resources for `GET /v1/resources`, the overview
 * stream's `resources` frames and the memory-free `phren computers` surface:
 * load against cores, memory, free disk on the home volume, battery, uptime
 * and the heavy jobs (simulators, emulators, xcodebuild, Gradle, agent
 * workers) with the pane that started them where one did; any other program
 * holding half a core or more across its processes shows as `busy`. macOS reads
 * sysctl, pmset and ps; Linux reads /proc, /sys and ps. Nothing here needs a
 * permission the Hook does not already have.
 */

export const RESOURCES_MAX_AGE_MS = intervalFromEnv("PHREN_RESOURCES_MAX_AGE_MS", 10_000, 1_000, 60_000);
/** Below this much free disk, or above twice the cores in load, a computer is stressed. */
export const LOW_DISK_BYTES = 10 * 1024 ** 3;
const GB = 1024 ** 3;

export type HeavyKind = "simulator" | "emulator" | "xcodebuild" | "gradle" | "java" | "codex" | "opencode" | "claude" | "busy";

export interface PaneRef { server: string; workspace?: string; pane: string; agent?: string; label?: string }

export interface HeavyProcess {
  kind: HeavyKind;
  name: string;
  pid: number;
  /** OS processes, including helpers; never a count of agents or working sessions. */
  processes: number;
  cpuPercent: number;
  memoryBytes: number;
  /** Why this process group is listed; resource use does not establish session activity. */
  resourceReason?: "cpu" | "memory" | "tracked";
  /** The harness that owns the job, when a pane or a registered group says so. */
  agent?: string;
  /** True when the group is one the Hook registered for a dispatched worker. */
  tracked?: boolean;
  pane?: PaneRef;
}

export interface ComputerResources {
  collectedAt: string;
  platform: string;
  uptimeSeconds: number;
  cpu: { cores: number; load1: number; load5: number; load15: number; loadPerCore: number };
  memory: { totalBytes: number; availablePercent?: number; pressure?: "normal" | "warn" | "critical"; swapUsedBytes?: number };
  disk?: { path: string; totalBytes: number; freeBytes: number };
  battery?: { percent: number; charging: boolean; onAC: boolean };
  heavy: HeavyProcess[];
  /** 0 idle to 1 saturated, per resource and overall (the highest), so every client fills its gauge the same way. */
  pressure: { cpu: number; memory: number; disk: number; overall: number };
  level: "ok" | "busy" | "stressed";
  warnings: Array<"load-high" | "memory-low" | "disk-low" | "battery-low">;
}

/** A `ps` row; `pgid` is the process group the job registry attributes work by. */
export interface ProcessRow extends ProcessLike { cpu: number; rssKB: number; command: string; args: string }

/** `ps -axo pid=,ppid=,pgid=,pcpu=,rss=,comm=` paired with the `args=` listing by
 * pid. The older five-column stats (no pgid) still parse, with pgid 0. */
export function parsePs(stats: string, args: string): ProcessRow[] {
  const argv = new Map<number, string>();
  for (const line of args.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) argv.set(Number(match[1]), match[2]);
  }
  const rows: ProcessRow[] = [];
  for (const line of stats.split("\n")) {
    const six = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    const five = six ? undefined : /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    const match = six ?? five;
    if (!match) continue;
    const pid = Number(match[1]);
    const pgid = six ? Number(match[3]) : 0;
    const command = (six ? match[6] : match[5]).trim();
    rows.push({ pid, ppid: Number(match[2]), pgid, cpu: Number(six ? match[4] : match[3]), rssKB: Number(six ? match[5] : match[4]),
      command, args: argv.get(pid) ?? command });
  }
  return rows;
}

/** What kind of heavy job a process is, if any. */
export function heavyKind(row: ProcessRow): { kind: HeavyKind; name: string } | undefined {
  const base = path.basename(row.command);
  const args = row.args;
  if (base === "launchd_sim") {
    return { kind: "simulator", name: /XCTestDevices|Clone \d+ of /.test(args) ? "Simulator test clone" : "Simulator" };
  }
  if (/^qemu-system/.test(base) || base === "emulator" || /^emulator\d*-/.test(base)) return { kind: "emulator", name: "Android emulator" };
  if (base === "xcodebuild") return { kind: "xcodebuild", name: "xcodebuild" };
  if (base === "java") {
    if (/Gradle(?:Daemon|Worker|Main)|gradle-launcher|org\.gradle\./.test(args)) return { kind: "gradle", name: /Kotlin/.test(args) ? "Kotlin daemon" : "Gradle" };
    if (/KotlinCompileDaemon/.test(args)) return { kind: "gradle", name: "Kotlin daemon" };
    return { kind: "java", name: "Java" };
  }
  if (base === "codex" || base === "node" && /^\S*node\s+\S*\/codex(?:\.js)?(?:\s|$)/.test(args)) {
    const service = /^\S+\s+(app-server|mcp-server)(?:\s|$)/.exec(args)?.[1];
    return { kind: "codex", name: service === "app-server" ? "Codex app server" : service === "mcp-server" ? "Codex MCP server" : "Codex" };
  }
  if (base === "opencode" || base === ".opencode") return { kind: "opencode", name: "OpenCode" };
  if (base === "claude" || /(?:^|\/)claude\/versions\/\d+\.\d+\.\d+$/.test(row.command)) return { kind: "claude", name: "Claude Code" };
  return undefined;
}

/**
 * The heavy jobs in a process table. Every process counts toward its nearest
 * heavy ancestor-or-self, so a Codex worker running xcodebuild shows both,
 * each with only its own share. Any other program shows as `busy` when its
 * processes together hold half a core. Known programs below both a core's
 * tenth and 200 MiB are left out, including simulators and emulators.
 * A memory-only row can be an idle session or helper; it is not evidence of
 * agent activity. Counts include OS helpers, not just the named executable.
 * On Linux, ps pcpu is a process lifetime average, so these cutoffs can miss
 * daemons that spike briefly.
 */
export function heavyProcesses(rows: ProcessRow[], owners: Map<number, PaneRef> = new Map(), jobs: readonly TrackedJob[] = [], limit = 12): HeavyProcess[] {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const kinds = new Map<number, { kind: HeavyKind; name: string }>();
  for (const row of rows) { const kind = heavyKind(row); if (kind) kinds.set(row.pid, kind); }
  // npm's node launcher and its native Codex child are one process group.
  // Keep independently launched/nested Codex workers as separate groups.
  for (const row of rows) {
    const parent = byPid.get(row.ppid);
    if (kinds.get(row.pid)?.kind === "codex" && parent && path.basename(parent.command) === "node" && kinds.get(parent.pid)?.kind === "codex") {
      kinds.set(parent.pid, kinds.get(row.pid)!);
      kinds.delete(row.pid);
    }
  }
  // Registered process groups: their pane names the job even when a detached
  // process has been reparented away from it.
  const jobsByPgid = jobPgids(jobs);
  const totals = new Map<number, HeavyProcess>();
  const busy = new Map<string, HeavyProcess & { top: number; row: ProcessRow }>();
  const claim = (row: ProcessRow): number | undefined => {
    for (let at: ProcessRow | undefined = row, hops = 0; at && hops < 64; at = byPid.get(at.ppid), hops++) {
      if (kinds.has(at.pid)) return at.pid;
      if (at.ppid === at.pid || at.ppid <= 1) break;
    }
    return undefined;
  };
  // The pane that owns a process: by the registered process group first, then
  // by following its ancestry to a pane's shell or foreground process.
  const owner = (row: ProcessRow): PaneRef | undefined => {
    for (let at: ProcessRow | undefined = row, hops = 0; at && hops < 64; at = byPid.get(at.ppid), hops++) {
      const pane = owners.get(at.pid);
      if (pane) return pane;
      const job = jobsByPgid.get(at.pgid);
      if (job?.pane) return job.pane;
      if (at.ppid === at.pid || at.ppid <= 1) break;
    }
    return jobsByPgid.get(row.pgid)?.pane;
  };
  const trackedRoots = new Set<number>();
  for (const row of rows) {
    const root = claim(row);
    if (root !== undefined && jobsByPgid.has(row.pgid)) trackedRoots.add(root);
  }
  for (const row of rows) {
    const root = claim(row);
    const tracked = jobsByPgid.has(row.pgid) || (root !== undefined && trackedRoots.has(root));
    if (root === undefined) {
      // Unclaimed work groups by program: twelve swift-frontends at 40% each
      // are one busy job. A registered group keeps its own bucket, so two
      // workers' helpers are not merged under one pane.
      const name = path.basename(row.command).slice(0, 60);
      const key = tracked ? `job:${row.pgid}\0${name}` : name;
      const group = busy.get(key);
      if (!group) busy.set(key, { kind: "busy", name, pid: row.pid, processes: 1, cpuPercent: row.cpu, memoryBytes: row.rssKB * 1024, top: row.cpu, row, ...(tracked ? { tracked: true } : {}) });
      else {
        group.processes++; group.cpuPercent += row.cpu; group.memoryBytes += row.rssKB * 1024;
        if (tracked) group.tracked = true;
        if (row.cpu > group.top) { group.top = row.cpu; group.pid = row.pid; group.row = row; }
      }
      continue;
    }
    let total = totals.get(root);
    if (!total) {
      const { kind, name } = kinds.get(root)!;
      const pane = owner(byPid.get(root)!);
      total = { kind, name, pid: root, processes: 0, cpuPercent: 0, memoryBytes: 0, ...(tracked ? { tracked: true } : {}),
        ...(pane ? { pane } : {}), ...(pane?.agent ? { agent: pane.agent } : {}) };
      totals.set(root, total);
    }
    total.processes++; total.cpuPercent += row.cpu; total.memoryBytes += row.rssKB * 1024;
    if (tracked) total.tracked = true;
  }
  for (const { top: _top, row, ...group } of busy.values()) {
    if (group.cpuPercent < 50 && !group.tracked) continue;
    const pane = owner(row);
    totals.set(group.pid, { ...group, ...(pane ? { pane } : {}), ...(pane?.agent ? { agent: pane.agent } : {}) });
  }
  return [...totals.values()]
    .filter(item => item.kind === "busy" || item.cpuPercent >= 10 || item.memoryBytes >= 200 * 1024 ** 2 || item.tracked)
    .map(item => ({ ...item, cpuPercent: Math.round(item.cpuPercent * 10) / 10,
      resourceReason: (item.cpuPercent >= 10 ? "cpu" : item.memoryBytes >= 200 * 1024 ** 2 ? "memory" : "tracked") as HeavyProcess["resourceReason"] }))
    .sort((a, b) => b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes)
    .slice(0, limit);
}

/** `pmset -g batt`: "Now drawing from 'AC Power'" then " -InternalBattery-0 (id=…)	87%; charging; …". */
export function parsePmset(output: string): ComputerResources["battery"] {
  const match = /(\d{1,3})%;\s*([^;]+);/.exec(output);
  if (!match) return undefined;
  const state = match[2].trim().toLowerCase();
  return { percent: Math.min(100, Number(match[1])), charging: state === "charging" || state === "charged" || state === "finishing charge",
    onAC: /'AC Power'/.test(output) };
}

/** `sysctl vm.swapusage`: "total = 2048.00M  used = 798.50M  free = …". */
export function parseSwap(output: string): number | undefined {
  const match = /used\s*=\s*([\d.]+)([KMG])/.exec(output);
  if (!match) return undefined;
  return Math.round(Number(match[1]) * { K: 1024, M: 1024 ** 2, G: GB }[match[2] as "K" | "M" | "G"]);
}

/** /proc/meminfo: MemTotal, MemAvailable and swap, in kB. */
export function parseMeminfo(text: string): ComputerResources["memory"] {
  const field = (name: string) => { const match = new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(text); return match ? Number(match[1]) * 1024 : undefined; };
  const total = field("MemTotal") ?? totalmem(), available = field("MemAvailable");
  const swapTotal = field("SwapTotal"), swapFree = field("SwapFree");
  const availablePercent = available !== undefined && total ? Math.round(available / total * 100) : undefined;
  return { totalBytes: total, ...(availablePercent !== undefined ? { availablePercent, pressure: availablePercent < 5 ? "critical" : availablePercent < 15 ? "warn" : "normal" } : {}),
    ...(swapTotal !== undefined && swapFree !== undefined ? { swapUsedBytes: swapTotal - swapFree } : {}) };
}

/** Gauge fill and warnings from the numbers. */
export function assess(value: Omit<ComputerResources, "pressure" | "level" | "warnings">): Pick<ComputerResources, "pressure" | "level" | "warnings"> {
  const cpu = Math.min(1, value.cpu.loadPerCore / 2);
  const memory = value.memory.pressure === "critical" ? 1
    : Math.max(value.memory.pressure === "warn" ? 0.75 : 0, value.memory.availablePercent === undefined ? 0 : 1 - value.memory.availablePercent / 100);
  const free = value.disk?.freeBytes, total = value.disk?.totalBytes;
  // Plenty of room reads by fraction used; under 50 GB it climbs to full at 10 GB.
  const disk = free === undefined || !total ? 0
    : free >= 50 * GB ? 0.5 * (1 - free / total) : Math.min(1, 0.5 + (50 * GB - free) / (80 * GB));
  const round = (n: number) => Math.round(Math.max(0, n) * 100) / 100;
  const warnings: ComputerResources["warnings"] = [];
  if (value.cpu.loadPerCore > 2) warnings.push("load-high");
  if (value.memory.pressure === "critical" || (value.memory.availablePercent ?? 100) < 5) warnings.push("memory-low");
  if (free !== undefined && free < LOW_DISK_BYTES) warnings.push("disk-low");
  if (value.battery && !value.battery.onAC && value.battery.percent < 15) warnings.push("battery-low");
  const overall = Math.max(cpu, memory, disk);
  return { pressure: { cpu: round(cpu), memory: round(memory), disk: round(disk), overall: round(overall) },
    level: warnings.some(w => w !== "battery-low") || overall >= 0.9 ? "stressed" : overall >= 0.6 ? "busy" : "ok", warnings };
}

async function run(file: string, args: string[]): Promise<string> {
  return (await exec(file, args, { timeout: 4_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } })).stdout;
}

async function darwinMemory(): Promise<ComputerResources["memory"]> {
  const [level, pressure, swap] = await Promise.all([
    run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_level"]).catch(() => ""),
    run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).catch(() => ""),
    run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]).catch(() => ""),
  ]);
  const available = Number(level.trim()), code = Number(pressure.trim()), swapUsedBytes = parseSwap(swap);
  return { totalBytes: totalmem(),
    ...(level.trim() && Number.isFinite(available) ? { availablePercent: available } : {}),
    ...(pressure.trim() && Number.isFinite(code) ? { pressure: code >= 4 ? "critical" : code >= 2 ? "warn" : "normal" } : {}),
    ...(swapUsedBytes !== undefined ? { swapUsedBytes } : {}) };
}

async function linuxBattery(): Promise<ComputerResources["battery"]> {
  const root = "/sys/class/power_supply";
  const names = await readdir(root).catch(() => [] as string[]);
  const battery = names.find(name => /^BAT/.test(name));
  if (!battery) return undefined;
  const read = (name: string, field: string) => readFile(path.join(root, name, field), "utf8").then(text => text.trim()).catch(() => "");
  const [capacity, status] = await Promise.all([read(battery, "capacity"), read(battery, "status")]);
  const online = await Promise.all(names.filter(name => !/^BAT/.test(name)).map(name => read(name, "online")));
  const percent = Number(capacity);
  if (!capacity || !Number.isFinite(percent)) return undefined;
  return { percent, charging: status === "Charging" || status === "Full", onAC: online.includes("1") };
}

async function processTable(): Promise<ProcessRow[]> {
  const [stats, args] = await Promise.all([run("/bin/ps", ["-axo", "pid=,ppid=,pgid=,pcpu=,rss=,comm="]), run("/bin/ps", ["-axo", "pid=,args="])]);
  return parsePs(stats, args);
}

/** Every pid a Herdr or tmux pane holds (its shell and foreground), for naming a job's pane. */
export async function paneOwners(): Promise<Map<number, PaneRef>> {
  const owners = new Map<number, PaneRef>();
  const { terminalProvider } = await import("./terminal.js");
  const provider = terminalProvider();
  for (const server of (await recentServers()).slice(0, 8)) {
    const name = String(server.session);
    const s = await sharedSnapshot(name, RESOURCES_MAX_AGE_MS).catch(() => undefined);
    if (!s) continue;
    const workspaces = new Map(objects(s.workspaces).map(w => [String(w.workspace_id), typeof w.label === "string" ? w.label : undefined]));
    await Promise.all(objects(s.panes).slice(0, 64).map(async pane => {
      const processes = await provider.processes(name, String(pane.pane_id)).catch(() => undefined);
      if (!processes) return;
      const ref: PaneRef = { server: name, pane: String(pane.pane_id),
        ...(workspaces.get(String(pane.workspace_id)) ? { workspace: workspaces.get(String(pane.workspace_id)) } : {}),
        ...(typeof pane.agent === "string" ? { agent: pane.agent } : {}),
        ...(typeof pane.label === "string" && pane.label ? { label: pane.label } : {}) };
      for (const pid of [processes.shellPid, ...processes.foregroundPids]) if (typeof pid === "number" && pid > 0) owners.set(pid, ref);
    }));
  }
  return owners;
}

export interface ResourceDeps {
  platform: NodeJS.Platform;
  now: () => number;
  home: () => string;
  processes: () => Promise<ProcessRow[]>;
  owners: () => Promise<Map<number, PaneRef>>;
  jobs?: JobSource;
}

export async function collectResources(deps: ResourceDeps): Promise<ComputerResources> {
  const [one, five, fifteen] = loadavg();
  const cores = cpus().length || 1;
  const platform = deps.platform;
  const registry = deps.jobs ?? new JobRegistry();
  const [memory, disk, battery, rows, registered] = await Promise.all([
    platform === "darwin" ? darwinMemory()
      : platform === "linux" ? readFile("/proc/meminfo", "utf8").then(parseMeminfo).catch(() => ({ totalBytes: totalmem() }))
      : Promise.resolve({ totalBytes: totalmem() }),
    statfs(deps.home()).then(info => ({ path: "~", totalBytes: info.blocks * info.bsize, freeBytes: info.bavail * info.bsize })).catch(() => undefined),
    platform === "darwin" ? run("/usr/bin/pmset", ["-g", "batt"]).then(parsePmset).catch(() => undefined)
      : platform === "linux" ? linuxBattery() : Promise.resolve(undefined),
    deps.processes().catch(() => [] as ProcessRow[]),
    registry.list().catch(() => [] as TrackedJob[]),
  ]);
  // Pane pids cost one terminal call per pane: only when there is a job to name.
  const preliminary = heavyProcesses(rows, new Map(), registered);
  const owners = preliminary.length || registered.length ? await deps.owners().catch(() => new Map<number, PaneRef>()) : new Map<number, PaneRef>();
  // Resolve registered workers' process groups and pane names from the table,
  // so a detached job keeps the agent that owns it.
  const jobs = owners.size ? await registry.reconcile(rows, owners).catch(() => registered) : registered;
  const round = (n: number) => Math.round(n * 100) / 100;
  const value = {
    collectedAt: new Date(deps.now()).toISOString(), platform, uptimeSeconds: Math.round(uptime()),
    cpu: { cores, load1: round(one), load5: round(five), load15: round(fifteen), loadPerCore: round(one / cores) },
    memory, ...(disk ? { disk } : {}), ...(battery ? { battery } : {}),
    heavy: owners.size || jobs.length ? heavyProcesses(rows, owners, jobs) : preliminary,
  };
  return { ...value, ...assess(value) };
}

/** One collection at a time, reused for `RESOURCES_MAX_AGE_MS`. */
export class ResourceMonitor {
  private cached?: { at: number; value: ComputerResources };
  private pending?: Promise<ComputerResources>;
  private readonly deps: ResourceDeps;
  private readonly registry: JobSource;
  constructor(deps: Partial<ResourceDeps> = {}, private maxAgeMs = RESOURCES_MAX_AGE_MS) {
    this.registry = deps.jobs ?? new JobRegistry();
    this.deps = { platform: process.platform, now: Date.now, home: homeDir, processes: processTable, owners: paneOwners, ...deps, jobs: this.registry };
  }
  async read(): Promise<ComputerResources> {
    if (this.cached && this.deps.now() - this.cached.at < this.maxAgeMs) return this.cached.value;
    this.pending ??= collectResources(this.deps)
      .then(value => { this.cached = { at: this.deps.now(), value }; return value; })
      .finally(() => { this.pending = undefined; });
    return this.pending;
  }
  /**
   * End only the registered process groups whose owning pane is gone. The
   * registry (job-registry.ts) does the safety checks; a failed pane read ends
   * nothing. Never the Hook's own service, never an owner's session, never an
   * unregistered process.
   */
  async cleanupJobs(): Promise<CleanupReport> {
    const rows = await this.deps.processes().catch(() => [] as ProcessRow[]);
    let owners: Map<number, PaneRef>, panesKnown = true;
    try { owners = await this.deps.owners(); } catch { panesKnown = false; owners = new Map<number, PaneRef>(); }
    const report = await this.registry.cleanup(rows, new Set([...owners.values()].map(paneKey)), { owners, panesKnown });
    this.cached = undefined;
    return report;
  }
}
