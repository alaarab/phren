import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { isValidProjectName, safeProjectPath } from "./utils.js";
import {
  debugLog,
  appendAuditLog,
  EXEC_TIMEOUT_MS,
  EXEC_TIMEOUT_QUICK_MS,
  getProjectDirs,
  runtimeFile,
  cortexOk,
  cortexErr,
  CortexError,
  type CortexResult,
} from "./shared.js";
import {
  checkMemoryPermission,
  loadCanonicalLocks,
  saveCanonicalLocks,
  hashContent,
  type MemoryPolicy,
} from "./shared-governance.js";

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

export interface LearningCitation {
  created_at: string;
  repo?: string;
  file?: string;
  line?: number;
  commit?: string;
}

export interface LearningTrustIssue {
  date: string;
  bullet: string;
  reason: "stale" | "invalid_citation";
}

export interface TrustFilterOptions {
  ttlDays?: number;
  minConfidence?: number;
  decay?: Partial<MemoryPolicy["decay"]>;
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
    const learningsPath = path.join(dir, "LEARNINGS.md");
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

// Validate LEARNINGS.md format. Returns array of issue strings (empty = valid).
export function validateLearningsFormat(content: string): string[] {
  const issues: string[] = [];
  const lines = content.split("\n");

  if (!lines[0]?.startsWith("# ")) {
    issues.push("Missing title heading (expected: # Project LEARNINGS)");
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

// Parse LEARNINGS.md into a map of date -> bullet entries
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

// Merge two LEARNINGS.md versions: union entries per date, newest date first
export function mergeLearnings(ours: string, theirs: string): string {
  const ourEntries = parseLearningsEntries(ours);
  const theirEntries = parseLearningsEntries(theirs);

  const allDates = [...new Set([...ourEntries.keys(), ...theirEntries.keys()])].sort().reverse();

  const titleLine = ours.split("\n")[0] || "# LEARNINGS";
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

// Attempt to auto-resolve git conflicts in LEARNINGS.md and backlog.md files.
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

    const canAutoMerge = filename === "learnings.md" || filename === "backlog.md";
    if (!canAutoMerge) {
      debugLog(`Cannot auto-merge: ${relFile} (not a known mergeable file)`);
      allResolved = false;
      continue;
    }

    try {
      const content = fs.readFileSync(fullPath, "utf8");
      const versions = extractConflictVersions(content);
      if (!versions) continue;

      const merged = filename === "learnings.md"
        ? mergeLearnings(versions.ours, versions.theirs)
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

function getHeadCommit(cwd: string): string | undefined {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: EXEC_TIMEOUT_QUICK_MS }).trim();
    return commit || undefined;
  } catch (err: any) {
    debugLog(`getHeadCommit: git rev-parse HEAD failed in ${cwd}: ${err?.message || err}`);
    return undefined;
  }
}

function getRepoRoot(cwd: string): string | undefined {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: EXEC_TIMEOUT_QUICK_MS }).trim();
    return root || undefined;
  } catch (err: any) {
    debugLog(`getRepoRoot: not a git repo or git unavailable in ${cwd}: ${err?.message || err}`);
    return undefined;
  }
}

function inferCitationLocation(repoPath: string, commit: string): { file?: string; line?: number } {
  try {
    const raw = execFileSync(
      "git",
      ["show", "--pretty=format:", "--unified=0", "--no-color", commit],
      { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: EXEC_TIMEOUT_MS }
    );
    let currentFile = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("+++ b/")) {
        currentFile = line.slice(6).trim();
        continue;
      }
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk && currentFile) {
        return { file: currentFile, line: Number.parseInt(hunk[1], 10) };
      }
    }
  } catch (err: any) {
    debugLog(`citationLocationFromCommit: git show failed: ${err.message}`);
  }
  return {};
}

function buildCitationComment(citation: LearningCitation): string {
  return `<!-- cortex:cite ${JSON.stringify(citation)} -->`;
}

function parseCitationComment(line: string): LearningCitation | null {
  const match = line.match(/<!--\s*cortex:cite\s+(\{.*\})\s*-->/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as LearningCitation;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.created_at !== "string" || !parsed.created_at) return null;
    return parsed;
  } catch (err: any) {
    debugLog(`parseCitationComment: malformed citation JSON: ${err?.message || err}`);
    return null;
  }
}

function resolveCitationFile(citation: LearningCitation): string | null {
  if (!citation.file) return null;
  if (path.isAbsolute(citation.file)) return citation.file;
  if (citation.repo) return path.resolve(citation.repo, citation.file);
  return path.resolve(citation.file);
}

// Session-scoped caches for git I/O during citation validation.
// Keyed by "repo\0commit" and "repo\0file\0line" respectively.
const commitExistsCache = new Map<string, boolean>();
const blameCache = new Map<string, string | false>();

export function clearCitationCaches(): void {
  commitExistsCache.clear();
  blameCache.clear();
}

function commitExists(repoPath: string, commit: string): boolean {
  const key = `${repoPath}\0${commit}`;
  const cached = commitExistsCache.get(key);
  if (cached !== undefined) return cached;
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
      cwd: repoPath,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    });
    commitExistsCache.set(key, true);
    return true;
  } catch (err: any) {
    debugLog(`commitExists: commit ${commit} not found in ${repoPath}: ${err?.message || err}`);
    commitExistsCache.set(key, false);
    return false;
  }
}

function cachedBlame(repoPath: string, relFile: string, line: number): string | false {
  const key = `${repoPath}\0${relFile}\0${line}`;
  const cached = blameCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const out = execFileSync(
      "git",
      ["blame", "-L", `${line},${line}`, "--porcelain", relFile],
      { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }
    ).trim();
    const first = out.split("\n")[0] || "";
    blameCache.set(key, first);
    return first;
  } catch (err: any) {
    debugLog(`cachedBlame: git blame failed for ${relFile}:${line}: ${err?.message || err}`);
    blameCache.set(key, false);
    return false;
  }
}

function isCitationValid(citation: LearningCitation): boolean {
  if (citation.repo && !fs.existsSync(citation.repo)) return false;
  if (citation.commit && citation.repo && !commitExists(citation.repo, citation.commit)) return false;

  const resolvedFile = resolveCitationFile(citation);
  if (resolvedFile) {
    if (!fs.existsSync(resolvedFile)) return false;
    if (citation.line !== undefined) {
      if (!Number.isInteger(citation.line) || citation.line < 1) return false;
      const lineCount = fs.readFileSync(resolvedFile, "utf8").split("\n").length;
      if (citation.line > lineCount) return false;
      if (citation.commit && citation.repo) {
        const relFile = path.isAbsolute(resolvedFile)
          ? path.relative(citation.repo, resolvedFile)
          : resolvedFile;
        const first = cachedBlame(citation.repo, relFile, citation.line);
        if (first === false || !first.startsWith(citation.commit)) return false;
      }
    }
  }

  return true;
}

function parseLearningDateHeading(line: string): string | null {
  const match = line.match(/^## (\d{4}-\d{2}-\d{2})$/);
  return match ? match[1] : null;
}

function isDateStale(headingDate: string, ttlDays: number): boolean {
  const ts = Date.parse(`${headingDate}T00:00:00Z`);
  if (Number.isNaN(ts)) return false;
  const ageDays = Math.floor((Date.now() - ts) / 86400000);
  return ageDays > ttlDays;
}

function ageDaysForDate(headingDate: string): number | null {
  const ts = Date.parse(`${headingDate}T00:00:00Z`);
  if (Number.isNaN(ts)) return null;
  return Math.floor((Date.now() - ts) / 86400000);
}

const DEFAULT_DECAY = {
  d30: 1.0,
  d60: 0.85,
  d90: 0.65,
  d120: 0.45,
};

function confidenceForAge(ageDays: number, decay: MemoryPolicy["decay"]): number {
  if (ageDays <= 30) return decay.d30;
  if (ageDays <= 60) return decay.d60;
  if (ageDays <= 90) return decay.d90;
  return decay.d120;
}

export function filterTrustedLearnings(content: string, ttlDays: number): string {
  return filterTrustedLearningsDetailed(content, { ttlDays }).content;
}

export function filterTrustedLearningsDetailed(content: string, opts: number | TrustFilterOptions): {
  content: string;
  issues: LearningTrustIssue[];
} {
  const options: TrustFilterOptions = typeof opts === "number" ? { ttlDays: opts } : opts;
  const ttlDays = options.ttlDays ?? 120;
  const minConfidence = options.minConfidence ?? 0.35;
  const decay: MemoryPolicy["decay"] = {
    ...DEFAULT_DECAY,
    ...(options.decay || {}),
  };

  const lines = content.split("\n");
  const out: string[] = [];
  const issues: LearningTrustIssue[] = [];
  let currentDate: string | null = null;
  let headingBuffer: string[] = [];
  let inDetails = false;

  const flushHeading = (hasEntries: boolean) => {
    if (headingBuffer.length === 0) return;
    if (hasEntries) {
      out.push(...headingBuffer);
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    }
    headingBuffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes("<details>")) {
      inDetails = true;
      continue;
    }
    if (line.includes("</details>")) {
      inDetails = false;
      continue;
    }
    if (inDetails) continue;

    const headingDate = parseLearningDateHeading(line);
    if (headingDate) {
      flushHeading(false);
      currentDate = headingDate;
      headingBuffer = [line];
      continue;
    }

    if (line.startsWith("# ")) {
      if (out.length === 0) out.push(line, "");
      continue;
    }

    if (!line.startsWith("- ")) continue;

    const stale = currentDate ? isDateStale(currentDate, ttlDays) : false;
    if (stale) {
      issues.push({ date: currentDate || "unknown", bullet: line, reason: "stale" });
      continue;
    }

    let confidence = 1;
    if (currentDate) {
      const age = ageDaysForDate(currentDate);
      if (age !== null) confidence *= confidenceForAge(age, decay);
    }

    const next = lines[i + 1] ?? "";
    const citation = parseCitationComment(next);
    if (citation && !isCitationValid(citation)) {
      issues.push({ date: currentDate || "unknown", bullet: line, reason: "invalid_citation" });
      continue;
    }
    if (!citation) confidence *= 0.8;
    if (confidence < minConfidence) {
      issues.push({ date: currentDate || "unknown", bullet: line, reason: "stale" });
      continue;
    }

    flushHeading(true);
    out.push(line);
    if (citation) {
      out.push(next);
      i++;
    }
  }

  return { content: out.join("\n").trim(), issues };
}

const LEGACY_FINDINGS_CANDIDATES = [
  "FINDINGS.md",
  "findings.md",
  "LESSONS.md",
  "lessons.md",
  "POSTMORTEM.md",
  "postmortem.md",
  "RETRO.md",
  "retro.md",
];

function normalizeMigratedBullet(raw: string): string {
  const cleaned = raw
    .replace(/^\s*[-*]\s*/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .replace(/^\d+\.\s*/, "")
    .trim();
  return cleaned;
}

function shouldPinCanonical(text: string): boolean {
  return /(must|always|never|avoid|required|critical|do not|don't)\b/i.test(text);
}

export function migrateLegacyFindings(
  cortexPath: string,
  project: string,
  opts: { pinCanonical?: boolean; dryRun?: boolean } = {}
): CortexResult<string> {
  const denial = checkMemoryPermission(cortexPath, "write");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  if (!isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir || !fs.existsSync(resolvedDir)) return cortexErr(`Project "${project}" not found in cortex.`, CortexError.PROJECT_NOT_FOUND);

  const available = new Map(
    fs.readdirSync(resolvedDir).map((name) => [name.toLowerCase(), name] as const)
  );
  const files = LEGACY_FINDINGS_CANDIDATES
    .map((name) => available.get(name.toLowerCase()))
    .filter((name): name is string => Boolean(name));
  if (!files.length) return cortexErr(`No legacy findings docs found for "${project}".`, CortexError.FILE_NOT_FOUND);

  const seen = new Set<string>();
  const extracted: Array<{ text: string; file: string; line: number }> = [];

  for (const file of files) {
    const fullPath = path.join(resolvedDir, file);
    const lines = fs.readFileSync(fullPath, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.match(/^\s*(?:[-*]\s+|\d+\.\s+)/)) continue;
      const bullet = normalizeMigratedBullet(line);
      if (!bullet) continue;
      const key = bullet.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      extracted.push({ text: bullet, file, line: i + 1 });
    }
  }

  if (!extracted.length) {
    return cortexOk(`Legacy findings docs found for "${project}", but no actionable bullet entries were detected.`);
  }

  if (opts.dryRun) {
    return cortexOk(`Found ${extracted.length} migratable findings in ${files.length} file(s) for "${project}".`);
  }

  let migrated = 0;
  let pinned = 0;
  for (const entry of extracted) {
    const learning = `${entry.text} (migrated from ${entry.file})`;
    addLearningToFile(cortexPath, project, learning, {
      repo: resolvedDir,
      file: path.join(resolvedDir, entry.file),
      line: entry.line,
    });
    migrated++;

    if (opts.pinCanonical && shouldPinCanonical(entry.text)) {
      upsertCanonicalMemory(cortexPath, project, entry.text);
      pinned++;
    }
  }

  appendAuditLog(
    cortexPath,
    "migrate_findings",
    `project=${project} files=${files.length} migrated=${migrated} pinned=${pinned}`
  );
  return cortexOk(`Migrated ${migrated} findings for "${project}" from ${files.length} legacy file(s)${opts.pinCanonical ? `; pinned ${pinned} canonical memories` : ""}.`);
}

export function upsertCanonicalMemory(cortexPath: string, project: string, memory: string): CortexResult<string> {
  const denial = checkMemoryPermission(cortexPath, "pin");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  if (!isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir || !fs.existsSync(resolvedDir)) return cortexErr(`Project "${project}" not found in cortex.`, CortexError.PROJECT_NOT_FOUND);
  const canonicalPath = path.join(resolvedDir, "CANONICAL_MEMORIES.md");
  const today = new Date().toISOString().slice(0, 10);
  const bullet = memory.startsWith("- ") ? memory : `- ${memory}`;

  if (!fs.existsSync(canonicalPath)) {
    fs.writeFileSync(
      canonicalPath,
      `# ${project} Canonical Memories\n\n## Pinned\n\n${bullet} _(pinned ${today})_\n`
    );
  } else {
    const content = fs.readFileSync(canonicalPath, "utf8");
    const line = `${bullet} _(pinned ${today})_`;
    if (!content.includes(bullet)) {
      const updated = content.includes("## Pinned")
        ? content.replace("## Pinned", `## Pinned\n\n${line}`)
        : `${content.trimEnd()}\n\n## Pinned\n\n${line}\n`;
      fs.writeFileSync(canonicalPath, updated.endsWith("\n") ? updated : updated + "\n");
    }
  }

  const canonicalContent = fs.readFileSync(canonicalPath, "utf8");
  const locks = loadCanonicalLocks(cortexPath);
  const lockKey = `${project}/CANONICAL_MEMORIES.md`;
  locks[lockKey] = {
    hash: hashContent(canonicalContent),
    snapshot: canonicalContent,
    updatedAt: new Date().toISOString(),
  };
  saveCanonicalLocks(cortexPath, locks);
  appendAuditLog(cortexPath, "pin_memory", `project=${project} memory=${JSON.stringify(memory)}`);
  return cortexOk(`Pinned canonical memory in ${project}.`);
}

export function isDuplicateLearning(existingContent: string, newLearning: string, threshold = 0.6): boolean {
  const normalize = (text: string): string[] => {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2);
  };

  const newWords = normalize(newLearning);
  if (newWords.length === 0) return false;
  const newSet = new Set(newWords);

  const bullets = existingContent.split("\n").filter(l => l.startsWith("- "));
  for (const bullet of bullets) {
    const existingWords = normalize(bullet);
    if (existingWords.length === 0) continue;
    const existingSet = new Set(existingWords);

    let overlap = 0;
    for (const w of newSet) {
      if (existingSet.has(w)) overlap++;
    }

    const smaller = Math.min(newSet.size, existingSet.size);
    if (smaller > 0 && overlap / smaller > threshold) {
      debugLog(`duplicate-detection: skipping learning, ${Math.round((overlap / smaller) * 100)}% overlap with existing: "${bullet.slice(0, 80)}"`);
      return true;
    }
  }

  return false;
}

export function addLearningToFile(
  cortexPath: string,
  project: string,
  learning: string,
  citationInput?: Partial<LearningCitation>
): CortexResult<string> {
  const denial = checkMemoryPermission(cortexPath, "write");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  if (!isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const learningsPath = path.join(resolvedDir, "LEARNINGS.md");

  const today = new Date().toISOString().slice(0, 10);
  const bullet = learning.startsWith("- ") ? learning : `- ${learning}`;
  const nowIso = new Date().toISOString();
  const cwd = process.cwd();
  const inferredRepo = getRepoRoot(cwd);
  const citation: LearningCitation = {
    created_at: nowIso,
    repo: citationInput?.repo || inferredRepo,
    file: citationInput?.file,
    line: citationInput?.line,
    commit: citationInput?.commit || (inferredRepo ? getHeadCommit(inferredRepo) : undefined),
  };
  if (citation.repo && citation.commit && (!citation.file || !citation.line)) {
    const inferred = inferCitationLocation(citation.repo, citation.commit);
    citation.file = citation.file || inferred.file;
    citation.line = citation.line || inferred.line;
  }
  const citationComment = `  ${buildCitationComment(citation)}`;

  if (!fs.existsSync(learningsPath)) {
    if (!fs.existsSync(resolvedDir)) return cortexErr(`Project "${project}" not found in cortex.`, CortexError.PROJECT_NOT_FOUND);
    const newContent = `# ${project} LEARNINGS\n\n## ${today}\n\n${bullet}\n${citationComment}\n`;
    fs.writeFileSync(learningsPath, newContent);
    appendAuditLog(
      cortexPath,
      "add_learning",
      `project=${project} created=true citation_commit=${citation.commit ?? "none"} citation_file=${citation.file ?? "none"}`
    );
    return cortexOk(`Created LEARNINGS.md for "${project}" and added insight.`);
  }

  const content = fs.readFileSync(learningsPath, "utf8");

  if (isDuplicateLearning(content, bullet)) {
    debugLog(`add_learning: skipped duplicate for "${project}": ${bullet.slice(0, 80)}`);
    return cortexOk(`Skipped duplicate learning for "${project}": already exists with similar wording.`);
  }

  const issues = validateLearningsFormat(content);
  if (issues.length > 0) {
    debugLog(`LEARNINGS.md format warnings for "${project}": ${issues.join("; ")}`);
  }

  const todayHeader = `## ${today}`;
  let updated: string;

  if (content.includes(todayHeader)) {
    updated = content.replace(todayHeader, `${todayHeader}\n\n${bullet}\n${citationComment}`);
  } else {
    const firstHeading = content.match(/^(## \d{4}-\d{2}-\d{2})/m);
    if (firstHeading) {
      updated = content.replace(firstHeading[0], `${todayHeader}\n\n${bullet}\n${citationComment}\n\n${firstHeading[0]}`);
    } else {
      updated = content.trimEnd() + `\n\n## ${today}\n\n${bullet}\n${citationComment}\n`;
    }
  }

  const tmpPath = learningsPath + `.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, updated);
  fs.renameSync(tmpPath, learningsPath);

  appendAuditLog(
    cortexPath,
    "add_learning",
    `project=${project} citation_commit=${citation.commit ?? "none"} citation_file=${citation.file ?? "none"}`
  );

  // Size cap: auto-archive oldest entries when LEARNINGS.md exceeds the cap
  const DEFAULT_LEARNINGS_CAP = 20;
  const cap = Number.parseInt(process.env.CORTEX_LEARNINGS_CAP || "", 10) || DEFAULT_LEARNINGS_CAP;
  const activeCount = countActiveLearnings(updated);
  if (activeCount > cap) {
    const archiveResult = autoArchiveToKnowledge(cortexPath, project, cap);
    if (archiveResult.ok && archiveResult.data > 0) {
      debugLog(`Size cap: archived ${archiveResult.data} oldest entries for "${project}" (cap=${cap})`);
    }
  }

  return cortexOk(`Added learning to ${project}: ${bullet} (with citation metadata)`);
}

export function addLearningsToFile(
  cortexPath: string,
  project: string,
  learnings: string[]
): CortexResult<{ added: string[]; skipped: string[] }> {
  const denial = checkMemoryPermission(cortexPath, "write");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  if (!isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const learningsPath = path.join(resolvedDir, "LEARNINGS.md");

  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  const cwd = process.cwd();
  const inferredRepo = getRepoRoot(cwd);
  const headCommit = inferredRepo ? getHeadCommit(inferredRepo) : undefined;

  const added: string[] = [];
  const skipped: string[] = [];

  if (!fs.existsSync(learningsPath)) {
    if (!fs.existsSync(resolvedDir)) return cortexErr(`Project "${project}" not found in cortex.`, CortexError.PROJECT_NOT_FOUND);
    // File doesn't exist — create with all learnings
    const lines: string[] = [`# ${project} LEARNINGS\n\n## ${today}\n`];
    for (const learning of learnings) {
      const bullet = learning.startsWith("- ") ? learning : `- ${learning}`;
      const citation: LearningCitation = { created_at: nowIso, repo: inferredRepo, commit: headCommit };
      lines.push(`\n${bullet}\n  ${buildCitationComment(citation)}`);
      added.push(learning);
    }
    fs.writeFileSync(learningsPath, lines.join("") + "\n");
    appendAuditLog(cortexPath, "add_learning", `project=${project} count=${added.length} batch=true`);
    return cortexOk({ added, skipped });
  }

  // Read once, apply all learnings, write once
  let content = fs.readFileSync(learningsPath, "utf8");
  const issues = validateLearningsFormat(content);
  if (issues.length > 0) debugLog(`LEARNINGS.md format warnings for "${project}": ${issues.join("; ")}`);

  for (const learning of learnings) {
    const bullet = learning.startsWith("- ") ? learning : `- ${learning}`;
    if (isDuplicateLearning(content, bullet)) { skipped.push(learning); continue; }
    const citation: LearningCitation = { created_at: nowIso, repo: inferredRepo, commit: headCommit };
    const citationComment = `  ${buildCitationComment(citation)}`;
    const todayHeader = `## ${today}`;
    if (content.includes(todayHeader)) {
      content = content.replace(todayHeader, `${todayHeader}\n\n${bullet}\n${citationComment}`);
    } else {
      const firstHeading = content.match(/^(## \d{4}-\d{2}-\d{2})/m);
      if (firstHeading) {
        content = content.replace(firstHeading[0], `${todayHeader}\n\n${bullet}\n${citationComment}\n\n${firstHeading[0]}`);
      } else {
        content = content.trimEnd() + `\n\n## ${today}\n\n${bullet}\n${citationComment}\n`;
      }
    }
    added.push(learning);
  }

  if (added.length > 0) {
    const tmpPath = learningsPath + `.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, learningsPath);
    appendAuditLog(cortexPath, "add_learning", `project=${project} count=${added.length} batch=true`);

    const DEFAULT_LEARNINGS_CAP = 20;
    const cap = Number.parseInt(process.env.CORTEX_LEARNINGS_CAP || "", 10) || DEFAULT_LEARNINGS_CAP;
    if (countActiveLearnings(content) > cap) {
      const archiveResult = autoArchiveToKnowledge(cortexPath, project, cap);
      if (archiveResult.ok && archiveResult.data > 0) {
        debugLog(`Size cap: archived ${archiveResult.data} oldest entries for "${project}" (cap=${cap})`);
      }
    }
  }

  return cortexOk({ added, skipped });
}

// ── Knowledge tier helpers ───────────────────────────────────────────────────

const TOPIC_PATTERNS: Array<{ topic: string; keywords: RegExp }> = [
  { topic: "architecture", keywords: /\b(architecture|design|structure|pattern|layer|module|component|system|schema|model|migration|database|api|endpoint|route)\b/i },
  { topic: "workflow", keywords: /\b(workflow|deploy|ci|cd|pipeline|build|release|publish|test|lint|script|hook|git|branch|merge|npm|package)\b/i },
  { topic: "gotchas", keywords: /\b(gotcha|caveat|bug|workaround|hack|issue|problem|error|fail|break|crash|conflict|race|edge case|timeout|memory leak)\b/i },
  { topic: "patterns", keywords: /\b(convention|style|naming|format|import|export|type|interface|class|function|async|promise|callback|event|signal|state)\b/i },
];

function classifyTopic(bullet: string): string {
  for (const { topic, keywords } of TOPIC_PATTERNS) {
    if (keywords.test(bullet)) return topic;
  }
  return "general";
}

/**
 * Count active (non-archived) learning entries in LEARNINGS.md content.
 * Entries inside <details> blocks are considered archived.
 */
export function countActiveLearnings(content: string): number {
  let inDetails = false;
  let count = 0;
  for (const line of content.split("\n")) {
    if (line.includes("<details>")) { inDetails = true; continue; }
    if (line.includes("</details>")) { inDetails = false; continue; }
    if (!inDetails && line.startsWith("- ")) count++;
  }
  return count;
}

interface ParsedEntry {
  date: string;
  bullet: string;
  citation?: string;
  lineIndex: number;
}

/**
 * Parse active (non-archived) entries from LEARNINGS.md, oldest first.
 */
function parseActiveEntries(content: string): ParsedEntry[] {
  const lines = content.split("\n");
  const entries: ParsedEntry[] = [];
  let currentDate = "";
  let inDetails = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("<details>")) { inDetails = true; continue; }
    if (line.includes("</details>")) { inDetails = false; continue; }
    if (inDetails) continue;

    const heading = line.match(/^## (\d{4}-\d{2}-\d{2})$/);
    if (heading) { currentDate = heading[1]; continue; }

    if (line.startsWith("- ") && currentDate) {
      const next = lines[i + 1] || "";
      const hasCitation = /^\s*<!--\s*cortex:cite\s+\{.*\}\s*-->/.test(next);
      entries.push({
        date: currentDate,
        bullet: line,
        citation: hasCitation ? next : undefined,
        lineIndex: i,
      });
      if (hasCitation) i++;
    }
  }

  // Sort oldest first (earliest date, then by line order within that date)
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.lineIndex - b.lineIndex);
  return entries;
}

/**
 * Archive the oldest entries from LEARNINGS.md into knowledge/{topic}.md files.
 * Keeps `keepCount` most recent entries, archives the rest grouped by topic.
 * Returns the number of entries archived.
 */
export function autoArchiveToKnowledge(
  cortexPath: string,
  project: string,
  keepCount: number,
): CortexResult<number> {
  if (!isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir || !fs.existsSync(resolvedDir)) return cortexErr(`Project "${project}" not found in cortex.`, CortexError.PROJECT_NOT_FOUND);
  const learningsPath = path.join(resolvedDir, "LEARNINGS.md");
  if (!fs.existsSync(learningsPath)) return cortexOk(0);

  // Consolidation lock to prevent concurrent runs (atomic create via wx flag)
  const STALE_LOCK_MS = 600_000; // 10 min
  const lockFile = runtimeFile(cortexPath, "consolidation.lock");
  try {
    fs.writeFileSync(lockFile, String(Date.now()), { flag: "wx" });
  } catch (e: any) {
    if (e?.code === "EEXIST") {
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs < STALE_LOCK_MS) {
          return cortexErr("Consolidation already running", CortexError.LOCK_TIMEOUT);
        }
        // Stale lock, overwrite it
        fs.writeFileSync(lockFile, String(Date.now()));
      } catch { return cortexErr("Consolidation already running", CortexError.LOCK_TIMEOUT); }
    } else { throw e; }
  }

  try {
  const content = fs.readFileSync(learningsPath, "utf8");
  const entries = parseActiveEntries(content);
  if (entries.length <= keepCount) return cortexOk(0);

  const toArchive = entries.slice(0, entries.length - keepCount);
  const toKeep = new Set(entries.slice(entries.length - keepCount).map(e => e.lineIndex));

  // Group archived entries by topic
  const byTopic = new Map<string, ParsedEntry[]>();
  for (const entry of toArchive) {
    const topic = classifyTopic(entry.bullet);
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic)!.push(entry);
  }

  // Write to knowledge/{topic}.md
  const knowledgeDir = path.join(resolvedDir, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  for (const [topic, topicEntries] of byTopic) {
    const filePath = path.join(knowledgeDir, `${topic}.md`);
    let existing = "";
    if (fs.existsSync(filePath)) {
      existing = fs.readFileSync(filePath, "utf8");
    } else {
      existing = `# ${project} - ${topic}\n`;
    }

    const newSection = [`\n## Archived ${today}\n`];
    for (const entry of topicEntries) {
      newSection.push(entry.bullet);
      if (entry.citation) newSection.push(entry.citation);
    }
    newSection.push("");

    fs.writeFileSync(filePath, existing.trimEnd() + "\n" + newSection.join("\n"));
  }

  // Remove archived entries from LEARNINGS.md
  const lines = content.split("\n");
  const archiveLineSet = new Set<number>();
  for (const entry of toArchive) {
    archiveLineSet.add(entry.lineIndex);
    if (entry.citation) archiveLineSet.add(entry.lineIndex + 1);
  }

  const filtered = lines.filter((_, i) => !archiveLineSet.has(i));

  // Clean up empty date sections
  const cleaned: string[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const line = filtered[i];
    const isDateHeading = /^## \d{4}-\d{2}-\d{2}$/.test(line);
    if (isDateHeading) {
      // Check if next non-empty lines have any bullets
      let hasBullets = false;
      for (let j = i + 1; j < filtered.length; j++) {
        const next = filtered[j].trim();
        if (!next) continue;
        if (next.startsWith("## ") || next.startsWith("# ")) break;
        if (next.startsWith("- ")) { hasBullets = true; break; }
        break;
      }
      if (!hasBullets) continue;
    }
    cleaned.push(line);
  }

  // Write consolidation marker
  const marker = `<!-- consolidated: ${today} -->`;
  const markerIdx = cleaned.findIndex(l => l.includes("consolidated:"));
  if (markerIdx >= 0) {
    cleaned[markerIdx] = marker;
  } else {
    // Insert after title
    const titleIdx = cleaned.findIndex(l => l.startsWith("# "));
    if (titleIdx >= 0) {
      cleaned.splice(titleIdx + 1, 0, "", marker);
    }
  }

  const tmpPath = learningsPath + `.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, cleaned.join("\n"));
  fs.renameSync(tmpPath, learningsPath);

  appendAuditLog(
    cortexPath,
    "auto_archive_knowledge",
    `project=${project} archived=${toArchive.length} topics=${[...byTopic.keys()].join(",")}`
  );

  return cortexOk(toArchive.length);
  } finally {
    try { fs.unlinkSync(lockFile); } catch { /* best-effort cleanup */ }
  }
}
