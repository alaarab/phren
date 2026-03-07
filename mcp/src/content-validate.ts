import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { debugLog, EXEC_TIMEOUT_MS, getProjectDirs } from "./shared.js";

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

// Check which projects have enough new learnings to warrant consolidation
export function checkConsolidationNeeded(cortexPath: string, profile?: string): ConsolidationNeeded[] {
  const ENTRY_THRESHOLD = 25;
  const TIME_THRESHOLD_DAYS = 60;
  const MIN_FOR_TIME_CHECK = 10;

  const projectDirs = getProjectDirs(cortexPath, profile);
  const results: ConsolidationNeeded[] = [];
  const today = new Date();

  for (const dir of projectDirs) {
    const learningsPath = path.join(dir, "FINDINGS.md");
    if (!fs.existsSync(learningsPath)) continue;

    const content = fs.readFileSync(learningsPath, "utf8");
    const lines = content.split("\n");

    const markerMatch = content.match(/<!--\s*consolidated:\s*(\d{4}-\d{2}-\d{2})/);
    const lastConsolidated = markerMatch ? markerMatch[1] : null;

    let startLine = 0;
    if (markerMatch) {
      startLine = lines.findIndex(l => l.includes("consolidated:")) + 1;
    }

    let inDetails = false;
    let entriesSince = 0;
    for (let i = startLine; i < lines.length; i++) {
      if (lines[i].includes("<details>")) { inDetails = true; continue; }
      if (lines[i].includes("</details>")) { inDetails = false; continue; }
      if (!inDetails && lines[i].match(/^- /)) entriesSince++;
    }

    let daysSince: number | null = null;
    if (lastConsolidated) {
      const consolidated = safeParseDate(lastConsolidated);
      daysSince = consolidated ? Math.floor((today.getTime() - consolidated.getTime()) / 86400000) : null;
    }

    const needsByCount = entriesSince >= ENTRY_THRESHOLD;
    const needsByTime = daysSince !== null && daysSince >= TIME_THRESHOLD_DAYS && entriesSince >= MIN_FOR_TIME_CHECK;
    const needsFirst = lastConsolidated === null && entriesSince >= ENTRY_THRESHOLD;

    if (needsByCount || needsByTime || needsFirst) {
      results.push({ project: path.basename(dir), entriesSince, daysSince, lastConsolidated });
    }
  }

  return results;
}

// Validate FINDINGS.md format. Returns array of issue strings (empty = valid).
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

// Strip the ## Done section from backlog content to reduce index bloat.
// Keeps title, Active, and Queue sections which are the actionable parts.
export function stripBacklogDoneSection(content: string): string {
  const donePattern = /^## Done\b.*$/im;
  const match = content.match(donePattern);
  if (!match || match.index === undefined) return content;
  return content.slice(0, match.index).trimEnd() + "\n";
}

// Validate backlog.md format. Returns array of issue strings (empty = valid).
export function validateBacklogFormat(content: string): string[] {
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

// Extract ours/theirs from a file containing git conflict markers
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

// Parse FINDINGS.md into a map of date -> bullet entries
function parseLearningsEntries(content: string): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  let currentDate = "";

  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(heading)) {
        currentDate = heading;
        if (!entries.has(currentDate)) entries.set(currentDate, []);
      }
    } else if (line.startsWith("- ") && currentDate) {
      entries.get(currentDate)!.push(line);
    }
  }

  return entries;
}

// Merge two FINDINGS.md versions: union entries per date, newest date first
export function mergeFindings(ours: string, theirs: string): string {
  const ourEntries = parseLearningsEntries(ours);
  const theirEntries = parseLearningsEntries(theirs);

  const allDates = [...new Set([...ourEntries.keys(), ...theirEntries.keys()])].sort().reverse();

  const titleLine = ours.split("\n")[0] || "# Findings";
  const lines = [titleLine, ""];

  for (const date of allDates) {
    const ourItems = ourEntries.get(date) ?? [];
    const theirItems = theirEntries.get(date) ?? [];
    const allItems = [...new Set([...ourItems, ...theirItems])];
    if (allItems.length > 0) {
      lines.push(`## ${date}`, "", ...allItems, "");
    }
  }

  return lines.join("\n");
}

// Parse backlog.md into a map of section name -> bullet entries
function parseBacklogSections(content: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = "";

  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();
      if (!sections.has(current)) sections.set(current, []);
    } else if (line.startsWith("- ") && current) {
      sections.get(current)!.push(line);
    }
  }

  return sections;
}

// Merge two backlog.md versions: union items per section, deduplicated
export function mergeBacklog(ours: string, theirs: string): string {
  const ourSections = parseBacklogSections(ours);
  const theirSections = parseBacklogSections(theirs);

  const sectionOrder = ["Active", "Queue", "Done"];
  const allSections = [...new Set([...ourSections.keys(), ...theirSections.keys()])];
  const ordered = [
    ...sectionOrder.filter(s => allSections.includes(s)),
    ...allSections.filter(s => !sectionOrder.includes(s)),
  ];

  const titleLine = ours.split("\n")[0] || "# backlog";
  const lines = [titleLine, ""];

  for (const section of ordered) {
    const ourItems = ourSections.get(section) ?? [];
    const theirItems = theirSections.get(section) ?? [];
    const allItems = [...new Set([...ourItems, ...theirItems])];
    lines.push(`## ${section}`, "", ...allItems, "");
  }

  return lines.join("\n");
}

// Attempt to auto-resolve git conflicts in FINDINGS.md and backlog.md files.
// Returns true if all conflicts were resolved, false if any remain.
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
  } catch (err: any) {
    debugLog(`autoMergeConflicts: failed to list conflicted files: ${err.message}`);
    return false;
  }

  if (conflictedFiles.length === 0) return true;

  let allResolved = true;

  for (const relFile of conflictedFiles) {
    const fullPath = path.join(cortexPath, relFile);
    const filename = path.basename(relFile).toLowerCase();

    const canAutoMerge = filename === "findings.md" || filename === "backlog.md";
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
        : mergeBacklog(versions.ours, versions.theirs);

      fs.writeFileSync(fullPath, merged);
      execFileSync("git", ["add", "--", relFile], { cwd: cortexPath, stdio: ["ignore", "ignore", "ignore"], timeout: EXEC_TIMEOUT_MS });
      debugLog(`Auto-merged: ${relFile}`);
    } catch (err: any) {
      debugLog(`Failed to auto-merge ${relFile}: ${err.message}`);
      allResolved = false;
    }
  }

  return allResolved;
}
