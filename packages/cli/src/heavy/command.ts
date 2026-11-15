import { spawn } from "node:child_process";
import { budgetFile, describePressure, readBudget, readPressure } from "./budget.js";
import { acquire, minutes, poolStatus, pools, PRIORITIES, priorityName, QueueTimeout, type PriorityName } from "./slots.js";

const USAGE = `Usage: phren heavy [--priority release|normal|low] [--slots N] [--pool NAME] [--label TEXT] [--timeout MINUTES] -- <command...>
       phren heavy status [--json]`;

/**
 * `phren heavy -- pnpm test`: run one heavy job (a full test run, a native
 * build) once this computer has a slot for it. Up to the budget's
 * `heavySlots` run at once; waiting jobs start release work first, then in
 * arrival order. The command's own exit code is returned; 75 when it never
 * started (timeout). Messages go to stderr so the command's stdout is untouched.
 */
export async function runHeavy(args: string[]): Promise<number> {
  if (args[0] === "status") return status(args.slice(1));
  const split = args.indexOf("--");
  if (split < 0 || split === args.length - 1) throw new Error(USAGE);
  const options = args.slice(0, split), command = args.slice(split + 1);
  const flags: Record<string, string> = {};
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i], value = options[i + 1];
    if (!["--priority", "--slots", "--pool", "--label", "--timeout"].includes(key) || value === undefined) throw new Error(USAGE);
    flags[key.slice(2)] = value;
  }
  const priority = (flags.priority ?? process.env.PHREN_HEAVY_PRIORITY ?? "normal") as PriorityName;
  if (!(priority in PRIORITIES)) throw new Error("Choose priority release, normal or low.");
  const pressure = await readPressure(), budget = readBudget(pressure.totalBytes);
  const pool = flags.pool ?? "heavy";
  const slots = flags.slots ? Number(flags.slots) : pool === "workers" ? budget.workers : budget.heavySlots;
  if (!Number.isInteger(slots) || slots < 1 || slots > 64) throw new Error("--slots takes a whole number from 1 to 64.");
  const timeout = flags.timeout === undefined ? undefined : Number(flags.timeout);
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) throw new Error("--timeout takes minutes.");
  const label = (flags.label ?? command.join(" ")).replace(/\s+/g, " ").slice(0, 120);
  const say = (message: string) => process.stderr.write(`phren heavy: ${message}\n`);
  let held;
  try {
    held = await acquire({ pool, slots, priority: PRIORITIES[priority], label, budget, pressure: () => readPressure(),
      report: message => say(`${message} [${pool}: ${slots} slot${slots === 1 ? "" : "s"}, ${priority}]`),
      ...(timeout !== undefined ? { timeoutMs: timeout * 60_000 } : {}) });
  } catch (error) {
    if (error instanceof QueueTimeout) { say(`not started, ${error.message}`); return 75; }
    throw error;
  }
  try {
    return await new Promise<number>(resolve => {
      const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: { ...process.env, PHREN_HEAVY_POOL: pool } });
      // Pass the person's or agent's interrupt on and keep the slot until the job is gone.
      const forward = (signal: NodeJS.Signals) => () => { try { child.kill(signal); } catch { /* Gone. */ } };
      const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(signal => [signal, forward(signal)] as const);
      for (const [signal, handler] of handlers) process.on(signal, handler);
      const done = (code: number) => { for (const [signal, handler] of handlers) process.off(signal, handler); resolve(code); };
      child.once("error", error => { say(`${command[0]}: ${error.message}`); done(127); });
      child.once("exit", (code, signal) => done(code ?? (signal ? 128 + (({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 } as Record<string, number>)[signal] ?? 1) : 1)));
    });
  } finally { held.release(); }
}

async function status(args: string[]): Promise<number> {
  if (args.some(arg => arg !== "--json")) throw new Error(USAGE);
  const pressure = await readPressure(), budget = readBudget(pressure.totalBytes), now = Date.now();
  const report = { pressure, budget, budgetFile: budgetFile(),
    pools: pools().map(pool => ({ pool, tickets: poolStatus(pool) })) };
  if (args.includes("--json")) { console.log(JSON.stringify(report, null, 2)); return 0; }
  console.log(`${describePressure(pressure)}`);
  console.log(`Budget: ${budget.workers} workers, ${budget.heavySlots} heavy jobs, at least ${(budget.minFreeBytes / 1024 ** 3).toFixed(1)} GB free, load under ${budget.maxLoadPerCore} per core (${report.budgetFile})`);
  for (const { pool, tickets } of report.pools) {
    if (!tickets.length) continue;
    console.log(`\n${pool}`);
    for (const t of tickets) console.log(`  ${t.state === "running" ? "running" : "waiting"}\t${minutes(now - (t.startedAt ?? t.createdAt))}\t${priorityName(t.priority)}\tpid ${t.pid}\t${t.label}`);
  }
  return 0;
}
