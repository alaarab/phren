/**
 * `phren dream run|status|log|eval`: the CLI over the dream engine (dream/run.ts)
 * and its outputs under `<store>/<project>/dreams/`. The MCP `dream_*` tools
 * (tools/dream.ts) call the same functions.
 */

import * as fs from "fs";
import * as path from "path";
import { redactSecretsForLog } from "../content/secrets.js";
import { applyDreamProposals, pendingDreamProposals } from "../dream/apply.js";
import { detectProject } from "../shared/index.js";
import { isValidProjectName } from "../utils.js";
import type { DreamMode } from "../config/dreaming.js";
import { dreamStatus, dreamStoreProjects, dreamsDir, dreamOutcomeCounts, type DreamStatus } from "../bridge/dream-schedule.js";
import { helperFor } from "../bridge/helper.js";
import { readDreamConfig } from "../dream/run.js";

export const DREAM_USAGE = `phren dream - reorganize a project's memory offline (docs/dreaming.md)

  phren dream run [--project <p>] [--dry-run] [--apply|--propose] [--force] [--json]
        Run a dream now. --dry-run shows the changeset without writing; --apply/--propose
        override dreaming.mode; --force runs even when dreaming is off.
  phren dream apply <runId> [--project <p>] [--only <n,m,...>] [--json]
        Apply pending structured proposals by zero-based index; refuse changed targets.
  phren dream status [--project <p>] [--json]
        Enabled, cadence, last run, next eligible time and last outcome counts
        (every project when --project is omitted and the folder is not a project).
  phren dream log [--project <p>] [--limit <n>] [--json]
        The latest entries of the project's dream journal (dreams/journal.md).
  phren dream eval [--real] [--model <m>] [--json]
        Score the dream engine on the bundled fixture store (a scripted model unless --real).

Turn it on with: phren config dreaming set enabled=true [cadence=nightly|idle|weekly|manual]`;

export const DREAM_LOG_DEFAULT_LIMIT = 20;
export const DREAM_LOG_MAX_LIMIT = 500;

export interface DreamRunArgs { project?: string; dryRun: boolean; mode?: DreamMode; force: boolean; scheduled: boolean; json: boolean }
export interface DreamListArgs { project?: string; limit: number; json: boolean }
export interface DreamEvalArgs { real: boolean; model?: string; json: boolean }

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function takeValue(args: string[], i: number, flag: string): { value?: string; skip: number; error?: string } {
  const arg = args[i];
  if (arg.startsWith(`${flag}=`)) return { value: arg.slice(flag.length + 1), skip: 0 };
  const next = args[i + 1];
  if (next === undefined || next.startsWith("--")) return { skip: 0, error: `${flag} needs a value.` };
  return { value: next, skip: 1 };
}

function checkProject(project: string | undefined): string | undefined {
  return project !== undefined && !isValidProjectName(project) ? `Invalid project name: "${project}".` : undefined;
}

export function parseDreamRunArgs(args: string[]): Parsed<DreamRunArgs> {
  const out: DreamRunArgs = { dryRun: false, force: false, scheduled: false, json: false };
  const modes = new Set<DreamMode>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project" || arg.startsWith("--project=")) {
      const taken = takeValue(args, i, "--project");
      if (taken.error) return { ok: false, error: taken.error };
      out.project = taken.value; i += taken.skip;
    } else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--apply") modes.add("apply");
    else if (arg === "--propose") modes.add("propose");
    else if (arg === "--force") out.force = true;
    else if (arg === "--scheduled") out.scheduled = true;
    else if (arg === "--json") out.json = true;
    else return { ok: false, error: `Unknown argument for phren dream run: "${arg}".` };
  }
  if (modes.size > 1) return { ok: false, error: "Pass --apply or --propose, not both." };
  if (modes.size) out.mode = [...modes][0];
  const bad = checkProject(out.project);
  return bad ? { ok: false, error: bad } : { ok: true, value: out };
}

export function parseDreamListArgs(args: string[], verb: "status" | "log"): Parsed<DreamListArgs> {
  const out: DreamListArgs = { limit: DREAM_LOG_DEFAULT_LIMIT, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project" || arg.startsWith("--project=")) {
      const taken = takeValue(args, i, "--project");
      if (taken.error) return { ok: false, error: taken.error };
      out.project = taken.value; i += taken.skip;
    } else if (verb === "log" && (arg === "--limit" || arg.startsWith("--limit="))) {
      const taken = takeValue(args, i, "--limit");
      const n = Number(taken.value);
      if (taken.error || !Number.isInteger(n) || n < 1 || n > DREAM_LOG_MAX_LIMIT) {
        return { ok: false, error: `--limit takes a whole number from 1 to ${DREAM_LOG_MAX_LIMIT}.` };
      }
      out.limit = n; i += taken.skip;
    } else if (arg === "--json") out.json = true;
    else return { ok: false, error: `Unknown argument for phren dream ${verb}: "${arg}".` };
  }
  const bad = checkProject(out.project);
  return bad ? { ok: false, error: bad } : { ok: true, value: out };
}

export function parseDreamEvalArgs(args: string[]): Parsed<DreamEvalArgs> {
  const out: DreamEvalArgs = { real: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--real") out.real = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--model" || arg.startsWith("--model=")) {
      const taken = takeValue(args, i, "--model");
      if (taken.error) return { ok: false, error: taken.error };
      out.model = taken.value; i += taken.skip;
    } else return { ok: false, error: `Unknown argument for phren dream eval: "${arg}".` };
  }
  return { ok: true, value: out };
}

/** The named project, else the one this folder belongs to. */
export function resolveDreamProject(phrenPath: string, project: string | undefined, profile?: string, cwd = process.cwd()): string | undefined {
  return project ?? detectProject(phrenPath, cwd, profile) ?? undefined;
}

export interface DreamRunOutcome {
  project: string;
  status: string;
  result: Record<string, unknown>;
  counts?: Record<string, number>;
}

/** Run one dream; the engine owns the marker inside its project lock. */
export async function runDream(phrenPath: string, project: string, opts: { dryRun?: boolean; mode?: DreamMode; force?: boolean; trigger?: "manual" | "scheduled" }): Promise<DreamRunOutcome> {
  const { dream } = await import("../dream/run.js");
  // The store travels along for an engine that takes it; one that reads PHREN_PATH ignores it.
  const store = { phrenPath };
  const result = await dream(project, { ...store, dryRun: opts.dryRun, mode: opts.mode, force: opts.force, trigger: opts.trigger ?? "manual", now: new Date() }) as unknown;
  const record = result && typeof result === "object" ? result as Record<string, unknown> : { status: "error", error: "The dream engine returned nothing." };
  const status = typeof record.status === "string" ? record.status : "error";
  const counts = dreamOutcomeCounts(record);
  return { project, status, result: record, ...(counts ? { counts } : {}) };
}

/** The last `limit` entries of `dreams/journal.md`, newest first. An entry is a non-blank line that is not a heading. */
export function readDreamJournal(phrenPath: string, project: string, limit = DREAM_LOG_DEFAULT_LIMIT): string[] {
  const dir = dreamsDir(phrenPath, project);
  if (!dir) return [];
  let text: string;
  try { text = fs.readFileSync(path.join(dir, "journal.md"), "utf8"); } catch { return []; }
  return text.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim() && !line.startsWith("#")).slice(-limit).reverse().map(redactSecretsForLog);
}

/** Status for one project or, with none named or detected, for every project in the profile. */
export function dreamStatuses(phrenPath: string, project: string | undefined, profile?: string, now = new Date()): DreamStatus[] {
  const names = project ? [project] : dreamStoreProjects(phrenPath, profile).sort();
  return names.map((name) => ({ ...dreamStatus(phrenPath, name, now), runsOn: helperSummary(phrenPath, name) }));
}

/** Dreams run on the project's helper account (role helpers), never silently on another login. */
function helperSummary(phrenPath: string, project: string): string {
  try {
    const choice = helperFor(phrenPath, project);
    const model = readDreamConfig(phrenPath, project).model;
    return `helper ${choice.account} · ${model || choice.model}`;
  } catch (err) {
    return `no helper account, so dreams can't run yet: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function formatStatus(status: DreamStatus): string {
  const lines = [`${status.project}: dreaming ${status.enabled ? "on" : "off"} · ${status.cadence}${status.cadence === "nightly" || status.cadence === "weekly" ? ` ${status.window}` : ""} · ${status.mode}`];
  if (status.lastRun) {
    const counts = status.lastOutcome ? ` (${Object.entries(status.lastOutcome).map(([k, n]) => `${k} ${n}`).join(", ")})` : "";
    lines.push(`  last run: ${status.lastRun.at} ${status.lastRun.status}${status.lastRun.trigger ? `, ${status.lastRun.trigger}` : ""}${counts}`);
  } else lines.push("  last run: never");
  lines.push(`  next: ${status.nextEligibleAt ?? "—"} · ${status.reason}`);
  lines.push(`  pending proposals: ${status.pendingProposals}`);
  if (status.runsOn) lines.push(`  runs on: ${status.runsOn}`);
  return lines.join("\n");
}

function fail(message: string): void {
  console.error(redactSecretsForLog(message));
  process.exitCode = 1;
}

export async function handleDreamCommand(args: string[], phrenPath: string, profile?: string): Promise<void> {
  const [verb, ...rest] = args;
  switch (verb) {
    case "apply": {
      const [runId, ...flags] = rest;
      if (!runId) return fail("Name the dream run ID.");
      let only: number[] | undefined;
      const listFlags: string[] = [];
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] === "--only" || flags[i].startsWith("--only=")) {
          const taken = takeValue(flags, i, "--only");
          if (taken.error || !/^\d+(,\d+)*$/.test(taken.value ?? "")) return fail("--only takes comma-separated nonnegative proposal indices.");
          only = taken.value!.split(",").map(Number); i += taken.skip;
        } else listFlags.push(flags[i]);
      }
      const parsed = parseDreamListArgs(listFlags, "status");
      if (!parsed.ok) return fail(parsed.error);
      const project = resolveDreamProject(phrenPath, parsed.value.project, profile);
      if (!project) return fail("Name the project with --project <name>.");
      try {
        const record = await applyDreamProposals(phrenPath, project, runId, only);
        console.log(parsed.value.json ? JSON.stringify(record, null, 2) : record.outcomes.map(o => `${o.index}: ${o.op} ${o.status} — ${o.detail}`).join("\n"));
      } catch (err) { fail(err instanceof Error ? err.message : String(err)); }
      return;
    }
    case "run": {
      const parsed = parseDreamRunArgs(rest);
      if (!parsed.ok) return fail(`${parsed.error}\n\n${DREAM_USAGE}`);
      const project = resolveDreamProject(phrenPath, parsed.value.project, profile);
      if (!project) return fail("Name the project with --project <name>; this folder is not one of your projects.");
      const outcome = await runDream(phrenPath, project, { dryRun: parsed.value.dryRun, mode: parsed.value.mode, force: parsed.value.force,
        trigger: parsed.value.scheduled ? "scheduled" : "manual" });
      if (parsed.value.json) console.log(JSON.stringify(outcome, null, 2));
      else {
        const counts = outcome.counts && Object.keys(outcome.counts).length ? ` · ${Object.entries(outcome.counts).map(([k, n]) => `${k} ${n}`).join(", ")}` : "";
        const runId = typeof outcome.result.runId === "string" ? ` ${outcome.result.runId}` : "";
        console.log(`Dream${runId} for ${project}: ${outcome.status}${parsed.value.dryRun ? " (dry run)" : ""}${counts}`);
        if (Array.isArray(outcome.result.warnings)) for (const warning of outcome.result.warnings) console.log(redactSecretsForLog(String(warning)));
        if (outcome.status === "disabled") console.log("Dreaming is off for this project. `phren config dreaming set enabled=true` turns it on; --force runs once anyway.");
        if (outcome.status === "busy") console.log("Another dream for this project is running.");
        if (typeof outcome.result.error === "string") console.error(outcome.result.error);
        else if (outcome.status === "failed" && typeof outcome.result.message === "string") console.error(outcome.result.message);
        if (parsed.value.dryRun && outcome.result.changeset) console.log(JSON.stringify(outcome.result.changeset, null, 2));
      }
      if (outcome.status === "error" || outcome.status === "failed") process.exitCode = 1;
      return;
    }
    case "status": {
      const parsed = parseDreamListArgs(rest, "status");
      if (!parsed.ok) return fail(`${parsed.error}\n\n${DREAM_USAGE}`);
      const project = resolveDreamProject(phrenPath, parsed.value.project, profile);
      const statuses = dreamStatuses(phrenPath, project, profile);
      if (parsed.value.json) console.log(JSON.stringify(project ? statuses[0] : statuses, null, 2));
      else console.log(statuses.length ? statuses.map(formatStatus).join("\n\n") : "No projects.");
      return;
    }
    case "log": {
      const parsed = parseDreamListArgs(rest, "log");
      if (!parsed.ok) return fail(`${parsed.error}\n\n${DREAM_USAGE}`);
      const project = resolveDreamProject(phrenPath, parsed.value.project, profile);
      if (!project) return fail("Name the project with --project <name>; this folder is not one of your projects.");
      const entries = readDreamJournal(phrenPath, project, parsed.value.limit);
      if (parsed.value.json) console.log(JSON.stringify({ project, entries, pendingProposals: pendingDreamProposals(phrenPath, project) }, null, 2));
      else console.log((entries.length ? entries.join("\n") : `No dreams recorded for ${project} yet.`) + `\nPending proposals: ${pendingDreamProposals(phrenPath, project)}`);
      return;
    }
    case "eval": {
      const parsed = parseDreamEvalArgs(rest);
      if (!parsed.ok) return fail(`${parsed.error}\n\n${DREAM_USAGE}`);
      // The harness lives in dream/eval/ (worker C); resolved at run time so the CLI never depends on it to build.
      const specifier = "../dream/eval/index.js";
      let mod: Record<string, unknown>;
      try { mod = await import(specifier) as Record<string, unknown>; }
      catch { return fail("The dream eval harness is not installed in this build."); }
      const run = (mod.runDreamEval ?? mod.default) as ((opts: { real: boolean; model?: string }) => Promise<unknown>) | undefined;
      if (typeof run !== "function") return fail("The dream eval harness exports no runDreamEval.");
      const report = await run({ real: parsed.value.real, ...(parsed.value.model ? { model: parsed.value.model } : {}) });
      console.log(parsed.value.json || typeof report !== "string" ? JSON.stringify(report, null, 2) : report);
      const passed = report && typeof report === "object" ? (report as Record<string, unknown>).passed : undefined;
      if (passed === false) process.exitCode = 1;
      return;
    }
    case undefined:
    case "help":
    case "--help":
      console.log(DREAM_USAGE);
      return;
    default:
      return fail(`Unknown dream subcommand "${verb}".\n\n${DREAM_USAGE}`);
  }
}
