import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { debugLog, EXEC_TIMEOUT_MS, getProjectDirs } from "../shared.js";
import { errorMessage } from "../utils.js";
import { countActiveFindings } from "./archive.js";
import { isTaskFileName } from "../data/tasks.js";
import { METADATA_REGEX } from "./metadata.js";
import { getNonPrimaryStores, getStoreProjectDirs } from "../store-registry.js";
import { FINDINGS_FILENAME } from "../data/access.js";

/** Maximum allowed length for a single finding entry (token budget protection). */
export const MAX_FINDING_LENGTH = 2000;

function safeParseDate(s: string): Date | null {
  const d = new Date(s);
  return isNaN(d.getTime()) || d.getFullYear() < 2020 ? null : d;
}

export interface ConsolidationNeeded {
  project: string;
  entriesSince: number;
  daysSince: number | null;
  lastConsolidated: string | null;
}

export interface ConsolidationStatus extends ConsolidationNeeded {
  recommended: boolean;
}

/** Thresholds used for consolidation recommendations. */
export const CONSOLIDATION_ENTRY_THRESHOLD = 25;
const CONSOLIDATION_TIME_THRESHOLD_DAYS = 60;
const CONSOLIDATION_MIN_FOR_TIME_CHECK = 10;

/**
 * Validate a single finding text before it is persisted.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateFinding(text: string): string | null {
  if (!text || !text.trim()) return "Finding text cannot be empty.";
  if (text.length > MAX_FINDING_LENGTH) return `Finding exceeds maximum length of ${MAX_FINDING_LENGTH} characters (got ${text.length}). Shorten the text or split into multiple findings.`;
  return null;
}

/**
 * Compute consolidation status for a single project directory.
 * Returns null if the project has no FINDINGS.md.
 */
export function getProjectConsolidationStatus(dir: string): ConsolidationStatus | null {
  const learningsPath = path.join(dir, FINDINGS_FILENAME);
  if (!fs.existsSync(learningsPath)) return null;

  const content = fs.readFileSync(learningsPath, "utf8");
  const markerMatch = content.match(/<!--\s*consolidated:\s*(\d{4}-\d{2}-\d{2})/);
  const lastConsolidated = markerMatch ? markerMatch[1] : null;

  // Count entries since last consolidated marker, skipping both <details> and
  // <!-- phren:archive:start/end --> blocks via countActiveFindings.
  const contentSinceMarker = markerMatch
    ? content.slice(content.indexOf(markerMatch[0]) + markerMatch[0].length)
    : content;
  const entriesSince = countActiveFindings(contentSinceMarker);

  let daysSince: number | null = null;
  if (lastConsolidated) {
    const consolidated = safeParseDate(lastConsolidated);
    daysSince = consolidated ? Math.floor((Date.now() - consolidated.getTime()) / 86400000) : null;
  }

  const recommended =
    entriesSince >= CONSOLIDATION_ENTRY_THRESHOLD ||
    (daysSince !== null && daysSince >= CONSOLIDATION_TIME_THRESHOLD_DAYS && entriesSince >= CONSOLIDATION_MIN_FOR_TIME_CHECK) ||
    (lastConsolidated === null && entriesSince >= CONSOLIDATION_ENTRY_THRESHOLD);

  return {
    project: path.basename(dir),
    entriesSince,
    daysSince,
    lastConsolidated,
    recommended,
  };
}

/**
 * Check which projects have enough new findings to warrant consolidation.
 * Returns projects that exceed the entry or time thresholds.
 */
export function checkConsolidationNeeded(phrenPath: string, profile?: string): ConsolidationNeeded[] {
  const projectDirs = getProjectDirs(phrenPath, profile);
  const results: ConsolidationNeeded[] = [];

  for (const dir of projectDirs) {
    const status = getProjectConsolidationStatus(dir);
    if (status && status.recommended) {
      results.push(status);
    }
  }

  // Include projects from team stores
  try {
    for (const store of getNonPrimaryStores(phrenPath)) {
      if (!fs.existsSync(store.path)) continue;
      for (const dir of getStoreProjectDirs(store)) {
        const status = getProjectConsolidationStatus(dir);
        if (status && status.recommended) {
          results.push(status);
        }
      }
    }
  } catch {
    // store-registry not available or error loading, continue with primary only
  }

  return results;
}

/**
 * Validate FINDINGS.md format and structure.
 * Returns an array of issue description strings (empty array means valid).
 */
export function validateFindingsFormat(content: string): string[] {
  const issues: string[] = [];
  const lines = content.split("\n");

  if (!lines[0]?.startsWith("# ")) {
    issues.push("Missing title heading (expected: # Project Findings)");
  }

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim();
      // Only validate headings that look like they should be dates
      if (/^\d/.test(heading) && !/^\d{4}-\d{2}-\d{2}$/.test(heading)) {
        issues.push(`Date heading should be YYYY-MM-DD format: "${line}"`);
      }
    }
  }

  return issues;
}

/**
 * Strip the ## Done section (and equivalents) from task content to reduce index bloat.
 * Keeps the title, Active, and Queue sections which are the actionable parts.
 * Handles: Done, Completed, Archived, Finished, Complete.
 */
export function stripTaskDoneSection(content: string): string {
  const donePattern = /^## (Done|Completed|Archived|Finished|Complete)\b.*$/im;
  const match = content.match(donePattern);
  if (!match || match.index === undefined) return content;
  return content.slice(0, match.index).trimEnd() + "\n";
}

/**
 * Validate tasks.md format and structure.
 * Returns an array of issue description strings (empty array means valid).
 */
export function validateTaskFormat(content: string): string[] {
  const issues: string[] = [];
  const lines = content.split("\n");

  if (!lines[0]?.startsWith("# ")) {
    issues.push("Missing title heading");
  }

  const hasSections =
    content.includes("## Active") ||
    content.includes("## Queue") ||
    content.includes("## Done");
  if (!hasSections) {
    issues.push("Missing expected sections (Active, Queue, Done)");
  }

  return issues;
}

/**
 * Extract ours/theirs versions from a file containing git conflict markers.
 * Returns null if no conflict markers are found.
 */
export function extractConflictVersions(content: string): { ours: string; theirs: string } | null {
  if (!content.includes("<<<<<<<")) return null;

  const oursLines: string[] = [];
  const theirsLines: string[] = [];
  let state: "normal" | "ours" | "theirs" = "normal";

  for (const line of content.split("\n")) {
    if (line.startsWith("<<<<<<<")) { state = "ours"; continue; }
    if (line === "=======" || line.startsWith("======= ")) { state = "theirs"; continue; }
    if (line.startsWith(">>>>>>>")) { state = "normal"; continue; }

    if (state === "normal") {
      oursLines.push(line);
      theirsLines.push(line);
    } else if (state === "ours") {
      oursLines.push(line);
    } else {
      theirsLines.push(line);
    }
  }

  return { ours: oursLines.join("\n"), theirs: theirsLines.join("\n") };
}

/** A FINDINGS.md split into the parts a merge has to reassemble. */
interface ParsedFindings {
  title: string;
  /** Everything between the title and the first date heading (consolidated markers…). */
  preamble: string[];
  /** date -> finding blocks (bullet plus its continuation lines). */
  dates: Map<string, string[]>;
  /** Everything from the first archive block or non-date section to EOF. */
  trailing: string[];
}

/** Does this line open a region that is not a live date section? */
function opensTrailingRegion(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("<details")) return true;
  if (trimmed.startsWith("<!-- phren:archive:start")) return true;
  if (line.startsWith("## ") && !/^\d{4}-\d{2}-\d{2}$/.test(line.slice(3).trim())) return true;
  return false;
}

/**
 * Parse FINDINGS.md into title / preamble / date sections / trailing.
 *
 * Two rules matter for not losing content:
 *
 * 1. A finding block is its bullet plus **every** following line up to the next
 *    bullet, heading, or blank line — not only `<!--` comments. Hand-written
 *    indented detail lines ("  - rationale: …") used to end the block, which
 *    dropped them *and* the citation comment that followed them.
 * 2. Once an archive wrapper (`<details>`, `<!-- phren:archive:start -->`) or a
 *    non-date `## ` section starts, everything after it is trailing content that
 *    is carried through verbatim. Parsing archived bullets as live date entries
 *    is how a merge promoted archived findings back into the active section.
 */
function parseFindings(content: string): ParsedFindings {
  const lines = content.split("\n");
  const title = lines[0] ?? "# Findings";

  const preamble: string[] = [];
  const dates = new Map<string, string[]>();
  const trailing: string[] = [];

  let currentDate = "";
  let currentBlock: string[] = [];
  let phase: "preamble" | "dates" | "trailing" = "preamble";

  const flush = () => {
    if (currentBlock.length > 0 && currentDate) {
      dates.get(currentDate)!.push(currentBlock.join("\n").replace(/\s+$/, ""));
    }
    currentBlock = [];
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    if (phase === "trailing") {
      trailing.push(line);
      continue;
    }

    if (opensTrailingRegion(line)) {
      flush();
      phase = "trailing";
      trailing.push(line);
      continue;
    }

    if (line.startsWith("## ") && /^\d{4}-\d{2}-\d{2}$/.test(line.slice(3).trim())) {
      flush();
      phase = "dates";
      currentDate = line.slice(3).trim();
      if (!dates.has(currentDate)) dates.set(currentDate, []);
      continue;
    }

    if (phase === "preamble") {
      preamble.push(line);
      continue;
    }

    if (line.startsWith("- ")) {
      flush();
      currentBlock = [line];
      continue;
    }

    if (line.trim() !== "") {
      // Either a continuation of the current finding (an indented sub-bullet, a
      // metadata comment, a wrapped sentence) or, with no bullet open, a stray
      // run of content — a fenced block, a stray paragraph. Both are kept as
      // part of a block so the writer can put them back; dropping "lines the
      // parser did not recognise" is what made this merge lossy.
      currentBlock.push(line);
      continue;
    }

    flush();
  }
  flush();

  while (preamble.length > 0 && preamble[preamble.length - 1].trim() === "") preamble.pop();
  while (trailing.length > 0 && trailing[trailing.length - 1].trim() === "") trailing.pop();

  return { title, preamble, dates, trailing };
}

// Extract the bullet text from a finding block (first line) for dedup purposes
function findingBulletText(block: string): string {
  // Strip stable finding ID so two entries with different fids but same text are considered duplicates during merge.
  return block.split("\n")[0].replace(METADATA_REGEX.findingId, "").replace(/\s+/g, " ").trim();
}

/** Union two line lists, keeping order and dropping lines already present. */
function unionLines(ourLines: string[], theirLines: string[]): string[] {
  const present = new Set(ourLines.map((line) => line.trim()).filter(Boolean));
  const out = [...ourLines];
  for (const line of theirLines) {
    const key = line.trim();
    if (key && present.has(key)) continue;
    if (key) present.add(key);
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

/**
 * Union trailing regions (archive `<details>` blocks, non-date sections).
 *
 * Segment-wise rather than line-wise: filtering individual lines could strip a
 * bullet out of theirs' `<details>` block and leave a stray `</details>`. When
 * one side's content lines are a subset of the other's, the subset is dropped —
 * that covers the common "theirs is ours plus one archived finding" case. When
 * they genuinely differ, both are emitted: a duplicated archive block is
 * recoverable, a deleted one is not.
 */
function unionTrailing(ourTrailing: string[], theirTrailing: string[]): string[] {
  if (ourTrailing.length === 0) return [...theirTrailing];
  if (theirTrailing.length === 0) return [...ourTrailing];

  const ourKeys = new Set(ourTrailing.map((line) => line.trim()).filter(Boolean));
  const theirContent = theirTrailing.map((line) => line.trim()).filter(Boolean);
  if (theirContent.every((line) => ourKeys.has(line))) return [...ourTrailing];

  const theirKeys = new Set(theirContent);
  const ourContent = ourTrailing.map((line) => line.trim()).filter(Boolean);
  if (ourContent.every((line) => theirKeys.has(line))) return [...theirTrailing];

  return [...ourTrailing, "", ...theirTrailing];
}

/** Content lines a merge must round-trip: no blanks, no title, no date headings. */
function significantLines(content: string): string[] {
  return content
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .filter((line) => !(line.startsWith("## ") && /^\d{4}-\d{2}-\d{2}$/.test(line.slice(3).trim())));
}

/** Raised when a merge would drop content; the caller must leave the conflict alone. */
export class FindingsMergeLossError extends Error {}

/**
 * Merge two FINDINGS.md versions: union entries per date, newest date first.
 *
 * Deduplicates by bullet text, keeping the continuation lines of whichever copy
 * wins (ours takes priority). Preamble and trailing regions are unioned from
 * **both** sides — taking them from `ours` alone silently deleted theirs'
 * archive blocks and non-date sections.
 *
 * Runs unattended (push_changes, session-stop conflict recovery) and its result
 * is committed and pushed, so it verifies itself: every content line of either
 * input must appear in the output, and a merge that cannot manage that throws
 * `FindingsMergeLossError` rather than committing the loss. Callers leave the
 * conflict for the user.
 */
export function mergeFindings(ours: string, theirs: string): string {
  const { text, dedupedContinuations } = buildMergedFindings(ours, theirs);

  const present = new Set(text.split("\n").map((line) => line.trim()));
  const lost = [...significantLines(ours), ...significantLines(theirs)]
    .filter((line) => !present.has(line))
    // A block that lost a dedup race takes its own continuation lines with it —
    // that is the intended rule (the finding is present, ours' provenance wins),
    // not the content loss this guard exists to catch.
    .filter((line) => !dedupedContinuations.has(line));
  if (lost.length > 0) {
    throw new FindingsMergeLossError(
      `Refusing to auto-merge ${FINDINGS_FILENAME}: ${lost.length} line(s) would be dropped, ` +
        `starting with "${lost[0].slice(0, 80)}". Resolve this conflict by hand.`,
    );
  }
  return text;
}

function buildMergedFindings(ours: string, theirs: string): { text: string; dedupedContinuations: Set<string> } {
  const ourSide = parseFindings(ours);
  const theirSide = parseFindings(theirs);

  const allDates = [...new Set([...ourSide.dates.keys(), ...theirSide.dates.keys()])].sort().reverse();
  const lines = [ourSide.title || theirSide.title || "# Findings"];
  const dedupedContinuations = new Set<string>();

  const preamble = unionLines(ourSide.preamble, theirSide.preamble);
  if (preamble.length > 0) lines.push(...preamble, "");
  else lines.push("");

  for (const date of allDates) {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const block of [...(ourSide.dates.get(date) ?? []), ...(theirSide.dates.get(date) ?? [])]) {
      const key = findingBulletText(block);
      if (seen.has(key)) {
        for (const line of block.split("\n").slice(1)) {
          const trimmed = line.trim();
          if (trimmed) dedupedContinuations.add(trimmed);
        }
        continue;
      }
      seen.add(key);
      merged.push(block);
    }

    if (merged.length > 0) {
      lines.push(`## ${date}`, "");
      for (const block of merged) lines.push(block, "");
    }
  }

  const trailing = unionTrailing(ourSide.trailing, theirSide.trailing);
  if (trailing.length > 0) lines.push(...trailing, "");

  return { text: lines.join("\n"), dedupedContinuations };
}

/** A parsed task record that may span multiple lines (bullet + Context: continuation). */
interface TaskRecord {
  /** The stable bid:XXXXXXXX if present in the bullet line, used as merge key. */
  stableId?: string;
  /** The bullet line itself. */
  bullet: string;
  /** Continuation lines immediately following the bullet (e.g. "  Context: ..."). */
  continuations: string[];
}

/** Pattern for stable bid comment embedded in task lines. */
const MERGE_BID_PATTERN = /<!--\s*bid:([a-z0-9]{8})\s*-->/;

/** Render a TaskRecord back to its original lines. */
function renderTaskRecord(record: TaskRecord): string[] {
  return [record.bullet, ...record.continuations];
}

/** Merge key: stable ID if present, otherwise normalised bullet text. */
function taskRecordKey(record: TaskRecord): string {
  if (record.stableId) return `bid:${record.stableId}`;
  return record.bullet.replace(MERGE_BID_PATTERN, "").trim().toLowerCase();
}

// Parse tasks.md into a map of section name -> multi-line TaskRecord entries.
function parseTaskSections(content: string): Map<string, TaskRecord[]> {
  const sections = new Map<string, TaskRecord[]>();
  let current = "";
  let currentRecord: TaskRecord | null = null;

  const flush = () => {
    if (currentRecord && current) {
      sections.get(current)!.push(currentRecord);
      currentRecord = null;
    }
  };

  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      current = line.slice(3).trim();
      if (!sections.has(current)) sections.set(current, []);
    } else if (line.startsWith("- ") && current) {
      flush();
      const bidMatch = line.match(MERGE_BID_PATTERN);
      currentRecord = {
        stableId: bidMatch ? bidMatch[1] : undefined,
        bullet: line,
        continuations: [],
      };
    } else if (currentRecord && line.trim().startsWith("Context:")) {
      currentRecord.continuations.push(line);
    } else {
      flush();
    }
  }
  flush();

  return sections;
}

/**
 * Merge two tasks.md versions: union items per section, deduplicated by stable ID when
 * present or by normalised bullet text otherwise. Context/continuation lines are preserved.
 * Ours wins on conflict. Section order follows Active > Queue > Done.
 */
export function mergeTask(ours: string, theirs: string): string {
  const ourSections = parseTaskSections(ours);
  const theirSections = parseTaskSections(theirs);

  const sectionOrder = ["Active", "Queue", "Done"];
  const allSections = [...new Set([...ourSections.keys(), ...theirSections.keys()])];
  const ordered = [
    ...sectionOrder.filter(s => allSections.includes(s)),
    ...allSections.filter(s => !sectionOrder.includes(s)),
  ];

  const titleLine = ours.split("\n")[0] || "# task";
  const lines = [titleLine, ""];

  for (const section of ordered) {
    const ourItems = ourSections.get(section) ?? [];
    const theirItems = theirSections.get(section) ?? [];

    // Merge: ours wins; include theirs only when key not already seen
    const seen = new Map<string, TaskRecord>();
    for (const record of ourItems) seen.set(taskRecordKey(record), record);
    for (const record of theirItems) {
      const key = taskRecordKey(record);
      if (!seen.has(key)) {
        seen.set(key, record);
      } else if (record.stableId) {
        // Merge fields from theirs into ours when using stable ID: preserve context lines
        const oursRecord = seen.get(key)!;
        if (oursRecord.continuations.length === 0 && record.continuations.length > 0) {
          seen.set(key, { ...oursRecord, continuations: record.continuations });
        }
      }
    }

    lines.push(`## ${section}`, "");
    for (const record of seen.values()) {
      lines.push(...renderTaskRecord(record));
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Attempt to auto-resolve git conflicts in FINDINGS.md and tasks.md files.
 * Returns true if all conflicts were resolved, false if any remain.
 */
export function autoMergeConflicts(phrenPath: string): boolean {
  let conflictedFiles: string[];
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
      cwd: phrenPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    conflictedFiles = out ? out.split("\n") : [];
  } catch (err: unknown) {
    debugLog(`autoMergeConflicts: failed to list conflicted files: ${errorMessage(err)}`);
    return false;
  }

  if (conflictedFiles.length === 0) return true;

  let allResolved = true;

  for (const relFile of conflictedFiles) {
    const fullPath = path.join(phrenPath, relFile);
    const filename = path.basename(relFile).toLowerCase();

    const canAutoMerge = filename === "findings.md" || isTaskFileName(filename);
    if (!canAutoMerge) {
      debugLog(`Cannot auto-merge: ${relFile} (not a known mergeable file)`);
      allResolved = false;
      continue;
    }

    try {
      const content = fs.readFileSync(fullPath, "utf8");
      const versions = extractConflictVersions(content);
      if (!versions) continue;

      const merged = filename === "findings.md"
        ? mergeFindings(versions.ours, versions.theirs)
        : mergeTask(versions.ours, versions.theirs);

      const tmpMergePath = fullPath + `.tmp-${crypto.randomUUID()}`;
      fs.writeFileSync(tmpMergePath, merged);
      fs.renameSync(tmpMergePath, fullPath);
      execFileSync("git", ["add", "--", relFile], { cwd: phrenPath, stdio: ["ignore", "ignore", "ignore"], timeout: EXEC_TIMEOUT_MS });
      debugLog(`Auto-merged: ${relFile}`);
    } catch (err: unknown) {
      debugLog(`Failed to auto-merge ${relFile}: ${errorMessage(err)}`);
      allResolved = false;
    }
  }

  return allResolved;
}
