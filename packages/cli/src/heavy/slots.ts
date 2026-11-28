import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { withFileLock } from "../governance/locks.js";
import { type Budget, type Pressure, pressureReason } from "./budget.js";

/**
 * A computer-wide counting semaphore in a directory: one small JSON ticket per
 * waiting or running job, ordered by priority and then arrival. Any shell on
 * the computer joins it through `phren heavy`, and `phren fanout run` through
 * its `workers` pool, so agents in different panes, harnesses and stores share
 * one count. A ticket whose process is gone is dropped by the next reader, so
 * a killed job never holds its slot.
 */
export const PRIORITIES = { release: 2, normal: 1, low: 0 } as const;
export type PriorityName = keyof typeof PRIORITIES;

/** What a `workers` ticket says about the fan-out worker it holds a place for,
 * so the Hook can show a queued worker under the agent that launched it before
 * the worker has a manifest. `provider` is absent until a picker chooses it. */
export interface WorkerTag {
  parent: { provider: "codex" | "claude"; session: string };
  provider?: "codex" | "opencode" | "claude";
  model?: string;
}
export interface Ticket { id: string; pid: number; priority: number; createdAt: number; label: string; state: "waiting" | "running"; startedAt?: number; worker?: WorkerTag }

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDERS = new Set(["codex", "opencode", "claude"]);

/** The worker a queued command will start, read from the launcher's own
 * environment and command line the way the fan-out wrappers and `phren fanout
 * run` choose a manifest's parent: Codex's thread id unless the nearest agent
 * process above is Claude, then Claude's session id. The provider comes from
 * `--provider` or a wrapper named `<provider>.sh`, the model from `--model`. */
export function workerTag(command: readonly string[], env: NodeJS.ProcessEnv, nearest: () => "codex" | "claude" | undefined,
  known: { provider?: string; model?: string } = {}): WorkerTag | undefined {
  const codex = [env.CODEX_THREAD_ID, env.CODEX_SESSION_ID].find(value => value && SESSION_UUID.test(value));
  const claude = env.CLAUDE_CODE_SESSION_ID && SESSION_UUID.test(env.CLAUDE_CODE_SESSION_ID) ? env.CLAUDE_CODE_SESSION_ID : undefined;
  const parent = codex && !(claude && nearest() === "claude") ? { provider: "codex" as const, session: codex.toLowerCase() }
    : claude ? { provider: "claude" as const, session: claude.toLowerCase() } : undefined;
  if (!parent) return undefined;
  const flag = (name: string) => { const at = command.indexOf(name); return at >= 0 ? command[at + 1] : undefined; };
  const script = /^(codex|opencode|claude)\.sh$/.exec(path.basename(command[0] ?? ""))?.[1];
  const provider = [known.provider, flag("--provider"), script].find(value => value && PROVIDERS.has(value)) as WorkerTag["provider"];
  const model = (known.model ?? flag("--model"))?.trim().slice(0, 200);
  return { parent, ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
}

export function slotsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.PHREN_SLOTS_DIR || path.join(env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "phren", "slots");
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function priorityName(priority: number): PriorityName {
  return (Object.keys(PRIORITIES) as PriorityName[]).find(name => PRIORITIES[name] === priority) ?? "normal";
}

/** Tickets of a pool, with dead holders' and waiters' tickets removed. */
export function readTickets(dir: string, isAlive: (pid: number) => boolean = alive): Ticket[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const tickets: Ticket[] = [];
  for (const name of names.filter(n => n.endsWith(".json"))) {
    const file = path.join(dir, name);
    try {
      const ticket = JSON.parse(fs.readFileSync(file, "utf8")) as Ticket;
      if (!Number.isInteger(ticket.pid) || !isAlive(ticket.pid)) { fs.rmSync(file, { force: true }); continue; }
      tickets.push(ticket);
    } catch { /* Partly written or removed meanwhile. */ }
  }
  return tickets;
}

/** Waiters in the order they will start: release work first, then by arrival. */
export function queueOrder(tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter(t => t.state === "waiting").sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

type Decision = { start: true; warning?: string } | { start: false; reason: string };

/**
 * Whether ticket `id` may start now. The pressure gate holds only while
 * another job in the pool runs: with the pool empty the first job always
 * starts (with a warning), so pressure from outside the pool can slow work
 * but never stop it for good.
 */
function decide(tickets: readonly Ticket[], id: string, slots: number, pressure: Pressure | undefined, budget: Budget, now = Date.now()): Decision {
  const running = tickets.filter(t => t.state === "running");
  const order = queueOrder(tickets), position = order.findIndex(t => t.id === id);
  const busy = running.map(t => `${t.label} (pid ${t.pid}, ${minutes(now - (t.startedAt ?? t.createdAt))})`).join(", ");
  if (running.length >= slots) return { start: false, reason: `all ${slots} slot${slots === 1 ? "" : "s"} busy: ${busy}` };
  if (position > 0) return { start: false, reason: `${position} job${position === 1 ? "" : "s"} ahead (${order.slice(0, position).map(t => `${t.label}, ${priorityName(t.priority)}`).join("; ")})` };
  const pressed = pressure && pressureReason(pressure, budget);
  if (pressed && running.length) return { start: false, reason: `${pressed}; ${running.length} running: ${busy}` };
  return pressed ? { start: true, warning: `${pressed}; starting anyway because nothing else in this pool is running` } : { start: true };
}

export function minutes(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export interface AcquireOptions {
  pool: string; slots: number; priority: number; label: string; budget: Budget;
  pressure: () => Promise<Pressure | undefined>;
  /** Called each time the reason for waiting changes, and once on start. */
  report: (message: string) => void;
  pollMs?: number; timeoutMs?: number; root?: string; pid?: number; now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The fan-out worker this ticket holds a place for (the `workers` pool). */
  worker?: WorkerTag;
}

export interface Held { id: string; release: () => void; waitedMs: number }

/** Waits for a slot. Throws `QueueTimeout` after `timeoutMs`; the ticket is removed either way. */
export async function acquire(options: AcquireOptions): Promise<Held> {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(options.pool)) throw new Error("Pool names are lowercase letters, digits and dashes.");
  const dir = path.join(options.root ?? slotsRoot(), options.pool), now = options.now ?? Date.now;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = `${now()}-${randomBytes(6).toString("hex")}`, file = path.join(dir, `${id}.json`), began = now();
  const ticket: Ticket = { id, pid: options.pid ?? process.pid, priority: options.priority, createdAt: began, label: options.label.slice(0, 120), state: "waiting",
    ...(options.worker ? { worker: options.worker } : {}) };
  const write = () => { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(ticket), { mode: 0o600 }); fs.renameSync(tmp, file); };
  const release = () => { fs.rmSync(file, { force: true }); };
  write();
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let said = "";
  try {
    for (;;) {
      const pressure = await options.pressure().catch(() => undefined);
      const decision = withFileLock(path.join(dir, ".queue"), () => {
        const result = decide(readTickets(dir), id, options.slots, pressure, options.budget, now());
        if (result.start) { ticket.state = "running"; ticket.startedAt = now(); write(); }
        return result;
      });
      if (decision.start) {
        const waited = now() - began;
        options.report(`${decision.warning ? `warning: ${decision.warning}. ` : ""}started${waited >= 1_000 ? ` after waiting ${minutes(waited)}` : ""}`);
        return { id, release, waitedMs: waited };
      }
      if (decision.reason !== said) { said = decision.reason; options.report(`queued: ${decision.reason}`); }
      if (options.timeoutMs !== undefined && now() - began >= options.timeoutMs) throw new QueueTimeout(`gave up after ${minutes(now() - began)} in the queue: ${said}`);
      await sleep(options.pollMs ?? 5_000);
    }
  } catch (error) { release(); throw error; }
}

export class QueueTimeout extends Error {}

export function poolStatus(pool: string, root = slotsRoot()): Ticket[] {
  const dir = path.join(root, pool);
  const tickets = readTickets(dir);
  return [...tickets.filter(t => t.state === "running").sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)), ...queueOrder(tickets)];
}

export function pools(root = slotsRoot()): string[] {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch { return []; }
}
