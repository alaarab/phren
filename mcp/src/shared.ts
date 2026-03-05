import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as yaml from "js-yaml";
import { globSync } from "glob";
import { createRequire } from "module";
import { isValidProjectName, safeProjectPath } from "./utils.js";

// sql.js-fts5 is CJS only, use createRequire for ESM compat
const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js-fts5") as (config?: Record<string, unknown>) => Promise<any>;

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

export async function buildIndex(cortexPath: string, profile?: string): Promise<any> {
  const wasmBinary = findWasmBinary();
  const SQL = await initSqlJs(wasmBinary ? { wasmBinary } : {});
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
        const content = fs.readFileSync(fullPath, "utf-8");
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

  console.error(`Indexed ${fileCount} files from ${projectDirs.length} projects`);
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
    fs.writeFileSync(learningsPath, `# ${project} LEARNINGS\n\n## ${today}\n\n${bullet}\n`);
    return `Created LEARNINGS.md for "${project}" and added insight.`;
  }

  const content = fs.readFileSync(learningsPath, "utf8");
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
