import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { findPhrenPath } from "../phren-paths.js";
import { homeDir } from "../home-paths.js";
import { bridgeRoot } from "./protocol.js";
import type { HealthCheck, HealthFinding, HealthSeverity } from "./machine-health.js";

/**
 * The slow half of machine health: platform probes that each cost a command or
 * a directory walk, run in the background every few minutes (OS updates every
 * few hours) and served from cache on each resource read. A probe whose tool
 * is missing or fails reports nothing; it never fails the read.
 *
 * macOS: launchd agents in a restart loop, Time Machine age, pending updates,
 * crash and jetsam reports. Linux: systemd NRestarts and failed units, OOM
 * kills, core dumps, journal size, pending updates, NVIDIA GPU errors. Both:
 * phren lock files whose owner process is gone.
 */

const HOUR = 3_600_000, DAY = 24 * HOUR, MIN = 60_000;
const GB = 1024 ** 3;
export const PROBE_EVERY_MS = 5 * MIN;
export const UPDATES_EVERY_MS = 6 * HOUR;

export interface ProbeDeps {
  platform: string;
  now: () => number;
  home: string;
  uid: number;
  /** stdout of a command; rejects when it is missing, fails or times out. */
  run: (file: string, args: string[], timeoutMs?: number) => Promise<string>;
  /** Directories searched (two levels) for `*.lock` files. */
  lockDirs: string[];
  alive: (pid: number) => boolean;
}

type Probe = { name: string; everyMs: number; platforms: string[]; run: (deps: ProbeDeps) => Promise<HealthFinding[]> };

const finding = (check: HealthCheck, subject: string, severity: HealthSeverity, title: string, detail: string, fix: string): HealthFinding =>
  ({ id: subject ? `${check}:${subject}` : check, check, severity, title, detail, fix });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ago = (ms: number) => ms >= DAY ? `${Math.floor(ms / DAY)}d` : `${Math.max(1, Math.floor(ms / HOUR))}h`;

// ── launchd / systemd restart loops ─────────────────────────────────────────

/** `launchctl print gui/<uid>/<label>`: restart count, unless the job is meant to run repeatedly. */
export function parseLaunchdService(label: string, text: string): HealthFinding | undefined {
  const runs = Number(/^\s*runs = (\d+)/m.exec(text)?.[1] ?? 0);
  // Interval, calendar and path-watching jobs run often by design.
  if (/run interval =|start calendar interval|event triggers|path state/i.test(text) && !/keepalive/i.test(text)) return undefined;
  if (runs < 100) return undefined;
  const exit = /last exit code = ([^\n]+)/.exec(text)?.[1]?.trim();
  return finding("restart-loop", label, runs >= 1000 ? "high" : "warn", `${label} restarted ${runs.toLocaleString("en-US")} times`,
    `launchd keeps relaunching it${exit ? `; last exit: ${exit}` : ""}.`,
    `Read its log, fix the cause, or unload it: launchctl bootout gui/$(id -u)/${label}`);
}

/** `launchctl list`: non-Apple labels, which are the ones worth printing. */
export function launchdLabels(text: string): string[] {
  return text.split("\n").slice(1).map(line => line.trim().split(/\s+/)[2]).filter((l): l is string => !!l && !l.startsWith("com.apple.")).slice(0, 80);
}

/** `systemctl show -p Id -p NRestarts <units>`: blocks separated by blank lines. */
export function parseSystemdRestarts(text: string, scope: "system" | "user"): HealthFinding[] {
  const out: HealthFinding[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const id = /^Id=(.+)$/m.exec(block)?.[1]?.trim();
    const restarts = Number(/^NRestarts=(\d+)$/m.exec(block)?.[1] ?? 0);
    if (!id || restarts < 20) continue;
    const flag = scope === "user" ? "--user " : "";
    out.push(finding("restart-loop", id, restarts >= 200 ? "high" : "warn", `${id} restarted ${restarts.toLocaleString("en-US")} times`,
      "systemd keeps restarting it.", `journalctl ${flag}-u ${id} -n 50, fix the cause, then systemctl ${flag}reset-failed ${id}.`));
  }
  return out;
}

/** `systemctl --failed --no-legend --plain`. */
export function parseFailedUnits(text: string, scope: "system" | "user"): HealthFinding[] {
  const units = text.split("\n").map(l => l.trim().replace(/^●\s*/, "").split(/\s+/)[0]).filter(Boolean);
  if (!units.length) return [];
  const flag = scope === "user" ? "--user " : "";
  return [finding("failed-units", scope, "warn", `${plural(units.length, `failed ${scope} unit`)}`, units.slice(0, 6).join(", "),
    `systemctl ${flag}status ${units[0]} for the reason; systemctl ${flag}reset-failed once fixed.`)];
}

// ── backups and updates ─────────────────────────────────────────────────────

/** `tmutil latestbackup`: the newest backup's timestamp in its path. */
export function parseTimeMachine(latest: string, now: number): HealthFinding | undefined {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(latest);
  if (!m) return undefined;
  const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  const age = now - at;
  if (age < 3 * DAY) return undefined;
  return finding("backup", "time-machine", age >= 14 * DAY ? "high" : "warn", `Last Time Machine backup ${ago(age)} ago`,
    "Work since then is not backed up.", "Connect the backup disk, or run tmutil startbackup and check System Settings > Time Machine.");
}

/** `softwareupdate -l`, `checkupdates` or `apt list --upgradable`. */
export function parseUpdates(text: string, tool: "softwareupdate" | "checkupdates" | "apt"): HealthFinding | undefined {
  const lines = text.split("\n");
  const names = tool === "softwareupdate" ? lines.filter(l => /^\s*\* Label:/.test(l)).map(l => l.replace(/^\s*\* Label:\s*/, "").trim())
    : tool === "apt" ? lines.filter(l => l.includes("[upgradable")).map(l => l.split("/")[0])
    : lines.map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
  if (!names.length) return undefined;
  const restart = tool === "softwareupdate" && /Action: restart/i.test(text);
  const fix = tool === "softwareupdate" ? "Install from System Settings > General > Software Update." : tool === "apt" ? "sudo apt upgrade" : "sudo pacman -Syu";
  return finding("os-updates", "", restart ? "warn" : "info", `${plural(names.length, "pending update")}`,
    `${names.slice(0, 4).join(", ")}${names.length > 4 ? ", …" : ""}${restart ? " (needs a restart)" : ""}.`, fix);
}

// ── crashes and out-of-memory kills ─────────────────────────────────────────

/** Report file names from DiagnosticReports changed in the last day. */
export function parseDiagnosticReports(names: readonly string[]): HealthFinding[] {
  const out: HealthFinding[] = [];
  const jetsam = names.filter(n => n.startsWith("JetsamEvent")).length;
  const panics = names.filter(n => /\.panic$|^panic-/.test(n)).length;
  const crashes = new Map<string, number>();
  for (const n of names) {
    if (!/\.(ips|crash)$/.test(n) || n.startsWith("JetsamEvent")) continue;
    const program = n.split(/[-_.]\d{4}-\d{2}-\d{2}/)[0];
    crashes.set(program, (crashes.get(program) ?? 0) + 1);
  }
  if (panics) out.push(finding("crashes", "kernel", "high", `${plural(panics, "kernel panic")} in the last day`, "The machine restarted on a panic.",
    "Open the panic report in Console; recurring panics point at hardware or a kernel extension."));
  if (jetsam) out.push(finding("oom", "", jetsam >= 5 ? "high" : "warn", `${plural(jetsam, "jetsam event")} in the last day`,
    "macOS killed processes to recover memory.", "Find what fills memory (memory-hog findings, Activity Monitor) and restart it."));
  for (const [program, count] of crashes) {
    if (count < 3) continue;
    out.push(finding("crashes", program, count >= 20 ? "high" : "warn", `${program} crashed ${count} times in the last day`,
      "Repeated crash reports in DiagnosticReports.", `Open the latest ${program} report in Console; update or reinstall it.`));
  }
  return out;
}

/** `journalctl -k --grep 'Out of memory: Killed process'` lines. */
export function parseOomKills(text: string): HealthFinding | undefined {
  const lines = text.split("\n").filter(l => /Killed process/.test(l));
  if (!lines.length) return undefined;
  const victims = [...new Set(lines.map(l => /\(([^)]+)\)/.exec(l)?.[1]).filter(Boolean))];
  return finding("oom", "", lines.length >= 5 ? "high" : "warn", `${plural(lines.length, "OOM kill")} in the last day`,
    `The kernel killed ${victims.slice(0, 4).join(", ") || "processes"} to free memory.`, "Find what fills memory and cap or restart it; add swap if there is none.");
}

/** `coredumpctl list --json=short`: crashes by executable. */
export function parseCoredumps(json: string): HealthFinding[] {
  let rows: Array<{ exe?: string }>;
  try { rows = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  const counts = new Map<string, number>();
  for (const r of rows) if (r.exe) counts.set(path.basename(r.exe), (counts.get(path.basename(r.exe)) ?? 0) + 1);
  return [...counts].filter(([, n]) => n >= 3).map(([exe, n]) => finding("crashes", exe, n >= 20 ? "high" : "warn",
    `${exe} crashed ${n} times in the last day`, "Repeated core dumps.", `coredumpctl info ${exe} for the backtrace.`));
}

/** `journalctl --disk-usage`. */
export function parseJournalSize(text: string): HealthFinding | undefined {
  const m = /take up ([\d.]+)([KMGT])/.exec(text);
  if (!m) return undefined;
  const bytes = Number(m[1]) * 1024 ** "KMGT".indexOf(m[2]) * 1024;
  if (bytes < 4 * GB) return undefined;
  return finding("journal", "", bytes >= 16 * GB ? "high" : "warn", `System journal at ${m[1]}${m[2]}`, "Logs are taking disk space.",
    "sudo journalctl --vacuum-size=1G, and set SystemMaxUse in journald.conf.");
}

// ── GPU ─────────────────────────────────────────────────────────────────────

/** `nvidia-smi --query-gpu=index,name,ecc.errors.uncorrected.volatile.total,temperature.gpu --format=csv,noheader,nounits` plus Xid lines. */
export function parseNvidia(query: string, xid: string): HealthFinding[] {
  const out: HealthFinding[] = [];
  for (const line of query.split("\n").filter(l => l.trim())) {
    const [index, name, ecc, temp] = line.split(",").map(s => s.trim());
    if (Number(ecc) > 0) out.push(finding("gpu", `ecc-${index}`, "high", `GPU ${index} has ${ecc} uncorrectable memory errors`, name,
      "Drain its jobs and reset it (nvidia-smi -r -i " + index + "); replace it if they recur."));
    if (Number(temp) >= 90) out.push(finding("gpu", `temp-${index}`, "warn", `GPU ${index} at ${temp}°C`, name, "Check fans and airflow; lower its power limit."));
  }
  const xids = xid.split("\n").map(l => /Xid \([^)]*\): (\d+)/.exec(l)?.[1]).filter((x): x is string => !!x);
  if (xids.length) {
    const fatal = xids.some(x => ["48", "79", "92", "94", "95"].includes(x));
    out.push(finding("gpu", "xid", fatal || xids.length >= 10 ? "high" : "warn", `${plural(xids.length, "NVIDIA Xid error")} in the last day`,
      `Codes ${[...new Set(xids)].join(", ")}.`, fatal ? "The GPU fell off the bus or hit a double-bit error: reboot, then check power and seating." : "Look up the Xid codes; often a driver or application fault."));
  }
  return out;
}

export async function nvidiaFindings(deps: Pick<ProbeDeps, "run">): Promise<HealthFinding[]> {
  let query: string;
  try {
    query = await deps.run("nvidia-smi", ["--query-gpu=index,name,ecc.errors.uncorrected.volatile.total,temperature.gpu", "--format=csv,noheader,nounits"], 15_000);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    const message = String((err as { stderr?: string }).stderr || (err as Error).message).split("\n")[0].slice(0, 160);
    return [finding("gpu", "smi", "high", "nvidia-smi fails", message, "The driver is not talking to the GPU: check for a driver/kernel mismatch and reboot.")];
  }
  const xid = await deps.run("journalctl", ["-k", "--since=-24h", "--no-pager", "-q", "-o", "cat", "--grep", "NVRM: Xid"], 15_000).catch(() => "");
  return parseNvidia(query, xid);
}

// ── stale locks ─────────────────────────────────────────────────────────────

/** A lock written as `<pid>\n<ms>` whose process is gone and that is older than 30 minutes. */
export async function staleLocks(deps: Pick<ProbeDeps, "lockDirs" | "alive" | "now">): Promise<HealthFinding | undefined> {
  const stale: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0 && !e.name.startsWith(".git") && e.name !== "node_modules") await walk(full, depth - 1);
      else if (e.isFile() && e.name.endsWith(".lock")) {
        const info = await stat(full).catch(() => undefined);
        if (!info || deps.now() - info.mtimeMs < 30 * MIN) continue;
        const pid = Number((await readFile(full, "utf8").catch(() => "")).split("\n")[0]);
        if (Number.isInteger(pid) && pid > 0 && !deps.alive(pid)) stale.push(full);
      }
    }
  };
  for (const dir of deps.lockDirs) await walk(dir, 2);
  if (!stale.length) return undefined;
  return finding("stale-lock", "", "warn", `${plural(stale.length, "stale lock")}`,
    `Held by processes that have exited: ${stale.slice(0, 4).map(p => path.basename(p)).join(", ")}.`,
    `Remove them: rm ${stale.slice(0, 4).map(p => JSON.stringify(p)).join(" ")}`);
}

// ── the probes ──────────────────────────────────────────────────────────────

const since24h = ["--since=-24h", "--no-pager", "-q", "-o", "cat"];
const defined = <T>(xs: Array<T | undefined>) => xs.filter((x): x is T => x !== undefined);

const PROBES: Probe[] = [
  { name: "launchd", everyMs: PROBE_EVERY_MS, platforms: ["darwin"], run: async d => {
    const labels = launchdLabels(await d.run("/bin/launchctl", ["list"]));
    const printed = await Promise.all(labels.map(l => d.run("/bin/launchctl", ["print", `gui/${d.uid}/${l}`]).then(t => parseLaunchdService(l, t), () => undefined)));
    return defined(printed);
  } },
  { name: "systemd", everyMs: PROBE_EVERY_MS, platforms: ["linux"], run: async d => {
    const out: HealthFinding[] = [];
    for (const scope of ["system", "user"] as const) {
      const flag = scope === "user" ? ["--user"] : [];
      const units = (await d.run("systemctl", [...flag, "list-units", "--type=service", "--all", "--no-legend", "--plain"]).catch(() => ""))
        .split("\n").map(l => l.trim().split(/\s+/)[0]).filter(u => u.endsWith(".service"));
      if (units.length) out.push(...parseSystemdRestarts(await d.run("systemctl", [...flag, "show", "-p", "Id", "-p", "NRestarts", ...units]).catch(() => ""), scope));
      out.push(...parseFailedUnits(await d.run("systemctl", [...flag, "--failed", "--no-legend", "--plain"]).catch(() => ""), scope));
    }
    return out;
  } },
  { name: "time-machine", everyMs: PROBE_EVERY_MS, platforms: ["darwin"], run: async d =>
    defined([parseTimeMachine(await d.run("/usr/bin/tmutil", ["latestbackup"], 20_000), d.now())]) },
  { name: "updates", everyMs: UPDATES_EVERY_MS, platforms: ["darwin", "linux"], run: async d => {
    if (d.platform === "darwin") return defined([parseUpdates(await d.run("/usr/sbin/softwareupdate", ["-l"], 120_000), "softwareupdate")]);
    const pacman = await d.run("checkupdates", [], 120_000).then(t => parseUpdates(t, "checkupdates"), (e: NodeJS.ErrnoException) => e.code === "ENOENT" ? null : undefined);
    if (pacman !== null) return defined([pacman]);
    return defined([parseUpdates(await d.run("apt", ["list", "--upgradable"], 60_000), "apt")]);
  } },
  { name: "crashes", everyMs: PROBE_EVERY_MS, platforms: ["darwin"], run: async d => {
    const recent: string[] = [];
    for (const dir of [path.join(d.home, "Library/Logs/DiagnosticReports"), "/Library/Logs/DiagnosticReports"]) {
      for (const n of await readdir(dir).catch(() => [] as string[])) {
        const info = await stat(path.join(dir, n)).catch(() => undefined);
        if (info?.isFile() && d.now() - info.mtimeMs < DAY) recent.push(n);
      }
    }
    return parseDiagnosticReports(recent);
  } },
  { name: "oom", everyMs: PROBE_EVERY_MS, platforms: ["linux"], run: async d => defined([
    parseOomKills(await d.run("journalctl", ["-k", ...since24h, "--grep", "Out of memory: Killed process"], 15_000).catch(() => "")),
    parseJournalSize(await d.run("journalctl", ["--disk-usage"]).catch(() => "")),
    ...parseCoredumps(await d.run("coredumpctl", ["list", "--since=-24h", "--no-legend", "--json=short"], 15_000).catch(() => "[]")),
  ]) },
  { name: "gpu", everyMs: PROBE_EVERY_MS, platforms: ["linux", "win32"], run: nvidiaFindings },
  { name: "locks", everyMs: PROBE_EVERY_MS, platforms: ["darwin", "linux"], run: async d => defined([await staleLocks(d)]) },
];

function defaultDeps(): ProbeDeps {
  const store = (() => { try { return findPhrenPath(); } catch { return null; } })();
  return {
    platform: process.platform, now: Date.now, home: homeDir(), uid: process.getuid?.() ?? 0,
    run: (file, args, timeoutMs = 10_000) => new Promise((resolve, reject) => {
      execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
        (err, stdout, stderr) => err ? reject(Object.assign(err, { stderr })) : resolve(stdout));
    }),
    lockDirs: [bridgeRoot(), ...(store ? [store] : [])],
    alive: pid => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } },
  };
}

/** Runs the due probes in the background and serves the last results. */
export class PlatformProbes {
  private results = new Map<string, HealthFinding[]>();
  private ranAt = new Map<string, number>();
  private running?: Promise<void>;
  private readonly deps: ProbeDeps;
  constructor(deps: Partial<ProbeDeps> = {}, private readonly probes: Probe[] = PROBES) {
    this.deps = { ...defaultDeps(), ...deps };
  }
  /** The cached findings; starts a refresh when a probe is due. */
  current(): HealthFinding[] {
    void this.refresh();
    return [...this.results.values()].flat();
  }
  refresh(): Promise<void> {
    if (this.running) return this.running;
    const now = this.deps.now();
    const due = this.probes.filter(p => p.platforms.includes(this.deps.platform) && now - (this.ranAt.get(p.name) ?? -Infinity) >= p.everyMs);
    if (!due.length) return Promise.resolve();
    for (const p of due) this.ranAt.set(p.name, now);
    // One at a time: these are background checks and should not compete with the work they watch.
    this.running = (async () => {
      for (const p of due) this.results.set(p.name, await p.run(this.deps).catch(() => []));
    })().finally(() => { this.running = undefined; });
    return this.running;
  }
}
