import * as fs from "fs";
import * as path from "path";
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
  patchJsonFile,
  setMcpEnabledPreference,
  type McpMode,
} from "./init.js";
import { configureAllHooks, detectInstalledTools } from "./hooks.js";
import { getMachineName, persistMachineName } from "./machine-identity.js";
import {
  debugLog,
  EXEC_TIMEOUT_MS,
  EXEC_TIMEOUT_QUICK_MS,
  isRecord,
  homePath,
  hookConfigPath,
} from "./shared.js";
import { errorMessage } from "./utils.js";
import {
  listMachines as listMachinesShared,
  listProfiles as listProfilesShared,
  setMachineProfile,
} from "./profile-store.js";
import { writeSkillMd } from "./link-skills.js";
import { syncScopeSkillsToDir } from "./skill-files.js";
import { renderSkillInstructionsSection } from "./skill-registry.js";
import { findProjectDir } from "./project-locator.js";
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
export { findProjectDir } from "./project-locator.js";
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

interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ProjectConfig {
  skills?: boolean;
  hooks?: {
    UserPromptSubmit?: boolean;
    Stop?: boolean;
    SessionStart?: boolean;
  };
  mcpServers?: Record<string, McpServerEntry>;
}

// ── Helpers (exported for link-doctor) ──────────────────────────────────────

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function log(msg: string) { process.stdout.write(msg + "\n"); }
function atomicWriteText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}
export { getMachineName } from "./machine-identity.js";

export function lookupProfile(cortexPath: string, machine: string): string {
  const listed = listMachinesShared(cortexPath);
  if (!listed.ok) return "";
  return listed.data[machine] || "";
}

function listProfiles(cortexPath: string): Array<{ name: string; description: string }> {
  const listed = listProfilesShared(cortexPath);
  if (!listed.ok) return [];
  return listed.data.map((profile) => ({ name: profile.name, description: "" }));
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

function currentPackageVersion(): string | null {
  try {
    const pkgPath = path.join(ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version || null;
  } catch (err: unknown) {
    debugLog(`currentPackageVersion: failed to read package.json: ${errorMessage(err)}`);
    return null;
  }
}

function readProjectConfig(cortexPath: string, project: string): ProjectConfig {
  const configPath = path.join(cortexPath, project, "cortex.project.yaml");
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, "utf8"), { schema: yaml.CORE_SCHEMA });
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ProjectConfig : {};
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] readProjectConfig: ${errorMessage(err)}\n`);
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
    debugLog(`checkStarterVersionUpdate: failed to read preferences: ${errorMessage(err)}`);
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

  const mapResult = setMachineProfile(cortexPath, machine, profile);
  if (!mapResult.ok) throw new Error(mapResult.error);
  persistMachineName(machine);

  log(`\nRegistered ${machine} with profile ${profile}.`);
  return { machine, profile };
}

// ── Sparse checkout ─────────────────────────────────────────────────────────

function setupSparseCheckout(cortexPath: string, projects: string[]) {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: cortexPath, stdio: "ignore", timeout: EXEC_TIMEOUT_QUICK_MS });
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] setupSparseCheckout notAGitRepo: ${errorMessage(err)}\n`);
    return;
  }

  const alwaysInclude = ["profiles", "machines.yaml", "global", "scripts", "link.sh", "README.md", ".gitignore"];
  const paths = [...alwaysInclude, ...projects];
  try {
    execFileSync("git", ["sparse-checkout", "set", ...paths], { cwd: cortexPath, stdio: "ignore", timeout: EXEC_TIMEOUT_MS });
    execFileSync("git", ["pull", "--ff-only"], { cwd: cortexPath, stdio: "ignore", timeout: EXEC_TIMEOUT_MS });
  } catch (err: unknown) {
    debugLog(`setupSparseCheckout: git sparse-checkout or pull failed: ${errorMessage(err)}`);
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
  const tokens = Math.round(content.length / 3.5 + (content.match(/\s+/g) || []).length * 0.1);
  if (tokens <= 500) return;
  const rounded = Math.round((tokens + 50) / 100) * 100;
  atomicWriteText(filePath, `<!-- tokens: ~${rounded} -->\n${content}`);
}

const GENERATED_AGENTS_MARKER = "<!-- cortex:generated-agents -->";

function writeManagedAgentsFile(src: string, dest: string, content: string, managedRoot: string): void {
  try {
    const stat = fs.lstatSync(dest);
    if (stat.isDirectory()) {
      log(`  preserve existing directory: ${dest}`);
      return;
    }
    if (stat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(dest);
      const resolvedTarget = path.resolve(path.dirname(dest), currentTarget);
      const managedPrefix = path.resolve(managedRoot) + path.sep;
      if (resolvedTarget === path.resolve(src) || resolvedTarget.startsWith(managedPrefix)) {
        fs.unlinkSync(dest);
      } else {
        log(`  preserve existing file: ${dest}`);
        return;
      }
    } else {
      const existing = fs.readFileSync(dest, "utf8");
      if (!existing.includes(GENERATED_AGENTS_MARKER)) {
        log(`  preserve existing file: ${dest}`);
        return;
      }
      fs.unlinkSync(dest);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  atomicWriteText(dest, `${content.trimEnd()}\n`);
}

// ── Linking operations ──────────────────────────────────────────────────────

function linkGlobal(cortexPath: string, tools: Set<string>) {
  log("  global skills -> ~/.claude/skills/");
  const skillsDir = homePath(".claude", "skills");
  syncScopeSkillsToDir(cortexPath, "global", skillsDir);

  const globalClaude = path.join(cortexPath, "global", "CLAUDE.md");
  if (fs.existsSync(globalClaude)) {
    symlinkFile(globalClaude, homePath(".claude", "CLAUDE.md"), cortexPath);
    if (tools.has("copilot")) {
      try {
        const copilotInstrDir = homePath(".github");
        fs.mkdirSync(copilotInstrDir, { recursive: true });
        symlinkFile(globalClaude, path.join(copilotInstrDir, "copilot-instructions.md"), cortexPath);
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] linkGlobal copilotInstructions: ${errorMessage(err)}\n`);
      }
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
        if (tools.has("copilot")) {
          try {
            const copilotDir = path.join(target, ".github");
            fs.mkdirSync(copilotDir, { recursive: true });
            symlinkFile(src, path.join(copilotDir, "copilot-instructions.md"), cortexPath);
          } catch (err: unknown) {
            if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] linkProject copilotInstructions: ${errorMessage(err)}\n`);
          }
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
    try { addTokenAnnotation(claudeFile); } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] linkProject tokenAnnotation: ${errorMessage(err)}\n`);
    }
  }

  // Project-level skills
  const config = readProjectConfig(cortexPath, project);
  const targetSkills = path.join(target, ".claude", "skills");
  const skillManifest = config.skills !== false
    ? syncScopeSkillsToDir(cortexPath, project, targetSkills)
    : undefined;

  if (tools.has("codex") && fs.existsSync(claudeFile)) {
    try {
      const manifest = skillManifest || syncScopeSkillsToDir(cortexPath, project, targetSkills);
      const agentsContent = `${fs.readFileSync(claudeFile, "utf8").trimEnd()}\n\n${GENERATED_AGENTS_MARKER}\n${renderSkillInstructionsSection(manifest)}\n`;
      writeManagedAgentsFile(claudeFile, path.join(target, "AGENTS.md"), agentsContent, cortexPath);
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] linkProject agentsMd: ${errorMessage(err)}\n`);
    }
  }

  // Per-project MCP servers
  if (isRecord(config.mcpServers)) {
    linkProjectMcpServers(project, config.mcpServers);
  }
}

/**
 * Merge per-project MCP servers into Claude's settings.json.
 * Keys are namespaced as "cortex__<project>__<name>" so we can identify
 * and clean them up without touching user-managed servers.
 */
function linkProjectMcpServers(project: string, servers: Record<string, McpServerEntry>): void {
  const settingsPath = hookConfigPath("claude");
  if (!fs.existsSync(settingsPath) && Object.keys(servers).length === 0) return;
  try {
    patchJsonFile(settingsPath, (data) => {
      const mcpServers = isRecord(data.mcpServers) ? data.mcpServers : (data.mcpServers = {});
      // Remove stale entries for this project (keys we previously wrote)
      for (const key of Object.keys(mcpServers)) {
        if (key.startsWith(`cortex__${project}__`)) delete mcpServers[key];
      }
      // Add current entries
      for (const [name, entry] of Object.entries(servers)) {
        const key = `cortex__${project}__${name}`;
        const server: Record<string, unknown> = { command: entry.command };
        if (Array.isArray(entry.args)) server.args = entry.args;
        if (entry.env && typeof entry.env === "object") server.env = entry.env;
        mcpServers[key] = server;
      }
    });
  } catch (err: unknown) {
    debugLog(`linkProjectMcpServers: failed for ${project}: ${errorMessage(err)}`);
  }
}

/** Remove any cortex__<project>__* MCP entries for projects no longer in the active set. */
function pruneStaleProjectMcpServers(activeProjects: string[]): void {
  const settingsPath = hookConfigPath("claude");
  if (!fs.existsSync(settingsPath)) return;
  try {
    patchJsonFile(settingsPath, (data) => {
      const mcpServers = isRecord(data.mcpServers) ? data.mcpServers : undefined;
      if (!mcpServers) return;
      for (const key of Object.keys(mcpServers)) {
        if (!key.startsWith("cortex__")) continue;
        // Key format: cortex__<project>__<name>
        const parts = key.split("__");
        if (parts.length < 3) continue;
        const project = parts[1];
        if (!activeProjects.includes(project)) {
          delete mcpServers[key];
          debugLog(`pruneStaleProjectMcpServers: removed stale entry "${key}"`);
        }
      }
    });
  } catch (err: unknown) {
    debugLog(`pruneStaleProjectMcpServers: failed: ${errorMessage(err)}`);
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
  persistMachineName(machine);

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
  // Remove stale cortex__<project>__* MCP entries for removed projects
  pruneStaleProjectMcpServers(projects.filter(p => p !== "global"));
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
  try { mcpStatus = configureClaude(cortexPath, { mcpEnabled, hooksEnabled }) ?? "installed"; } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] link configureClaude: ${errorMessage(err)}\n`);
  }
  logMcpTargetStatus("Claude", mcpStatus);

  let vsStatus = "no_vscode";
  try { vsStatus = configureVSCode(cortexPath, { mcpEnabled }) ?? "no_vscode"; } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] link configureVSCode: ${errorMessage(err)}\n`);
  }
  logMcpTargetStatus("VS Code", vsStatus);

  let cursorStatus = "no_cursor";
  try { cursorStatus = configureCursorMcp(cortexPath, { mcpEnabled }) ?? "no_cursor"; } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] link configureCursorMcp: ${errorMessage(err)}\n`);
  }
  logMcpTargetStatus("Cursor", cursorStatus);

  let copilotStatus = "no_copilot";
  try { copilotStatus = configureCopilotMcp(cortexPath, { mcpEnabled }) ?? "no_copilot"; } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] link configureCopilotMcp: ${errorMessage(err)}\n`);
  }
  logMcpTargetStatus("Copilot CLI", copilotStatus);

  let codexStatus = "no_codex";
  try { codexStatus = configureCodexMcp(cortexPath, { mcpEnabled }) ?? "no_codex"; } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] link configureCodexMcp: ${errorMessage(err)}\n`);
  }
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
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] link writeSkillMd: ${errorMessage(err)}\n`);
  }
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
  log(`\nWhat's next:`);
  log(`  Start Claude in your project directory — cortex injects context automatically.`);
  log(`  Run /cortex-discover after your first week to surface gaps in project knowledge.`);
  log(`  Run /cortex-consolidate after working across projects to find shared patterns.`);
}
