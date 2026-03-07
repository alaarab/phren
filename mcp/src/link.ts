import * as fs from "fs";
import * as path from "path";
import * as os from "os";
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
import { configureAllHooks, detectInstalledTools } from "./hooks.js";
import {
  debugLog,
  EXEC_TIMEOUT_MS,
  EXEC_TIMEOUT_QUICK_MS,
  isRecord,
} from "./shared.js";
import { linkSkillsDir, writeSkillMd } from "./link-skills.js";
import {
  writeContextDefault,
  writeContextDebugging,
  writeContextPlanning,
  writeContextClean,
  readBackNativeMemory,
  rebuildMemory,
} from "./link-context.js";

// Re-export sub-modules so existing imports from "./link.js" continue to work
export { runDoctor } from "./link-doctor.js";
export { updateFileChecksums, verifyFileChecksums } from "./link-checksums.js";
export {
  parseSkillFrontmatter,
  validateSkillFrontmatter,
  validateSkillsDir,
  readSkillManifestHooks,
  migrateSkillsToFolders,
} from "./link-skills.js";
export type {
  ManifestHooks,
  SkillFrontmatter,
  SkillValidationResult,
} from "./link-skills.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface ProfileData {
  name?: string;
  description?: string;
  projects?: string[];
}

type MachinesConfig = Record<string, string>;

export interface LinkOptions {
  machine?: string;
  profile?: string;
  register?: boolean;
  task?: "debugging" | "planning" | "clean";
  allTools?: boolean;
  mcp?: McpMode;
}

export interface DoctorResult {
  ok: boolean;
  machine?: string;
  profile?: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

interface ProjectConfig {
  skills?: boolean;
  hooks?: {
    UserPromptSubmit?: boolean;
    Stop?: boolean;
    SessionStart?: boolean;
  };
}

// ── Helpers (exported for link-doctor) ──────────────────────────────────────

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

const LEGACY_MACHINE_FILE = path.join(os.homedir(), ".cortex-machine");
const CORTEX_MACHINE_FILE = path.join(os.homedir(), ".cortex", ".machine-id");

function machineFilePath(): string {
  if (fs.existsSync(LEGACY_MACHINE_FILE)) return LEGACY_MACHINE_FILE;
  if (fs.existsSync(CORTEX_MACHINE_FILE)) return CORTEX_MACHINE_FILE;
  if (process.platform === "win32") return CORTEX_MACHINE_FILE;
  return LEGACY_MACHINE_FILE;
}

const DEFAULT_SEARCH_PATHS = [
  os.homedir(),
  path.join(os.homedir(), "Sites"),
  path.join(os.homedir(), "Projects"),
  path.join(os.homedir(), "Code"),
  path.join(os.homedir(), "dev"),
];

function log(msg: string) { process.stdout.write(msg + "\n"); }

export function safeUsername(): string {
  try { return os.userInfo().username; } catch { return "unknown"; }
}

export function getMachineName(): string {
  const mf = machineFilePath();
  if (fs.existsSync(mf)) return fs.readFileSync(mf, "utf8").trim();
  if (process.env.WSL_DISTRO_NAME && process.env.COMPUTERNAME) {
    return process.env.COMPUTERNAME.toLowerCase();
  }
  return os.hostname();
}

export function lookupProfile(cortexPath: string, machine: string): string {
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

export function findProfileFile(cortexPath: string, profileName: string): string | null {
  const profilesDir = path.join(cortexPath, "profiles");
  if (!fs.existsSync(profilesDir)) return null;
  for (const f of fs.readdirSync(profilesDir)) {
    if (!f.endsWith(".yaml")) continue;
    const data = yaml.load(fs.readFileSync(path.join(profilesDir, f), "utf8"), { schema: yaml.CORE_SCHEMA }) as ProfileData | undefined;
    if (data?.name === profileName) return path.join(profilesDir, f);
  }
  return null;
}

export function getProfileProjects(profileFile: string): string[] {
  const data = yaml.load(fs.readFileSync(profileFile, "utf8"), { schema: yaml.CORE_SCHEMA }) as ProfileData | undefined;
  return Array.isArray(data?.projects) ? data.projects : [];
}

export function findProjectDir(name: string): string | null {
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

function readProjectConfig(cortexPath: string, project: string): ProjectConfig {
  const configPath = path.join(cortexPath, project, "cortex.project.yaml");
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, "utf8"), { schema: yaml.CORE_SCHEMA });
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ProjectConfig : {};
  } catch {
    return {};
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

// ── Machine registration ────────────────────────────────────────────────────

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

  const machineFile = machineFilePath();
  fs.mkdirSync(path.dirname(machineFile), { recursive: true });
  fs.writeFileSync(machineFile, machine);

  const machinesFile = path.join(cortexPath, "machines.yaml");
  const existing = fs.existsSync(machinesFile) ? fs.readFileSync(machinesFile, "utf8") : "";
  const yamlKey = machine.includes(":") || machine.includes('"') || machine.includes("'")
    ? `"${machine.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : machine;
  const yamlVal = profile.includes(":") || profile.includes('"') || profile.includes("'")
    ? `"${profile.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : profile;
  const alreadyRegistered = new RegExp(`^${yamlKey}\\s*:`, "m").test(existing);
  if (!alreadyRegistered) {
    fs.writeFileSync(machinesFile, existing.trimEnd() + `\n${yamlKey}: ${yamlVal}\n`);
  }

  try {
    execFileSync("git", ["add", "machines.yaml"], { cwd: cortexPath, stdio: "ignore", timeout: EXEC_TIMEOUT_MS });
    execFileSync("git", ["commit", "-m", `Register machine: ${machine} (${profile})`, "--allow-empty"], {
      cwd: cortexPath, stdio: "ignore", timeout: EXEC_TIMEOUT_MS,
    });
  } catch { /* best effort */ }

  log(`\nRegistered ${machine} with profile ${profile}.`);
  return { machine, profile };
}

// ── Sparse checkout ─────────────────────────────────────────────────────────

function setupSparseCheckout(cortexPath: string, projects: string[]) {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: cortexPath, stdio: "ignore", timeout: EXEC_TIMEOUT_QUICK_MS });
  } catch { return; }

  const alwaysInclude = ["profiles", "machines.yaml", "global", "scripts", "link.sh", "README.md", ".gitignore"];
  const paths = [...alwaysInclude, ...projects];
  try {
    execFileSync("git", ["sparse-checkout", "set", ...paths], { cwd: cortexPath, stdio: "ignore", timeout: EXEC_TIMEOUT_MS });
    execFileSync("git", ["pull", "--ff-only"], { cwd: cortexPath, stdio: "ignore", timeout: EXEC_TIMEOUT_MS });
  } catch (err: unknown) {
    debugLog(`setupSparseCheckout: git sparse-checkout or pull failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Symlink helpers ─────────────────────────────────────────────────────────

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

function addTokenAnnotation(filePath: string) {
  const content = fs.readFileSync(filePath, "utf8");
  if (content.startsWith("<!-- tokens:")) return;
  const tokens = Math.round(content.length / 4);
  if (tokens <= 500) return;
  const rounded = Math.round((tokens + 50) / 100) * 100;
  fs.writeFileSync(filePath, `<!-- tokens: ~${rounded} -->\n${content}`);
}

// ── Linking operations ──────────────────────────────────────────────────────

function linkGlobal(cortexPath: string, tools: Set<string>) {
  log("  global skills -> ~/.claude/skills/");
  const skillsDir = path.join(os.homedir(), ".claude", "skills");
  linkSkillsDir(path.join(cortexPath, "global", "skills"), skillsDir, cortexPath, symlinkFile);

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

  // Project-level skills
  const projectSkills = path.join(cortexPath, project, ".claude", "skills");
  const config = readProjectConfig(cortexPath, project);
  if (config.skills !== false && fs.existsSync(projectSkills)) {
    const targetSkills = path.join(target, ".claude", "skills");
    linkSkillsDir(projectSkills, targetSkills, cortexPath, symlinkFile);
  }
}

// ── Main orchestrator ───────────────────────────────────────────────────────

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

  // Detect installed tools once
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

  // Register hooks for Copilot CLI, Cursor, Codex
  if (hooksEnabled) {
    const hookedTools = configureAllHooks(cortexPath, { tools: detectedTools });
    if (hookedTools.length) log(`  Hooks registered: ${hookedTools.join(", ")}`);
  } else {
    log(`  Hooks registration skipped (hooks-mode is off)`);
  }

  // Write cortex.SKILL.md
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
