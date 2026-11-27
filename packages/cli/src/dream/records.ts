// Stored dream runs and append-only decisions on structured proposals.
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { withFileLock } from "../governance/locks.js";
import { getMachineName } from "../machine-identity.js";
import { atomicWriteText, runtimeFile, tryUnlink } from "../phren-paths.js";
import { journalFile, projectStoreDir } from "./collect.js";
import { PHASE_OPS } from "./prompt.js";
import { sanitizeDream } from "./privacy.js";
import type { DreamChange, DreamChangeset, DreamOp } from "./types.js";

export type DreamMode = "propose" | "apply";
/** `deferred`: an addition still waiting for review queue publication. */
export type DreamOutcomeStatus = "applied" | "proposed" | "skipped" | "deferred" | "failed";

export interface DreamOutcome { index: number; op: DreamOp; status: DreamOutcomeStatus; detail: string }
/** A change validation refused, with why; `index` is its position in the model's answer. */
export interface DreamDrop { index: number; op: string; reason: string }

const DREAM_RUN_ID = /^[a-zA-Z0-9_-]+$/;
const OUTCOME_STATUSES = new Set<DreamOutcomeStatus>(["applied", "proposed", "skipped", "deferred", "failed"]);
const DREAM_OPS = new Set(Object.values(PHASE_OPS).flat());
export const DREAM_ACCEPTANCE_DEFAULT_LIMIT = 20;
export const clean = (text: string, max = 200) => text.replace(/\s+/g, " ").replace(/--+/g, "-").trim().slice(0, max);

export function dreamRecordFile(phrenPath: string, project: string, runId: string): string {
  if (!DREAM_RUN_ID.test(runId)) throw new Error("Invalid dream run ID.");
  return path.join(dreamsDir(phrenPath, project), `${runId}.json`);
}

export function readDreamRecord(file: string, project: string, runId: string): DreamRecord {
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as DreamRecord;
  if (record?.changeset?.project !== project || record.changeset.runId !== runId) throw new Error("Dream record identity mismatch.");
  const { outcomes, changeset: { changes } } = record;
  if ((record.mode !== "propose" && record.mode !== "apply") || !Array.isArray(changes) ||
      !Array.isArray(outcomes) || changes.length !== outcomes.length) throw new Error("Invalid dream outcomes.");
  const seen = new Set<number>();
  for (const outcome of outcomes) {
    if (!outcome || !Number.isSafeInteger(outcome.index) || outcome.index < 0 || seen.has(outcome.index) ||
        !DREAM_OPS.has(outcome.op) || changes[outcome.index]?.op !== outcome.op || !OUTCOME_STATUSES.has(outcome.status)) {
      throw new Error("Invalid dream outcome index, operation or status.");
    }
    seen.add(outcome.index);
  }
  return record;
}

export interface DreamRecord {
  changeset: DreamChangeset;
  findingVersions?: Record<string, string>;
  warnings?: string[];
  mode: DreamMode;
  model?: string;
  finishedAt: string;
  outcomes: DreamOutcome[];
  dropped: DreamDrop[];
  costUSD?: number;
}

export interface DreamCounts { applied: number; proposed: number; skipped: number; deferred: number; failed: number; dropped: number }

export function countOutcomes(outcomes: DreamOutcome[], dropped: DreamDrop[]): DreamCounts {
  const counts: DreamCounts = { applied: 0, proposed: 0, skipped: 0, deferred: 0, failed: 0, dropped: dropped.length };
  for (const outcome of outcomes) counts[outcome.status]++;
  return counts;
}

function dreamsDir(phrenPath: string, project: string): string {
  return path.join(projectStoreDir(phrenPath, project), "dreams");
}

function lastRunFile(phrenPath: string, project: string): string {
  return path.join(dreamsDir(phrenPath, project), "last-run.json");
}

export function recordDream(phrenPath: string, project: string, record: DreamRecord): string {
  record = sanitizeDream(record);
  const file = dreamRecordFile(phrenPath, project, record.changeset.runId);
  if (fs.existsSync(file)) throw new Error("Dream run is already recorded.");
  atomicWriteText(file, `${JSON.stringify(record, null, 2)}\n`);
  const counts = countOutcomes(record.outcomes, record.dropped);
  const notes = clean(record.changeset.notes, 160);
  const line = `- ${record.changeset.startedAt} ${record.changeset.runId} ${record.mode}: ${counts.applied} applied, ${counts.proposed} proposed, `
    + `${counts.skipped} skipped, ${counts.deferred ? `${counts.deferred} deferred (review queue over budget), ` : ""}${counts.failed} failed, ${counts.dropped} dropped (${record.changeset.inputs.transcripts} sessions)${notes ? ` — ${notes}` : ""}${record.warnings?.length ? ` — ${record.warnings.join("; ")}` : ""}`;
  appendJournal(journalFile(phrenPath, project), project, `${line}\n`);
  return file;
}

function appendJournal(journal: string, project: string, line: string): void {
  line = sanitizeDream(line);
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  withFileLock(journal, () => {
    if (!fs.existsSync(journal)) fs.writeFileSync(journal, `# ${project} dream journal\n\n`);
    fs.appendFileSync(journal, line);
  });
}

export interface DreamLastRun { at: string; trigger: "manual" | "scheduled"; runId: string; startedAt: string; finishedAt: string; to: string; mode: DreamMode; status: string; counts?: DreamCounts }

export function writeLastRun(phrenPath: string, project: string, marker: Omit<DreamLastRun, "at">): void {
  atomicWriteText(lastRunFile(phrenPath, project), `${JSON.stringify({ ...marker, at: marker.finishedAt }, null, 2)}\n`);
}

export function readLastRun(phrenPath: string, project: string): DreamLastRun | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(lastRunFile(phrenPath, project), "utf8"));
    return value && typeof value.to === "string" && Number.isFinite(Date.parse(value.to)) ? value as DreamLastRun : undefined;
  } catch { return undefined; }
}

export interface DreamDecision {
  id: string;
  runId: string;
  index: number;
  op: DreamOp;
  outcome: "applied" | "rejected";
  decidedAt?: string;
  computer: string;
  reason?: string;
  supersedes?: string[];
}

export interface DreamEffectiveOutcome extends Omit<DreamOutcome, "status"> {
  status: DreamOutcomeStatus | "rejected" | "conflicted";
  decidedAt?: string;
  reason?: string;
  reasons?: string[];
}

export function isPendingProposal({ status }: Pick<DreamEffectiveOutcome, "status">): boolean {
  return status === "proposed" || status === "deferred";
}

function decisionsDir(phrenPath: string, project: string, runId: string): string {
  return path.join(path.dirname(dreamRecordFile(phrenPath, project, runId)), "decisions", runId);
}

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const DECISION_FILE = new RegExp(`^(0|[1-9]\\d*)-(${UUID})\\.json$`);
const DECISION_ID = new RegExp(`^${UUID}$`);
const LEGACY_APPLIED = "legacy-applied";

type StoredDreamDecision = DreamDecision & { decidedAt: string };
type DecisionInput = Omit<StoredDreamDecision, "id" | "decidedAt" | "computer">;
interface DreamReceipt { changeHash: string; decision: StoredDreamDecision; before?: string }

function receiptPath(phrenPath: string, project: string, runId: string, index: number): string {
  return runtimeFile(phrenPath, path.join("dream-receipts", project, runId, `${index}.json`));
}

function changeHash(change: DreamChange): string {
  return crypto.createHash("sha256").update(JSON.stringify(change)).digest("hex");
}

function appendDreamDecision(phrenPath: string, project: string, { id, ...decision }: StoredDreamDecision): void {
  const file = path.join(decisionsDir(phrenPath, project, decision.runId), `${decision.index}-${id}.json`);
  const contents = `${JSON.stringify(decision, null, 2)}\n`;
  const existing = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!existing) atomicWriteText(file, contents);
  else if (!existing.isFile() || fs.readFileSync(file, "utf8") !== contents) throw new Error("Dream decision already exists with different contents.");
}

function newDreamDecision(input: DecisionInput): StoredDreamDecision {
  return sanitizeDream({ ...input, id: crypto.randomUUID(), decidedAt: new Date().toISOString(), computer: getMachineName() });
}

export function writeDreamDecision(phrenPath: string, project: string, input: DecisionInput): void {
  appendDreamDecision(phrenPath, project, newDreamDecision(input));
}

export function beginDreamApply(phrenPath: string, project: string, runId: string, index: number, change: DreamChange, before: string): () => void {
  const file = receiptPath(phrenPath, project, runId, index);
  const receipt: DreamReceipt = { changeHash: changeHash(change), decision: newDreamDecision({ runId, index, op: change.op, outcome: "applied" }) };
  atomicWriteText(file, `${JSON.stringify({ ...receipt, before })}\n`);
  return () => {
    atomicWriteText(file, `${JSON.stringify(receipt)}\n`);
    appendDreamDecision(phrenPath, project, receipt.decision);
    tryUnlink(file);
  };
}

export function recoverDreamDecision(
  phrenPath: string, project: string, runId: string, index: number, change: DreamChange,
  inspect: () => { fingerprint: string; applied: boolean },
): void {
  const file = receiptPath(phrenPath, project, runId, index);
  if (!fs.existsSync(file)) return;
  const { before, ...receipt } = JSON.parse(fs.readFileSync(file, "utf8")) as DreamReceipt;
  const { changeHash: hash, decision } = receipt;
  if (!validDecision(decision, runId, index) || !DECISION_ID.test(decision.id) || decision.op !== change.op ||
      decision.outcome !== "applied" || hash !== changeHash(change)) {
    throw new Error(`The saved apply receipt for ${runId}#${index} does not match its proposal.`);
  }
  if (before !== undefined) {
    const state = inspect();
    if (state.fingerprint === before) {
      tryUnlink(file);
      return;
    }
    if (!state.applied) throw new Error(`Cannot verify interrupted apply ${runId}#${index}. Inspect its changes before retrying.`);
    atomicWriteText(file, `${JSON.stringify(receipt)}\n`);
  }
  appendDreamDecision(phrenPath, project, decision);
  tryUnlink(file);
}

function validDecision(data: Omit<DreamDecision, "id">, runId: string, index: number): data is Omit<StoredDreamDecision, "id"> {
  return data?.runId === runId && data.index === index && Number.isSafeInteger(index) &&
    (data.outcome === "applied" || data.outcome === "rejected") && DREAM_OPS.has(data.op) && data.op !== "add_finding" &&
    typeof data.decidedAt === "string" && Number.isFinite(Date.parse(data.decidedAt)) && typeof data.computer === "string" &&
    (data.reason === undefined || typeof data.reason === "string") &&
    (data.supersedes === undefined || (Array.isArray(data.supersedes) &&
      data.supersedes.every(id => typeof id === "string" && (id === LEGACY_APPLIED || DECISION_ID.test(id)))));
}

export function readDreamDecisions(phrenPath: string, project: string, runId: string): Map<number, DreamDecision[]> {
  const dir = decisionsDir(phrenPath, project, runId);
  const byIndex = new Map<number, DreamDecision[]>();
  let files: fs.Dirent[];
  try { files = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return byIndex; throw err; }
  for (const file of files) {
    const name = file.isFile() ? DECISION_FILE.exec(file.name) : null;
    if (!name) continue;
    let raw: string;
    try { raw = fs.readFileSync(path.join(dir, file.name), "utf8"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; throw err; }
    let data: Omit<DreamDecision, "id">;
    try { data = JSON.parse(raw); } catch { continue; }
    if (!validDecision(data, runId, Number(name[1]))) continue;
    const decisions = byIndex.get(data.index) ?? [];
    decisions.push({ ...data, id: name[2] });
    byIndex.set(data.index, decisions);
  }
  return byIndex;
}

export function isStructuredProposal(outcome: DreamOutcome): boolean {
  return outcome.op !== "add_finding" && (isPendingProposal(outcome) || outcome.status === "applied" || outcome.status === "skipped");
}

export function activeDreamDecisions(runId: string, outcome: DreamOutcome, decisions: DreamDecision[] = []): DreamDecision[] {
  if (!isStructuredProposal(outcome)) return [];
  const matching = decisions.filter(d => d.op === outcome.op);
  if (outcome.status === "applied") {
    matching.push({ id: LEGACY_APPLIED, runId, index: outcome.index, op: outcome.op, outcome: "applied", computer: "0.3.97 client" });
  }
  const ids = new Set(matching.map(d => d.id));
  const dependencies = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  // A cyclic record, and any decision relying on it, cannot supersede a valid decision.
  const ordered: string[] = [];
  for (const { id, supersedes } of matching) {
    const refs = new Set(supersedes?.filter(ref => ids.has(ref)));
    dependencies.set(id, refs.size);
    if (!refs.size) ordered.push(id);
    for (const ref of refs) {
      const next = dependents.get(ref) ?? [];
      next.push(id);
      dependents.set(ref, next);
    }
  }
  for (let i = 0; i < ordered.length; i++) {
    for (const id of dependents.get(ordered[i]) ?? []) {
      const remaining = dependencies.get(id)! - 1;
      dependencies.set(id, remaining);
      if (!remaining) ordered.push(id);
    }
  }
  const acyclic = matching.filter(d => dependencies.get(d.id) === 0);
  const superseded = new Set(acyclic.flatMap(d => d.supersedes ?? []));
  const timestamp = (decision: DreamDecision) => decision.decidedAt ? Date.parse(decision.decidedAt) : Infinity;
  return acyclic.filter(d => !superseded.has(d.id)).sort((a, b) => timestamp(a) - timestamp(b) || a.id.localeCompare(b.id));
}

export function effectiveDreamOutcome(outcome: DreamOutcome, active: DreamDecision[]): DreamEffectiveOutcome {
  const first = active[0];
  if (!first) return outcome;
  const reasons = active.flatMap(d => d.reason === undefined ? [] : [d.reason]);
  if (active.some(d => d.outcome !== first.outcome)) {
    return { ...outcome, status: "conflicted", detail: "opposing decisions; resolve explicitly", reasons };
  }
  return { ...outcome, status: first.outcome, detail: `proposal ${first.outcome}`, decidedAt: first.decidedAt,
    ...(reasons.length ? { reason: reasons[0], reasons } : {}) };
}

interface DreamOpAcceptance { proposed: number; applied: number; rejected: number; pending: number; conflicted: number; skipped: number; acceptRate: number | null }
export interface DreamAcceptance {
  runs: number;
  byOp: Partial<Record<DreamOp, DreamOpAcceptance>>;
}
export interface DreamDecisionConflict { runId: string; index: number; op: DreamOp; decisions: DreamDecision[] }

function acceptanceByOp(runs: DreamEffectiveOutcome[][]): DreamAcceptance["byOp"] {
  const byOp = new Map<DreamOp, DreamOpAcceptance>();
  for (const outcomes of runs) {
    for (const { op, status } of outcomes) {
      const counts = byOp.get(op) ?? { proposed: 0, applied: 0, rejected: 0, pending: 0, conflicted: 0, skipped: 0, acceptRate: null };
      counts.proposed++;
      if (status === "applied" || status === "rejected" || status === "conflicted" || status === "skipped") counts[status]++;
      else counts.pending++;
      const decided = counts.applied + counts.rejected;
      counts.acceptRate = decided ? counts.applied / decided : null;
      byOp.set(op, counts);
    }
  }
  return Object.fromEntries(byOp);
}

export function formatDreamAcceptance(counts: DreamOpAcceptance): string {
  const rate = counts.acceptRate === null ? "—" : `${Math.round(counts.acceptRate * 100)}%`;
  return `${counts.proposed} proposed, ${counts.applied} applied, ${counts.rejected} rejected, ${counts.pending} pending, ${counts.conflicted} conflicted, ${counts.skipped} skipped, ${rate} accepted`;
}

function* readDreamRecords(phrenPath: string, project: string): Generator<DreamRecord> {
  const dir = dreamsDir(phrenPath, project);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith(".json") || name === "last-run.json" || !DREAM_RUN_ID.test(name.slice(0, -5))) continue;
    try {
      yield readDreamRecord(path.join(dir, name), project, name.slice(0, -5));
    } catch { /* Not a run record. */ }
  }
}

export function pendingDreamProposals(phrenPath: string, project: string): number {
  return dreamProposalStats(phrenPath, project, 0).pendingProposals;
}

export function dreamProposalStats(phrenPath: string, project: string, limit: number): {
  pendingProposals: number; acceptance: DreamAcceptance; conflicts: DreamDecisionConflict[];
} {
  let pendingProposals = 0;
  const conflicts: DreamDecisionConflict[] = [];
  const runs: Array<{ outcomes: DreamEffectiveOutcome[]; at: number }> = [];
  for (const record of readDreamRecords(phrenPath, project)) {
    const { runId, startedAt } = record.changeset;
    const outcomes: DreamEffectiveOutcome[] = [];
    if (record.mode === "propose") {
      pendingProposals += record.outcomes.filter(o => o.op === "add_finding" && o.status === "deferred").length;
      const decisions = readDreamDecisions(phrenPath, project, runId);
      for (const outcome of record.outcomes.filter(isStructuredProposal)) {
        const active = activeDreamDecisions(runId, outcome, decisions.get(outcome.index));
        const effective = effectiveDreamOutcome(outcome, active);
        outcomes.push(effective);
        if (isPendingProposal(effective)) pendingProposals++;
        if (effective.status === "conflicted") conflicts.push({ runId, index: outcome.index, op: outcome.op, decisions: active });
      }
    }
    const at = Date.parse(record.finishedAt ?? startedAt);
    if (Number.isFinite(at)) runs.push({ outcomes, at });
  }
  const recent = runs.sort((a, b) => b.at - a.at).slice(0, limit);
  return { pendingProposals, conflicts, acceptance: { runs: recent.length, byOp: acceptanceByOp(recent.map(run => run.outcomes)) } };
}
