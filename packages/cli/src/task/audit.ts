// auditTasks(): one bounded weekly audit of a project's open tasks (issue #934).
// A headless helper model reads the phren-task-audit skill's rules, the oldest
// Active+Queue tasks (at most `limit`, so a 246-task project stays bounded) and
// the repository, then replies with one verdict per task. phren closes the ones
// the evidence shows done and leaves every other task a dated note at most —
// a task is never removed: the owner decides what to keep. Same shape as a
// dream (dream/run.ts): lock per project, strict JSON parse, a run record and
// a last-run marker the scheduler reads back.
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import { redactSecretsForLog } from "../content/secrets.js";
import { completeTask, readTasks, updateTask, type TaskDoc, type TaskItem } from "../data/tasks.js";
import { projectDirsFor, projectStoreDir } from "../dream/collect.js";
import { defaultDreamRunner, newRunId, type DreamRunner, type DreamRunnerResult } from "../dream/run.js";
import { tryFileLock } from "../governance/locks.js";
import { taskWriteDenied } from "./write-access.js";
import { findPhrenPath, renameOverSync, runtimeDir } from "../phren-paths.js";
import { findSkill } from "../skill/registry.js";
import { isValidProjectName } from "../utils-paths.js";
import { taskLastTouched } from "./session-tasks.js";

/** Most tasks sent to the model in one run; the oldest go first. */
export const AUDIT_LIMIT_DEFAULT = 40;
/** A task's context is cut to this many characters in the prompt. */
const AUDIT_CONTEXT_CHARS = 600;
/** The evidence and remainder fields are capped at this length. */
export const AUDIT_EVIDENCE_MAX = 500;
const AUDIT_TIMEOUT_S = 600;
const AUDIT_SKILL_NAME = "phren-task-audit";

/** Used only when the installed skill is missing, so the audit still has rules to follow. */
export const EMBEDDED_AUDIT_RULES = [
  "You are auditing a project's open tasks against its code.",
  "For each task, check the repository in your working directory and its git history for the work.",
  '- done: the change is in the code now. evidence must name what shows it: a commit, a file and function, or a test.',
  "- partial: some of it is in the code. remainder says what is still missing.",
  "- valid: the work is still worth doing and has not started.",
  "- obsolete: the code or the plan moved on and the task no longer applies. evidence says why.",
  "- unresolved: you cannot tell from the repository.",
  "Never edit anything, never invent evidence, never remove a task; a person decides what to keep.",
].join("\n");

export type AuditVerdictKind = "done" | "partial" | "valid" | "obsolete" | "unresolved";

export interface AuditVerdict {
  bid: string;
  verdict: AuditVerdictKind;
  evidence?: string;
  remainder?: string;
}

/** A reply the audit refused, with why; `index` is its position in the model's answer. */
export interface AuditDrop { index: number; bid?: string; reason: string }

export type AuditAppliedAction = "closed" | "noted" | "denied" | "failed";
/** What one accepted verdict did to the store. */
export interface AuditApplied { bid: string; action: AuditAppliedAction; detail: string }

export interface AuditCounts {
  candidates: number;
  done: number;
  partial: number;
  obsolete: number;
  valid: number;
  unresolved: number;
  dropped: number;
  closed: number;
  noted: number;
  denied: number;
  failed: number;
}

const emptyCounts = (): AuditCounts => ({ candidates: 0, done: 0, partial: 0, obsolete: 0, valid: 0, unresolved: 0,
  dropped: 0, closed: 0, noted: 0, denied: 0, failed: 0 });

export type AuditStatus = "ok" | "busy" | "empty" | "failed";
export type AuditTrigger = "manual" | "scheduled";

export interface AuditOptions {
  phrenPath?: string;
  trigger?: AuditTrigger;
  dryRun?: boolean;
  now?: Date;
  runner?: DreamRunner;
  limit?: number;
  signal?: AbortSignal;
}

export interface TaskAuditResult {
  status: AuditStatus;
  project: string;
  trigger: AuditTrigger;
  dryRun: boolean;
  runId?: string;
  message: string;
  verdicts?: AuditVerdict[];
  dropped?: AuditDrop[];
  counts?: AuditCounts;
  /** task-audits/<runId>.json, when recorded. */
  record?: string;
  model?: string;
  costUSD?: number;
}

/** task-audits/<runId>.json: what the model said and what phren did about it. */
export interface TaskAuditRecord {
  project: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  trigger: AuditTrigger;
  candidates: string[];
  verdicts: AuditVerdict[];
  dropped: AuditDrop[];
  applied: AuditApplied[];
  counts: AuditCounts;
  model?: string;
  costUSD?: number;
}

export interface AuditLastRun { at: string; status: AuditStatus; trigger: AuditTrigger; runId?: string; counts?: AuditCounts }

// ── Paths ────────────────────────────────────────────────────────────────────

export function taskAuditLockPath(phrenPath: string, project: string): string {
  return path.join(runtimeDir(phrenPath), `task-audit-${project}`);
}

/** Store-aware, like dreamsDir: the owning store's project folder, not a phantom primary one. */
export function taskAuditsDir(phrenPath: string, project: string): string {
  return path.join(projectStoreDir(phrenPath, project), "task-audits");
}

export function auditLastRunFile(phrenPath: string, project: string): string {
  return path.join(taskAuditsDir(phrenPath, project), "last-run.json");
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmp, content);
  renameOverSync(tmp, file);
}

export function writeAuditLastRun(phrenPath: string, project: string, marker: AuditLastRun): void {
  writeAtomic(auditLastRunFile(phrenPath, project), `${JSON.stringify(marker, null, 2)}\n`);
}

// Loose on purpose: a field a newer phren adds must not hide the last run from the scheduler.
const lastRunShape = z.object({ at: z.string(), status: z.enum(["ok", "busy", "empty", "failed"]), trigger: z.enum(["manual", "scheduled"]),
  runId: z.string().optional(), counts: z.record(z.string(), z.number()).optional() }).passthrough();

export function readAuditLastRun(phrenPath: string, project: string): AuditLastRun | undefined {
  try {
    const parsed = lastRunShape.safeParse(JSON.parse(fs.readFileSync(auditLastRunFile(phrenPath, project), "utf8")));
    return parsed.success && Number.isFinite(Date.parse(parsed.data.at)) ? parsed.data as AuditLastRun : undefined;
  } catch { return undefined; }
}

// ── Candidates, rules and prompt ──────────────────────────────────────────────

/** When each task was last sent to an audit, by stable id: task-audits/audited.json. */
export function auditedFile(phrenPath: string, project: string): string {
  return path.join(taskAuditsDir(phrenPath, project), "audited.json");
}

export function readAudited(phrenPath: string, project: string): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(auditedFile(phrenPath, project), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([bid, at]) => /^[a-f0-9]{8}$/.test(bid) && typeof at === "string" && Number.isFinite(Date.parse(at))));
  } catch { return {}; }
}

/** Active+Queue tasks with a usable identity: never audited first, then the longest since their
 * last audit, then the oldest last touch. Without the audit order a task the model calls valid
 * (and so never touches) would come back every week and starve a long list. */
export function auditCandidates(doc: TaskDoc, limit: number, audited: Record<string, string> = {}): TaskItem[] {
  const touched = (item: TaskItem) => taskLastTouched(item) ?? 0;
  const lastAudit = (item: TaskItem) => (audited[item.stableId!] ? Date.parse(audited[item.stableId!]) : 0);
  return [...doc.items.Active, ...doc.items.Queue]
    .filter((item) => item.stableId && !item.identityAmbiguous)
    .sort((a, b) => lastAudit(a) - lastAudit(b) || touched(a) - touched(b))
    .slice(0, Math.max(0, Math.floor(limit)));
}

const skillBody = (raw: string): string => {
  const body = raw.replace(/^\uFEFF/, "").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  return body || raw.trim();
};

/** The installed phren-task-audit skill's body, or the embedded rules when it is not found. */
export function auditRules(phrenPath: string, project: string): string {
  try {
    const found = findSkill(phrenPath, "", project, AUDIT_SKILL_NAME);
    if (found && !("error" in found) && found.path) {
      const body = skillBody(fs.readFileSync(found.path, "utf8"));
      if (body) return body;
    }
  } catch { /* No installed skill: the embedded rules below. */ }
  return EMBEDDED_AUDIT_RULES;
}

export function buildAuditPrompt(rules: string, candidates: readonly TaskItem[]): string {
  const rows = candidates.map((item) => {
    const context = item.context ? ` — Context: ${item.context.slice(0, AUDIT_CONTEXT_CHARS)}` : "";
    return `- bid:${item.stableId} (${item.section}) ${item.line}${context}`;
  });
  return [
    rules, "",
    `Open tasks to audit (at most ${candidates.length}, oldest first):`,
    ...rows, "",
    'Audit each task against the repository in your working directory. Do not edit anything. '
    + 'Reply with JSON only: {"verdicts":[{"bid":"xxxxxxxx","verdict":"done|partial|valid|obsolete|unresolved","evidence":"...","remainder":"..."}]}',
  ].join("\n");
}

// ── Reply parsing ─────────────────────────────────────────────────────────────

const verdictShape = z.object({
  bid: z.string(),
  verdict: z.enum(["done", "partial", "valid", "obsolete", "unresolved"]),
  evidence: z.string().optional(),
  remainder: z.string().optional(),
});
const replyShape = z.object({ verdicts: z.array(verdictShape) });

export type RawVerdict = z.infer<typeof verdictShape>;

/** The JSON object in a model reply, tolerating a code fence or stray prose around it. */
export function parseAuditReply(output: string): { ok: true; value: { verdicts: RawVerdict[] } } | { ok: false; error: string } {
  const text = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "The model's reply has no JSON object." };
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch {
    return { ok: false, error: "The model's reply is not valid JSON." };
  }
  const checked = replyShape.safeParse(parsed);
  if (!checked.success) return { ok: false, error: "The model's reply does not match the audit schema." };
  return { ok: true, value: checked.data };
}

const clean = (value: string | undefined): string => {
  const text = typeof value === "string" ? redactSecretsForLog(value).replace(/\s+/g, " ").trim() : "";
  return text.slice(0, AUDIT_EVIDENCE_MAX);
};

/** Keep only verdicts that name a candidate and carry the text their verdict needs. */
export function matchVerdicts(raw: readonly RawVerdict[], candidates: ReadonlyArray<Pick<TaskItem, "stableId">>): { verdicts: AuditVerdict[]; dropped: AuditDrop[] } {
  const bids = new Set(candidates.map((item) => item.stableId).filter((id): id is string => !!id));
  const seen = new Set<string>();
  const verdicts: AuditVerdict[] = [];
  const dropped: AuditDrop[] = [];
  raw.forEach((row, index) => {
    const drop = (reason: string) => dropped.push({ index, ...(row.bid ? { bid: row.bid } : {}), reason });
    const bid = row.bid.trim();
    if (!bids.has(bid)) return drop(`unknown bid ${JSON.stringify(row.bid)}`);
    if (seen.has(bid)) return drop("the task already has a verdict in this reply");
    seen.add(bid);
    const evidence = clean(row.evidence);
    const remainder = clean(row.remainder);
    if (row.verdict === "done" && !evidence) return drop("a done verdict needs evidence");
    if (row.verdict === "partial" && !remainder && !evidence) return drop("a partial verdict needs a remainder");
    if (row.verdict === "obsolete" && !evidence) return drop("an obsolete verdict needs evidence");
    verdicts.push({ bid, verdict: row.verdict, ...(evidence ? { evidence } : {}), ...(remainder ? { remainder } : {}) });
  });
  return { verdicts, dropped };
}

// ── Run ──────────────────────────────────────────────────────────────────────

const dayStamp = (now: Date): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

export async function auditTasks(project: string, opts: AuditOptions = {}): Promise<TaskAuditResult> {
  const phrenPath = opts.phrenPath ?? findPhrenPath();
  const dryRun = opts.dryRun === true;
  const trigger: AuditTrigger = opts.trigger ?? "manual";
  const base = { project, trigger, dryRun };
  if (!phrenPath) return { ...base, status: "failed", message: "No Phren store found." };
  if (!isValidProjectName(project)) return { ...base, status: "failed", message: `Invalid project name: "${project}".` };

  const release = tryFileLock(taskAuditLockPath(phrenPath, project));
  if (!release) return { ...base, status: "busy", message: `A task audit is already running for ${project}.` };
  try {
    const now = opts.now ?? new Date();
    const runId = newRunId(now);
    const startedAt = now.toISOString();
    const fail = (message: string): TaskAuditResult => {
      if (!dryRun) writeAuditLastRun(phrenPath, project, { at: new Date().toISOString(), status: "failed", trigger, runId });
      return { ...base, status: "failed", runId, message: redactSecretsForLog(message) };
    };

    const doc = readTasks(phrenPath, project);
    if (!doc.ok) return fail(`Could not read ${project}'s tasks: ${doc.error}`);
    const audited = readAudited(phrenPath, project);
    const candidates = auditCandidates(doc.data, opts.limit ?? AUDIT_LIMIT_DEFAULT, audited);
    if (!candidates.length) {
      if (!dryRun) writeAuditLastRun(phrenPath, project, { at: new Date().toISOString(), status: "empty", trigger, runId, counts: emptyCounts() });
      return { ...base, status: "empty", runId, message: `No open tasks with a stable ID in ${project}; nothing to audit.` };
    }

    const prompt = buildAuditPrompt(auditRules(phrenPath, project), candidates);
    // The repo checkout a dream would read (the project's source path), else the project's store folder.
    const cwd = projectDirsFor(phrenPath, project)[0] ?? projectStoreDir(phrenPath, project);
    let reply: DreamRunnerResult;
    try {
      reply = await (opts.runner ?? defaultDreamRunner)({ prompt, cwd, timeoutSeconds: AUDIT_TIMEOUT_S, signal: opts.signal }, project, phrenPath);
    } catch (err: unknown) {
      reply = { ok: false, output: err instanceof Error ? err.message : String(err) };
    }
    const spend = { ...(reply.model ? { model: reply.model } : {}), ...(reply.costUSD !== undefined ? { costUSD: reply.costUSD } : {}) };
    if (!reply.ok) return fail(`The audit model failed: ${redactSecretsForLog(reply.output).slice(0, 500)}`);
    const parsed = parseAuditReply(reply.output);
    if (!parsed.ok) return fail(parsed.error);
    const { verdicts, dropped } = matchVerdicts(parsed.value.verdicts, candidates);

    const counts = { ...emptyCounts(), candidates: candidates.length, dropped: dropped.length };
    for (const verdict of verdicts) counts[verdict.verdict]++;

    if (dryRun) {
      const closing = verdicts.filter((v) => v.verdict === "done").length;
      const noting = verdicts.filter((v) => v.verdict === "partial" || v.verdict === "obsolete").length;
      return { ...base, status: "ok", runId, verdicts, dropped, counts, ...spend,
        message: `Dry run: ${closing} task${closing === 1 ? "" : "s"} would close, ${noting} would get a note, ${dropped.length} dropped.` };
    }

    // Apply: a done task closes with its evidence; the rest get a dated note at most.
    const completeDenied = taskWriteDenied(phrenPath, project, "complete_task");
    const updateDenied = taskWriteDenied(phrenPath, project, "update_task");
    const day = dayStamp(now);
    const applied: AuditApplied[] = [];
    const note = (bid: string, text: string): AuditApplied => {
      if (updateDenied) return { bid, action: "denied", detail: updateDenied };
      const updated = updateTask(phrenPath, project, `bid:${bid}`, { context: text });
      return updated.ok ? { bid, action: "noted", detail: text } : { bid, action: "failed", detail: updated.error };
    };
    // The model ran for minutes on a snapshot: a task edited since (its line or context changed, or it
    // left the open sections) gets no verdict applied, since the evidence was for the old wording.
    const snapshot = new Map(candidates.map((item) => [item.stableId!, `${item.line}\n${item.context ?? ""}`]));
    const unchanged = (bid: string): boolean => {
      const now = readTasks(phrenPath, project);
      const item = now.ok ? [...now.data.items.Active, ...now.data.items.Queue].find((entry) => entry.stableId === bid) : undefined;
      return !!item && `${item.line}\n${item.context ?? ""}` === snapshot.get(bid);
    };
    for (const verdict of verdicts) {
      if ((verdict.verdict === "done" || verdict.verdict === "partial" || verdict.verdict === "obsolete") && !unchanged(verdict.bid)) {
        counts.failed++;
        applied.push({ bid: verdict.bid, action: "failed", detail: "the task changed or closed during the audit; verdict not applied" });
        continue;
      }
      if (verdict.verdict === "done") {
        if (completeDenied || updateDenied) {
          counts.denied++;
          applied.push({ bid: verdict.bid, action: "denied", detail: completeDenied ?? updateDenied! });
          continue;
        }
        const completed = completeTask(phrenPath, project, `bid:${verdict.bid}`);
        if (!completed.ok) { counts.failed++; applied.push({ bid: verdict.bid, action: "failed", detail: completed.error }); continue; }
        counts.closed++;
        // The item now sits in Done; updateTask still finds it by bid, so the evidence lands beside it.
        const noted = note(verdict.bid, `Weekly audit ${day}: done: ${verdict.evidence}`);
        if (noted.action === "failed") {
          counts.failed++;
          applied.push({ bid: verdict.bid, action: "failed", detail: `closed, but the context note failed: ${noted.detail}` });
        } else {
          applied.push({ bid: verdict.bid, action: "closed", detail: `${completed.data} Context: ${noted.detail}` });
        }
      } else if (verdict.verdict === "partial") {
        const result = note(verdict.bid, `Weekly audit ${day}: remaining: ${verdict.remainder ?? verdict.evidence}`);
        applied.push(result);
        if (result.action === "noted") counts.noted++;
        else if (result.action === "denied") counts.denied++;
        else counts.failed++;
      } else if (verdict.verdict === "obsolete") {
        // Never removed: a dated note is all phren writes; the owner decides.
        const result = note(verdict.bid, `Weekly audit ${day}: looks obsolete: ${verdict.evidence}`);
        applied.push(result);
        if (result.action === "noted") counts.noted++;
        else if (result.action === "denied") counts.denied++;
        else counts.failed++;
      }
    }

    const finishedAt = new Date().toISOString();
    const recordPath = path.join(taskAuditsDir(phrenPath, project), `${runId}.json`);
    writeAtomic(recordPath, `${JSON.stringify({ project, runId, startedAt, finishedAt, trigger,
      candidates: candidates.map((item) => item.stableId!), verdicts, dropped, applied, counts, ...spend } satisfies TaskAuditRecord, null, 2)}\n`);
    writeAuditLastRun(phrenPath, project, { at: finishedAt, status: "ok", trigger, runId, counts });
    // Every task sent this run moves to the back of the next run's order; ids no longer open drop out.
    const open = new Set([...doc.data.items.Active, ...doc.data.items.Queue].map((item) => item.stableId).filter(Boolean));
    writeAtomic(auditedFile(phrenPath, project), `${JSON.stringify(Object.fromEntries([
      ...Object.entries(audited).filter(([bid]) => open.has(bid)), ...candidates.map((item) => [item.stableId!, finishedAt]),
    ]))}\n`);
    const extra = [
      `${counts.closed} closed`, `${counts.noted} noted`,
      ...(counts.denied ? [`${counts.denied} denied`] : []),
      ...(counts.failed ? [`${counts.failed} failed`] : []),
      ...(counts.dropped ? [`${counts.dropped} dropped`] : []),
    ];
    return { ...base, status: "ok", runId, verdicts, dropped, counts, record: recordPath, ...spend,
      message: `${project}: audited ${verdicts.length} of ${candidates.length} open tasks — ${extra.join(", ")}.` };
  } finally {
    release();
  }
}
