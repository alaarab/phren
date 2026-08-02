import * as crypto from "crypto";
import * as fs from "fs";
import { impactLogFile } from "../shared.js";
import { rotateJsonlIfLarge, runtimeFile } from "../phren-paths.js";
import { withFileLock } from "../shared/governance.js";
import { normalizeFindingText } from "../content/metadata.js";
import { logger } from "../logger.js";
import { errorMessage } from "../utils.js";

interface FindingImpactEntry {
  findingId: string;
  project: string;
  timestamp: string;
  sessionId: string;
  taskCompleted: boolean;
}

interface ParsedImpactSummary {
  surfaceCountByFinding: Map<string, number>;
  completedByFinding: Set<string>;
}

interface ImpactLogInput {
  findingId: string;
  project: string;
  sessionId: string;
}

/**
 * Impact aggregation, and why it is not a plain memoised read.
 *
 * `getHighImpactFindings()` runs inside `applyTrustFilter()` on the prompt hot
 * path, and `logImpact()` appends to the same file later in the *same* prompt.
 * The old mtime+size cache was therefore invalidated by the very writer it was
 * meant to protect: every prompt re-parsed the whole log, line by line, and at
 * the log's steady-state ceiling of 2MB (13,773 lines) that cost ~9ms per
 * prompt. Worse, `hook-prompt` is a fresh `node` process per prompt, so an
 * in-process cache could never hit on the path that actually needed it.
 *
 * So the aggregate is (a) derived once, (b) persisted to a sidecar keyed by the
 * log's exact [mtimeMs, size], and (c) folded forward on append rather than
 * discarded — appending a record only ever increments one counter. A reader in
 * the next process validates the sidecar's marker against the log and falls
 * back to a full derive on any mismatch, so being wrong is impossible; the
 * worst case is the work we used to do every time.
 */
const IMPACT_SUMMARY_VERSION = 1;

interface ImpactSourceMarker {
  mtimeMs: number;
  size: number;
}

interface PersistedImpactSummary {
  version: number;
  source: ImpactSourceMarker;
  counts: Record<string, number>;
  completed: string[];
}

let summaryCache:
  | {
    file: string;
    marker: ImpactSourceMarker;
    summary: ParsedImpactSummary;
  }
  | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function statMarker(file: string): ImpactSourceMarker | null {
  try {
    const stat = fs.statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function markersMatch(a: ImpactSourceMarker | null, b: ImpactSourceMarker | null): boolean {
  if (!a || !b) return false;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function impactSummaryFile(phrenPath: string): string {
  return runtimeFile(phrenPath, "impact-summary.json");
}

function emptySummary(): ParsedImpactSummary {
  return { surfaceCountByFinding: new Map<string, number>(), completedByFinding: new Set<string>() };
}

function readSidecarSummary(phrenPath: string, marker: ImpactSourceMarker): ParsedImpactSummary | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(impactSummaryFile(phrenPath), "utf8")
    ) as Partial<PersistedImpactSummary>;
    if (parsed?.version !== IMPACT_SUMMARY_VERSION) return null;
    if (!parsed.source || !markersMatch(parsed.source, marker)) return null;
    if (!parsed.counts || typeof parsed.counts !== "object" || !Array.isArray(parsed.completed)) return null;
    const surfaceCountByFinding = new Map<string, number>();
    for (const [findingId, count] of Object.entries(parsed.counts)) {
      if (typeof count === "number" && Number.isFinite(count)) surfaceCountByFinding.set(findingId, count);
    }
    return {
      surfaceCountByFinding,
      completedByFinding: new Set(parsed.completed.filter((id): id is string => typeof id === "string")),
    };
  } catch {
    return null;
  }
}

function writeSidecarSummary(phrenPath: string, marker: ImpactSourceMarker, summary: ParsedImpactSummary): void {
  const target = impactSummaryFile(phrenPath);
  const payload: PersistedImpactSummary = {
    version: IMPACT_SUMMARY_VERSION,
    source: marker,
    counts: Object.fromEntries(summary.surfaceCountByFinding),
    completed: [...summary.completedByFinding],
  };
  // Atomic replace, no lock: readers validate the marker, so a lost race costs
  // one re-derive and can never surface a torn or mismatched aggregate.
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, target);
  } catch (err: unknown) {
    logger.debug("writeSidecarSummary", errorMessage(err));
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
  }
}

function invalidateImpactSummary(phrenPath: string): void {
  summaryCache = null;
  try { fs.unlinkSync(impactSummaryFile(phrenPath)); } catch { /* already absent */ }
}

/** The aggregate for the log's current revision, without ever re-parsing it. Null when unavailable. */
function peekSummary(phrenPath: string, file: string, marker: ImpactSourceMarker): ParsedImpactSummary | null {
  if (summaryCache && summaryCache.file === file && markersMatch(summaryCache.marker, marker)) {
    return summaryCache.summary;
  }
  return readSidecarSummary(phrenPath, marker);
}

function foldEntriesIntoSummary(summary: ParsedImpactSummary, entries: FindingImpactEntry[]): void {
  for (const entry of entries) {
    summary.surfaceCountByFinding.set(
      entry.findingId,
      (summary.surfaceCountByFinding.get(entry.findingId) ?? 0) + 1
    );
    if (entry.taskCompleted) summary.completedByFinding.add(entry.findingId);
  }
}

export function findingIdFromLine(line: string): string {
  const fid = line.match(/<!--\s*fid:([a-z0-9]{8})\s*-->/i);
  if (fid?.[1]) return `fid:${fid[1].toLowerCase()}`;
  const normalized = normalizeFindingText(line);
  if (!normalized) return "hash:empty";
  const hash = crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 12);
  return `hash:${hash}`;
}

export function extractFindingIdsFromSnippet(snippet: string): string[] {
  const lines = snippet
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const bulletLines = lines.filter((line) => line.startsWith("- "));
  const candidates = bulletLines.length > 0 ? bulletLines : (lines[0] ? [lines[0]] : []);
  const ids = new Set<string>();
  for (const line of candidates) {
    ids.add(findingIdFromLine(line));
  }
  return [...ids];
}

function parseImpactLine(line: string): FindingImpactEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<FindingImpactEntry>;
    if (
      !parsed
      || typeof parsed.findingId !== "string"
      || typeof parsed.project !== "string"
      || typeof parsed.timestamp !== "string"
      || typeof parsed.sessionId !== "string"
      || typeof parsed.taskCompleted !== "boolean"
    ) {
      return null;
    }
    return {
      findingId: parsed.findingId,
      project: parsed.project,
      timestamp: parsed.timestamp,
      sessionId: parsed.sessionId,
      taskCompleted: parsed.taskCompleted,
    };
  } catch {
    return null;
  }
}

/** The expensive path: derive the aggregate by parsing every line of the log. */
function readImpactSummary(phrenPath: string): ParsedImpactSummary {
  const file = impactLogFile(phrenPath);
  const summary = emptySummary();

  if (!fs.existsSync(file)) return summary;

  const content = fs.readFileSync(file, "utf8");
  for (const line of content.split("\n")) {
    const entry = parseImpactLine(line);
    if (!entry) continue;

    summary.surfaceCountByFinding.set(
      entry.findingId,
      (summary.surfaceCountByFinding.get(entry.findingId) ?? 0) + 1
    );
    if (entry.taskCompleted) {
      summary.completedByFinding.add(entry.findingId);
    }
  }

  return summary;
}

function appendImpact(phrenPath: string, entries: FindingImpactEntry[]): void {
  if (entries.length === 0) return;
  const file = impactLogFile(phrenPath);
  withFileLock(file, () => {
    // Cap the log. Rotation drops the oldest records, which changes the surface
    // counts, so the aggregate cannot be folded across it.
    const sizeBeforeRotate = statMarker(file)?.size ?? 0;
    rotateJsonlIfLarge(file);
    const preAppendMarker = statMarker(file);
    const rotated = (preAppendMarker?.size ?? 0) !== sizeBeforeRotate;

    // An aggregate that already describes the pre-append log can absorb these
    // records directly — they are exactly the delta, and appending one only
    // ever increments one counter. A file that does not exist yet has an empty
    // aggregate by definition.
    const known = rotated
      ? null
      : preAppendMarker
        ? peekSummary(phrenPath, file, preAppendMarker)
        : emptySummary();

    const lines = entries.map((entry) => JSON.stringify(entry));
    fs.appendFileSync(file, lines.join("\n") + "\n");

    const markerAfter = statMarker(file);
    if (!known || !markerAfter) {
      // No aggregate at hand. Drop the sidecar and let the next read rebuild
      // it — deriving it here would put the whole parse on the write path.
      invalidateImpactSummary(phrenPath);
      return;
    }
    foldEntriesIntoSummary(known, entries);
    summaryCache = { file, marker: markerAfter, summary: known };
    writeSidecarSummary(phrenPath, markerAfter, known);
  });
}

export function logImpact(phrenPath: string, entries: ImpactLogInput[]): void {
  if (entries.length === 0) return;
  const timestamp = nowIso();
  appendImpact(phrenPath, entries.map((entry) => ({
    findingId: entry.findingId,
    project: entry.project,
    sessionId: entry.sessionId,
    timestamp,
    taskCompleted: false,
  })));
}

export function getHighImpactFindings(phrenPath: string, minSurfaceCount = 3): Set<string> {
  const file = impactLogFile(phrenPath);
  const marker = statMarker(file);
  if (!marker) return new Set<string>();

  let summary = peekSummary(phrenPath, file, marker);
  if (!summary) {
    summary = readImpactSummary(phrenPath);
    summaryCache = { file, marker, summary };
    // Persist it so the *next* prompt's process — hooks are short-lived, so it
    // is always a different one — starts from the aggregate instead of the log.
    writeSidecarSummary(phrenPath, marker, summary);
  } else {
    summaryCache = { file, marker, summary };
  }

  // Derived per call: the threshold is a caller's choice, not a property of the
  // aggregate, so it does not belong in the cache key.
  const ids = new Set<string>();
  for (const [findingId, surfaceCount] of summary.surfaceCountByFinding.entries()) {
    if (surfaceCount >= minSurfaceCount && summary.completedByFinding.has(findingId)) {
      ids.add(findingId);
    }
  }
  return ids;
}


export function markImpactEntriesCompletedForSession(phrenPath: string, sessionId: string, project?: string): number {
  if (!sessionId) return 0;
  const file = impactLogFile(phrenPath);
  if (!fs.existsSync(file)) return 0;

  const updated = withFileLock(file, () => {
    if (!fs.existsSync(file)) return 0;
    const preMarker = statMarker(file);
    const known = preMarker ? peekSummary(phrenPath, file, preMarker) : null;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let updatedCount = 0;
    const flipped = new Set<string>();

    const rewritten = lines
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const entry = parseImpactLine(line);
        if (!entry) return line;
        if (entry.taskCompleted) return line;
        if (entry.sessionId !== sessionId) return line;
        if (project && entry.project !== project) return line;
        updatedCount += 1;
        flipped.add(entry.findingId);
        return JSON.stringify({ ...entry, taskCompleted: true });
      });

    if (updatedCount > 0) {
      fs.writeFileSync(file, rewritten.join("\n") + "\n");
      // This rewrite flips taskCompleted on existing records; it never adds or
      // removes any, so the surface counts are untouched and the aggregate only
      // gains completed ids.
      const postMarker = statMarker(file);
      if (known && postMarker) {
        for (const findingId of flipped) known.completedByFinding.add(findingId);
        summaryCache = { file, marker: postMarker, summary: known };
        writeSidecarSummary(phrenPath, postMarker, known);
      } else {
        invalidateImpactSummary(phrenPath);
      }
    }
    return updatedCount;
  });

  return updated;
}
