// dream(): one dreaming pass for one project. Collect what happened, ask the helper model
// for a changeset, keep only the changes that are well-formed, allowed and evidenced, then
// apply or propose them and record the run. One dream per project at a time.
import * as crypto from "crypto";
import * as path from "path";
import { helperFor, runHelper } from "../bridge/helper.js";
import { buildConfigView } from "../config/resolve.js";
import { scanForSecrets } from "../content/secrets.js";
import { tryFileLock } from "../governance/locks.js";
import { findPhrenPath, runtimeDir } from "../phren-paths.js";
import { isValidProjectName } from "../utils-paths.js";
import { applyChangeset, countOutcomes, PAGE_PATH, readLastRun, recordDream, writeLastRun,
  type DreamCounts, type DreamDrop, type DreamMode, type DreamOutcome } from "./apply.js";
import { collect, projectStoreDir, type CollectOptions, type DreamInputs } from "./collect.js";
import { buildDreamPrompt, DREAM_PHASES, PHASE_OPS, type DreamPhase } from "./prompt.js";
import type { DreamChange, DreamChangeset, DreamEvidence, DreamOp } from "./types.js";

// ── Config ───────────────────────────────────────────────────────────────────

export interface DreamConfig {
  enabled: boolean;
  mode: DreamMode;
  cadence: "nightly" | "idle" | "weekly" | "manual";
  window: string;
  idleMinutes: number;
  lookbackHours: number;
  maxChanges: number;
  injectBudgetKB: number;
  phases: DreamPhase[];
  model: string;
}

export const DREAM_CONFIG_DEFAULTS: DreamConfig = {
  enabled: false,
  mode: "propose",
  cadence: "nightly",
  window: "02:00-05:00",
  idleMinutes: 45,
  lookbackHours: 24,
  maxChanges: 25,
  injectBudgetKB: 8,
  phases: [...DREAM_PHASES],
  model: "",
};

const positive = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

/** Coerce raw values (from the `dreaming` config domain or a caller) onto the defaults; anything malformed falls back. */
export function normalizeDreamConfig(raw: Record<string, unknown>): DreamConfig {
  const d = DREAM_CONFIG_DEFAULTS;
  const phases = Array.isArray(raw.phases)
    ? raw.phases.filter((p): p is DreamPhase => typeof p === "string" && (DREAM_PHASES as readonly string[]).includes(p))
    : d.phases;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : d.enabled,
    mode: raw.mode === "apply" || raw.mode === "propose" ? raw.mode : d.mode,
    cadence: ["nightly", "idle", "weekly", "manual"].includes(String(raw.cadence)) ? raw.cadence as DreamConfig["cadence"] : d.cadence,
    window: typeof raw.window === "string" && /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(raw.window) ? raw.window : d.window,
    idleMinutes: positive(raw.idleMinutes, d.idleMinutes),
    lookbackHours: positive(raw.lookbackHours, d.lookbackHours),
    maxChanges: Math.floor(positive(raw.maxChanges, d.maxChanges)),
    injectBudgetKB: positive(raw.injectBudgetKB, d.injectBudgetKB),
    phases: Array.isArray(raw.phases) ? phases : d.phases,
    model: typeof raw.model === "string" ? raw.model.trim() : d.model,
  };
}

/** The project's resolved `dreaming.*` settings (defaults → global → project), via the shared config resolver. */
export function readDreamConfig(phrenPath: string, project: string): DreamConfig {
  const raw: Record<string, unknown> = {};
  try {
    const fields = buildConfigView(phrenPath, project).fields;
    for (const key of Object.keys(DREAM_CONFIG_DEFAULTS)) {
      const field = fields[`dreaming.${key}`];
      if (field && field.value !== undefined) raw[key] = field.value;
    }
  } catch { /* An unreadable config means defaults, which means off. */ }
  return normalizeDreamConfig(raw);
}

// ── Parse and validate ───────────────────────────────────────────────────────

/** The JSON object in a model reply, tolerating a code fence or stray prose around it. */
export function parseChangesetJson(output: string): { ok: true; value: { changes: unknown[]; notes: string } } | { ok: false; error: string } {
  const text = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "The model's reply has no JSON object." };
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (err: unknown) {
    return { ok: false, error: `The model's reply is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const value = parsed as Record<string, unknown>;
  if (!value || typeof value !== "object" || !Array.isArray(value.changes)) return { ok: false, error: "The model's JSON has no changes array." };
  return { ok: true, value: { changes: value.changes, notes: typeof value.notes === "string" ? value.notes : "" } };
}

const KNOWN_OPS: readonly DreamOp[] = ["add_finding", "supersede", "retract", "edit", "merge", "move_topic", "promote_truth", "demote_truth", "write_page", "link"];
const NO_EVIDENCE_OPS: readonly DreamOp[] = ["move_topic", "demote_truth", "link", "write_page"];
const FINDING_TYPES = ["decision", "pitfall", "pattern", "bug"];
const EVIDENCE_KINDS = ["transcript", "code", "git", "finding"];
const TEXT_MAX = 5_000;
const PAGE_MAX = 64 * 1024;

export interface ValidationContext {
  fids: Set<string>;
  truths: string[];
  topics: Set<string>;
  phases: DreamPhase[];
  maxChanges: number;
}

const str = (value: unknown, max = TEXT_MAX): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;

function evidenceList(value: unknown): DreamEvidence[] {
  if (!Array.isArray(value)) return [];
  const list: DreamEvidence[] = [];
  for (const raw of value) {
    const e = raw as Record<string, unknown>;
    if (!e || typeof e !== "object" || !EVIDENCE_KINDS.includes(String(e.kind))) continue;
    const ref = str(e.ref, 300);
    if (!ref) continue;
    const quote = str(e.quote, 1_000);
    list.push({ kind: e.kind as DreamEvidence["kind"], ref, ...(quote ? { quote } : {}) });
  }
  return list;
}

/** One raw change as a typed change, or why it can't be one. */
function shapeChange(raw: Record<string, unknown>, ctx: ValidationContext): DreamChange | string {
  const op = raw.op as DreamOp;
  const evidence = evidenceList(raw.evidence);
  const fid = (value: unknown): string | undefined => {
    const id = str(value, 20)?.replace(/^fid:/, "");
    return id && ctx.fids.has(id) ? id : undefined;
  };
  const needFid = () => `unknown findingId ${JSON.stringify(raw.findingId)}`;
  switch (op) {
    case "add_finding": {
      const text = str(raw.text);
      if (!text) return "missing text";
      const findingType = FINDING_TYPES.includes(String(raw.findingType)) ? raw.findingType as "decision" : undefined;
      const topic = str(raw.topic, 64);
      return { op, text, ...(findingType ? { findingType } : {}), ...(topic ? { topic } : {}), evidence };
    }
    case "supersede": case "edit": {
      const findingId = fid(raw.findingId), newText = str(raw.newText);
      if (!findingId) return needFid();
      if (!newText) return "missing newText";
      return { op, findingId, newText, evidence };
    }
    case "retract": {
      const findingId = fid(raw.findingId), reason = str(raw.reason, 500);
      if (!findingId) return needFid();
      if (!reason) return "missing reason";
      return { op, findingId, reason, evidence };
    }
    case "merge": {
      const ids = Array.isArray(raw.findingIds) ? raw.findingIds.map(fid) : [];
      const newText = str(raw.newText);
      if (ids.length < 2 || ids.some(id => !id)) return `merge needs two or more known findingIds, got ${JSON.stringify(raw.findingIds)}`;
      if (new Set(ids).size !== ids.length) return "merge lists a finding twice";
      if (!newText) return "missing newText";
      return { op, findingIds: ids as string[], newText, evidence };
    }
    case "move_topic": {
      const findingId = fid(raw.findingId), topic = str(raw.topic, 64);
      if (!findingId) return needFid();
      if (!topic || !ctx.topics.has(topic)) return `unknown topic ${JSON.stringify(raw.topic)}`;
      return { op, findingId, topic };
    }
    case "promote_truth": {
      const findingId = fid(raw.findingId), text = str(raw.text, 500);
      if (!findingId) return needFid();
      if (!text) return "missing text";
      return { op, findingId, text, evidence };
    }
    case "demote_truth": {
      const truth = str(raw.truth, 2_000), reason = str(raw.reason, 500);
      if (!truth || !ctx.truths.includes(truth.replace(/^- /, ""))) return `unknown truth ${JSON.stringify(raw.truth)}`;
      if (!reason) return "missing reason";
      return { op, truth: truth.replace(/^- /, ""), reason };
    }
    case "write_page": {
      const page = str(raw.page, 120), markdown = str(raw.markdown, PAGE_MAX);
      if (!page || !PAGE_PATH.test(page)) return `bad page path ${JSON.stringify(raw.page)}`;
      if (!markdown) return "missing markdown";
      const links = Array.isArray(raw.links) ? raw.links.filter((l): l is string => typeof l === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(l)) : [];
      return { op, page, markdown, links };
    }
    case "link": {
      const findingId = fid(raw.findingId), entity = str(raw.entity, 100);
      if (!findingId) return needFid();
      if (!entity) return "missing entity";
      return { op, findingId, entity };
    }
    default:
      return `unknown op ${JSON.stringify(raw.op)}`;
  }
}

/** Keep the well-formed, allowed, evidenced changes up to maxChanges; say why each other one was dropped. */
export function validateChanges(rawChanges: unknown[], ctx: ValidationContext): { changes: DreamChange[]; dropped: DreamDrop[] } {
  const allowed = new Set(ctx.phases.flatMap(phase => PHASE_OPS[phase]));
  const changes: DreamChange[] = [];
  const dropped: DreamDrop[] = [];
  rawChanges.forEach((value, index) => {
    const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const op = typeof raw.op === "string" ? raw.op : String(raw.op);
    const drop = (reason: string) => dropped.push({ index, op, reason });
    if (!KNOWN_OPS.includes(op as DreamOp)) return drop("unknown op");
    if (!allowed.has(op as DreamOp)) return drop("op not allowed by the enabled phases");
    const shaped = shapeChange(raw, ctx);
    if (typeof shaped === "string") return drop(shaped);
    if (!NO_EVIDENCE_OPS.includes(shaped.op) && !("evidence" in shaped && shaped.evidence.length)) return drop("no evidence");
    const secret = scanForSecrets(JSON.stringify(shaped));
    if (secret) return drop(`contains ${secret}`);
    if (changes.length >= ctx.maxChanges) return drop(`over maxChanges (${ctx.maxChanges})`);
    changes.push(shaped);
  });
  return { changes, dropped };
}

// ── Run ──────────────────────────────────────────────────────────────────────

export interface DreamRunnerRequest { prompt: string; cwd: string; model?: string; timeoutSeconds: number; signal?: AbortSignal }
export interface DreamRunnerResult { ok: boolean; output: string; model?: string; costUSD?: number; durationMs?: number }
/** Runs the model once. The default is the project's helper (`claude -p`, read-only). */
export type DreamRunner = (request: DreamRunnerRequest, project: string, phrenPath: string) => Promise<DreamRunnerResult>;

export type DreamStatus = "ok" | "disabled" | "busy" | "empty" | "failed";

export interface DreamOptions {
  dryRun?: boolean;
  mode?: DreamMode;
  now?: Date;
  /** Run even when dreaming is disabled, or when nothing happened in the window (a manual `--force`). */
  force?: boolean;
  phrenPath?: string;
  runner?: DreamRunner;
  /** Overrides on the resolved config (tests, CLI flags). */
  config?: Partial<DreamConfig>;
  /** Overrides on collection (tests: transcript roots, project folders, git). */
  collect?: Partial<Omit<CollectOptions, "from" | "to">>;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

export interface DreamResult {
  status: DreamStatus;
  project: string;
  mode: DreamMode;
  dryRun: boolean;
  runId?: string;
  message: string;
  changeset?: DreamChangeset;
  outcomes: DreamOutcome[];
  dropped: DreamDrop[];
  counts?: DreamCounts;
  /** dreams/<runId>.json, when recorded. */
  record?: string;
  model?: string;
  costUSD?: number;
}

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9.:_[\]-]{0,63}$/;
const DREAM_TIMEOUT_S = 600;

export const defaultDreamRunner: DreamRunner = async (request, project, phrenPath) => {
  const choice = helperFor(phrenPath, project);
  if (request.model && MODEL_NAME.test(request.model)) choice.model = request.model;
  const result = await runHelper(choice, { prompt: request.prompt, cwd: request.cwd, timeoutSeconds: request.timeoutSeconds, signal: request.signal });
  return { ok: result.ok, output: result.output, model: result.model, ...(result.costUSD !== undefined ? { costUSD: result.costUSD } : {}), durationMs: result.durationMs };
};

export function newRunId(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${crypto.randomBytes(3).toString("hex")}`;
}

export function dreamLockPath(phrenPath: string, project: string): string {
  return path.join(runtimeDir(phrenPath), `dream-${project}`);
}

export async function dream(project: string, opts: DreamOptions = {}): Promise<DreamResult> {
  const phrenPath = opts.phrenPath ?? findPhrenPath();
  const dryRun = opts.dryRun === true;
  const base = { project, dryRun, outcomes: [] as DreamOutcome[], dropped: [] as DreamDrop[] };
  if (!phrenPath) return { ...base, status: "failed", mode: opts.mode ?? "propose", message: "No Phren store found." };
  if (!isValidProjectName(project)) return { ...base, status: "failed", mode: opts.mode ?? "propose", message: `Invalid project name: "${project}".` };

  const config = { ...readDreamConfig(phrenPath, project), ...opts.config };
  const mode = opts.mode ?? config.mode;
  if (!config.enabled && !opts.force) {
    return { ...base, status: "disabled", mode, message: `Dreaming is off for ${project} (dreaming.enabled). Use --force for a manual run.` };
  }

  const release = tryFileLock(dreamLockPath(phrenPath, project));
  if (!release) return { ...base, status: "busy", mode, message: `A dream is already running for ${project}.` };
  try {
    const now = opts.now ?? new Date();
    const last = readLastRun(phrenPath, project);
    const fromMs = last ? Date.parse(last.to) : now.getTime() - config.lookbackHours * 3_600_000;
    const from = new Date(Math.min(fromMs, now.getTime()));
    const inputs: DreamInputs = await collect(phrenPath, project, {
      ...opts.collect, from, to: now, injectBudgetKB: config.injectBudgetKB,
    });
    const runId = newRunId(now);
    const changesetBase = {
      project, runId, startedAt: now.toISOString(), lookback: { from: inputs.from, to: inputs.to },
      inputs: { transcripts: inputs.transcripts.length, findings: inputs.findings.length, truths: inputs.truths.length, pages: inputs.pages.length },
    };

    if (!inputs.transcripts.length && !inputs.budget.over && !opts.force) {
      if (!dryRun) writeLastRun(phrenPath, project, { runId, startedAt: changesetBase.startedAt, finishedAt: new Date().toISOString(), to: inputs.to, mode, status: "empty" });
      return { ...base, status: "empty", mode, runId, message: `No sessions in ${project} since ${inputs.from}; nothing to dream about.` };
    }

    const phases = config.phases;
    const prompt = buildDreamPrompt(inputs, { phases, maxChanges: config.maxChanges, now });
    const cwd = inputs.repoDir ?? projectStoreDir(phrenPath, project);
    let reply: DreamRunnerResult;
    try {
      reply = await (opts.runner ?? defaultDreamRunner)({ prompt, cwd, timeoutSeconds: opts.timeoutSeconds ?? DREAM_TIMEOUT_S, signal: opts.signal, ...(config.model ? { model: config.model } : {}) }, project, phrenPath);
    } catch (err: unknown) {
      reply = { ok: false, output: err instanceof Error ? err.message : String(err) };
    }
    const spend = { ...(reply.model ? { model: reply.model } : {}), ...(reply.costUSD !== undefined ? { costUSD: reply.costUSD } : {}) };
    const fail = (message: string): DreamResult => {
      if (!dryRun) writeLastRun(phrenPath, project, { runId, startedAt: changesetBase.startedAt, finishedAt: new Date().toISOString(), to: last?.to ?? inputs.from, mode, status: "failed" });
      return { ...base, status: "failed", mode, runId, message, ...spend };
    };
    if (!reply.ok) return fail(`The dreaming model failed: ${reply.output.slice(0, 500)}`);
    const parsed = parseChangesetJson(reply.output);
    if (!parsed.ok) return fail(parsed.error);

    const { changes, dropped } = validateChanges(parsed.value.changes, {
      fids: new Set(inputs.findings.map(f => f.fid)), truths: inputs.truths, topics: new Set(inputs.topics.map(t => t.slug)),
      phases, maxChanges: config.maxChanges,
    });
    const changeset: DreamChangeset = { ...changesetBase, changes, notes: parsed.value.notes.slice(0, 2_000) };
    if (dryRun) {
      return { ...base, status: "ok", mode, runId, changeset, dropped, counts: countOutcomes([], dropped), ...spend,
        message: `Dry run: ${changes.length} changes would be ${mode === "apply" ? "applied" : "proposed"}, ${dropped.length} dropped.` };
    }

    const outcomes = await applyChangeset(phrenPath, changeset, { mode, injectBudgetKB: config.injectBudgetKB, ...(reply.model ? { model: reply.model } : {}) });
    const finishedAt = new Date().toISOString();
    const record = recordDream(phrenPath, project, { changeset, mode, ...spend, finishedAt, outcomes, dropped });
    const counts = countOutcomes(outcomes, dropped);
    writeLastRun(phrenPath, project, { runId, startedAt: changeset.startedAt, finishedAt, to: inputs.to, mode, status: "ok", counts });
    return { ...base, status: "ok", mode, runId, changeset, outcomes, dropped, counts, record, ...spend,
      message: `${project}: ${counts.applied} applied, ${counts.proposed} proposed, ${counts.skipped} skipped, ${counts.failed} failed, ${counts.dropped} dropped.` };
  } finally {
    release();
  }
}
