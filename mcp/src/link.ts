import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import * as readline from "readline";
import * as yaml from "js-yaml";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import {
  configureClaude,
  configureCodexMcp,
  configureCopilotMcp,
  configureCursorMcp,
  configureVSCode,
  ensureGovernanceFiles,
  getHooksEnabledPreference,
  getMcpEnabledPreference,
  isVersionNewer,
  logMcpTargetStatus,
  setMcpEnabledPreference,
  type McpMode,
} from "./init.js";
import { buildLifecycleCommands, configureAllHooks, detectInstalledTools } from "./hooks.js";
import {
  debugLog,
  EXEC_TIMEOUT_MS,
  EXEC_TIMEOUT_QUICK_MS,
  getProjectDirs,
  isRecord,
} from "./shared.js";
import { validateGovernanceJson } from "./shared-governance.js";
import {
  buildIndex,
  queryRows,
} from "./shared-index.js";
import {
  validateBacklogFormat,
  validateFindingsFormat,
} from "./shared-content.js";

interface ProfileData {
  name?: string;
  description?: string;
  projects?: string[];
}

type MachinesConfig = Record<string, string>;

// Cross-platform home directory helper: respects HOME / USERPROFILE overrides
// (important for tests and Windows CI where os.homedir() may not reflect env overrides).
function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

// Claude Code derives its project key from the home dir with path separators replaced by dashes.
// On Windows the drive letter introduces a colon (e.g. C:\Users\... -> C:-Users-...) which is
// illegal in directory names, so we strip colons too.
function claudeProjectKey(): string {
  return homeDir().replace(/[/\\:]/g, "-").replace(/^-/, "");
}

const LEGACY_MACHINE_FILE = path.join(os.homedir(), ".cortex-machine");
const CORTEX_MACHINE_FILE = path.join(os.homedir(), ".cortex", ".machine-id");
const CONTEXT_FILE = path.join(os.homedir(), ".cortex-context.md");

function machineFilePath(): string {
  // Prefer legacy location if it exists (backwards compat)
  if (fs.existsSync(LEGACY_MACHINE_FILE)) return LEGACY_MACHINE_FILE;
  // Prefer inside cortex dir (works on Windows without dotfile issues)
  if (fs.existsSync(CORTEX_MACHINE_FILE)) return CORTEX_MACHINE_FILE;
  // On Windows (non-WSL), use cortex dir to avoid dotfile issues
  if (process.platform === "win32") return CORTEX_MACHINE_FILE;
  return LEGACY_MACHINE_FILE;
}
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const DEFAULT_SEARCH_PATHS = [
  os.homedir(),
  path.join(os.homedir(), "Sites"),
  path.join(os.homedir(), "Projects"),
  path.join(os.homedir(), "Code"),
  path.join(os.homedir(), "dev"),
];

function log(msg: string) { process.stdout.write(msg + "\n"); }

function safeUsername(): string {
  try { return os.userInfo().username; } catch { return "unknown"; }
}

function getMachineName(): string {
  const mf = machineFilePath();
  if (fs.existsSync(mf)) return fs.readFileSync(mf, "utf8").trim();
  // On WSL, prefer the Windows hostname for consistency with native Windows.
  if (process.env.WSL_DISTRO_NAME && process.env.COMPUTERNAME) {
    return process.env.COMPUTERNAME.toLowerCase();
  }
  return os.hostname();
}

function lookupProfile(cortexPath: string, machine: string): string {
  const machinesFile = path.join(cortexPath, "machines.yaml");
  if (!fs.existsSync(machinesFile)) return "";
  const data = yaml.load(fs.readFileSync(machinesFile, "utf8"), { schema: yaml.CORE_SCHEMA });
  if (!isRecord(data)) return "";
  const value = data[machine];
  return typeof value === "string" ? value : "";
}

function listProfiles(cortexPath: string): Array<{ name: string; description: string }> {
  const profilesDir = path.join(cortexPath, "profiles");
  if (!fs.existsSync(profilesDir)) return [];
  return fs.readdirSync(profilesDir)
    .filter(f => f.endsWith(".yaml"))
    .map(f => {
      const data = yaml.load(fs.readFileSync(path.join(profilesDir, f), "utf8"), { schema: yaml.CORE_SCHEMA }) as ProfileData | undefined;
      return { name: data?.name ?? "", description: data?.description ?? "" };
    })
    .filter(p => p.name);
}

function findProfileFile(cortexPath: string, profileName: string): string | null {
  const profilesDir = path.join(cortexPath, "profiles");
  if (!fs.existsSync(profilesDir)) return null;
  for (const f of fs.readdirSync(profilesDir)) {
    if (!f.endsWith(".yaml")) continue;
    const data = yaml.load(fs.readFileSync(path.join(profilesDir, f), "utf8"), { schema: yaml.CORE_SCHEMA }) as ProfileData | undefined;
    if (data?.name === profileName) return path.join(profilesDir, f);
  }
  return null;
}

function getProfileProjects(profileFile: string): string[] {
  const data = yaml.load(fs.readFileSync(profileFile, "utf8"), { schema: yaml.CORE_SCHEMA }) as ProfileData | undefined;
  return Array.isArray(data?.projects) ? data.projects : [];
}

function allKnownProjects(cortexPath: string): string[] {
  const profilesDir = path.join(cortexPath, "profiles");
  if (!fs.existsSync(profilesDir)) return [];
  const projects = new Set<string>();
  for (const f of fs.readdirSync(profilesDir)) {
    if (!f.endsWith(".yaml")) continue;
    const data = yaml.load(fs.readFileSync(path.join(profilesDir, f), "utf8"), { schema: yaml.CORE_SCHEMA }) as ProfileData | undefined;
    for (const p of (data?.projects ?? [])) projects.add(p);
  }
  return [...projects].sort();
}

function findProjectDir(name: string): string | null {
  const extra = process.env.PROJECTS_DIR ? [process.env.PROJECTS_DIR] : [];
  for (const base of [...extra, ...DEFAULT_SEARCH_PATHS]) {
    const candidate = path.join(base, name);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    } catch (err: unknown) {
      debugLog(`findProjectDir: failed to check ${candidate}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

function displayName(slug: string): string {
  if (!slug) return "";
  return slug.split("-").map(w => w[0]?.toUpperCase() + w.slice(1)).join(" ");
}


function currentPackageVersion(): string | null {
  try {
    const pkgPath = path.join(ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version || null;
  } catch (err: unknown) {
    debugLog(`currentPackageVersion: failed to read package.json: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function maybeOfferStarterTemplateUpdate(cortexPath: string) {
  const current = currentPackageVersion();
  if (!current) return;
  const prefsPath = path.join(cortexPath, ".governance", "install-preferences.json");
  if (!fs.existsSync(prefsPath)) return;
  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8")) as { installedVersion?: string };
    if (isVersionNewer(current, prefs.installedVersion)) {
      log(`  Starter template update available: v${prefs.installedVersion} -> v${current}`);
      log(`  Run \`npx @alaarab/cortex init --apply-starter-update\` to refresh global/CLAUDE.md and global skills.`);
    }
  } catch (err: unknown) {
    debugLog(`checkStarterVersionUpdate: failed to read preferences: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function registerMachine(cortexPath: string): Promise<{ machine: string; profile: string }> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>(r => rl.question(q, r));

  log("This machine isn't registered with cortex yet.\n");
  const machine = (await ask("What should this machine be called? (e.g. work-desktop): ")).trim();
  if (!machine) { rl.close(); throw new Error("Machine name can't be empty."); }

  log("\nAvailable profiles:");
  for (const p of listProfiles(cortexPath)) log(`  ${p.name}  (${p.description})`);
  log("");

  const profile = (await ask("Which profile? ")).trim();
  rl.close();
  if (!profile) throw new Error("Profile name can't be empty.");
  if (!findProfileFile(cortexPath, profile)) throw new Error(`No profile named '${profile}' found.`);

  // Write machine file
  const machineFile = machineFilePath();
  fs.mkdirSync(path.dirname(machineFile), { recursive: true });
  fs.writeFileSync(machineFile, machine);

  // Append to machines.yaml
  const machinesFile = path.join(cortexPath, "machines.yaml");
  const existing = fs.existsSync(machinesFile) ? fs.readFileSync(machinesFile, "utf8") : "";
  fs.writeFileSync(machinesFile, existing.trimEnd() + `\n${machine}: ${profile}\n`);

  // Commit if in git repo
  try {
    execFileSync("git", ["add", "machines.yaml"], { cwd: cortexPath, stdio: "ignore", timeout: EXEC_TIMEOUT_MS });
    execFileSync("git", ["commit", "-m", `Register machine: ${machine} (${profile})`, "--allow-empty"], {
      cwd: cortexPath, stdio: "ignore", timeout: EXEC_TIMEOUT_MS,
    });
  } catch { /* best effort */ }

  log(`\nRegistered ${machine} with profile ${profile}.`);
  return { machine, profile };
}

function setupSparseCheckout(cortexPath: string, projects: string[]) {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: cortexPath, stdio: "ignore", timeout: EXEC_TIMEOUT_QUICK_MS });
  } catch { return; } // Not a git repo

  const alwaysInclude = ["profiles", "machines.yaml", "global", "scripts", "link.sh", "README.md", ".gitignore"];
  const paths = [...alwaysInclude, ...projects];
  try {
    execFileSync("git", ["sparse-checkout", "set", ...paths], { cwd: cortexPath, stdio: "ignore", timeout: EXEC_TIMEOUT_MS });
    execFileSync("git", ["pull", "--ff-only"], { cwd: cortexPath, stdio: "ignore", timeout: EXEC_TIMEOUT_MS });
  } catch (err: unknown) {
    debugLog(`setupSparseCheckout: git sparse-checkout or pull failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function symlinkFile(src: string, dest: string, managedRoot: string): boolean {
  try {
    const stat = fs.lstatSync(dest);
    if (stat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(dest);
      const resolvedTarget = path.resolve(path.dirname(dest), currentTarget);
      const managedPrefix = path.resolve(managedRoot) + path.sep;
      if (resolvedTarget === path.resolve(src)) return true;
      if (!resolvedTarget.startsWith(managedPrefix)) {
        log(`  preserve existing symlink: ${dest}`);
        return false;
      }
      fs.unlinkSync(dest);
    } else {
      try {
        if (stat.isFile() && fs.readFileSync(dest, "utf8") === fs.readFileSync(src, "utf8")) {
          fs.unlinkSync(dest);
        } else {
          const kind = stat.isDirectory() ? "directory" : "file";
          log(`  preserve existing ${kind}: ${dest}`);
          return false;
        }
      } catch {
        log(`  preserve existing file: ${dest}`);
        return false;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  fs.symlinkSync(src, dest);
  return true;
}

// ── SKILL.md ──────────────────────────────────────────────────────────────────

function getPackageVersion(): string {
  try {
    const pkgPath = path.join(ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version || "1.0.0";
  } catch (err: unknown) {
    debugLog(`getPackageVersion: failed to read package.json: ${err instanceof Error ? err.message : String(err)}`);
    return "1.0.0";
  }
}

function writeSkillMd(cortexPath: string) {
  const lifecycle = buildLifecycleCommands(cortexPath);
  const sessionStartCmd = lifecycle.sessionStart.replace(/"/g, '\\"');
  const promptCmd = lifecycle.userPromptSubmit.replace(/"/g, '\\"');
  const stopCmd = lifecycle.stop.replace(/"/g, '\\"');
  const version = getPackageVersion();

  const content = `---
name: cortex
description: Long-term memory for your AI agents with automatic context injection and finding capture
version: "${version}"
license: MIT
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${sessionStartCmd}"
  UserPromptSubmit:
    - hooks:
        - type: command
          command: "${promptCmd}"
          timeout: 3
  Stop:
    - hooks:
        - type: command
          command: "${stopCmd}"
---

# cortex

Long-term memory for your AI agents. Injects relevant project context at the start of
each prompt and saves findings at session end via git. Works with Claude Code, Copilot CLI,
Cursor, Codex, and more.

## Lifecycle hooks

- **SessionStart**: pulls latest cortex data and self-heals hook/symlink drift
- **UserPromptSubmit**: searches cortex, injects matching context with trust filtering and token budgeting
- **Stop**: commits and pushes any cortex changes to remote

## MCP tools (18)

**Search and browse:**
- \`search_cortex\`: FTS5 search with synonym expansion across all project knowledge
- \`get_project_summary\`: project summary card and available docs
- \`list_projects\`: all projects in the active profile
- \`get_findings\`: read recent findings without a search query

**Backlog management:**
- \`get_backlog\`: read tasks for one or all projects, or fetch a single item by ID or text
- \`add_backlog_item\`: add a task to the Queue section
- \`complete_backlog_item\`: match by text, move to Done
- \`update_backlog_item\`: change priority, context, or section

**Learning capture:**
- \`add_finding\`: append insight under today's date with optional citation metadata
- \`remove_finding\`: remove a finding by matching text
- \`push_changes\`: commit and push all cortex changes
- \`pin_memory\`: promote important memory into CANONICAL_MEMORIES.md
- \`memory_feedback\`: record helpful/reprompt/regression outcomes

**Data management:**
- \`export_project\`: export project data as portable JSON for sharing or backup
- \`import_project\`: import project from previously exported JSON
- \`manage_project(project, action: "archive"|"unarchive")\`: archive or restore a project
`;

  const dest = path.join(cortexPath, "cortex.SKILL.md");
  fs.writeFileSync(dest, content);
}

// ── Skill manifest reading (#297) ───────────────────────────────────────────

export interface ManifestHooks {
  SessionStart?: string;
  UserPromptSubmit?: string;
  Stop?: string;
}

export function readSkillManifestHooks(cortexPath: string): ManifestHooks | null {
  const manifestPath = path.join(cortexPath, "cortex.SKILL.md");
  if (!fs.existsSync(manifestPath)) return null;

  const content = fs.readFileSync(manifestPath, "utf8");
  const { frontmatter } = parseSkillFrontmatter(content);
  if (!frontmatter || typeof frontmatter.hooks !== "object" || !frontmatter.hooks) return null;

  const hooks = frontmatter.hooks as Record<string, unknown>;
  const result: ManifestHooks = {};

  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value) || !value[0]) continue;
    const entry = value[0] as Record<string, unknown>;
    const hooksList = entry.hooks as unknown[];
    if (!Array.isArray(hooksList) || !hooksList[0]) continue;
    const hookDef = hooksList[0] as Record<string, unknown>;
    if (typeof hookDef.command === "string") {
      (result as Record<string, string>)[event] = hookDef.command;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ── Skill frontmatter validation (#294, #298) ──────────────────────────────

export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  license?: string;
  dependencies?: string[];
  hooks?: Record<string, unknown>;
}

export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  frontmatter?: SkillFrontmatter;
}

const REQUIRED_SKILL_FIELDS = ["name", "description"] as const;

export function parseSkillFrontmatter(content: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content };
  try {
    const parsed = yaml.load(match[1]) as Record<string, unknown>;
    return { frontmatter: parsed && typeof parsed === "object" ? parsed : null, body: match[2] };
  } catch (err: unknown) {
    debugLog(`parseSkillFrontmatter: malformed YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`);
    return { frontmatter: null, body: content };
  }
}

export function validateSkillFrontmatter(content: string, filePath?: string): SkillValidationResult {
  const { frontmatter } = parseSkillFrontmatter(content);
  const prefix = filePath ? `${filePath}: ` : "";
  if (!frontmatter) return { valid: false, errors: [`${prefix}missing or invalid YAML frontmatter`] };

  const errors: string[] = [];
  for (const field of REQUIRED_SKILL_FIELDS) {
    if (typeof frontmatter[field] !== "string" || !frontmatter[field]) {
      errors.push(`${prefix}missing required field "${field}"`);
    }
  }

  if (frontmatter.dependencies !== undefined) {
    if (!Array.isArray(frontmatter.dependencies)) {
      errors.push(`${prefix}"dependencies" must be an array`);
    } else if (frontmatter.dependencies.some((d: unknown) => typeof d !== "string")) {
      errors.push(`${prefix}"dependencies" entries must be strings`);
    }
  }

  if (frontmatter.hooks !== undefined && (typeof frontmatter.hooks !== "object" || frontmatter.hooks === null)) {
    errors.push(`${prefix}"hooks" must be an object`);
  }

  if (frontmatter.version !== undefined && typeof frontmatter.version !== "string") {
    errors.push(`${prefix}"version" must be a string`);
  }

  return {
    valid: errors.length === 0,
    errors,
    frontmatter: errors.length === 0 ? frontmatter as unknown as SkillFrontmatter : undefined,
  };
}

export function validateSkillsDir(skillsDir: string): SkillValidationResult[] {
  if (!fs.existsSync(skillsDir)) return [];
  const results: SkillValidationResult[] = [];
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      const skillFile = path.join(entryPath, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        results.push(validateSkillFrontmatter(fs.readFileSync(skillFile, "utf8"), skillFile));
      }
    } else if (stat.isFile() && entry.endsWith(".md")) {
      results.push(validateSkillFrontmatter(fs.readFileSync(entryPath, "utf8"), entryPath));
    }
  }
  return results;
}

export function migrateSkillsToFolders(skillsDir: string): string[] {
  if (!fs.existsSync(skillsDir)) return [];
  const migrated: string[] = [];
  for (const entry of fs.readdirSync(skillsDir)) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(skillsDir, entry);
    if (!fs.statSync(filePath).isFile()) continue;
    const name = entry.replace(/\.md$/, "");
    const folderPath = path.join(skillsDir, name);
    if (fs.existsSync(folderPath)) continue;
    fs.mkdirSync(folderPath, { recursive: true });
    fs.renameSync(filePath, path.join(folderPath, "SKILL.md"));
    migrated.push(name);
  }
  return migrated;
}

function linkSkillsDir(srcDir: string, destDir: string, managedRoot: string) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });

  for (const entry of fs.readdirSync(srcDir)) {
    const srcPath = path.join(srcDir, entry);
    const stat = fs.statSync(srcPath);

    if (stat.isFile() && entry.endsWith(".md")) {
      // Flat skill file: link directly
      symlinkFile(srcPath, path.join(destDir, entry), managedRoot);
    } else if (stat.isDirectory()) {
      // Subfolder format: look for SKILL.md inside
      const skillFile = path.join(srcPath, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        symlinkFile(skillFile, path.join(destDir, `${entry}.md`), managedRoot);
      }
    }
  }
}

function linkGlobal(cortexPath: string, tools: Set<string>) {
  log("  global skills -> ~/.claude/skills/");
  const skillsDir = path.join(os.homedir(), ".claude", "skills");
  linkSkillsDir(path.join(cortexPath, "global", "skills"), skillsDir, cortexPath);

  const globalClaude = path.join(cortexPath, "global", "CLAUDE.md");
  if (fs.existsSync(globalClaude)) {
    symlinkFile(globalClaude, path.join(os.homedir(), ".claude", "CLAUDE.md"), cortexPath);
    if (tools.has("copilot")) {
      try {
        const copilotInstrDir = path.join(os.homedir(), ".github");
        fs.mkdirSync(copilotInstrDir, { recursive: true });
        symlinkFile(globalClaude, path.join(copilotInstrDir, "copilot-instructions.md"), cortexPath);
      } catch { /* best effort */ }
    }
  }
}

function addTokenAnnotation(filePath: string) {
  const content = fs.readFileSync(filePath, "utf8");
  if (content.startsWith("<!-- tokens:")) return;
  const tokens = Math.round(content.length / 4);
  if (tokens <= 500) return;
  const rounded = Math.round((tokens + 50) / 100) * 100;
  fs.writeFileSync(filePath, `<!-- tokens: ~${rounded} -->\n${content}`);
}

function linkProject(cortexPath: string, project: string, tools: Set<string>) {
  const target = findProjectDir(project);
  if (!target) { log(`  skip ${project} (not found on disk)`); return; }
  log(`  ${project} -> ${target}`);

  for (const f of ["CLAUDE.md", "REFERENCE.md", "FINDINGS.md"]) {
    const src = path.join(cortexPath, project, f);
    if (fs.existsSync(src)) {
      symlinkFile(src, path.join(target, f), cortexPath);
      if (f === "CLAUDE.md") {
        if (tools.has("codex")) {
          try { symlinkFile(src, path.join(target, "AGENTS.md"), cortexPath); } catch { /* best effort */ }
        }
        if (tools.has("copilot")) {
          try {
            const copilotDir = path.join(target, ".github");
            fs.mkdirSync(copilotDir, { recursive: true });
            symlinkFile(src, path.join(copilotDir, "copilot-instructions.md"), cortexPath);
          } catch { /* best effort */ }
        }
      }
    }
  }

  // CLAUDE-*.md split files
  const projectDir = path.join(cortexPath, project);
  if (fs.existsSync(projectDir)) {
    for (const f of fs.readdirSync(projectDir)) {
      if (/^CLAUDE-.+\.md$/.test(f)) symlinkFile(path.join(projectDir, f), path.join(target, f), cortexPath);
    }
  }

  // Token annotation on CLAUDE.md
  const claudeFile = path.join(cortexPath, project, "CLAUDE.md");
  if (fs.existsSync(claudeFile)) {
    try { addTokenAnnotation(claudeFile); } catch { /* best effort */ }
  }

  // Project-level skills (supports both flat .md and subfolder/SKILL.md)
  const projectSkills = path.join(cortexPath, project, ".claude", "skills");
  if (fs.existsSync(projectSkills)) {
    const targetSkills = path.join(target, ".claude", "skills");
    linkSkillsDir(projectSkills, targetSkills, cortexPath);
  }
}

function writeContextFile(managedContent: string) {
  const wrapped = `<!-- cortex-managed -->\n${managedContent}\n<!-- /cortex-managed -->`;
  if (fs.existsSync(CONTEXT_FILE)) {
    const existing = fs.readFileSync(CONTEXT_FILE, "utf8");
    if (existing.includes("<!-- cortex-managed -->")) {
      const startIdx = existing.indexOf("<!-- cortex-managed -->");
      const endIdx = existing.indexOf("<!-- /cortex-managed -->");
      const before = startIdx > 0 ? existing.slice(0, startIdx).trimEnd() : "";
      const after = endIdx !== -1 ? existing.slice(endIdx + "<!-- /cortex-managed -->".length).trimStart() : "";
      const parts = [before, wrapped, after].filter(Boolean);
      fs.writeFileSync(CONTEXT_FILE, parts.join("\n") + "\n");
      return;
    }
  }
  fs.writeFileSync(CONTEXT_FILE, wrapped + "\n");
}

function formatMcpStatus(status: string): string {
  if (status === "installed" || status === "already_configured") {
    return "MCP: active (search_cortex, get_project_summary, list_projects)";
  }
  if (status === "disabled" || status === "already_disabled") {
    return "MCP: disabled (hooks-only fallback active)";
  }
  if (status === "not_built") return "MCP: not built. Run: cd mcp && npm install && npm run build";
  return "";
}

function writeContextDefault(machine: string, profile: string, mcpStatus: string, projects: string[], cortexPath: string) {
  const all = allKnownProjects(cortexPath);
  const inactive = all.filter(p => !projects.includes(p));
  const mcpLine = formatMcpStatus(mcpStatus);
  const lines = [
    "# cortex context",
    `Machine: ${machine}`,
    `Profile: ${profile}`,
    `Active projects: ${projects.join(", ")}`,
    `Not on this machine: ${inactive.length ? inactive.join(", ") : "none"}`,
    ...(mcpLine ? [mcpLine] : []),
    `Last synced: ${new Date().toISOString().slice(0, 10)}`,
  ];
  writeContextFile(lines.join("\n"));
  log(`  wrote ${CONTEXT_FILE}`);
}

function writeContextDebugging(machine: string, profile: string, mcpStatus: string, projects: string[], cortexPath: string) {
  const mcpLine = formatMcpStatus(mcpStatus);
  let content = [
    "# cortex context (debugging)",
    `Machine: ${machine}`,
    `Profile: ${profile}`,
    `Last synced: ${new Date().toISOString().slice(0, 10)}`,
    ...(mcpLine ? [mcpLine] : []),
  ].join("\n") + "\n\n## Project Findings\n";

  const MAX_FILE_BYTES = 50 * 1024;
  for (const project of projects) {
    if (project === "global") continue;
    const findings = path.join(cortexPath, project, "FINDINGS.md");
    if (fs.existsSync(findings)) {
      let body = fs.readFileSync(findings, "utf8");
      if (body.length > MAX_FILE_BYTES) {
        // Keep only the most recent entries (end of file)
        body = body.slice(-MAX_FILE_BYTES);
        const firstNewline = body.indexOf("\n");
        if (firstNewline !== -1) body = body.slice(firstNewline + 1);
        body = `(truncated to most recent entries)\n${body}`;
      }
      content += `\n### ${project}\n${body}\n`;
    }
  }
  writeContextFile(content);
  log(`  wrote ${CONTEXT_FILE} (debugging mode)`);
}

function writeContextPlanning(machine: string, profile: string, mcpStatus: string, projects: string[], cortexPath: string) {
  const mcpLine = formatMcpStatus(mcpStatus);
  let content = [
    "# cortex context (planning)",
    `Machine: ${machine}`,
    `Profile: ${profile}`,
    `Last synced: ${new Date().toISOString().slice(0, 10)}`,
    ...(mcpLine ? [mcpLine] : []),
  ].join("\n");

  const MAX_CONTEXT_BYTES = 100 * 1024;
  for (const project of projects) {
    if (project === "global") continue;
    if (content.length >= MAX_CONTEXT_BYTES) {
      content += `\n\n(remaining projects truncated, context size limit reached)\n`;
      break;
    }
    const summaryFile = path.join(cortexPath, project, "summary.md");
    const backlogFile = path.join(cortexPath, project, "backlog.md");
    if (!fs.existsSync(summaryFile) && !fs.existsSync(backlogFile)) continue;
    content += `\n\n## ${project}\n`;
    if (fs.existsSync(summaryFile)) content += fs.readFileSync(summaryFile, "utf8") + "\n";
    if (fs.existsSync(backlogFile)) {
      let backlog = fs.readFileSync(backlogFile, "utf8");
      const remaining = MAX_CONTEXT_BYTES - content.length;
      if (backlog.length > remaining && remaining > 0) {
        backlog = backlog.slice(0, remaining) + "\n(backlog truncated)\n";
      }
      content += `\n### Backlog\n${backlog}\n`;
    }
  }
  writeContextFile(content);
  log(`  wrote ${CONTEXT_FILE} (planning mode)`);
}

function writeContextClean(machine: string, profile: string, mcpStatus: string, projects: string[]) {
  const mcpLine = formatMcpStatus(mcpStatus);
  let content = `# cortex context (clean)\nMachine: ${machine} | Profile: ${profile} | Projects: ${projects.join(", ")}\n`;
  if (mcpLine) content += mcpLine + "\n";
  writeContextFile(content);
  log(`  wrote ${CONTEXT_FILE} (clean mode)`);
}

function readBackNativeMemory(cortexPath: string, projects: string[]) {
  const projectKey = claudeProjectKey();
  const memoryDir = path.join(homeDir(), ".claude", "projects", projectKey, "memory");
  if (!fs.existsSync(memoryDir)) return;

  for (const project of projects) {
    if (project === "global") continue;
    const nativeFile = path.join(memoryDir, `MEMORY-${project}.md`);
    if (!fs.existsSync(nativeFile)) continue;

    const content = fs.readFileSync(nativeFile, "utf8");
    const notesMatch = content.match(/^## Notes\n([\s\S]*)$/m);
    if (!notesMatch) continue;

    const notes = notesMatch[1]
      .replace(/<!-- Session findings, patterns, decisions -->\n?/, "")
      .trim();
    if (!notes) continue;

    const targetFile = path.join(cortexPath, project, "native-notes.md");
    const existing = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, "utf8").trim() : "";
    if (existing === notes) continue;

    fs.mkdirSync(path.join(cortexPath, project), { recursive: true });
    fs.writeFileSync(targetFile, notes + "\n");
    log(`  synced native memory notes for ${project}`);
  }
}

function rebuildMemory(cortexPath: string, projects: string[]) {
  // Claude Code uses CWD with path separators replaced by dashes as the project key.
  // The root memory lives under the home directory's project key.
  const projectKey = claudeProjectKey();
  const memoryDir = path.join(homeDir(), ".claude", "projects", projectKey, "memory");
  const memoryFile = path.join(memoryDir, "MEMORY.md");

  const hasSummaries = projects.some(p =>
    p !== "global" && fs.existsSync(path.join(cortexPath, p, "summary.md"))
  );
  if (!hasSummaries) return;

  fs.mkdirSync(memoryDir, { recursive: true });

  let header = "";
  if (fs.existsSync(memoryFile)) {
    const existing = fs.readFileSync(memoryFile, "utf8");
    const idx = existing.indexOf("<!-- cortex:projects:start -->");
    if (idx !== -1) header = existing.slice(0, idx);
  }

  let managed = "<!-- cortex:projects:start -->\n<!-- Auto-generated by cortex link. Do not edit below this line. -->\n\n## Active Projects\n\n| Project | What | Memory |\n|---------|------|--------|\n";
  for (const project of projects) {
    if (project === "global") continue;
    const summaryFile = path.join(cortexPath, project, "summary.md");
    if (!fs.existsSync(summaryFile)) continue;
    const summary = fs.readFileSync(summaryFile, "utf8");
    const whatMatch = summary.match(/^\*\*What:\*\*\s*(.+)/m);
    const what = whatMatch?.[1]?.trim() ?? "(see summary)";
    managed += `| ${displayName(project)} | ${what} | MEMORY-${project}.md |\n`;
  }
  managed += "\n<!-- cortex:projects:end -->";

  const freshHeader = "# Root Memory\n\n## Machine Context\nRead `~/.cortex-context.md` for profile, active projects, last sync date.\n\n## Cross-Project Notes\n- Read a project's CLAUDE.md before making changes.\n- Per-project memory files (MEMORY-{name}.md) have commands, versions, findings.\n\n";
  fs.writeFileSync(memoryFile, (header || freshHeader) + managed + "\n");
  log(`  rebuilt ${memoryFile} (pointer format)`);

  for (const project of projects) {
    if (project === "global") continue;
    const summaryFile = path.join(cortexPath, project, "summary.md");
    if (!fs.existsSync(summaryFile)) continue;
    const projectMemory = path.join(memoryDir, `MEMORY-${project}.md`);
    if (!fs.existsSync(projectMemory)) {
      fs.writeFileSync(projectMemory, `# ${displayName(project)}\n\n${fs.readFileSync(summaryFile, "utf8")}\n\n## Notes\n<!-- Session findings, patterns, decisions -->\n`);
      log(`  created ${projectMemory}`);
    }
  }
}

export interface LinkOptions {
  machine?: string;
  profile?: string;
  register?: boolean;
  task?: "debugging" | "planning" | "clean";
  allTools?: boolean;   // configure hooks for all tools regardless of detection
  mcp?: McpMode;
}

export interface DoctorResult {
  ok: boolean;
  machine?: string;
  profile?: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export async function runLink(cortexPath: string, opts: LinkOptions = {}) {
  log("cortex link\n");
  ensureGovernanceFiles(cortexPath);

  // Step 1: Identify machine + profile
  let machine = opts.machine ?? getMachineName();
  let profile = "";

  if (opts.profile) {
    profile = opts.profile;
  } else if (opts.register) {
    const reg = await registerMachine(cortexPath);
    machine = reg.machine;
    profile = reg.profile;
  } else {
    profile = lookupProfile(cortexPath, machine);
    if (!profile) {
      const reg = await registerMachine(cortexPath);
      machine = reg.machine;
      profile = reg.profile;
    }
  }

  if (!profile) throw new Error(`Could not determine profile for machine '${machine}'.`);

  // Step 2: Find profile file
  const profileFile = findProfileFile(cortexPath, profile);
  if (!profileFile) throw new Error(`Profile '${profile}' not found in profiles/.`);

  log(`Machine: ${machine}`);
  log(`Profile: ${profile} (${profileFile})\n`);

  // Step 3: Read projects
  const projects = getProfileProjects(profileFile);
  if (!projects.length) throw new Error(`Profile '${profile}' has no projects listed.`);

  // Step 4: Sparse checkout
  log("Setting up sparse checkout...");
  setupSparseCheckout(cortexPath, projects);
  log("");

  // Detect installed tools once — used for symlinks and hook registration
  const detectedTools = opts.allTools
    ? new Set(["copilot", "cursor", "codex"])
    : detectInstalledTools();

  // Step 5: Symlink
  log("Linking...");
  linkGlobal(cortexPath, detectedTools);
  for (const p of projects) {
    if (p !== "global") linkProject(cortexPath, p, detectedTools);
  }
  log("");

  // Step 6: Configure MCP
  log("Configuring MCP...");
  const mcpEnabled = opts.mcp ? opts.mcp === "on" : getMcpEnabledPreference(cortexPath);
  const hooksEnabled = getHooksEnabledPreference(cortexPath);
  setMcpEnabledPreference(cortexPath, mcpEnabled);
  log(`  MCP mode: ${mcpEnabled ? "ON (recommended)" : "OFF (hooks-only fallback)"}`);
  log(`  Hooks mode: ${hooksEnabled ? "ON (active)" : "OFF (disabled)"}`);
  maybeOfferStarterTemplateUpdate(cortexPath);
  let mcpStatus = "no_settings";
  try { mcpStatus = configureClaude(cortexPath, { mcpEnabled, hooksEnabled }) ?? "installed"; } catch { /* best effort */ }
  logMcpTargetStatus("Claude", mcpStatus);

  let vsStatus = "no_vscode";
  try { vsStatus = configureVSCode(cortexPath, { mcpEnabled }) ?? "no_vscode"; } catch { /* best effort */ }
  logMcpTargetStatus("VS Code", vsStatus);

  let cursorStatus = "no_cursor";
  try { cursorStatus = configureCursorMcp(cortexPath, { mcpEnabled }) ?? "no_cursor"; } catch { /* best effort */ }
  logMcpTargetStatus("Cursor", cursorStatus);

  let copilotStatus = "no_copilot";
  try { copilotStatus = configureCopilotMcp(cortexPath, { mcpEnabled }) ?? "no_copilot"; } catch { /* best effort */ }
  logMcpTargetStatus("Copilot CLI", copilotStatus);

  let codexStatus = "no_codex";
  try { codexStatus = configureCodexMcp(cortexPath, { mcpEnabled }) ?? "no_codex"; } catch { /* best effort */ }
  logMcpTargetStatus("Codex", codexStatus);
  const mcpStatusForContext = [mcpStatus, vsStatus, cursorStatus, copilotStatus, codexStatus].some(
    (s) => s === "installed" || s === "already_configured"
  )
    ? "installed"
    : [mcpStatus, vsStatus, cursorStatus, copilotStatus, codexStatus].some(
      (s) => s === "disabled" || s === "already_disabled"
    )
      ? "disabled"
      : mcpStatus;

  // Register hooks for Copilot CLI, Cursor, Codex (reuse same detected set)
  if (hooksEnabled) {
    const hookedTools = configureAllHooks(cortexPath, { tools: detectedTools });
    if (hookedTools.length) log(`  Hooks registered: ${hookedTools.join(", ")}`);
  } else {
    log(`  Hooks registration skipped (hooks-mode is off)`);
  }

  // Write cortex.SKILL.md for agentskills-compatible tools
  try {
    writeSkillMd(cortexPath);
    log(`  cortex.SKILL.md written (agentskills-compatible tools)`);
  } catch { /* best effort */ }
  log("");

  // Step 7: Context file
  if (opts.task === "debugging") {
    writeContextDebugging(machine, profile, mcpStatusForContext, projects, cortexPath);
  } else if (opts.task === "planning") {
    writeContextPlanning(machine, profile, mcpStatusForContext, projects, cortexPath);
  } else if (opts.task === "clean") {
    writeContextClean(machine, profile, mcpStatusForContext, projects);
  } else {
    writeContextDefault(machine, profile, mcpStatusForContext, projects, cortexPath);
  }

  // Step 8: Memory (read back native changes, then rebuild)
  readBackNativeMemory(cortexPath, projects);
  rebuildMemory(cortexPath, projects);

  log(`\nDone. Profile '${profile}' is active.`);
  if (opts.task) log(`Task mode: ${opts.task}`);
}

function isWrapperActive(tool: string): boolean {
  const wrapperPath = path.join(os.homedir(), ".local", "bin", tool);
  if (!fs.existsSync(wrapperPath)) return false;
  try {
    const resolved = execFileSync("which", [tool], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    }).trim();
    return path.resolve(resolved) === path.resolve(wrapperPath);
  } catch (err: unknown) {
    debugLog(`isWrapperActive: which ${tool} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── File checksum helpers ────────────────────────────────────────────────────

function fileChecksum(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

interface ChecksumStore {
  [relativePath: string]: { sha256: string; updatedAt: string };
}

function checksumStorePath(cortexPath: string): string {
  return path.join(cortexPath, ".governance", "file-checksums.json");
}

function loadChecksums(cortexPath: string): ChecksumStore {
  const file = checksumStorePath(cortexPath);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function saveChecksums(cortexPath: string, store: ChecksumStore): void {
  const file = checksumStorePath(cortexPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2) + "\n");
}

export function updateFileChecksums(cortexPath: string, profileName?: string): { updated: number; files: string[] } {
  const store = loadChecksums(cortexPath);
  const now = new Date().toISOString();
  const tracked: string[] = [];
  const dirs = getProjectDirs(cortexPath, profileName);
  for (const dir of dirs) {
    for (const name of ["FINDINGS.md", "backlog.md", "CANONICAL.md"]) {
      const full = path.join(dir, name);
      if (!fs.existsSync(full)) continue;
      // Normalize to forward slashes for consistent keys across platforms
      const rel = path.relative(cortexPath, full).replace(/\\/g, "/");
      store[rel] = { sha256: fileChecksum(full), updatedAt: now };
      tracked.push(rel);
    }
  }
  saveChecksums(cortexPath, store);
  return { updated: tracked.length, files: tracked };
}

export function verifyFileChecksums(cortexPath: string): Array<{ file: string; status: "ok" | "mismatch" | "missing" }> {
  const store = loadChecksums(cortexPath);
  const results: Array<{ file: string; status: "ok" | "mismatch" | "missing" }> = [];
  for (const [rel, entry] of Object.entries(store)) {
    const full = path.join(cortexPath, rel);
    if (!fs.existsSync(full)) {
      results.push({ file: rel, status: "missing" });
      continue;
    }
    const current = fileChecksum(full);
    results.push({ file: rel, status: current === entry.sha256 ? "ok" : "mismatch" });
  }
  return results;
}

export async function runDoctor(cortexPath: string, fix: boolean = false, checkData: boolean = false): Promise<DoctorResult> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const machine = getMachineName();
  const profile = lookupProfile(cortexPath, machine);

  checks.push({
    name: "machine-registered",
    ok: Boolean(profile),
    detail: profile
      ? `machine=${machine} profile=${profile}`
      : `no profile mapping for machine=${machine} in machines.yaml`,
  });

  const profileFile = profile ? findProfileFile(cortexPath, profile) : null;
  checks.push({
    name: "profile-exists",
    ok: Boolean(profileFile),
    detail: profileFile ? `profile file found: ${profileFile}` : "profile file missing",
  });

  const projects = profileFile ? getProfileProjects(profileFile) : [];
  checks.push({
    name: "profile-projects",
    ok: projects.length > 0,
    detail: projects.length ? `${projects.length} projects in profile` : "no projects listed",
  });

  // Filesystem speed check: write + read a small temp file
  const fsBenchFile = path.join(cortexPath, ".fs-bench-tmp");
  let fsMs = 0;
  try {
    const t0 = Date.now();
    fs.writeFileSync(fsBenchFile, "cortex-fs-check");
    fs.readFileSync(fsBenchFile, "utf8");
    fs.unlinkSync(fsBenchFile);
    fsMs = Date.now() - t0;
  } catch {
    fsMs = -1;
    try { fs.unlinkSync(fsBenchFile); } catch { /* ignore */ }
  }
  const fsSlow = fsMs > 500 || fsMs < 0;
  checks.push({
    name: "filesystem-speed",
    ok: !fsSlow,
    detail: fsMs < 0
      ? "could not benchmark filesystem, check ~/.cortex permissions"
      : `write+read+delete in ${fsMs}ms${fsSlow ? " (slow, check if ~/.cortex is on a network mount)" : ""}`,
  });

  const contextFile = path.join(os.homedir(), ".cortex-context.md");
  checks.push({
    name: "context-file",
    ok: fs.existsSync(contextFile),
    detail: fs.existsSync(contextFile) ? contextFile : "missing ~/.cortex-context.md",
  });

  const memoryFile = path.join(
    os.homedir(),
    ".claude",
    "projects",
    `-home-${safeUsername()}`,
    "memory",
    "MEMORY.md"
  );
  checks.push({
    name: "root-memory",
    ok: fs.existsSync(memoryFile),
    detail: fs.existsSync(memoryFile) ? memoryFile : "missing generated MEMORY.md",
  });

  const globalClaudeSrc = path.join(cortexPath, "global", "CLAUDE.md");
  const globalClaudeDest = path.join(os.homedir(), ".claude", "CLAUDE.md");
  let globalLinkOk = false;
  try {
    globalLinkOk = fs.existsSync(globalClaudeDest) && fs.realpathSync(globalClaudeDest) === fs.realpathSync(globalClaudeSrc);
  } catch (err: unknown) {
    debugLog(`doctor: global CLAUDE.md symlink check failed: ${err instanceof Error ? err.message : String(err)}`);
    globalLinkOk = false;
  }
  checks.push({
    name: "global-link",
    ok: globalLinkOk,
    detail: globalLinkOk ? "global CLAUDE.md symlink ok" : "global CLAUDE.md link drifted/missing",
  });

  for (const project of projects) {
    if (project === "global") continue;
    const target = findProjectDir(project);
    if (!target) {
      checks.push({ name: `project-path:${project}`, ok: false, detail: "project directory not found on disk" });
      continue;
    }
    for (const f of ["CLAUDE.md", "REFERENCE.md", "FINDINGS.md"]) {
      const src = path.join(cortexPath, project, f);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(target, f);
      let ok = false;
      try {
        ok = fs.existsSync(dest) && fs.realpathSync(dest) === fs.realpathSync(src);
      } catch (err: unknown) {
        debugLog(`doctor: symlink check failed for ${dest}: ${err instanceof Error ? err.message : String(err)}`);
        ok = false;
      }
      checks.push({
        name: `symlink:${project}/${f}`,
        ok,
        detail: ok ? "ok" : `missing/drifted link at ${dest}`,
      });
    }
  }

  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  let hookOk = false;
  let lifecycleOk = false;
  try {
    const cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const hooks = cfg?.hooks || {};
    const promptHooks = JSON.stringify(hooks.UserPromptSubmit || []);
    const stopHooks = JSON.stringify(hooks.Stop || []);
    const startHooks = JSON.stringify(hooks.SessionStart || []);
    hookOk = promptHooks.includes("hook-prompt");
    const stopHookOk = stopHooks.includes("hook-stop") || stopHooks.includes("auto-save");
    const startHookOk = startHooks.includes("hook-session-start") || startHooks.includes("doctor --fix");
    lifecycleOk = stopHookOk && startHookOk;
  } catch (err: unknown) {
    debugLog(`doctor: failed to read Claude settings for hook check: ${err instanceof Error ? err.message : String(err)}`);
    hookOk = false;
    lifecycleOk = false;
  }
  checks.push({
    name: "claude-hooks",
    ok: hookOk,
    detail: hookOk ? "prompt hook configured" : "missing prompt hook in ~/.claude/settings.json",
  });
  checks.push({
    name: "lifecycle-hooks",
    ok: lifecycleOk,
    detail: lifecycleOk
      ? "session-start + stop lifecycle hooks configured"
      : "missing lifecycle hooks (expected hook-session-start and hook-stop)",
  });

  const runtimeHealthPath = path.join(cortexPath, ".governance", "runtime-health.json");
  let runtime: Record<string, unknown> | null = null;
  if (fs.existsSync(runtimeHealthPath)) {
    try { runtime = JSON.parse(fs.readFileSync(runtimeHealthPath, "utf8")); } catch { runtime = null; }
  }
  checks.push({
    name: "runtime-health-file",
    ok: Boolean(runtime),
    detail: runtime ? runtimeHealthPath : "missing or unreadable .governance/runtime-health.json",
  });
  const lastAutoSave = runtime?.["lastAutoSave"];
  const autoSaveObj = isRecord(lastAutoSave) ? lastAutoSave : null;
  const autoSaveStatus = typeof autoSaveObj?.["status"] === "string" ? autoSaveObj["status"] : undefined;
  const autoSaveAt = typeof autoSaveObj?.["at"] === "string" ? autoSaveObj["at"] : undefined;
  checks.push({
    name: "runtime-auto-save",
    ok: autoSaveStatus === "saved-pushed" || autoSaveStatus === "saved-local" || autoSaveStatus === "clean",
    detail: autoSaveStatus
      ? `last auto-save: ${autoSaveStatus}${autoSaveAt ? ` @ ${autoSaveAt}` : ""}`
      : "no auto-save runtime record yet",
  });
  checks.push({
    name: "runtime-prompt",
    ok: Boolean(runtime?.["lastPromptAt"]),
    detail: runtime?.["lastPromptAt"] ? `last prompt hook run @ ${runtime["lastPromptAt"]}` : "no prompt runtime record yet",
  });

  try {
    const db = await buildIndex(cortexPath, profile || undefined);
    const healthRow = queryRows(db, "SELECT count(*) FROM docs", []);
    const count = Number((healthRow?.[0]?.[0] as number | string | undefined) ?? 0);
    checks.push({
      name: "fts-index",
      ok: Number.isFinite(count) && count >= 0,
      detail: `index query ok (docs=${count})`,
    });
  } catch (err: unknown) {
    checks.push({
      name: "fts-index",
      ok: false,
      detail: `index build/query failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const detected = detectInstalledTools();
  if (detected.has("copilot")) {
    const copilotHooks = path.join(os.homedir(), ".github", "hooks", "cortex.json");
    checks.push({
      name: "copilot-hooks",
      ok: fs.existsSync(copilotHooks),
      detail: fs.existsSync(copilotHooks) ? "copilot hooks config present" : "missing ~/.github/hooks/cortex.json",
    });
  }
  if (detected.has("cursor")) {
    const cursorHooks = path.join(os.homedir(), ".cursor", "hooks.json");
    checks.push({
      name: "cursor-hooks",
      ok: fs.existsSync(cursorHooks),
      detail: fs.existsSync(cursorHooks) ? "cursor hooks config present" : "missing ~/.cursor/hooks.json",
    });
  }
  if (detected.has("codex")) {
    const codexHooks = path.join(cortexPath, "codex.json");
    checks.push({
      name: "codex-hooks",
      ok: fs.existsSync(codexHooks),
      detail: fs.existsSync(codexHooks) ? "codex hooks config present" : "missing codex.json in cortex root",
    });
  }
  for (const tool of ["copilot", "cursor", "codex"]) {
    if (!detected.has(tool)) continue;
    const active = isWrapperActive(tool);
    checks.push({
      name: `wrapper:${tool}`,
      ok: active,
      detail: active
        ? `${tool} wrapper active via ~/.local/bin/${tool}`
        : `${tool} wrapper missing or not first in PATH`,
    });
  }

  // Detect unmigrated LEARNINGS.md files and knowledge/ directories
  const projectDirs = fs.readdirSync(cortexPath).filter(d => !d.startsWith('.') && fs.statSync(path.join(cortexPath, d)).isDirectory());
  for (const proj of projectDirs) {
    const oldLearnings = path.join(cortexPath, proj, 'LEARNINGS.md');
    if (fs.existsSync(oldLearnings)) {
      checks.push({ name: `migrate:${proj}/LEARNINGS.md`, ok: false, detail: `${proj}/LEARNINGS.md → run --fix to migrate to FINDINGS.md` });
    }
    const oldKnowledge = path.join(cortexPath, proj, 'knowledge');
    if (fs.existsSync(oldKnowledge)) {
      checks.push({ name: `migrate:${proj}/knowledge`, ok: false, detail: `${proj}/knowledge/ → run --fix to migrate to reference/` });
    }
  }

  if (fix && profile && profileFile) {
    // Migrate LEARNINGS.md → FINDINGS.md
    for (const proj of projectDirs) {
      const oldFile = path.join(cortexPath, proj, 'LEARNINGS.md');
      const newFile = path.join(cortexPath, proj, 'FINDINGS.md');
      if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) {
        fs.renameSync(oldFile, newFile);
        console.log(`Migrated ${proj}/LEARNINGS.md → FINDINGS.md`);
      }
      // Migrate knowledge/ → reference/
      const oldDir = path.join(cortexPath, proj, 'knowledge');
      const newDir = path.join(cortexPath, proj, 'reference');
      if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
        fs.renameSync(oldDir, newDir);
        console.log(`Migrated ${proj}/knowledge/ → reference/`);
      }
    }
    // Migrate governance files
    const govDir = path.join(cortexPath, '.governance');
    if (fs.existsSync(govDir)) {
      const govRenames: [string, string][] = [
        ['memory-policy.json', 'retention-policy.json'],
        ['memory-workflow-policy.json', 'workflow-policy.json'],
      ];
      for (const [old, next] of govRenames) {
        const oldPath = path.join(govDir, old);
        const newPath = path.join(govDir, next);
        if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
          fs.renameSync(oldPath, newPath);
          console.log(`Migrated .governance/${old} → ${next}`);
        }
      }
    }

    await runLink(cortexPath, { machine, profile });
    checks.push({ name: "self-heal", ok: true, detail: "relinked hooks, symlinks, context, memory pointers" });
  } else if (fix) {
    checks.push({ name: "self-heal", ok: false, detail: "blocked: machine/profile not fully configured" });
  } else {
    // Read-only mode: just check if hook configs exist, don't write anything
    const detectedTools = detectInstalledTools();
    const hookChecks: string[] = [];
    const missing: string[] = [];
    for (const tool of detectedTools) {
      let configPath = "";
      if (tool === "copilot") configPath = path.join(os.homedir(), ".github", "hooks", "cortex.json");
      else if (tool === "cursor") configPath = path.join(os.homedir(), ".cursor", "hooks.json");
      else if (tool === "codex") configPath = path.join(cortexPath, "codex.json");
      if (configPath && fs.existsSync(configPath)) hookChecks.push(tool);
      else if (configPath) missing.push(tool);
    }
    checks.push({
      name: "hooks",
      ok: missing.length === 0,
      detail: hookChecks.length
        ? `hook configs present for: ${hookChecks.join(", ")}${missing.length ? `; missing: ${missing.join(", ")}` : ""}`
        : detectedTools.size === 0
          ? "no external tools detected"
          : `missing hook configs for: ${missing.join(", ")}`,
    });
  }

  if (checkData) {
    const governanceChecks: Array<{ file: string; schema: "access-control" | "retention-policy" | "workflow-policy" | "index-policy" | "runtime-health" | "memory-scores" | "canonical-locks" }> = [
      { file: "access-control.json", schema: "access-control" },
      { file: "retention-policy.json", schema: "retention-policy" },
      { file: "workflow-policy.json", schema: "workflow-policy" },
      { file: "index-policy.json", schema: "index-policy" },
      { file: "runtime-health.json", schema: "runtime-health" },
      { file: "memory-scores.json", schema: "memory-scores" },
      { file: "canonical-locks.json", schema: "canonical-locks" },
    ];

    for (const item of governanceChecks) {
      const filePath = path.join(cortexPath, ".governance", item.file);
      const exists = fs.existsSync(filePath);
      const valid = exists ? validateGovernanceJson(filePath, item.schema) : false;
      checks.push({
        name: `data:governance:${item.file}`,
        ok: exists && valid,
        detail: !exists ? "missing governance file" : valid ? "valid" : "invalid JSON/schema",
      });
    }

    for (const projectDir of getProjectDirs(cortexPath, profile)) {
      const projectName = path.basename(projectDir);
      if (projectName === "global") continue;

      const backlogPath = path.join(projectDir, "backlog.md");
      if (fs.existsSync(backlogPath)) {
        const content = fs.readFileSync(backlogPath, "utf8");
        const issues = validateBacklogFormat(content);
        checks.push({
          name: `data:backlog:${projectName}`,
          ok: issues.length === 0,
          detail: issues.length ? issues.join("; ") : "valid",
        });
      }

      const findingsPath = path.join(projectDir, "FINDINGS.md");
      if (fs.existsSync(findingsPath)) {
        const content = fs.readFileSync(findingsPath, "utf8");
        const issues = validateFindingsFormat(content);
        checks.push({
          name: `data:findings:${projectName}`,
          ok: issues.length === 0,
          detail: issues.length ? issues.join("; ") : "valid",
        });
      }
    }

    // Validate skill frontmatter in bundled skills
    const bundledSkills = path.join(cortexPath, "..", "skills");
    const skillResults = validateSkillsDir(fs.existsSync(bundledSkills) ? bundledSkills : path.join(cortexPath, "skills"));
    const invalidSkills = skillResults.filter(r => !r.valid);
    checks.push({
      name: "data:skills-frontmatter",
      ok: invalidSkills.length === 0,
      detail: invalidSkills.length
        ? `${invalidSkills.length} skill(s) with invalid frontmatter: ${invalidSkills.flatMap(r => r.errors).join("; ")}`
        : `${skillResults.length} skill(s) validated`,
    });

    // Validate cortex.SKILL.md manifest
    const manifestPath = path.join(cortexPath, "cortex.SKILL.md");
    if (fs.existsSync(manifestPath)) {
      const manifestResult = validateSkillFrontmatter(fs.readFileSync(manifestPath, "utf8"), manifestPath);
      checks.push({
        name: "data:skill-manifest",
        ok: manifestResult.valid,
        detail: manifestResult.valid ? "cortex.SKILL.md frontmatter valid" : manifestResult.errors.join("; "),
      });
    }

    // Verify file checksums
    const checksumResults = verifyFileChecksums(cortexPath);
    const mismatches = checksumResults.filter((r) => r.status === "mismatch");
    const missing = checksumResults.filter((r) => r.status === "missing");
    if (checksumResults.length > 0) {
      checks.push({
        name: "data:file-checksums",
        ok: mismatches.length === 0 && missing.length === 0,
        detail: mismatches.length || missing.length
          ? `${mismatches.length} mismatch(es), ${missing.length} missing`
          : `${checksumResults.length} file(s) verified`,
      });
    }

    if (fix) {
      updateFileChecksums(cortexPath, profile);
    }
  }

  const ok = checks.every((c) => c.ok);
  return { ok, machine, profile: profile || undefined, checks };
}
