import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { debugLog, runtimeFile, phrenOk, phrenErr, PhrenError, appendAuditLog, tryUnlink, type PhrenResult } from "./shared.js";
import { isValidProjectName, safeProjectPath, errorMessage } from "./utils.js";
import { logWarn } from "./logger.js";
import { withFileLock } from "./shared-governance.js";
import { appendArchivedEntriesToTopicDoc, classifyTopicForText, readProjectTopics, topicReferencePath } from "./project-topics.js";
import { isCitationLine, isArchiveStart, isArchiveEnd, stripComments } from "./content-metadata.js";

/**
 * Count active (non-archived) finding entries in FINDINGS.md content.
 * Entries inside archive blocks are considered archived.
 * Supports structured archive markers and HTML details blocks.
 */
export function countActiveFindings(content: string): number {
  let inArchive = false;
  let count = 0;
  for (const line of content.split("\n")) {
    if (isArchiveStart(line)) { inArchive = true; continue; }
    if (isArchiveEnd(line)) { inArchive = false; continue; }
    if (!inArchive && line.startsWith("- ")) count++;
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
 * Parse active (non-archived) entries from FINDINGS.md, oldest first.
 */
function parseActiveEntries(content: string): ParsedEntry[] {
  const lines = content.split("\n");
  const entries: ParsedEntry[] = [];
  let currentDate = "";
  let inArchive = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isArchiveStart(line)) { inArchive = true; continue; }
    if (isArchiveEnd(line)) { inArchive = false; continue; }
    if (inArchive) continue;

    const heading = line.match(/^## (\d{4}-\d{2}-\d{2})$/);
    if (heading) { currentDate = heading[1]; continue; }

    if (line.startsWith("- ") && currentDate) {
      const next = lines[i + 1] || "";
      const hasCitation = isCitationLine(next);
      entries.push({
        date: currentDate,
        bullet: line,
        citation: hasCitation ? next : undefined,
        lineIndex: i,
      });
      if (hasCitation) i++;
    }
  }

  // Sort oldest first: earliest date first; within the same date, higher
  // lineIndex = earlier in the file (newest findings are prepended at top).
  // Q25: see docs/decisions/Q25-descending-lineindex-archive.md
  entries.sort((a, b) => a.date.localeCompare(b.date) || b.lineIndex - a.lineIndex);
  return entries;
}

/**
 * Check whether a bullet already exists in a reference file (already archived).
 */
/** Build a Set of normalized bullet strings from all .md files in referenceDir. */
function buildArchivedBulletSet(referenceDir: string): Set<string> {
  const bulletSet = new Set<string>();
  if (!fs.existsSync(referenceDir)) return bulletSet;
  try {
    const stack = [referenceDir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const content = fs.readFileSync(fullPath, "utf8");
        for (const line of content.split("\n")) {
          if (!line.startsWith("- ")) continue;
          const normalizedLine = stripComments(line).replace(/^-\s+/, "").trim().toLowerCase();
          if (normalizedLine) bulletSet.add(normalizedLine);
        }
      }
    }
  } catch (err: unknown) {
    if ((process.env.PHREN_DEBUG)) process.stderr.write(`[phren] buildArchivedBulletSet: ${errorMessage(err)}\n`);
  }
  return bulletSet;
}

function isAlreadyArchived(archivedSet: Set<string>, bullet: string): boolean {
  const normalizedBullet = stripComments(bullet).replace(/^-\s+/, "").trim().toLowerCase();
  if (!normalizedBullet) return false;
  return archivedSet.has(normalizedBullet);
}

/**
 * Archive the oldest entries from FINDINGS.md into reference/{topic}.md files.
 * Keeps `keepCount` most recent entries, archives the rest grouped by topic.
 * Returns the number of entries archived.
 */
export function autoArchiveToReference(
  phrenPath: string,
  project: string,
  keepCount: number,
): PhrenResult<number> {
  if (!isValidProjectName(project)) return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
  const resolvedDir = safeProjectPath(phrenPath, project);
  if (!resolvedDir || !fs.existsSync(resolvedDir)) return phrenErr(`Project "${project}" not found in phren.`, PhrenError.PROJECT_NOT_FOUND);
  const learningsPath = path.join(resolvedDir, "FINDINGS.md");
  if (!fs.existsSync(learningsPath)) return phrenOk(0);

  // Consolidation lock to prevent concurrent runs for the same project (atomic create via wx flag).
  // Use a project-specific lock so consolidating multiple projects in parallel is allowed.
  const STALE_LOCK_MS = 600_000; // 10 min
  const lockFile = runtimeFile(phrenPath, `consolidation-${project}.lock`);
  try {
    fs.writeFileSync(lockFile, String(Date.now()), { flag: "wx" });
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs < STALE_LOCK_MS) {
          return phrenErr("Consolidation already running", PhrenError.LOCK_TIMEOUT);
        }
        // Stale lock: delete then re-create atomically with wx.
        tryUnlink(lockFile);
        // Re-attempt atomic create. If EEXIST, another thread won the race.
        try {
          fs.writeFileSync(lockFile, String(Date.now()), { flag: "wx" });
        } catch (wxErr: unknown) {
          if ((wxErr as NodeJS.ErrnoException).code === "EEXIST") return phrenErr("Consolidation already running", PhrenError.LOCK_TIMEOUT);
          throw wxErr;
        }
      } catch (innerErr: unknown) {
        if ((innerErr as NodeJS.ErrnoException).code === "EEXIST" || (innerErr as NodeJS.ErrnoException).code === "ENOENT") {
          return phrenErr("Consolidation already running", PhrenError.LOCK_TIMEOUT);
        }
        throw innerErr;
      }
    } else { throw e; }
  }

  // Q11: see docs/decisions/Q11-findings-lock-read-modify-write.md
  try {
  return withFileLock(learningsPath, () => {
  const content = fs.readFileSync(learningsPath, "utf8");
  const entries = parseActiveEntries(content);
  if (entries.length <= keepCount) return phrenOk(0);

  const toArchive = entries.slice(0, entries.length - keepCount);

  // Guard: skip entries already present in reference tier (prevent double-archive)
  const referenceDir = path.join(resolvedDir, "reference");
  const { topics } = readProjectTopics(phrenPath, project);
  const today = new Date().toISOString().slice(0, 10);
  const archivedSet = buildArchivedBulletSet(referenceDir);
  const actuallyArchived: ParsedEntry[] = [];
  for (const entry of toArchive) {
    if (isAlreadyArchived(archivedSet, entry.bullet)) {
      debugLog(`auto_archive: skipping already-archived entry: "${entry.bullet.slice(0, 60)}"`);
      continue;
    }
    actuallyArchived.push(entry);
  }

  // Group archived entries by topic
  const byTopic = new Map<string, Array<{ date: string; bullet: string; citation?: string }>>();
  for (const entry of actuallyArchived) {
    const topic = classifyTopicForText(entry.bullet, topics);
    const bucket = byTopic.get(topic.slug) ?? [];
    bucket.push({ date: today, bullet: entry.bullet, citation: entry.citation });
    byTopic.set(topic.slug, bucket);
  }

  // Write to reference/topics/{topic}.md (atomic rename per file)
  fs.mkdirSync(referenceDir, { recursive: true });

  const successfulTopics = new Set<string>();
  for (const [topicSlug, topicEntries] of byTopic) {
    const filePath = topicReferencePath(phrenPath, project, topicSlug);
    const topic = topics.find((item) => item.slug === topicSlug) ?? topics.find((item) => item.slug === "general");
    if (!filePath || !topic) continue;
    try {
      appendArchivedEntriesToTopicDoc(filePath, project, topic, topicEntries);
      successfulTopics.add(topicSlug);
    } catch (err: unknown) {
      debugLog(`auto_archive: failed to write reference file for topic "${topicSlug}": ${errorMessage(err)}`);
    }
  }

  // Only remove entries whose topics were successfully written to reference files,
  // plus entries already present in reference (safe to remove since they're already archived).
  const alreadyArchivedEntries = toArchive.filter(entry => !actuallyArchived.includes(entry));
  const successfullyArchived = actuallyArchived.filter(entry => successfulTopics.has(classifyTopicForText(entry.bullet, topics).slug));
  const safeToRemove = [...successfullyArchived, ...alreadyArchivedEntries];

  // Remove archived entries from FINDINGS.md
  const lines = content.split("\n");
  const archiveLineSet = new Set<number>();
  for (const entry of safeToRemove) {
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

  const skippedCount = alreadyArchivedEntries.length;
  const failedTopics = [...byTopic.keys()].filter(t => !successfulTopics.has(t));
  appendAuditLog(
    phrenPath,
    "auto_archive_reference",
    `project=${project} archived=${successfullyArchived.length} skipped_duplicates=${skippedCount}${failedTopics.length ? ` failed_topics=${failedTopics.join(",")}` : ""} topics=${[...successfulTopics].join(",")}`
  );

  return phrenOk(safeToRemove.length);
  });
  } finally {
    try { fs.unlinkSync(lockFile); } catch (err: unknown) {
      logWarn("autoArchiveToReference", `unlockFile: ${errorMessage(err)}`);
    }
  }
}
