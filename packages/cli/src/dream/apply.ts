// Applying a dream: each change goes through the same finding, truth, topic and review
// APIs an agent's own MCP calls use, so lifecycle history, fids, locks and citations are
// kept. Propose mode queues one review item per change instead. Either way the run is
// recorded in dreams/<runId>.json and one line of dreams/journal.md.
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { addFindingToFile, upsertCanonical } from "../content/learning.js";
import type { FindingProvenance } from "../content/citation.js";
import { applyFindingTypePrefix } from "../core/finding.js";
import { editFinding, readFindings, removeFinding } from "../data/access.js";
import { retractFinding, supersedeFinding } from "../finding/lifecycle.js";
import { withFileLock } from "../governance/locks.js";
import { appendReviewQueue } from "../governance/policy.js";
import { renameOverSync, runtimeFile } from "../phren-paths.js";
import { appendArchivedEntriesToTopicDoc, readProjectTopics, topicReferencePath } from "../project-topics.js";
import { storeAwareProjectPath } from "../store-routing.js";
import { journalFile, projectStoreDir } from "./collect.js";
import { injectedSize, writePage } from "./contract-stubs.js"; // CONTRACT STUB: ./pages.js and ./budget.js at integration
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
function replaceWith(phrenPath: string, project: string, ids: string[], newText: string, model?: string): { status: DreamOutcomeStatus; detail: string } {
  const read = readFindings(phrenPath, project);
  const items = ids.map(id => read.ok ? read.data.find(f => f.stableId === id.replace(/^fid:/, "")) : undefined);
  const missing = ids.filter((_, i) => !items[i]);
  if (missing.length) return { status: "failed", detail: `no finding ${missing.map(fidRef).join(", ")}` };
  const added = addFindingToFile(phrenPath, project, newText, { supersedes: items[0]!.text }, { provenance: provenance(model) });
  if (!added.ok) return { status: "failed", detail: added.error };
  let rest = ids;
  let detail = `replaced ${ids.map(fidRef).join(", ")}`;
  if (added.data.status === "skipped") {
    const edited = editFinding(phrenPath, project, fidRef(ids[0]), newText);
    if (!edited.ok) return { status: "failed", detail: `near-duplicate of a saved finding, and editing ${fidRef(ids[0])} failed: ${edited.error}` };
    rest = ids.slice(1);
    detail = `edited ${fidRef(ids[0])} in place (the new text was a near-duplicate)${rest.length ? `; superseded ${rest.map(fidRef).join(", ")}` : ""}`;
  }
  const errors: string[] = [];
  const after = readFindings(phrenPath, project);
  for (const id of rest) {
    const current = after.ok ? after.data.find(f => f.stableId === id.replace(/^fid:/, "")) : undefined;
    if (current?.status === "superseded") continue;
    const result = supersedeFinding(phrenPath, project, fidRef(id), newText);
    if (!result.ok) errors.push(`${fidRef(id)}: ${result.error}`);
  }
  return errors.length ? { status: "failed", detail: `${detail}; ${errors.join("; ")}` } : { status: "applied", detail };
}

function truthsPath(phrenPath: string, project: string): string {
  return storeAwareProjectPath(phrenPath, project, "truths.md") ?? path.join(phrenPath, project, "truths.md");
}

/** Remove one truth line. There is no removal API beside upsertCanonical, so this uses its lock and atomic rename. */
function removeTruth(phrenPath: string, project: string, truth: string): boolean {
  const file = truthsPath(phrenPath, project);
  if (!fs.existsSync(file)) return false;
  const wanted = truth.trim().replace(/^- /, "");
  return withFileLock(file, () => {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const index = lines.findIndex(line => line.startsWith("- ") && line.slice(2).replace(TRUTH_DATE, "").trim() === wanted);
    if (index < 0) return false;
    lines.splice(index, 1);
    const tmp = `${file}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmp, lines.join("\n").replace(/\n{3,}/g, "\n\n"));
    renameOverSync(tmp, file);
    return true;
  });
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
      return replaceWith(phrenPath, project, [change.findingId], change.newText, options.model);
    case "retract": {
      const result = retractFinding(phrenPath, project, fidRef(change.findingId), change.reason);
      return result.ok ? ok(`retracted ${fidRef(change.findingId)}`) : fail(result.error);
    }
    case "edit": {
      const result = editFinding(phrenPath, project, fidRef(change.findingId), change.newText);
      return result.ok ? ok(`edited ${fidRef(change.findingId)}`) : fail(result.error);
    }
    case "merge":
      return replaceWith(phrenPath, project, change.findingIds, change.newText, options.model);
    case "move_topic": {
      const topic = readProjectTopics(phrenPath, project).topics.find(t => t.slug === change.topic);
      if (!topic) return fail(`unknown topic "${change.topic}"`);
      const file = topicReferencePath(phrenPath, project, topic.slug);
      if (!file) return fail(`no topic file for "${topic.slug}"`);
      const read = readFindings(phrenPath, project);
      const fid = change.findingId.replace(/^fid:/, "");
      const item = read.ok ? read.data.find(f => f.stableId === fid) : undefined;
      if (!item) return fail(`no finding ${fidRef(fid)}`);
      // Archive first: a failed removal leaves a duplicate, never a lost finding.
      appendArchivedEntriesToTopicDoc(file, project, topic, [{ date: item.date, bullet: `- ${item.text} <!-- fid:${fid} -->`, ...(item.citation ? { citation: item.citation } : {}) }]);
      const removed = removeFinding(phrenPath, project, fidRef(fid));
      return removed.ok ? ok(`moved ${fidRef(fid)} to ${topic.slug}`) : fail(`archived to ${topic.slug} but not removed: ${removed.error}`);
    }
    case "promote_truth": {
      const budget = Math.round(options.injectBudgetKB * 1024);
      const size = await injectedSize(phrenPath, project);
      const adds = Buffer.byteLength(change.text, "utf8") + 24;
      if (size + adds > budget && !all.some(other => other.op === "demote_truth")) {
        return fail(`would put the injected layer at ${size + adds} bytes, over its ${budget}-byte budget, with no demotion in this changeset`);
      }
      const result = upsertCanonical(phrenPath, project, change.text);
      return result.ok ? ok(result.data) : fail(result.error);
    }
    case "demote_truth": {
      if (!removeTruth(phrenPath, project, change.truth)) return fail("no such truth");
      // Demoted, not deleted: it stays findable as an ordinary finding.
      const added = addText(phrenPath, project, change.truth, options.model);
      return added.ok ? ok("demoted to a finding") : fail(`removed from truths, not re-added: ${added.detail}`);
    }
    case "write_page": {
      const slug = PAGE_PATH.exec(change.page)?.[1];
      if (!slug) return fail(`bad page path "${change.page}"`);
      const written = await writePage(phrenPath, project, slug, change.markdown, change.links);
      return ok(written.brokenLinks.length ? `wrote ${slug}; broken links: ${written.brokenLinks.join(", ")}` : `wrote ${slug}`);
    }
    case "link": {
      if (!findingText(phrenPath, project, change.findingId)) return fail(`no finding ${fidRef(change.findingId)}`);
      persistLink(phrenPath, project, change.entity);
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
    outcomes.push({ index, op: change.op, ...result });
  }
  return outcomes;
}

// ── Records ──────────────────────────────────────────────────────────────────

export interface DreamRecord {
  changeset: DreamChangeset;
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
  const dir = dreamsDir(phrenPath, project);
  const file = path.join(dir, `${record.changeset.runId}.json`);
  writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
  const counts = countOutcomes(record.outcomes, record.dropped);
  const notes = clean(record.changeset.notes, 160);
  const line = `- ${record.changeset.startedAt} ${record.changeset.runId} ${record.mode}: ${counts.applied} applied, ${counts.proposed} proposed, `
    + `${counts.skipped} skipped, ${counts.failed} failed, ${counts.dropped} dropped (${record.changeset.inputs.transcripts} sessions)${notes ? ` — ${notes}` : ""}\n`;
  appendJournal(phrenPath, project, line);
  return file;
}

export function appendJournal(phrenPath: string, project: string, line: string): void {
  const journal = journalFile(phrenPath, project);
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  withFileLock(journal, () => {
    if (!fs.existsSync(journal)) fs.writeFileSync(journal, `# ${project} dream journal\n\n`);
    fs.appendFileSync(journal, line);
  });
}

export interface DreamLastRun { runId: string; startedAt: string; finishedAt: string; to: string; mode: DreamMode; status: string; counts?: DreamCounts }

export function writeLastRun(phrenPath: string, project: string, marker: DreamLastRun): void {
  writeAtomic(lastRunFile(phrenPath, project), `${JSON.stringify(marker, null, 2)}\n`);
}

export function readLastRun(phrenPath: string, project: string): DreamLastRun | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(lastRunFile(phrenPath, project), "utf8"));
    return value && typeof value.to === "string" && Number.isFinite(Date.parse(value.to)) ? value as DreamLastRun : undefined;
  } catch { return undefined; }
}
