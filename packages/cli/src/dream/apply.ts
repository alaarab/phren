// Applying a dream: each change goes through the same finding, truth, topic and review
// APIs an agent's own MCP calls use, so lifecycle history, fids, locks and citations are
// kept. Propose mode queues additions and stores other operations for dream apply.
// Either way the run is recorded in dreams/<runId>.json and dreams/journal.md.
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { assertFindingVersions, readFindingVersions } from "../finding/versions.js";
import { sanitizeDream } from "./privacy.js";
import { isCitationLine } from "../content/metadata.js";
import { addFindingToFile, upsertCanonical } from "../content/learning.js";
import type { FindingProvenance } from "../content/citation.js";
import { applyFindingTypePrefix } from "../core/finding.js";
import { editFinding, readFindings } from "../data/access.js";
import { retractFinding, supersedeFinding } from "../finding/lifecycle.js";
import { withFileLock } from "../governance/locks.js";
import { appendReviewQueue } from "../governance/policy.js";
import { renameOverSync, runtimeFile } from "../phren-paths.js";
import { appendArchivedEntriesToTopicDoc, readProjectTopics, topicReferencePath } from "../project-topics.js";
import { storeAwareProjectPath } from "../store-routing.js";
import { journalFile, projectStoreDir } from "./collect.js";
import { checkPromotion } from "./budget.js";
import { writePage } from "./pages.js";
import type { DreamChange, DreamChangeset, DreamEvidence, DreamOp } from "./types.js";

export type DreamMode = "propose" | "apply";
export type DreamOutcomeStatus = "applied" | "proposed" | "skipped" | "failed";

export interface DreamOutcome { index: number; op: DreamOp; status: DreamOutcomeStatus; detail: string }
/** A change validation refused, with why; `index` is its position in the model's answer. */
export interface DreamDrop { index: number; op: string; reason: string }

export interface ApplyOptions {
  mode: DreamMode;
  injectBudgetKB: number;
  /** The model that dreamed, for provenance. */
  model?: string;
  expectedFindings?: Record<string, string>;
}

export const PAGE_PATH = /^reference\/pages\/([a-z0-9][a-z0-9-]{0,63})\.md$/;
const TRUTH_DATE = /\s*_\(added \d{4}-\d{2}-\d{2}\)_\s*$/;

const fidRef = (id: string) => `fid:${id.replace(/^fid:/, "")}`;
const errorText = (err: unknown) => err instanceof Error ? err.message : String(err);

function findingText(phrenPath: string, project: string, id: string): string | undefined {
  const read = readFindings(phrenPath, project);
  if (!read.ok) return undefined;
  const fid = id.replace(/^fid:/, "");
  return read.data.find(item => item.stableId === fid)?.text;
}

export function findingVersions(phrenPath: string, project: string): Record<string, string> {
  return readFindingVersions(path.join(projectStoreDir(phrenPath, project), "FINDINGS.md"));
}

const targetIds = (change: DreamChange): string[] => change.op === "merge" ? change.findingIds : "findingId" in change ? [change.findingId] : [];

function provenance(model?: string): FindingProvenance {
  return { source: "consolidation", tool: "dream", ...(model ? { model } : {}) };
}

function addText(phrenPath: string, project: string, text: string, model?: string): { ok: boolean; detail: string; skipped?: boolean } {
  const result = addFindingToFile(phrenPath, project, text, undefined, { provenance: provenance(model) });
  if (!result.ok) return { ok: false, detail: result.error };
  return { ok: true, detail: result.data.message, ...(result.data.status === "skipped" ? { skipped: true } : {}) };
}

/**
 * Replace findings with one new finding: add it as superseding the first (the add_finding
 * `supersedes` citation, which keeps the old one out of dedup), then supersede the rest by fid.
 * If the new text is still a near-duplicate of a saved finding, rewrite the first in place.
 */
function replaceWith(phrenPath: string, project: string, ids: string[], newText: string, model?: string, expectedFindings?: Record<string, string>): { status: DreamOutcomeStatus; detail: string } {
  const read = readFindings(phrenPath, project);
  const items = ids.map(id => read.ok ? read.data.find(f => f.stableId === id.replace(/^fid:/, "")) : undefined);
  const missing = ids.filter((_, i) => !items[i]);
  if (missing.length) return { status: "failed", detail: `no finding ${missing.map(fidRef).join(", ")}` };
  const added = addFindingToFile(phrenPath, project, newText, { supersedes: items[0]!.text }, { provenance: provenance(model), expectedFindings });
  if (!added.ok) return { status: "failed", detail: added.error };
  let rest = ids;
  let detail = `replaced ${ids.map(fidRef).join(", ")}`;
  if (added.data.status === "skipped") {
    const edited = editFinding(phrenPath, project, fidRef(ids[0]), newText, expectedFindings);
    if (!edited.ok) return { status: "failed", detail: `near-duplicate of a saved finding, and editing ${fidRef(ids[0])} failed: ${edited.error}` };
    rest = ids.slice(1);
    detail = `edited ${fidRef(ids[0])} in place (the new text was a near-duplicate)${rest.length ? `; superseded ${rest.map(fidRef).join(", ")}` : ""}`;
  }
  const errors: string[] = [];
  const after = readFindings(phrenPath, project);
  for (const id of rest) {
    const current = after.ok ? after.data.find(f => f.stableId === id.replace(/^fid:/, "")) : undefined;
    if (current?.status === "superseded") continue;
    const result = supersedeFinding(phrenPath, project, fidRef(id), newText, expectedFindings ? { [id.replace(/^fid:/, "")]: expectedFindings[id.replace(/^fid:/, "")] } : undefined);
    if (!result.ok) errors.push(`${fidRef(id)}: ${result.error}`);
  }
  return errors.length ? { status: "failed", detail: `${detail}; ${errors.join("; ")}` } : { status: "applied", detail };
}

function truthsPath(phrenPath: string, project: string): string {
  return storeAwareProjectPath(phrenPath, project, "truths.md") ?? path.join(phrenPath, project, "truths.md");
}

/** Persist a manual fragment link the way the link_findings tool does, so an index rebuild keeps it. */
function persistLink(phrenPath: string, project: string, entity: string): void {
  const file = runtimeFile(phrenPath, "manual-links.json");
  withFileLock(file, () => {
    let existing: Array<{ entity: string; entityType: string; sourceDoc: string; relType: string }> = [];
    if (fs.existsSync(file)) existing = JSON.parse(fs.readFileSync(file, "utf8"));
    const entry = { entity: entity.toLowerCase(), entityType: "fragment", sourceDoc: `${project}/FINDINGS.md`, relType: "mentions" };
    if (existing.some(e => e.entity === entry.entity && e.entityType === entry.entityType && e.sourceDoc === entry.sourceDoc && e.relType === entry.relType)) return;
    existing.push(entry);
    const tmp = `${file}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
    renameOverSync(tmp, file);
  });
}

async function applyOne(phrenPath: string, project: string, change: DreamChange, all: DreamChange[], options: ApplyOptions): Promise<{ status: DreamOutcomeStatus; detail: string }> {
  const ok = (detail: string) => ({ status: "applied" as const, detail });
  const fail = (detail: string) => ({ status: "failed" as const, detail });
  switch (change.op) {
    case "add_finding": {
      const added = addText(phrenPath, project, applyFindingTypePrefix(change.text, change.findingType), options.model);
      if (!added.ok) return fail(added.detail);
      return added.skipped ? { status: "skipped", detail: added.detail } : ok(added.detail);
    }
    case "supersede":
      return replaceWith(phrenPath, project, [change.findingId], change.newText, options.model, options.expectedFindings);
    case "retract": {
      const result = retractFinding(phrenPath, project, fidRef(change.findingId), change.reason, options.expectedFindings);
      return result.ok ? ok(`retracted ${fidRef(change.findingId)}`) : fail(result.error);
    }
    case "edit": {
      const result = editFinding(phrenPath, project, fidRef(change.findingId), change.newText, options.expectedFindings);
      return result.ok ? ok(`edited ${fidRef(change.findingId)}`) : fail(result.error);
    }
    case "merge":
      return replaceWith(phrenPath, project, change.findingIds, change.newText, options.model, options.expectedFindings);
    case "move_topic": {
      const topic = readProjectTopics(phrenPath, project).topics.find(t => t.slug === change.topic);
      if (!topic) return fail(`unknown topic "${change.topic}"`);
      const file = topicReferencePath(phrenPath, project, topic.slug);
      if (!file) return fail(`no topic file for "${topic.slug}"`);
      const source = path.join(projectStoreDir(phrenPath, project), "FINDINGS.md");
      const expected = findingVersions(phrenPath, project)[change.findingId.replace(/^fid:/, "")];
      return withFileLock(source, () => {
        assertFindingVersions(source, options.expectedFindings);
        const fid = change.findingId.replace(/^fid:/, "");
        const read = readFindings(phrenPath, project);
        const item = read.ok ? read.data.find(f => f.stableId === fid) : undefined;
        if (!item || !expected || findingVersions(phrenPath, project)[fid] !== expected) return fail(`finding ${fidRef(fid)} is missing or changed`);
        const before = fs.readFileSync(source, "utf8");
        const lines = before.split("\n");
        const index = lines.findIndex(line => line.startsWith("- ") && new RegExp(`<!--\\s*fid:${fid}\\s*-->`).test(line));
        if (index < 0) return fail(`no stored bullet ${fidRef(fid)}`);
        const citation = isCitationLine(lines[index + 1] ?? "") ? lines[index + 1] : undefined;
        appendArchivedEntriesToTopicDoc(file, project, topic, [{ date: item.date, bullet: lines[index], ...(citation ? { citation } : {}) }]);
        if (fs.readFileSync(source, "utf8") !== before) return fail("source changed while archiving; kept source");
        lines.splice(index, citation ? 2 : 1);
        writeAtomic(source, lines.join("\n"));
        return ok(`moved ${fidRef(fid)} to ${topic.slug}`);
      });
    }
    case "promote_truth": {
      const demoted = all.flatMap(other => other.op === "demote_truth" ? [other.truth] : []);
      const check = checkPromotion(phrenPath, project, options.injectBudgetKB, change.text, demoted);
      if (!check.fits) {
        return fail(`would put the injected layer at ${check.bytesAfter} bytes, over its ${check.budgetBytes}-byte budget, without enough demotions in this changeset`);
      }
      return withFileLock(path.join(projectStoreDir(phrenPath, project), "FINDINGS.md"), () => {
        assertFindingVersions(path.join(projectStoreDir(phrenPath, project), "FINDINGS.md"), options.expectedFindings);
        const result = upsertCanonical(phrenPath, project, change.text);
        return result.ok ? ok(result.data) : fail(result.error);
      });
    }
    case "demote_truth": {
      const file = truthsPath(phrenPath, project);
      if (!fs.existsSync(file)) return fail("no such truth");
      const before = fs.readFileSync(file, "utf8");
      const lines = before.split("\n");
      const index = lines.findIndex(line => line.startsWith("- ") && line.slice(2).replace(TRUTH_DATE, "").trim() === change.truth);
      if (index < 0) return fail("no such truth");
      const added = addText(phrenPath, project, change.truth, options.model);
      if (!added.ok) return fail(`truth kept: ${added.detail}`);
      return withFileLock(file, () => {
        if (fs.readFileSync(file, "utf8") !== before) return fail("truth changed while saving finding; kept truth");
        lines.splice(index, 1);
        writeAtomic(file, lines.join("\n"));
        return ok("demoted to a finding");
      });
    }
    case "write_page": {
      const slug = PAGE_PATH.exec(change.page)?.[1];
      if (!slug) return fail(`bad page path "${change.page}"`);
      const written = await writePage(phrenPath, project, slug, change.markdown, change.links);
      return ok(written.brokenLinks.length ? `wrote ${slug}; broken links: ${written.brokenLinks.join(", ")}` : `wrote ${slug}`);
    }
    case "link": {
      if (!findingText(phrenPath, project, change.findingId)) return fail(`no finding ${fidRef(change.findingId)}`);
      withFileLock(path.join(projectStoreDir(phrenPath, project), "FINDINGS.md"), () => {
        assertFindingVersions(path.join(projectStoreDir(phrenPath, project), "FINDINGS.md"), options.expectedFindings);
        persistLink(phrenPath, project, change.entity);
      });
      return ok(`linked ${fidRef(change.findingId)} to ${change.entity.toLowerCase()}`);
    }
  }
}

const evidenceOf = (change: DreamChange): DreamEvidence[] => "evidence" in change ? change.evidence : [];
const clean = (text: string, max = 200) => text.replace(/\s+/g, " ").replace(/--+/g, "-").trim().slice(0, max);

/** The review line a person reads for one proposed change. add_finding is just the finding, so approving it adds it. */
export function proposalText(change: DreamChange): string {
  const evidence = evidenceOf(change).map(e => `${e.kind} ${e.ref}`).join("; ");
  const why = evidence ? ` (evidence: ${evidence})` : "";
  switch (change.op) {
    case "add_finding": return applyFindingTypePrefix(change.text, change.findingType);
    case "supersede": return `Dream: supersede ${fidRef(change.findingId)} with "${change.newText}"${why}`;
    case "retract": return `Dream: retract ${fidRef(change.findingId)}: ${change.reason}${why}`;
    case "edit": return `Dream: edit ${fidRef(change.findingId)} to "${change.newText}"${why}`;
    case "merge": return `Dream: merge ${change.findingIds.map(fidRef).join(", ")} into "${change.newText}"${why}`;
    case "move_topic": return `Dream: move ${fidRef(change.findingId)} to topic ${change.topic}`;
    case "promote_truth": return `Dream: promote ${fidRef(change.findingId)} to a truth: "${change.text}"${why}`;
    case "demote_truth": return `Dream: demote truth "${change.truth}": ${change.reason}`;
    case "write_page": return `Dream: write page ${change.page}${change.links.length ? ` linking ${change.links.join(", ")}` : ""}`;
    case "link": return `Dream: link ${fidRef(change.findingId)} to ${change.entity}`;
  }
}

function proposeOne(phrenPath: string, project: string, runId: string, index: number, change: DreamChange): { status: DreamOutcomeStatus; detail: string } {
  if (change.op !== "add_finding") return { status: "proposed", detail: `pending dream apply ${runId} --only ${index}` };
  const refs = evidenceOf(change).map(e => clean(`${e.kind}:${e.ref}`, 80)).join("; ");
  const meta = `<!-- dream:${clean(runId, 64)}#${index} op:${change.op} -->${refs ? ` <!-- evidence: ${refs} -->` : ""}`;
  const result = appendReviewQueue(phrenPath, project, "Review", [{ text: proposalText(change), meta }]);
  if (!result.ok) return { status: "failed", detail: result.error };
  return result.data > 0 ? { status: "proposed", detail: "queued for review" } : { status: "skipped", detail: "already in the review queue" };
}

/** Apply or propose every change in order. One change failing never stops the rest. */
export async function applyChangeset(phrenPath: string, changeset: DreamChangeset, options: ApplyOptions): Promise<DreamOutcome[]> {
  const outcomes: DreamOutcome[] = [];
  for (const [index, change] of changeset.changes.entries()) {
    let result: { status: DreamOutcomeStatus; detail: string };
    try {
      result = options.mode === "propose"
        ? proposeOne(phrenPath, changeset.project, changeset.runId, index, change)
        : await applyOne(phrenPath, changeset.project, change, changeset.changes, options);
    } catch (err: unknown) {
      result = { status: "failed", detail: errorText(err) };
    }
    outcomes.push(sanitizeDream({ index, op: change.op, ...result }));
  }
  return outcomes;
}

// ── Records ──────────────────────────────────────────────────────────────────

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

export interface DreamCounts { applied: number; proposed: number; skipped: number; failed: number; dropped: number }

export function countOutcomes(outcomes: DreamOutcome[], dropped: DreamDrop[]): DreamCounts {
  const counts: DreamCounts = { applied: 0, proposed: 0, skipped: 0, failed: 0, dropped: dropped.length };
  for (const outcome of outcomes) counts[outcome.status]++;
  return counts;
}

export function dreamsDir(phrenPath: string, project: string): string {
  return path.join(projectStoreDir(phrenPath, project), "dreams");
}

export function lastRunFile(phrenPath: string, project: string): string {
  return path.join(dreamsDir(phrenPath, project), "last-run.json");
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, content);
  renameOverSync(tmp, file);
}

/** dreams/<runId>.json plus one journal line. Returns the record's path. */
export function recordDream(phrenPath: string, project: string, record: DreamRecord): string {
  record = sanitizeDream(record);
  const dir = dreamsDir(phrenPath, project);
  const file = path.join(dir, `${record.changeset.runId}.json`);
  writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
  const counts = countOutcomes(record.outcomes, record.dropped);
  const notes = clean(record.changeset.notes, 160);
  const line = `- ${record.changeset.startedAt} ${record.changeset.runId} ${record.mode}: ${counts.applied} applied, ${counts.proposed} proposed, `
    + `${counts.skipped} skipped, ${counts.failed} failed, ${counts.dropped} dropped (${record.changeset.inputs.transcripts} sessions)${notes ? ` — ${notes}` : ""}${record.warnings?.length ? ` — ${record.warnings.join("; ")}` : ""}\n`;
  appendJournal(phrenPath, project, line);
  return file;
}

export function appendJournal(phrenPath: string, project: string, line: string): void {
  line = sanitizeDream(line);
  const journal = journalFile(phrenPath, project);
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  withFileLock(journal, () => {
    if (!fs.existsSync(journal)) fs.writeFileSync(journal, `# ${project} dream journal\n\n`);
    fs.appendFileSync(journal, line);
  });
}

export interface DreamLastRun { at: string; trigger: "manual" | "scheduled"; runId: string; startedAt: string; finishedAt: string; to: string; mode: DreamMode; status: string; counts?: DreamCounts }

export function writeLastRun(phrenPath: string, project: string, marker: Omit<DreamLastRun, "at">): void {
  writeAtomic(lastRunFile(phrenPath, project), `${JSON.stringify({ ...marker, at: marker.finishedAt }, null, 2)}\n`);
}

export function readLastRun(phrenPath: string, project: string): DreamLastRun | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(lastRunFile(phrenPath, project), "utf8"));
    return value && typeof value.to === "string" && Number.isFinite(Date.parse(value.to)) ? value as DreamLastRun : undefined;
  } catch { return undefined; }
}

/** Pending structured operations; add proposals are owned by the review queue. */
export function pendingDreamProposals(phrenPath: string, project: string): number {
  let names: string[];
  try { names = fs.readdirSync(dreamsDir(phrenPath, project)); } catch { return 0; }
  let count = 0;
  for (const name of names.filter(n => n.endsWith(".json") && n !== "last-run.json")) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dreamsDir(phrenPath, project), name), "utf8")) as DreamRecord;
      count += record.outcomes.filter(o => o.status === "proposed" && o.op !== "add_finding").length;
    } catch { /* Not a run record. */ }
  }
  return count;
}

/** Apply selected zero-based indices from a stored run, never replay completed changes. */
export async function applyDreamProposals(phrenPath: string, project: string, runId: string, only?: number[]): Promise<DreamRecord> {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid dream run ID.");
  if (only?.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error("Proposal indices must be nonnegative integers.");
  const { dreamLockPath, readDreamConfig } = await import("./run.js");
  return withFileLock(dreamLockPath(phrenPath, project), async () => {
    const file = path.join(dreamsDir(phrenPath, project), `${runId}.json`);
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as DreamRecord;
    if (record.changeset.project !== project || record.changeset.runId !== runId) throw new Error("Dream record identity mismatch.");
    if (only?.some(n => !record.changeset.changes[n])) throw new Error("Unknown proposal index.");
    const config = readDreamConfig(phrenPath, project);
    // Validate all targets before our own earlier operations can modify them.
    const current = findingVersions(phrenPath, project);
    const eligible = new Set(record.outcomes.filter(o => o.status === "proposed" && o.op !== "add_finding" && (!only || only.includes(o.index))).map(o => o.index));
    const stale = new Set([...eligible].filter(index => targetIds(record.changeset.changes[index]).some(id => {
      const fid = id.replace(/^fid:/, "");
      return !current[fid] || !record.findingVersions?.[fid] || current[fid] !== record.findingVersions[fid];
    })));
    for (const index of eligible) {
      const change = record.changeset.changes[index];
      let result: { status: DreamOutcomeStatus; detail: string };
      if (stale.has(index)) result = { status: "failed", detail: "target finding missing or changed since the run" };
      else {
        const ids = targetIds(change).map(id => id.replace(/^fid:/, ""));
        const selected = [...eligible].filter(i => !stale.has(i)).map(i => record.changeset.changes[i]);
        try {
          result = await applyOne(phrenPath, project, change, selected, {
            mode: "apply", injectBudgetKB: config.injectBudgetKB, model: record.model,
            expectedFindings: Object.fromEntries(ids.map(fid => [fid, current[fid]])),
          });
          const after = findingVersions(phrenPath, project);
          for (const fid of ids) current[fid] = after[fid];
        } catch (err) { result = { status: "failed", detail: errorText(err) }; }
      }
      const outcome = sanitizeDream({ index, op: change.op, ...result });
      record.outcomes = record.outcomes.map(o => o.index === index ? outcome : o);
      // Checkpoint each outcome before proceeding to the next proposal.
      writeAtomic(file, `${JSON.stringify(sanitizeDream(record), null, 2)}\n`);
      appendJournal(phrenPath, project, `- ${new Date().toISOString()} ${runId}#${index} ${outcome.status}: ${outcome.detail}\n`);
    }
    return sanitizeDream(record);
  });
}
