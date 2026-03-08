import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { debugLog, runtimeFile, cortexOk, cortexErr, CortexError, appendAuditLog, type CortexResult } from "./shared.js";
import { isValidProjectName, safeProjectPath } from "./utils.js";
import { withFileLock } from "./shared-governance.js";

// ── Reference tier helpers ───────────────────────────────────────────────────

const TOPIC_KEYWORDS: Record<string, string[]> = {
  api: ["api", "endpoint", "route", "rest", "graphql", "grpc", "request", "response", "http", "url", "webhook", "cors"],
  database: ["database", "db", "sql", "query", "index", "migration", "schema", "table", "column", "postgres", "mysql", "sqlite", "mongo", "redis", "orm"],
  performance: ["performance", "speed", "latency", "cache", "optimize", "memory", "cpu", "bottleneck", "profiling", "benchmark", "throughput", "lazy"],
  security: ["security", "vulnerability", "xss", "csrf", "injection", "sanitize", "escape", "encrypt", "decrypt", "hash", "salt", "tls", "ssl"],
  frontend: ["frontend", "ui", "ux", "css", "html", "dom", "render", "component", "layout", "responsive", "animation", "browser", "react", "vue", "angular"],
  testing: ["test", "spec", "assert", "mock", "stub", "fixture", "coverage", "jest", "vitest", "playwright", "e2e", "unit", "integration"],
  devops: ["deploy", "ci", "cd", "pipeline", "docker", "kubernetes", "container", "infra", "terraform", "aws", "cloud", "monitoring", "logging"],
  architecture: ["architecture", "design", "pattern", "layer", "module", "system", "structure", "microservice", "monolith", "event-driven", "plugin"],
  debugging: ["debug", "bug", "error", "crash", "fix", "issue", "stack", "trace", "breakpoint", "log", "workaround", "pitfall", "caveat"],
  tooling: ["tool", "cli", "script", "build", "webpack", "vite", "eslint", "prettier", "npm", "package", "config", "plugin", "hook", "git"],
  auth: ["auth", "login", "logout", "session", "token", "jwt", "oauth", "sso", "permission", "role", "access", "credential"],
  data: ["data", "model", "schema", "serialize", "deserialize", "json", "csv", "transform", "validate", "parse", "format", "encode"],
  mobile: ["mobile", "ios", "android", "react-native", "flutter", "native", "touch", "gesture", "push-notification", "app-store"],
  ai_ml: ["ai", "ml", "model", "embedding", "vector", "llm", "prompt", "token", "inference", "training", "neural", "gpt", "claude"],
  general: [],
};

function classifyTopic(bullet: string): string {
  const lower = bullet.toLowerCase();
  let bestTopic = "general";
  let bestScore = 0;

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (topic === "general") continue;
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestTopic = topic;
    }
  }

  return bestTopic;
}

/**
 * Count active (non-archived) finding entries in FINDINGS.md content.
 * Entries inside archive blocks are considered archived.
 * Supports both new structured markers (<!-- cortex:archive:start/end -->)
 * and legacy <details>...</details> format for backwards compatibility.
 */
export function countActiveFindings(content: string): number {
  let inArchive = false;
  let count = 0;
  for (const line of content.split("\n")) {
    if (line.includes("<!-- cortex:archive:start -->") || line.includes("<details>")) { inArchive = true; continue; }
    if (line.includes("<!-- cortex:archive:end -->") || line.includes("</details>")) { inArchive = false; continue; }
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
    if (line.includes("<!-- cortex:archive:start -->") || line.includes("<details>")) { inArchive = true; continue; }
    if (line.includes("<!-- cortex:archive:end -->") || line.includes("</details>")) { inArchive = false; continue; }
    if (inArchive) continue;

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

  // Sort oldest first: earliest date first; within the same date, higher
  // lineIndex = earlier in the file (newest findings are prepended at top).
  // Q25: use descending lineIndex within the same day so that when we slice
  // `toArchive = entries.slice(0, N)` we archive the truly oldest entries
  // (lowest in the file = largest lineIndex for that date).
  entries.sort((a, b) => a.date.localeCompare(b.date) || b.lineIndex - a.lineIndex);
  return entries;
}

/**
 * Check whether a bullet already exists in a reference file (already archived).
 */
function isAlreadyArchived(referenceDir: string, bullet: string): boolean {
  if (!fs.existsSync(referenceDir)) return false;
  const normalizedBullet = bullet.replace(/<!--.*?-->/g, "").replace(/^-\s+/, "").trim().toLowerCase();
  if (!normalizedBullet) return false;
  try {
    const files = fs.readdirSync(referenceDir).filter(f => f.endsWith(".md"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(referenceDir, file), "utf8");
      for (const line of content.split("\n")) {
        if (!line.startsWith("- ")) continue;
        const normalizedLine = line.replace(/<!--.*?-->/g, "").replace(/^-\s+/, "").trim().toLowerCase();
        if (normalizedLine === normalizedBullet) return true;
      }
    }
  } catch { /* best-effort */ }
  return false;
}

/**
 * Archive the oldest entries from FINDINGS.md into reference/{topic}.md files.
 * Keeps `keepCount` most recent entries, archives the rest grouped by topic.
 * Returns the number of entries archived.
 */
export function autoArchiveToReference(
  cortexPath: string,
  project: string,
  keepCount: number,
): CortexResult<number> {
  if (!isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir || !fs.existsSync(resolvedDir)) return cortexErr(`Project "${project}" not found in cortex.`, CortexError.PROJECT_NOT_FOUND);
  const learningsPath = path.join(resolvedDir, "FINDINGS.md");
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

  // Q11: Hold the per-file lock on FINDINGS.md for the entire read-modify-write
  // cycle so finding writers and the archive pass see a consistent file.
  try {
  return withFileLock(learningsPath, () => {
  const content = fs.readFileSync(learningsPath, "utf8");
  const entries = parseActiveEntries(content);
  if (entries.length <= keepCount) return cortexOk(0);

  const toArchive = entries.slice(0, entries.length - keepCount);

  // Guard: skip entries already present in reference tier (prevent double-archive)
  const referenceDir = path.join(resolvedDir, "reference");
  const actuallyArchived: ParsedEntry[] = [];
  for (const entry of toArchive) {
    if (isAlreadyArchived(referenceDir, entry.bullet)) {
      debugLog(`auto_archive: skipping already-archived entry: "${entry.bullet.slice(0, 60)}"`);
      continue;
    }
    actuallyArchived.push(entry);
  }

  // Group archived entries by topic
  const byTopic = new Map<string, ParsedEntry[]>();
  for (const entry of actuallyArchived) {
    const topic = classifyTopic(entry.bullet);
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic)!.push(entry);
  }

  // Write to reference/{topic}.md (atomic rename per file)
  fs.mkdirSync(referenceDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  for (const [topic, topicEntries] of byTopic) {
    const filePath = path.join(referenceDir, `${topic}.md`);
    // Q11: hold per-file lock on each reference file while writing
    withFileLock(filePath, () => {
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

      const refContent = existing.trimEnd() + "\n" + newSection.join("\n");
      const tmpRefPath = filePath + `.tmp-${crypto.randomUUID()}`;
      fs.writeFileSync(tmpRefPath, refContent);
      fs.renameSync(tmpRefPath, filePath);
    });
  }

  // Remove archived entries from FINDINGS.md
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

  const skippedCount = toArchive.length - actuallyArchived.length;
  appendAuditLog(
    cortexPath,
    "auto_archive_reference",
    `project=${project} archived=${actuallyArchived.length} skipped_duplicates=${skippedCount} topics=${[...byTopic.keys()].join(",")}`
  );

  return cortexOk(toArchive.length);
  });
  } finally {
    try { fs.unlinkSync(lockFile); } catch { /* best-effort cleanup */ }
  }
}
