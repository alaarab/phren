/**
 * `phren task audit`: the CLI over the task audit engine (task/audit.ts) and
 * its records under `<store>/<project>/task-audits/`. The registry's `task`
 * namespace dispatches the "audit" subcommand here; the Hook's ticker
 * (bridge/task-audit-schedule.ts) runs the same thing with --scheduled.
 */

import { redactSecretsForLog } from "../content/secrets.js";
import { detectProject } from "../shared/index.js";
import { auditTasks, AUDIT_LIMIT_DEFAULT, type AuditTrigger } from "../task/audit.js";
import { isValidProjectName } from "../utils.js";

export const TASK_AUDIT_USAGE = `phren task audit - audit a project's open tasks against its code (issue #934)

  phren task audit [--project <p>] [--scheduled] [--dry-run] [--limit <n>] [--json]
        Audit the oldest open tasks (default ${AUDIT_LIMIT_DEFAULT}) with the project's helper
        model and close the ones its evidence shows done; the rest get a dated note
        at most, and nothing is ever removed. --dry-run shows the verdicts without
        touching a task; --scheduled marks a ticker-started run.

The Hook starts this weekly for each project whose dreaming config is enabled
and whose window is open; PHREN_TASK_AUDIT=off stops that ticker.`;

export const TASK_AUDIT_MAX_LIMIT = 500;

export interface TaskAuditArgs { project?: string; scheduled: boolean; dryRun: boolean; limit?: number; json: boolean }

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function takeValue(args: string[], i: number, flag: string): { value?: string; skip: number; error?: string } {
  const arg = args[i];
  if (arg.startsWith(`${flag}=`)) return { value: arg.slice(flag.length + 1), skip: 0 };
  const next = args[i + 1];
  if (next === undefined || next.startsWith("--")) return { skip: 0, error: `${flag} needs a value.` };
  return { value: next, skip: 1 };
}

export function parseTaskAuditArgs(args: string[]): Parsed<TaskAuditArgs> {
  const out: TaskAuditArgs = { scheduled: false, dryRun: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project" || arg.startsWith("--project=")) {
      const taken = takeValue(args, i, "--project");
      if (taken.error) return { ok: false, error: taken.error };
      out.project = taken.value; i += taken.skip;
    } else if (arg === "--scheduled") out.scheduled = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const taken = takeValue(args, i, "--limit");
      const n = Number(taken.value);
      if (taken.error || !Number.isInteger(n) || n < 1 || n > TASK_AUDIT_MAX_LIMIT) {
        return { ok: false, error: `--limit takes a whole number from 1 to ${TASK_AUDIT_MAX_LIMIT}.` };
      }
      out.limit = n; i += taken.skip;
    } else return { ok: false, error: `Unknown argument for phren task audit: "${arg}".` };
  }
  if (out.project !== undefined && !isValidProjectName(out.project)) {
    return { ok: false, error: `Invalid project name: "${out.project}".` };
  }
  return { ok: true, value: out };
}

function fail(message: string): void {
  console.error(redactSecretsForLog(message));
  process.exitCode = 1;
}

export async function handleTaskAudit(args: string[], phrenPath: string, profile?: string): Promise<void> {
  const parsed = parseTaskAuditArgs(args);
  if (!parsed.ok) return fail(`${parsed.error}\n\n${TASK_AUDIT_USAGE}`);
  const project = parsed.value.project ?? detectProject(phrenPath, process.cwd(), profile) ?? undefined;
  if (!project) return fail("Name the project with --project <name>; this folder is not one of your projects.");
  const trigger: AuditTrigger = parsed.value.scheduled ? "scheduled" : "manual";
  const result = await auditTasks(project, { phrenPath, trigger, dryRun: parsed.value.dryRun,
    ...(parsed.value.limit ? { limit: parsed.value.limit } : {}) });

  if (parsed.value.json) console.log(JSON.stringify(result, null, 2));
  else {
    const counts = result.counts && Object.keys(result.counts).length
      ? ` · ${Object.entries(result.counts).filter(([, n]) => n > 0).map(([key, n]) => `${key} ${n}`).join(", ")}` : "";
    const runId = result.runId ? ` ${result.runId}` : "";
    console.log(`Task audit${runId} for ${project}: ${result.status}${parsed.value.dryRun ? " (dry run)" : ""}${counts}`);
    if (result.status === "busy") console.log("Another task audit for this project is running.");
    if (result.status === "empty") console.log("No open tasks with a stable ID; nothing to audit.");
    if (result.status === "failed") console.error(result.message);
    if (parsed.value.dryRun && result.verdicts?.length) console.log(JSON.stringify(result.verdicts, null, 2));
  }
  if (result.status === "failed") process.exitCode = 1;
}
