import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { fileURLToPath } from "url";
import * as yaml from "js-yaml";
import { globSync } from "glob";
import { createRequire } from "module";
import { isValidProjectName, safeProjectPath } from "./utils.js";

// sql.js-fts5 is CJS only, use createRequire for ESM compat
const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js-fts5") as (config?: Record<string, unknown>) => Promise<any>;

// Debug logger - writes to ~/.cortex/debug.log when CORTEX_DEBUG=1
export function debugLog(msg: string): void {
  if (!process.env.CORTEX_DEBUG) return;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const logFile = path.join(home, ".cortex", "debug.log");
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* best effort */ }
}

// Validate that a path is a safe, existing directory
function requireDirectory(resolved: string, label: string): string {
  if (!fs.existsSync(resolved)) {
    console.error(`${label} not found: ${resolved}`);
    process.exit(1);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    console.error(`${label} is not a directory: ${resolved}`);
    process.exit(1);
  }
  return resolved;
}

// Resolve the cortex root directory
// Priority: CORTEX_PATH env > ~/.cortex > ~/cortex (auto-creates ~/.cortex on first run)
export function findCortexPath(): string {
  if (process.env.CORTEX_PATH) return process.env.CORTEX_PATH;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  for (const name of [".cortex", "cortex"]) {
    const candidate = path.join(home, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  const defaultPath = path.join(home, ".cortex");
  fs.mkdirSync(defaultPath, { recursive: true });
  fs.writeFileSync(
    path.join(defaultPath, "README.md"),
    `# My Cortex\n\nThis is your personal knowledge base. Each subdirectory is a project.\n\nGet started:\n\n\`\`\`bash\nmkdir my-project\ncd my-project\ntouch CLAUDE.md summary.md LEARNINGS.md backlog.md\n\`\`\`\n\nOr run \`/cortex:init my-project\` in Claude Code to scaffold one.\n\nPush this directory to a private GitHub repo to sync across machines.\n`
  );
  console.error(`Created ~/.cortex`);
  return defaultPath;
}

// Resolve the cortex path from an explicit argument (used by MCP mode)
export function findCortexPathWithArg(arg?: string): string {
  if (arg) {
    const resolved = arg.replace(/^~/, process.env.HOME || process.env.USERPROFILE || "");
    return requireDirectory(resolved, "cortex path");
  }
  return findCortexPath();
}

// Figure out which project directories to index
export function getProjectDirs(cortexPath: string, profile?: string): string[] {
  if (profile) {
    if (!isValidProjectName(profile)) {
      console.error(`Invalid CORTEX_PROFILE value: ${profile}`);
      return [];
    }
    const profilePath = path.join(cortexPath, "profiles", `${profile}.yaml`);
    if (fs.existsSync(profilePath)) {
      const data = yaml.load(fs.readFileSync(profilePath, "utf-8")) as Record<string, unknown>;
      const projects = data?.projects;
      if (Array.isArray(projects)) {
        return projects
          .map((p: unknown) => {
            const name = String(p);
            if (!isValidProjectName(name)) {
              console.error(`Skipping invalid project name in profile: ${name}`);
              return null;
            }
            return safeProjectPath(cortexPath, name);
          })
          .filter((p): p is string => p !== null && fs.existsSync(p));
      }
    }
  }

  return fs.readdirSync(cortexPath, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith(".") && d.name !== "profiles" && d.name !== "templates")
    .map(d => path.join(cortexPath, d.name));
}

// Classify a file by its name and path
const FILE_TYPE_MAP: Record<string, string> = {
  "claude.md": "claude",
  "summary.md": "summary",
  "learnings.md": "learnings",
  "knowledge.md": "knowledge",
  "backlog.md": "backlog",
  "changelog.md": "changelog",
};

function classifyFile(filename: string, relPath: string): string {
  const mapped = FILE_TYPE_MAP[filename.toLowerCase()];
  if (mapped) return mapped;
  if (relPath.includes("skills/") || relPath.includes("skills\\")) return "skill";
  return "other";
}

// Find and load the WASM binary for sql.js-fts5
function findWasmBinary(): Buffer | undefined {
  const __filename = fileURLToPath(import.meta.url);
  let dir = path.dirname(__filename);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "node_modules", "sql.js-fts5", "dist", "sql-wasm.wasm");
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate);
    dir = path.dirname(dir);
  }
  return undefined;
}

// Compute a hash of all .md file mtimes to use as a cache invalidation key
function computeCortexHash(cortexPath: string, profile?: string): string {
  const projectDirs = getProjectDirs(cortexPath, profile);
  const files: string[] = [];
  for (const dir of projectDirs) {
    try {
      const mdFiles = globSync("**/*.md", { cwd: dir, nodir: true });
      for (const f of mdFiles) files.push(path.join(dir, f));
    } catch { /* skip unreadable dirs */ }
  }
  files.sort();
  const hash = crypto.createHash("md5");
  for (const f of files) {
    try {
      const stat = fs.statSync(f);
      hash.update(`${f}:${stat.mtimeMs}:${stat.size}`);
    } catch { /* skip */ }
  }
  // Include profile in hash so profile changes invalidate cache
  if (profile) hash.update(`profile:${profile}`);
  return hash.digest("hex");
}

export async function buildIndex(cortexPath: string, profile?: string): Promise<any> {
  const cacheDir = path.join(os.tmpdir(), "cortex-fts-cache");
  const hash = computeCortexHash(cortexPath, profile);
  const cacheFile = path.join(cacheDir, `${hash}.db`);

  const wasmBinary = findWasmBinary();
  const SQL = await initSqlJs(wasmBinary ? { wasmBinary } : {});

  // Try to load from cache first
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = fs.readFileSync(cacheFile);
      const db = new SQL.Database(cached);
      debugLog(`Loaded FTS index from cache (${hash.slice(0, 8)})`);
      return db;
    } catch {
      debugLog(`Cache load failed, rebuilding index`);
    }
  }

  // Build fresh index
  const db = new SQL.Database();
  db.run(`
    CREATE VIRTUAL TABLE docs USING fts5(
      project, filename, type, content, path
    );
  `);

  const projectDirs = getProjectDirs(cortexPath, profile);
  let fileCount = 0;

  for (const dir of projectDirs) {
    const projectName = path.basename(dir);
    const mdFiles = globSync("**/*.md", { cwd: dir, nodir: true });

    for (const relFile of mdFiles) {
      const fullPath = path.join(dir, relFile);
      const filename = path.basename(relFile);
      const type = classifyFile(filename, relFile);

      try {
        const raw = fs.readFileSync(fullPath, "utf-8");
        // Strip <details> archive blocks so consolidated entries don't pollute search
        const content = raw.replace(/<details>[\s\S]*?<\/details>/gi, "");
        db.run(
          "INSERT INTO docs (project, filename, type, content, path) VALUES (?, ?, ?, ?, ?)",
          [projectName, filename, type, content, fullPath]
        );
        fileCount++;
      } catch {
        // Skip files we can't read
      }
    }
  }

  debugLog(`Built FTS index: ${fileCount} files from ${projectDirs.length} projects`);
  console.error(`Indexed ${fileCount} files from ${projectDirs.length} projects`);

  // Persist cache to disk for future fast loads
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, db.export());
    // Clean stale cache entries (all except current hash)
    for (const f of fs.readdirSync(cacheDir)) {
      if (!f.endsWith(".db") || f === `${hash}.db`) continue;
      try { fs.unlinkSync(path.join(cacheDir, f)); } catch { /* best effort */ }
    }
    debugLog(`Saved FTS index cache (${hash.slice(0, 8)})`);
  } catch {
    debugLog(`Failed to save FTS index cache`);
  }

  return db;
}

// Extract rows from a db.exec result, or null if empty
export function queryRows(db: any, sql: string, params: (string | number)[]): any[][] | null {
  const results = db.exec(sql, params);
  if (!results.length || !results[0].values.length) return null;
  return results[0].values;
}

// Extract a snippet around the match
export function extractSnippet(content: string, query: string, lines: number = 5): string {
  const terms = query.replace(/\b(AND|OR|NOT|NEAR)\b/gi, "")
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter(t => t.length > 1)
    .map(t => t.toLowerCase());

  if (terms.length === 0) {
    return content.split("\n").slice(0, lines).join("\n");
  }

  const contentLines = content.split("\n");

  const headingIndices: number[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trimStart().startsWith("#")) headingIndices.push(i);
  }

  function nearestHeadingDist(idx: number): number {
    let min = Infinity;
    for (const h of headingIndices) {
      const d = Math.abs(idx - h);
      if (d < min) min = d;
    }
    return min;
  }

  function sectionMiddle(idx: number): number {
    let sectionStart = 0;
    let sectionEnd = contentLines.length;
    for (const h of headingIndices) {
      if (h <= idx) sectionStart = h;
      else { sectionEnd = h; break; }
    }
    return (sectionStart + sectionEnd) / 2;
  }

  let bestIdx = 0;
  let bestScore = 0;
  let bestHeadingDist = Infinity;
  let bestMidDist = Infinity;

  for (let i = 0; i < contentLines.length; i++) {
    const lineLower = contentLines[i].toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (lineLower.includes(term)) score++;
    }
    if (score === 0) continue;

    const hDist = nearestHeadingDist(i);
    const nearHeading = hDist <= 3;
    const mDist = Math.abs(i - sectionMiddle(i));

    const better =
      score > bestScore ||
      (score === bestScore && nearHeading && bestHeadingDist > 3) ||
      (score === bestScore && nearHeading === (bestHeadingDist <= 3) && mDist < bestMidDist);

    if (better) {
      bestScore = score;
      bestIdx = i;
      bestHeadingDist = hDist;
      bestMidDist = mDist;
    }
  }

  const start = Math.max(0, bestIdx - 1);
  const end = Math.min(contentLines.length, bestIdx + lines - 1);
  return contentLines.slice(start, end).join("\n");
}

// Detect which cortex project matches a given directory (cwd)
// Matches against path segments to avoid false positives (e.g., "api" matching "/home/user/capital")
export function detectProject(cortexPath: string, cwd: string, profile?: string): string | null {
  const projectDirs = getProjectDirs(cortexPath, profile);
  const cwdSegments = cwd.toLowerCase().split(path.sep);

  for (const dir of projectDirs) {
    const projectName = path.basename(dir).toLowerCase();
    if (cwdSegments.includes(projectName)) return path.basename(dir);
  }
  return null;
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
      daysSince = Math.floor((today.getTime() - new Date(lastConsolidated).getTime()) / 86400000);
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

// --- Format validation ---

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

// --- Git conflict auto-merge ---

// Extract ours/theirs from a file containing git conflict markers
function extractConflictVersions(content: string): { ours: string; theirs: string } | null {
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
function mergeLearnings(ours: string, theirs: string): string {
  const ourEntries = parseLearningsEntries(ours);
  const theirEntries = parseLearningsEntries(theirs);

  const allDates = [...new Set([...ourEntries.keys(), ...theirEntries.keys()])].sort().reverse();

  // Preserve the title line from ours
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
function mergeBacklog(ours: string, theirs: string): string {
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
  const { execSync } = require("child_process") as typeof import("child_process");

  let conflictedFiles: string[];
  try {
    const out = execSync("git diff --name-only --diff-filter=U", {
      cwd: cortexPath,
      encoding: "utf8",
    }).trim();
    conflictedFiles = out ? out.split("\n") : [];
  } catch {
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
      if (!versions) continue; // No actual conflict markers

      const merged = filename === "learnings.md"
        ? mergeLearnings(versions.ours, versions.theirs)
        : mergeBacklog(versions.ours, versions.theirs);

      fs.writeFileSync(fullPath, merged);
      execSync(`git add "${relFile}"`, { cwd: cortexPath });
      debugLog(`Auto-merged: ${relFile}`);
    } catch (err: any) {
      debugLog(`Failed to auto-merge ${relFile}: ${err.message}`);
      allResolved = false;
    }
  }

  return allResolved;
}

// Add a learning to a project's LEARNINGS.md
export function addLearningToFile(cortexPath: string, project: string, learning: string): string {
  if (!isValidProjectName(project)) return `Invalid project name: "${project}".`;
  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir) return `Invalid project name: "${project}".`;
  const learningsPath = path.join(resolvedDir, "LEARNINGS.md");

  const today = new Date().toISOString().slice(0, 10);
  const bullet = learning.startsWith("- ") ? learning : `- ${learning}`;

  if (!fs.existsSync(learningsPath)) {
    if (!fs.existsSync(resolvedDir)) return `Project "${project}" not found in cortex.`;
    const newContent = `# ${project} LEARNINGS\n\n## ${today}\n\n${bullet}\n`;
    fs.writeFileSync(learningsPath, newContent);
    return `Created LEARNINGS.md for "${project}" and added insight.`;
  }

  const content = fs.readFileSync(learningsPath, "utf8");

  // Soft-validate before writing
  const issues = validateLearningsFormat(content);
  if (issues.length > 0) {
    debugLog(`LEARNINGS.md format warnings for "${project}": ${issues.join("; ")}`);
  }

  const todayHeader = `## ${today}`;

  if (content.includes(todayHeader)) {
    const updated = content.replace(todayHeader, `${todayHeader}\n\n${bullet}`);
    fs.writeFileSync(learningsPath, updated);
  } else {
    const firstHeading = content.match(/^(## \d{4}-\d{2}-\d{2})/m);
    if (firstHeading) {
      const updated = content.replace(firstHeading[0], `${todayHeader}\n\n${bullet}\n\n${firstHeading[0]}`);
      fs.writeFileSync(learningsPath, updated);
    } else {
      fs.writeFileSync(learningsPath, content.trimEnd() + `\n\n## ${today}\n\n${bullet}\n`);
    }
  }

  return `Added learning to ${project}: ${bullet}`;
}
