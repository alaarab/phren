import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { debugLog, EXEC_TIMEOUT_MS, getProjectDirs } from "./shared.js";
import { errorMessage } from "./utils.js";
import { countActiveFindings } from "./content-archive.js";
import { isTaskFileName } from "./data-tasks.js";

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
  const learningsPath = path.join(dir, "FINDINGS.md");
  if (!fs.existsSync(learningsPath)) return null;

  const content = fs.readFileSync(learningsPath, "utf8");
  const markerMatch = content.match(/<!--\s*consolidated:\s*(\d{4}-\d{2}-\d{2})/);
  const lastConsolidated = markerMatch ? markerMatch[1] : null;

  // Count entries since last consolidated marker, skipping both <details> and
  // <!-- cortex:archive:start/end --> blocks via countActiveFindings.
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
export function checkConsolidationNeeded(cortexPath: string, profile?: string): ConsolidationNeeded[] {
  const projectDirs = getProjectDirs(cortexPath, profile);
  const results: ConsolidationNeeded[] = [];

  for (const dir of projectDirs) {
    const status = getProjectConsolidationStatus(dir);
    if (status && status.recommended) {
      results.push(status);
    }
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

// Parse FINDINGS.md into a map of date -> finding blocks.
// Each finding is a bullet line plus any immediately following HTML comment lines
// (e.g. <!-- cortex:cite {...} -->). These are stored as multi-line strings and
// deduplicated by the bullet text only, preserving provenance comments.
function parseFindingsEntries(content: string): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  let currentDate = "";
  let currentBlock: string[] = [];

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      // Flush any pending block before switching date
      if (currentBlock.length > 0 && currentDate) {
        entries.get(currentDate)!.push(currentBlock.join("\n"));
        currentBlock = [];
      }
      const heading = line.slice(3).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(heading)) {
        currentDate = heading;
        if (!entries.has(currentDate)) entries.set(currentDate, []);
      }
    } else if (line.startsWith("- ") && currentDate) {
      // Flush previous block
      if (currentBlock.length > 0) {
        entries.get(currentDate)!.push(currentBlock.join("\n"));
      }
      currentBlock = [line];
    } else if (currentBlock.length > 0 && /^\s*<!--/.test(line)) {
      // HTML comment continuation of current finding block
      currentBlock.push(line);
    } else {
      // Non-comment, non-bullet line: flush any pending block
      if (currentBlock.length > 0 && currentDate) {
        entries.get(currentDate)!.push(currentBlock.join("\n"));
        currentBlock = [];
      }
    }
  }
  // Flush final block
  if (currentBlock.length > 0 && currentDate) {
    entries.get(currentDate)!.push(currentBlock.join("\n"));
  }

  return entries;
}

// Extract the bullet text from a finding block (first line) for dedup purposes
function findingBulletText(block: string): string {
  // Strip stable finding ID so two entries with different fids but same text are considered duplicates during merge.
  return block.split("\n")[0].replace(/<!--\s*fid:[a-z0-9]{8}\s*-->/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Extract non-entry preamble content from a FINDINGS.md string.
 * Returns lines that appear before the first date section heading (## YYYY-MM-DD)
 * and are not the title line, so things like <!-- consolidated: ... --> markers
 * and <details>cortex:archive blocks are preserved during merge.
 */
function extractFindingsPreamble(content: string): string[] {
  const lines = content.split("\n");
  const preamble: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## ") && /^\d{4}-\d{2}-\d{2}$/.test(line.slice(3).trim())) break;
    preamble.push(line);
  }
  // Drop the title line (index 0) since it's handled separately
  return preamble.slice(1);
}

/**
 * Extract postamble content from a FINDINGS.md string.
 * Returns lines that appear after all date sections, such as <details> archive blocks.
 */
function extractFindingsPostamble(content: string): string[] {
  const lines = content.split("\n");
  // Find the last date-section heading
  let lastDateIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("## ") && /^\d{4}-\d{2}-\d{2}$/.test(lines[i].slice(3).trim())) {
      lastDateIdx = i;
      break;
    }
  }
  if (lastDateIdx === -1) return [];
  // Skip forward past the date section's content to find postamble
  for (let i = lastDateIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ") && !/^\d{4}-\d{2}-\d{2}$/.test(lines[i].slice(3).trim())) {
      return lines.slice(i);
    }
    if (lines[i].startsWith("<details") || lines[i].startsWith("<!-- consolidated:")) {
      return lines.slice(i);
    }
  }
  return [];
}

/**
 * Merge two FINDINGS.md versions: union entries per date, newest date first.
 * Deduplicates by bullet text only, keeping comment lines from whichever
 * version is kept (ours takes priority).
 * Preserves preamble content (consolidated markers) and postamble (archive blocks).
 */
export function mergeFindings(ours: string, theirs: string): string {
  const ourEntries = parseFindingsEntries(ours);
  const theirEntries = parseFindingsEntries(theirs);

  const allDates = [...new Set([...ourEntries.keys(), ...theirEntries.keys()])].sort().reverse();

  const titleLine = ours.split("\n")[0] || "# Findings";
  // Preserve preamble from ours (consolidated markers, etc.)
  const preamble = extractFindingsPreamble(ours);
  // Preserve postamble from ours (archive <details> blocks, etc.)
  const postamble = extractFindingsPostamble(ours);

  const lines = [titleLine];
  if (preamble.length > 0) {
    lines.push(...preamble);
  } else {
    lines.push("");
  }

  for (const date of allDates) {
    const ourItems = ourEntries.get(date) ?? [];
    const theirItems = theirEntries.get(date) ?? [];

    // Dedup by bullet text, ours wins on conflict
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const block of ourItems) {
      const key = findingBulletText(block);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(block);
      }
    }
    for (const block of theirItems) {
      const key = findingBulletText(block);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(block);
      }
    }

    if (merged.length > 0) {
      lines.push(`## ${date}`, "");
      for (const block of merged) {
        lines.push(block, "");
      }
    }
  }

  if (postamble.length > 0) {
    lines.push(...postamble);
  }

  return lines.join("\n");
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
export function autoMergeConflicts(cortexPath: string): boolean {
  let conflictedFiles: string[];
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
      cwd: cortexPath,
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
    const fullPath = path.join(cortexPath, relFile);
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
      execFileSync("git", ["add", "--", relFile], { cwd: cortexPath, stdio: ["ignore", "ignore", "ignore"], timeout: EXEC_TIMEOUT_MS });
      debugLog(`Auto-merged: ${relFile}`);
    } catch (err: unknown) {
      debugLog(`Failed to auto-merge ${relFile}: ${errorMessage(err)}`);
      allResolved = false;
    }
  }

  return allResolved;
}
