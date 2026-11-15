import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { parseEtime, parsePs, withStartTimes, type ProcessRow } from "../bridge/resources.js";
import { minutes, slotsRoot } from "./slots.js";

const exec = promisify(execFile);

/**
 * `phren reap`: what agents left running that nobody stops: dev servers,
 * build daemons, test watchers, headless browsers whose parent is gone, shell
 * wait loops and Postgres test database clones. Read-only: every row carries
 * the exact command that would stop it, and the owner runs the ones they want.
 */
export type ReapKind = "dev server" | "build daemon" | "test watcher" | "headless browser" | "wait loop";
export interface ReapRow { kind: ReapKind; name: string; pid: number; ageMs?: number; idleMs?: number; cpuShare?: number; rssBytes: number; by: string; cwd?: string; stop: string }
export interface ReapDatabase { name: string; template: string; bytes?: number; connections: number; stop: string }

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);
const AGENTS: Array<[RegExp, string]> = [[/^claude$|claude\/versions\//, "claude"], [/^codex(-.*)?$/, "codex"], [/^\.?opencode$/, "opencode"], [/^phren-agent$/, "phren agent"]];

/** What a process is, when it is something agents start and forget. */
export function classify(row: ProcessRow, parentGone: boolean): { kind: ReapKind; name: string } | undefined {
  const base = path.basename(row.command), args = row.args;
  // `until ! pgrep -f text; do sleep 5; done`: pgrep sees this shell's own command line, so it never ends.
  // `pgrep -x name` matches the program name only and is fine; `-f` is the one that matches itself.
  if (SHELLS.has(base.replace(/^-/, "")) && /\b(?:until|while)\b.*\bpgrep\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*f/.test(args)) return { kind: "wait loop", name: "pgrep -f wait loop" };
  if (/GradleDaemon|org\.gradle\.launcher\.daemon/.test(args)) return { kind: "build daemon", name: "Gradle daemon" };
  if (/KotlinCompileDaemon|kotlin-daemon/.test(args)) return { kind: "build daemon", name: "Kotlin daemon" };
  if (/\bturbo(?:\.exe)?\s+daemon\b/.test(args)) return { kind: "build daemon", name: "turbo daemon" };
  if (/\btsc(?:\.js)?\b.*\s(?:--watch|-w)(?:\s|$)/.test(args)) return { kind: "build daemon", name: "tsc --watch" };
  if (/\bvitest(?:\.mjs)?\b/.test(args) && !/\bvitest(?:\.mjs)?\s+(?:run|bench|list)\b|\s--run\b/.test(args) && !/\/vitest\/dist\/workers?\//.test(args)) return { kind: "test watcher", name: "vitest (watch)" };
  if (/\bjest(?:\.js)?\b.*\s--watch(?:All)?\b/.test(args)) return { kind: "test watcher", name: "jest --watch" };
  if (/\b(next|nuxt|astro|remix|storybook|wrangler)\b(?:\.m?js)?\s+dev\b/.test(args)) return { kind: "dev server", name: `${/\b(next|nuxt|astro|remix|storybook|wrangler)\b/.exec(args)![1]} dev` };
  if (/\bvite(?:\.m?js)?\b(?!\s+build)/.test(args) && !/\bvitest\b/.test(args)) return { kind: "dev server", name: "vite" };
  if (/webpack-dev-server|\bwebpack(?:\.js)?\s+serve\b/.test(args)) return { kind: "dev server", name: "webpack dev server" };
  if (/\b(?:nodemon|tsx\s+watch)\b/.test(args)) return { kind: "dev server", name: /nodemon/.test(args) ? "nodemon" : "tsx watch" };
  if (/\buvicorn\b.*--reload|\bpython3?\s+-m\s+http\.server\b|\brails\s+s(?:erver)?\b/.test(args)) return { kind: "dev server", name: base };
  if (parentGone && /--headless\b/.test(args) && /chrom|firefox|headless_shell/i.test(row.command + args) && !/--type=/.test(args)) return { kind: "headless browser", name: "headless browser" };
  return undefined;
}

/** The agent above a process, by ancestry or (Linux) by the session ids agents put in their children's environment. */
function startedBy(row: ProcessRow, byPid: Map<number, ProcessRow>, env: (pid: number) => string | undefined): string | undefined {
  let current: ProcessRow | undefined = byPid.get(row.ppid);
  for (let depth = 0; current && depth < 24; depth++, current = byPid.get(current.ppid)) {
    const base = path.basename(current.command);
    const agent = AGENTS.find(([pattern]) => pattern.test(base) || pattern.test(current!.command));
    if (agent) return `${agent[1]} (pid ${current.pid})`;
  }
  const vars = env(row.pid);
  if (!vars) return undefined;
  const id = (name: string) => new RegExp(`(?:^|\\0)${name}=([^\\0]+)`).exec(vars)?.[1];
  if (id("PHREN_FANOUT_JOB")) return `fan-out worker ${id("PHREN_FANOUT_JOB")} (gone)`;
  if (id("CLAUDE_CODE_SESSION_ID") || id("CLAUDECODE")) return `claude session ${id("CLAUDE_CODE_SESSION_ID")?.slice(0, 8) ?? ""} (gone)`.replace("  ", " ");
  if (id("CODEX_THREAD_ID") || id("CODEX_SESSION_ID")) return `codex thread ${(id("CODEX_THREAD_ID") ?? id("CODEX_SESSION_ID"))!.slice(0, 8)} (gone)`;
  return undefined;
}

export interface Sample { cpuSeconds: number; since: number }

/**
 * Report rows from a process table. `cpu` is each pid's cumulative CPU
 * seconds; `samples` is what an earlier report saw, so a process whose CPU
 * time has not moved since is idle at least that long. Returns the samples to
 * keep for next time. Without `all`, only work an agent started (or whose
 * parent is gone) is listed.
 */
export function reapRows(rows: ProcessRow[], options: { now: number; cpu: Map<number, number>; samples: Record<string, Sample>; all?: boolean;
  env?: (pid: number) => string | undefined; cwd?: (pid: number) => string | undefined; self?: number }): { rows: ReapRow[]; samples: Record<string, Sample> } {
  const byPid = new Map(rows.map(row => [row.pid, row])), children = new Map<number, ProcessRow[]>();
  for (const row of rows) children.set(row.ppid, [...children.get(row.ppid) ?? [], row]);
  const env = options.env ?? (() => undefined), samples: Record<string, Sample> = {}, found: ReapRow[] = [];
  // The report's own shell and its callers are never listed: they are running this.
  const claimed = new Set<number>();
  for (let pid = options.self, depth = 0; pid && pid > 1 && depth < 64; pid = byPid.get(pid)?.ppid, depth++) claimed.add(pid);
  for (const row of [...rows].sort((a, b) => a.pid - b.pid)) {
    if (claimed.has(row.pid)) continue;
    const parentGone = row.ppid <= 1 || !byPid.has(row.ppid);
    const kind = classify(row, parentGone);
    if (!kind) continue;
    const by = startedBy(row, byPid, env) ?? (parentGone ? "parent gone" : undefined);
    if (!by && !options.all) continue;
    // A server's children (esbuild, workers) count toward it and are not listed again.
    let rss = 0;
    const stack = [row];
    while (stack.length) { const next = stack.pop()!; claimed.add(next.pid); rss += next.rssKB * 1024; stack.push(...children.get(next.pid) ?? []); }
    const key = `${row.pid}:${row.startedAt ?? 0}`, cpuSeconds = options.cpu.get(row.pid);
    let idleMs: number | undefined;
    if (cpuSeconds !== undefined) {
      const before = options.samples[key];
      const since = before && before.cpuSeconds === cpuSeconds ? before.since : options.now;
      samples[key] = { cpuSeconds, since };
      if (before) idleMs = options.now - since;
    }
    const ageMs = row.startedAt ? options.now - row.startedAt : undefined;
    const cwd = options.cwd?.(row.pid);
    found.push({ ...kind, pid: row.pid, ...(ageMs !== undefined ? { ageMs } : {}), ...(idleMs !== undefined ? { idleMs } : {}),
      ...(ageMs && cpuSeconds !== undefined ? { cpuShare: Math.min(1, cpuSeconds * 1000 / ageMs) } : {}),
      rssBytes: rss, by: by ?? "you", ...(cwd ? { cwd } : {}), stop: `kill ${row.pid}` });
  }
  found.sort((a, b) => (b.idleMs ?? -1) - (a.idleMs ?? -1) || (b.ageMs ?? 0) - (a.ageMs ?? 0));
  return { rows: found, samples };
}

/** `ps -o pid=,time=` cumulative CPU: `[[dd-]hh:]mm:ss[.cc]`. */
export function parseCpuTimes(output: string): Map<number, number> {
  const cpu = new Map<number, number>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    const seconds = match ? parseEtime(match[2].replace(/\.\d+$/, "")) : undefined;
    if (match && seconds !== undefined) cpu.set(Number(match[1]), seconds);
  }
  return cpu;
}

/** Databases cloned from a test template (`hub_test_797` beside `hub_test`): name, template, size and open connections. */
export function testClones(rows: Array<{ name: string; bytes?: number; connections: number }>): ReapDatabase[] {
  const names = new Set(rows.map(row => row.name));
  return rows.flatMap(row => {
    // Strip `_suffix` parts until another database's name is left.
    let template = /^(.*)_[a-z0-9]+$/i.exec(row.name)?.[1];
    while (template && !names.has(template)) template = /^(.*)_[a-z0-9]+$/i.exec(template)?.[1];
    if (!template || !/test/i.test(template)) return [];
    return [{ name: row.name, template, ...(row.bytes !== undefined ? { bytes: row.bytes } : {}), connections: row.connections, stop: `dropdb '${row.name.replace(/'/g, "'\\''")}'` }];
  });
}

async function postgresClones(): Promise<{ databases: ReapDatabase[]; note?: string }> {
  const sql = "select datname, pg_database_size(datname), (select count(*) from pg_stat_activity a where a.datname = d.datname) from pg_database d where not datistemplate and datallowconn";
  try {
    const { stdout } = await exec("psql", ["-XAtq", "-F", "\t", "-d", "postgres", "-c", sql], { timeout: 5_000, env: { ...process.env, PGCONNECT_TIMEOUT: "3" } });
    const rows = stdout.split("\n").filter(Boolean).map(line => { const [name, bytes, connections] = line.split("\t"); return { name, bytes: Number(bytes), connections: Number(connections) || 0 }; });
    return { databases: testClones(rows) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { databases: [], note: code === "ENOENT" ? "psql not installed; Postgres not checked" : "Postgres not reachable with psql's defaults (PGHOST, PGUSER); not checked" };
  }
}

function samplesFile(): string { return path.join(path.dirname(slotsRoot()), "reap-samples.json"); }

export async function runReap(args: string[]): Promise<number> {
  if (args.some(arg => arg !== "--json" && arg !== "--all")) throw new Error("Usage: phren reap [--all] [--json]");
  const ps = (format: string) => exec("/bin/ps", ["-axo", format], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }).then(r => r.stdout);
  const [stats, argv, elapsed, times] = await Promise.all([ps("pid=,ppid=,pgid=,pcpu=,rss=,comm="), ps("pid=,args="), ps("pid=,etime=").catch(() => ""), ps("pid=,time=").catch(() => "")]);
  const now = Date.now(), rows = withStartTimes(parsePs(stats, argv), elapsed, now);
  let previous: Record<string, Sample> = {};
  try { previous = JSON.parse(fs.readFileSync(samplesFile(), "utf8")); } catch { /* First report. */ }
  const linux = process.platform === "linux";
  const report = reapRows(rows, { now, cpu: parseCpuTimes(times), samples: previous, all: args.includes("--all"), self: process.pid,
    env: pid => linux ? (() => { try { return fs.readFileSync(`/proc/${pid}/environ`, "utf8"); } catch { return undefined; } })() : undefined,
    cwd: pid => linux ? (() => { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return undefined; } })() : undefined });
  try { fs.mkdirSync(path.dirname(samplesFile()), { recursive: true, mode: 0o700 }); fs.writeFileSync(samplesFile(), JSON.stringify(report.samples), { mode: 0o600 }); } catch { /* Idle times start over next time. */ }
  const pg = await postgresClones();
  if (args.includes("--json")) { console.log(JSON.stringify({ processes: report.rows, databases: pg.databases, ...(pg.note ? { note: pg.note } : {}) }, null, 2)); return 0; }
  const mb = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
  if (!report.rows.length && !pg.databases.length) console.log("Nothing left running by agents.");
  for (const row of report.rows) {
    const idle = row.idleMs !== undefined ? `idle ${minutes(row.idleMs)}` : `idle unknown${row.cpuShare !== undefined ? `, ${(row.cpuShare * 100).toFixed(1)}% CPU over its life` : ""}`;
    console.log(`${row.kind}: ${row.name}, pid ${row.pid}, ${row.ageMs !== undefined ? `up ${minutes(row.ageMs)}` : "age unknown"}, ${idle}, ${mb(row.rssBytes)}, started by ${row.by}${row.cwd ? `, in ${row.cwd}` : ""}`);
    console.log(`  stop: ${row.stop}`);
  }
  for (const db of pg.databases) {
    console.log(`test database: ${db.name} (clone of ${db.template})${db.bytes !== undefined ? `, ${mb(db.bytes)}` : ""}, ${db.connections} connection${db.connections === 1 ? "" : "s"}`);
    console.log(`  stop: ${db.stop}`);
  }
  if (pg.note) console.log(pg.note);
  if (report.rows.some(row => row.idleMs === undefined)) console.log("Idle time shows from the second report on: run phren reap again later.");
  console.log("Nothing was stopped. Run the stop commands you want.");
  return 0;
}
