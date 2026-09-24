import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { moduleEnabled, moduleSnapshot } from "../modules/runtime.js";
import { skillEnabled, reconcileStarterSkills, starterInstructions } from "../modules/provision.js";
/**
 * Governance files, root file migration, verification, starter templates, bootstrap.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as yaml from "js-yaml";
import { loadYamlDocument } from "../phren-core.js";
import {
  atomicWriteText,
  debugLog,
  hookConfigPath,
  EXEC_TIMEOUT_QUICK_MS,
  readRootManifest,
  sessionsDir,
  runtimeHealthFile,
  isRecord,
} from "../shared.js";
import { ensurePrivateDir, homePath } from "../phren-paths.js";
import { isLiveForeignPhrenRoot, phrenRootFromGlobalClaudeLink } from "./guard-globals.js";
import { resolveWorktreeParent } from "../git-worktree.js";
import { listProfiles, resolveActiveProfile, setMachineProfile } from "../profile-store.js";
import { getMachineName } from "../machine-identity.js";
import { execFileSync } from "child_process";
import {
  GOVERNANCE_SCHEMA_VERSION,
} from "../shared/governance.js";
import { errorMessage } from "../utils.js";
import { ROOT, STARTER_DIR, VERSION, resolveEntryScript, commandVersion, versionAtLeast, nearestWritableTarget } from "./shared.js";
import { readInstallPreferences } from "./preferences.js";
import {
  getManagementPreset,
  resolveManagementCapabilities,
  type ManagementCapabilities,
  type ManagementPreset,
} from "./management-preset.js";
import { TASKS_FILENAME } from "../data/tasks.js";
import { writeSkillMd } from "../link/skills.js";
import { syncScopeSkillsToDir } from "../skill/files.js";
import { detectInstalledTools } from "../hooks.js";
import { logger } from "../logger.js";
import { migrateStoreAgentInstructions } from "../agent-instructions.js";

import {
  bootstrapFromExisting,
  ensureProjectScaffold,
  inferInitScaffoldFromRepo,
  type InferredInitScaffold,
  type InitProjectDomain,
} from "../core/project-registry.js";

export {
  bootstrapFromExisting,
  ensureProjectScaffold,
  inferInitScaffoldFromRepo,
  type InferredInitScaffold,
  type InitProjectDomain,
};

export interface PostInitCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}


interface LocalGitRepoStatus {
  ok: boolean;
  initialized: boolean;
  detail: string;
}


const LEGACY_SAMPLE_PROJECTS = new Set(["my-api", "my-frontend"]);

function normalizeProjects(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => String(entry));
}

/**
 * The sample names are also ordinary repo names, so the name alone is not
 * evidence. phren stopped shipping the sample directories: an entry with no
 * project directory in the store is the leftover sample, one with a directory
 * is a real project.
 */
function profileLooksRealProject(phrenPath: string, project: string): boolean {
  if (project === "global" || !LEGACY_SAMPLE_PROJECTS.has(project)) return true;
  return fs.existsSync(path.join(phrenPath, project));
}

function pruneLegacySampleProjectsFromProfiles(phrenPath: string): { filesUpdated: number; removed: number } {
  const profilesDir = path.join(phrenPath, "profiles");
  if (!fs.existsSync(profilesDir)) return { filesUpdated: 0, removed: 0 };

  let filesUpdated = 0;
  let removed = 0;
  for (const file of fs.readdirSync(profilesDir)) {
    if (!file.endsWith(".yaml")) continue;
    const fullPath = path.join(profilesDir, file);
    try {
      const parsed = loadYamlDocument(fs.readFileSync(fullPath, "utf8"), (text) => yaml.load(text, { schema: yaml.CORE_SCHEMA }));
      if (!isRecord(parsed)) continue;
      const originalProjects = normalizeProjects(parsed.projects);
      const nextProjects = originalProjects.filter((project) => profileLooksRealProject(phrenPath, project));
      if (nextProjects.length === originalProjects.length) continue;
      removed += originalProjects.length - nextProjects.length;
      const nextData = { ...parsed, projects: nextProjects };
      atomicWriteText(fullPath, yaml.dump(nextData, { lineWidth: 1000 }));
      filesUpdated++;
    } catch (err: unknown) {
      debugLog(`pruneLegacySampleProjectsFromProfiles failed for ${fullPath}: ${errorMessage(err)}`);
    }
  }

  return { filesUpdated, removed };
}

function claudeProjectKeyForHome(home: string): string {
  return home.replace(/[/\\:]/g, "-").replace(/^-/, "");
}

export function resolvePreferredHomeDir(phrenPath: string): string {
  const scoreAgentFootprint = (candidate: string): number => {
    let score = 0;
    if (fs.existsSync(path.join(candidate, ".claude"))) score += 1;
    if (fs.existsSync(path.join(candidate, ".claude", "settings.json"))) score += 2;
    if (fs.existsSync(path.join(candidate, ".claude", "projects"))) score += 4;
    if (fs.existsSync(path.join(candidate, ".phren-context.md"))) score += 3;
    return score;
  };

  const resolvedHome = process.env.HOME?.trim() ? path.resolve(process.env.HOME) : undefined;
  const resolvedUserProfile = process.env.USERPROFILE?.trim() ? path.resolve(process.env.USERPROFILE) : undefined;

  // In devcontainers and WSL, HOME can be an ephemeral shim while USERPROFILE is
  // the stable agent home. Prefer USERPROFILE when both differ and USERPROFILE
  // already has an agent footprint.
  if (resolvedHome && resolvedUserProfile && resolvedHome !== resolvedUserProfile) {
    if (scoreAgentFootprint(resolvedUserProfile) > 0) return resolvedUserProfile;
  }

  // An explicit HOME/USERPROFILE is authoritative. Only fall back to
  // os.homedir() and the store's parent when neither is set — otherwise a
  // caller that deliberately points HOME elsewhere (the test suite, a
  // sandbox) loses the footprint contest to the developer's real home and
  // we write symlinks into it.
  const candidates = [
    resolvedHome,
    resolvedUserProfile,
    ...(resolvedHome || resolvedUserProfile
      ? []
      : [path.resolve(os.homedir()), path.resolve(path.dirname(phrenPath))]),
  ].filter((entry): entry is string => Boolean(entry && entry.trim()));
  const unique = [...new Set(candidates)];

  let bestPath: string | null = null;
  let bestScore = 0;
  for (const candidate of unique) {
    const score = scoreAgentFootprint(candidate);
    if (score > bestScore) {
      bestScore = score;
      bestPath = candidate;
    }
  }
  if (bestPath) return bestPath;
  return unique[0] ?? os.homedir();
}

function ensureGeneratedContextFile(home: string): boolean {
  const contextFile = path.join(home, ".phren-context.md");
  if (fs.existsSync(contextFile)) return false;
  atomicWriteText(
    contextFile,
    [
      "<!-- phren-managed -->",
      "# phren context",
      "Machine/profile context will be refreshed on the next link/init pass.",
      "<!-- phren-managed -->",
      "",
    ].join("\n"),
  );
  return true;
}

function ensureGeneratedRootMemory(home: string): boolean {
  const memoryFile = path.join(
    home,
    ".claude",
    "projects",
    claudeProjectKeyForHome(home),
    "memory",
    "MEMORY.md",
  );
  if (fs.existsSync(memoryFile)) return false;
  atomicWriteText(
    memoryFile,
    [
      "# Root Memory",
      "",
      "## Machine Context",
      "Read `~/.phren-context.md` for profile, active projects, and sync metadata.",
      "",
      "<!-- phren:projects:start -->",
      "<!-- Auto-generated by phren init/doctor repair. -->",
      "",
      "## Active Projects",
      "",
      "| Project | What | Memory |",
      "|---------|------|--------|",
      "",
      "<!-- phren:projects:end -->",
      "",
    ].join("\n"),
  );
  return true;
}

interface RepairInstallResult {
  profileFilesUpdated: number;
  removedLegacyProjects: number;
  createdContextFile: boolean;
  createdRootMemory: boolean;
  createdGlobalAssets: string[];
  createdRuntimeAssets: string[];
  createdFeatureDefaults: string[];
  createdSkillArtifacts: string[];
  repairedGlobalSymlink: boolean;
}

function ensureGlobalStarterAssets(phrenPath: string): string[] {
  const created: string[] = [];
  const starterGlobal = path.join(STARTER_DIR, "global");
  if (!fs.existsSync(starterGlobal)) return created;

  const targetGlobalDir = path.join(phrenPath, "global");
  fs.mkdirSync(targetGlobalDir, { recursive: true });

  const starterClaude = path.join(starterGlobal, "AGENTS.md");
  const targetClaude = path.join(targetGlobalDir, "AGENTS.md");
  if (fs.existsSync(starterClaude) && !fs.existsSync(targetClaude)) {
    fs.copyFileSync(starterClaude, targetClaude);
    created.push("global/AGENTS.md");
  }

  const starterSkillsDir = path.join(starterGlobal, "skills");
  const targetSkillsDir = path.join(targetGlobalDir, "skills");
  fs.mkdirSync(targetSkillsDir, { recursive: true });
  if (fs.existsSync(starterSkillsDir)) {
    for (const entry of fs.readdirSync(starterSkillsDir, { withFileTypes: true })) {
      if (!skillEnabled(phrenPath, entry.name)) continue;
      const source = path.join(starterSkillsDir, entry.name);
      const target = path.join(targetSkillsDir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".md")) {
        if (fs.existsSync(target)) continue;
        fs.copyFileSync(source, target);
        created.push(path.join("global", "skills", entry.name));
      } else if (entry.isDirectory() && fs.existsSync(path.join(source, "SKILL.md"))) {
        if (fs.existsSync(target)) continue;
        copyDirRecursive(source, target);
        created.push(path.join("global", "skills", entry.name) + path.sep);
      }
    }
  }

  return created;
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function ensureRuntimeAssets(phrenPath: string): string[] {
  const created: string[] = [];
  // Both directories hold per-user private data (credential store, debug and
  // hook-error logs, session transcripts) and are gitignored by the store
  // template. ensurePrivateDir creates them 0700 and tightens an existing
  // 0755 one left behind by an older install.
  const runtimeDir = path.join(phrenPath, ".runtime");
  const runtimeExisted = fs.existsSync(runtimeDir);
  ensurePrivateDir(runtimeDir);
  if (!runtimeExisted) created.push(".runtime/");

  const sessions = sessionsDir(phrenPath);
  const sessionsExisted = fs.existsSync(sessions);
  ensurePrivateDir(sessions);
  if (!sessionsExisted) created.push(".sessions/");



  return created;
}

function ensureDefaultFeatureFlags(phrenPath: string, preset?: ManagementPreset): string[] {
  const created: string[] = [];
  const envPath = path.join(phrenPath, ".env");
  const header = "# phren feature flags — generated by init\n";
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : header;
  let changed = !fs.existsSync(envPath);
  const lines = content.split("\n");
  // Manual preset opts out of prompt-time auto-capture by default.
  const autoCaptureDefault = preset === "manual" ? "0" : "1";
  const hasAutoCaptureFlag = lines.some((line) => line.trimStart().startsWith("PHREN_FEATURE_AUTO_CAPTURE="));
  if (!hasAutoCaptureFlag) {
    if (!content.endsWith("\n")) content += "\n";
    content += `PHREN_FEATURE_AUTO_CAPTURE=${autoCaptureDefault}\n`;
    changed = true;
    created.push(`.env:PHREN_FEATURE_AUTO_CAPTURE=${autoCaptureDefault}`);
  }
  if (changed) {
    atomicWriteText(envPath, content);
  }
  return created;
}

function ensureGeneratedSkillArtifacts(phrenPath: string, preferredHome: string): string[] {
  const created: string[] = [];
  const homeClaudeDir = path.join(preferredHome, ".claude");
  const globalSkillsDir = path.join(homeClaudeDir, "skills");
  const manifestPath = path.join(homeClaudeDir, "skill-manifest.json");
  const commandsPath = path.join(homeClaudeDir, "skill-commands.json");
  const hadManifest = fs.existsSync(manifestPath);
  const hadCommands = fs.existsSync(commandsPath);

  try {
    syncScopeSkillsToDir(phrenPath, "global", globalSkillsDir);
    if (!hadManifest && fs.existsSync(manifestPath)) created.push("~/.claude/skill-manifest.json");
    if (!hadCommands && fs.existsSync(commandsPath)) created.push("~/.claude/skill-commands.json");
  } catch (err: unknown) {
    debugLog(`ensureGeneratedSkillArtifacts: global skill mirror sync failed: ${errorMessage(err)}`);
  }

  const copilotSkillsDir = path.join(preferredHome, ".copilot", "skills");
  const hadCopilotSkillsDir = fs.existsSync(copilotSkillsDir);
  if (detectInstalledTools().has("copilot")) {
    try {
      syncScopeSkillsToDir(phrenPath, "global", copilotSkillsDir);
      if (!hadCopilotSkillsDir && fs.existsSync(copilotSkillsDir)) created.push("~/.copilot/skills/");
    } catch (err: unknown) {
      debugLog(`ensureGeneratedSkillArtifacts: copilot skill mirror sync failed: ${errorMessage(err)}`);
    }
  }

  const skillMdPath = path.join(phrenPath, "phren.SKILL.md");
  const hadSkillMd = fs.existsSync(skillMdPath);
  try {
    writeSkillMd(phrenPath);
    if (!hadSkillMd && fs.existsSync(skillMdPath)) created.push("phren.SKILL.md");
  } catch (err: unknown) {
    debugLog(`ensureGeneratedSkillArtifacts: writeSkillMd failed: ${errorMessage(err)}`);
  }

  return created;
}

export function ensureGitignoreEntry(repoRoot: string, entry: string): boolean {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  const normalizedEntry = entry.trim();
  if (!normalizedEntry) return false;

  let content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const lines = content.split("\n").map((line) => line.trim());
  if (lines.includes(normalizedEntry)) return false;

  if (content && !content.endsWith("\n")) content += "\n";
  content += `${normalizedEntry}\n`;
  atomicWriteText(gitignorePath, content);
  return true;
}

export function upsertProjectEnvVar(repoRoot: string, key: string, value: string): boolean {
  const envPath = path.join(repoRoot, ".env");
  const normalizedKey = key.trim();
  if (!normalizedKey) return false;
  const nextLine = `${normalizedKey}=${value}`;

  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const lineRe = new RegExp(`^\\s*${normalizedKey}=.*$`, "m");
  if (lineRe.test(content)) {
    const updated = content.replace(lineRe, nextLine);
    if (updated === content) return false;
    atomicWriteText(envPath, updated);
    return true;
  }

  if (content && !content.endsWith("\n")) content += "\n";
  content += `${nextLine}\n`;
  atomicWriteText(envPath, content);
  return true;
}

export function repairPreexistingInstall(
  phrenPath: string,
  opts?: { caps?: ManagementCapabilities; preset?: ManagementPreset }
): RepairInstallResult {
  // Resolve the effective management capabilities. Callers that are applying a
  // not-yet-persisted preset (e.g. init) pass caps explicitly; the every-session
  // self-heal path resolves from stored preferences.
  const caps = opts?.caps ?? resolveManagementCapabilities(phrenPath);
  const preset = opts?.preset ?? getManagementPreset(phrenPath);
  moduleSnapshot(phrenPath);
  reconcileStarterSkills(phrenPath, STARTER_DIR);
  const createdGovernanceAssets = ensureGovernanceFiles(phrenPath);
  const migratedInstructions = migrateStoreAgentInstructions(phrenPath);
  const createdGlobalAssets = [...migratedInstructions, ...ensureGlobalStarterAssets(phrenPath)];
  const createdRuntimeAssets = [...createdGovernanceAssets, ...ensureRuntimeAssets(phrenPath)];
  const createdFeatureDefaults = ensureDefaultFeatureFlags(phrenPath, preset);
  const profileRepair = pruneLegacySampleProjectsFromProfiles(phrenPath);
  const preferredHome = resolvePreferredHomeDir(phrenPath);
  // Structural surfaces (home skills symlinks + ~/.claude/CLAUDE.md) are only
  // created/self-healed under presets that opt into them.
  const createdSkillArtifacts = caps.installSkillLinks
    ? ensureGeneratedSkillArtifacts(phrenPath, preferredHome)
    : [];
  const repairedGlobalSymlink = caps.linkGlobalClaudeMd ? repairGlobalClaudeSymlink(phrenPath) : false;
  return {
    profileFilesUpdated: profileRepair.filesUpdated,
    removedLegacyProjects: profileRepair.removed,
    // Both live in the user's home, so they are self-heal surfaces: `assisted`
    // and `manual` do not re-create them.
    createdContextFile: caps.selfHeal ? ensureGeneratedContextFile(preferredHome) : false,
    createdRootMemory: caps.selfHeal ? ensureGeneratedRootMemory(preferredHome) : false,
    createdGlobalAssets,
    createdRuntimeAssets,
    createdFeatureDefaults,
    createdSkillArtifacts,
    repairedGlobalSymlink,
  };
}

/**
 * Re-create the ~/.claude/CLAUDE.md symlink if the source exists but the link
 * is missing or broken.
 *
 * The ownership test used to be `target.includes(".phren") ||
 * target.endsWith("global/AGENTS.md")`, which treats *any* live phren root's
 * global file as fair game to unlink. That is how a run with
 * `PHREN_PATH=/tmp/…` — a smoke test, or phren's own web UI — leaves the
 * user's real `~/.claude/CLAUDE.md` pointing into a temp directory that then
 * disappears, and every later Claude session starts with no global context.
 *
 * assertNoGlobalWiringConflict does not save us here: it guards `phren init`,
 * and this function is reached from repairPreexistingInstall(), which runs on
 * every SessionStart hook (cli/session-start.ts), from the web UI
 * (ui/server.ts) and from `phren doctor` (link/doctor.ts) — none of which
 * consult the guard. So the check has to live at the write site.
 *
 * New rule: a symlink into a *different* root that still looks live is left
 * alone. Stale wiring (the root is gone, or was never a root) is still
 * repaired, which is the case this function exists for.
 */
function repairGlobalClaudeSymlink(phrenPath: string): boolean {
  const src = path.join(phrenPath, "global", "AGENTS.md");
  if (!fs.existsSync(src)) return false;
  const dest = homePath(".claude", "CLAUDE.md");
  try {
    const stat = fs.lstatSync(dest);
    if (stat.isSymbolicLink()) {
      const target = path.resolve(path.dirname(dest), fs.readlinkSync(dest));
      if (target === path.resolve(src)) return false; // already correct
      const owningRoot = phrenRootFromGlobalClaudeLink(target);
      if (owningRoot && isLiveForeignPhrenRoot(owningRoot, phrenPath)) {
        debugLog(`refusing to repoint ~/.claude/CLAUDE.md: still owned by live phren root ${owningRoot}`);
        return false;
      }
      // Stale phren wiring — safe to replace. `.includes(".phren")` stays for
      // links that are not shaped like <root>/global/AGENTS.md.
      if (owningRoot || target.includes(".phren")) fs.unlinkSync(dest);
      else return false; // not ours, don't touch
    } else {
      return false; // regular file exists, don't clobber
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(src, dest);
    debugLog(`repaired global AGENTS.md symlink: ${dest} -> ${src}`);
    return true;
  } catch (err) {
    debugLog(`failed to repair global AGENTS.md symlink: ${errorMessage(err)}`);
    return false;
  }
}

function isExpectedVerifyFailure(phrenPath: string, check: Pick<PostInitCheck, "name" | "ok">): boolean {
  if (check.ok) return false;
  const prefs = readInstallPreferences(phrenPath);
  // git-remote failure is only expected when the user chose local-only (no clone URL)
  if (check.name === "git-remote") return prefs.syncIntent !== "sync";
  if (check.name === "mcp-config" && prefs.mcpEnabled === false) return true;
  if (check.name === "hooks-registered" && prefs.hooksEnabled === false) return true;
  return false;
}

export function getVerifyOutcomeNote(phrenPath: string, checks: PostInitCheck[]): string | null {
  const failures = checks.filter((check) => !check.ok);
  if (failures.length === 0) return null;
  const expectedFailures = failures.filter((check) => isExpectedVerifyFailure(phrenPath, check));
  if (expectedFailures.length === 0) return null;
  if (expectedFailures.length === failures.length) {
    return "Setup looks usable in local-only / hooks-only mode; remaining issues are optional sync or MCP checks.";
  }
  return "Some reported issues are optional for your chosen install mode; review git-remote / MCP failures separately from hard failures.";
}

interface HookEntrypointCheckDeps {
  pathExists?: typeof fs.existsSync;
  versionReader?: typeof commandVersion;
}

export function getHookEntrypointCheck(deps: HookEntrypointCheckDeps = {}): PostInitCheck {
  const pathExists = deps.pathExists ?? fs.existsSync;
  const versionReader = deps.versionReader ?? commandVersion;
  const distIndex = resolveEntryScript();
  const localEntrypointOk = pathExists(distIndex);
  const hookEntrypointOk = localEntrypointOk || Boolean(versionReader("npx", ["--version"]));
  const detail = localEntrypointOk
    ? "Hook entrypoint available via local dist/index.js"
    : hookEntrypointOk
      ? "Hook entrypoint available via npx fallback"
      : "Hook entrypoint missing and npx unavailable, hooks will fail";
  return {
    name: "hook-entrypoint",
    ok: hookEntrypointOk,
    detail,
    fix: hookEntrypointOk ? undefined : "Rebuild phren: `npm run build` or reinstall the package, and ensure npm/npx is available for hook fallbacks",
  };
}

function gitRemoteStatus(phrenPath: string): { ok: boolean; detail: string } {
  try {
    execFileSync("git", ["-C", phrenPath, "rev-parse", "--is-inside-work-tree"], {
      env: nonInteractiveGitEnv(),
      stdio: ["ignore", "ignore", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    });
  } catch {
    return { ok: false, detail: "phren path is not a git repository" };
  }
  let remote: string;
  try {
    remote = execFileSync("git", ["-C", phrenPath, "remote", "get-url", "origin"], {
      env: nonInteractiveGitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    }).trim();
    if (!remote) return { ok: false, detail: "git origin remote not configured" };
  } catch {
    return { ok: false, detail: "git origin remote not configured" };
  }

  // Connectivity test: verify the remote is reachable (10s timeout)
  try {
    execFileSync("git", ["-C", phrenPath, "ls-remote", "--exit-code", "origin"], {
      env: nonInteractiveGitEnv(),
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 10_000,
    });
    return { ok: true, detail: `origin=${remote}` };
  } catch {
    return { ok: false, detail: `origin=${remote} (configured but unreachable)` };
  }
}

function copyStarterFile(phrenPath: string, src: string, dest: string): string | null {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(src, dest);
    return dest;
  }

  const existing = fs.readFileSync(dest);
  const incoming = fs.readFileSync(src);
  if (existing.equals(incoming)) {
    return null;
  }

  const relative = path.relative(phrenPath, dest);
  const stagingDir = path.join(phrenPath, ".runtime", "starter-updates", path.dirname(relative));
  fs.mkdirSync(stagingDir, { recursive: true });
  const currentPath = path.join(stagingDir, `${path.basename(dest)}.current`);
  const stagedPath = path.join(stagingDir, `${path.basename(dest)}.new`);
  fs.copyFileSync(dest, currentPath);
  fs.copyFileSync(src, stagedPath);
  return stagedPath;
}

export function applyStarterTemplateUpdates(phrenPath: string): string[] {
  const updates: string[] = [];
  const starterGlobal = path.join(STARTER_DIR, "global");
  if (!fs.existsSync(starterGlobal)) return updates;

  const starterClaude = path.join(starterGlobal, "AGENTS.md");
  const targetClaude = path.join(phrenPath, "global", "AGENTS.md");
  if (fs.existsSync(starterClaude)) {
    const written = copyStarterFile(phrenPath, starterClaude, targetClaude);
    if (written) updates.push(path.relative(phrenPath, written));
  }

  const starterSkillsDir = path.join(starterGlobal, "skills");
  const targetSkillsDir = path.join(phrenPath, "global", "skills");
  if (fs.existsSync(starterSkillsDir)) {
    fs.mkdirSync(targetSkillsDir, { recursive: true });
    for (const f of fs.readdirSync(starterSkillsDir, { withFileTypes: true })) {
      if (!skillEnabled(phrenPath, f.name)) continue;
      const src = path.join(starterSkillsDir, f.name);
      const dest = path.join(targetSkillsDir, f.name);
      if (f.isFile() && f.name.endsWith(".md")) {
        const written = copyStarterFile(phrenPath, src, dest);
        if (written) updates.push(path.relative(phrenPath, written));
      } else if (f.isDirectory() && fs.existsSync(path.join(src, "SKILL.md"))) {
        for (const inner of walkSkillFolder(src)) {
          const written = copyStarterFile(phrenPath, path.join(src, inner), path.join(dest, inner));
          if (written) updates.push(path.relative(phrenPath, written));
        }
      }
    }
  }

  return updates;
}

function walkSkillFolder(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkSkillFolder(abs, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

export function ensureGovernanceFiles(phrenPath: string): string[] {
  const created: string[] = [];
  const govDir = path.join(phrenPath, ".config");
  if (!fs.existsSync(govDir)) created.push(".config/");
  fs.mkdirSync(govDir, { recursive: true });
  const sv = GOVERNANCE_SCHEMA_VERSION;
  const policy = path.join(govDir, "retention-policy.json");
  const workflow = path.join(govDir, "workflow-policy.json");
  const indexPolicy = path.join(govDir, "index-policy.json");
  const runtimeHealth = runtimeHealthFile(phrenPath);

  if (!fs.existsSync(policy)) {
    atomicWriteText(
      policy,
      JSON.stringify({
        schemaVersion: sv,
        ttlDays: 120,
        retentionDays: 365,
        autoAcceptThreshold: 0.75,
        minInjectConfidence: 0.35,
        decay: { d30: 1.0, d60: 0.85, d90: 0.65, d120: 0.45 },
      }, null, 2) + "\n"
    );
    created.push(".config/retention-policy.json");
  }
  if (!fs.existsSync(workflow)) {
    atomicWriteText(
      workflow,
      JSON.stringify({
        schemaVersion: sv,
        lowConfidenceThreshold: 0.7,
        riskySections: ["Stale", "Conflicts"],
        taskMode: "auto",
      }, null, 2) + "\n"
    );
    created.push(".config/workflow-policy.json");
  }
  if (!fs.existsSync(indexPolicy)) {
    atomicWriteText(
      indexPolicy,
      JSON.stringify({
        schemaVersion: sv,
        includeGlobs: ["**/*.md", "**/skills/**/*.md", ".claude/skills/**/*.md"],
        excludeGlobs: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/build/**"],
        includeHidden: false,
      }, null, 2) + "\n"
    );
    created.push(".config/index-policy.json");
  }
  if (!fs.existsSync(runtimeHealth)) {
    atomicWriteText(runtimeHealth, JSON.stringify({ schemaVersion: sv }, null, 2) + "\n");
    created.push(".runtime/runtime-health.json");
  } else {
    try {
      const current = JSON.parse(fs.readFileSync(runtimeHealth, "utf8"));
      if (current && typeof current === "object" && !Array.isArray(current)) {
        const existingSchema = typeof current.schemaVersion === "number" ? current.schemaVersion : 0;
        if (existingSchema < sv) {
          atomicWriteText(runtimeHealth, JSON.stringify({ ...current, schemaVersion: sv }, null, 2) + "\n");
        }
      }
    } catch (err: unknown) {
      debugLog(`ensureGovernanceFiles: malformed runtime health file, leaving untouched: ${errorMessage(err)}`);
    }
  }
  return created;
}

const TEMPLATES_DIR = path.join(ROOT, "starter", "templates");

export function listTemplates(): string[] {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  return fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

export function applyTemplate(projectDir: string, templateName: string, projectName: string): boolean {
  const templateDir = path.join(TEMPLATES_DIR, templateName);
  if (!fs.existsSync(templateDir)) return false;
  fs.mkdirSync(projectDir, { recursive: true });
  function copyTemplateDir(srcDir: string, destDir: string) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.name === TASKS_FILENAME && !moduleEnabled(path.dirname(projectDir), "tasks")) continue;
      const src = path.join(srcDir, entry.name);
      const dest = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        copyTemplateDir(src, dest);
      } else {
        let content = fs.readFileSync(src, "utf8");
        if (entry.name === "AGENTS.md") content = starterInstructions(path.dirname(projectDir), content);
        content = content.replace(/\{\{project\}\}/g, projectName);
        content = content.replace(/\{\{date\}\}/g, new Date().toISOString().slice(0, 10));
        atomicWriteText(dest, content);
      }
    }
  }
  copyTemplateDir(templateDir, projectDir);
  return true;
}

export function ensureLocalGitRepo(phrenPath: string): LocalGitRepoStatus {
  // Check if phrenPath already has its own git repo (not just being inside a parent)
  try {
    const topLevel = execFileSync("git", ["-C", phrenPath, "rev-parse", "--show-toplevel"], {
      env: nonInteractiveGitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    }).trim();
    // Normalize both paths: resolve symlinks (macOS /var→/private/var) and
    // on Windows resolve 8.3 short names (RUNNER~1→runneradmin) + case-insensitive
    const realpath = process.platform === "win32" ? fs.realpathSync.native : fs.realpathSync;
    let resolvedTopLevel = realpath(path.resolve(topLevel));
    let resolvedPhrenPath = realpath(path.resolve(phrenPath));
    if (process.platform === "win32") {
      resolvedTopLevel = resolvedTopLevel.toLowerCase();
      resolvedPhrenPath = resolvedPhrenPath.toLowerCase();
    }
    if (resolvedTopLevel === resolvedPhrenPath) {
      // phrenPath IS the repo root — it has its own git repo
      return { ok: true, initialized: false, detail: "existing git repo" };
    }
    // phrenPath is inside a parent repo — skip nested init
    logger.warn("init", `Skipping git init: ${resolvedPhrenPath} is inside existing repo ${resolvedTopLevel}`);
    return { ok: true, initialized: false, detail: `skipped: inside existing repo ${resolvedTopLevel}` };
  } catch {
    // Not inside any git repo — fall through to initialization below.
  }

  try {
    try {
      execFileSync("git", ["-C", phrenPath, "init", "--initial-branch=main"], {
        env: nonInteractiveGitEnv(),
        stdio: ["ignore", "ignore", "ignore"],
        timeout: EXEC_TIMEOUT_QUICK_MS,
      });
    } catch {
      execFileSync("git", ["-C", phrenPath, "init"], {
        env: nonInteractiveGitEnv(),
        stdio: ["ignore", "ignore", "ignore"],
        timeout: EXEC_TIMEOUT_QUICK_MS,
      });
      try {
        execFileSync("git", ["-C", phrenPath, "branch", "-M", "main"], {
          env: nonInteractiveGitEnv(),
          stdio: ["ignore", "ignore", "ignore"],
          timeout: EXEC_TIMEOUT_QUICK_MS,
        });
      } catch {
        // Older git versions may not support renaming immediately here.
      }
    }
    return { ok: true, initialized: true, detail: "initialized local git repo" };
  } catch (err: unknown) {
    return { ok: false, initialized: false, detail: `git init failed: ${errorMessage(err)}` };
  }
}

export function updateMachinesYaml(phrenPath: string, machine?: string, profile?: string) {
  const machinesFile = path.join(phrenPath, "machines.yaml");
  if (!fs.existsSync(machinesFile)) return;
  const machineName = (machine?.trim() || getMachineName()).trim();
  if (!machineName) return;
  const activeProfile = resolveActiveProfile(phrenPath, profile);
  const profileName = profile?.trim() || (activeProfile.ok ? (activeProfile.data || "") : "") || "personal";

  let hasExistingMapping = false;
  try {
    const loaded = loadYamlDocument(fs.readFileSync(machinesFile, "utf8"), (text) => yaml.load(text, { schema: yaml.CORE_SCHEMA }));
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
      hasExistingMapping = Object.prototype.hasOwnProperty.call(loaded, machineName);
    }
  } catch (err: unknown) {
    // Not "no existing mapping": setMachineProfile refuses to rewrite the file,
    // and the user needs to hear why the mapping did not change.
    logger.debug("setup", `updateMachinesYaml parse: ${errorMessage(err)}`);
    console.warn(`  ${machinesFile} could not be parsed; machine mappings left unchanged. Fix it by hand (check for git conflict markers), then run 'phren init' again.`);
    return;
  }

  // Passive init/link refreshes should keep an existing mapping; explicit overrides can remap.
  if (hasExistingMapping && !machine && !profile) return;
  const mapping = setMachineProfile(phrenPath, machineName, profileName);
  if (!mapping.ok) logger.debug("setup", `updateMachinesYaml setMachineProfile: ${mapping.error}`);
}

/**
 * Detect if a directory looks like a project that should be bootstrapped.
 * Returns the path if it qualifies, null otherwise.
 * A directory qualifies if it:
 * - Is not the home directory or phren directory
 * - Has an AGENTS.md, legacy CLAUDE.md, .claude/CLAUDE.md, or .git directory
 *
 * A git worktree resolves to the repository it belongs to. Without this a
 * throwaway agent worktree under `.claude/worktrees/<codename>` looks like its
 * own repo (it has a `.git` entry) and gets offered as a new project.
 */
export function detectProjectDir(dir: string, phrenPath: string): string | null {
  const home = os.homedir();
  const tmpRoot = path.resolve(os.tmpdir());
  const resolvedPhrenPath = path.resolve(phrenPath);
  const worktree = resolveWorktreeParent(dir);
  let current = worktree && fs.existsSync(worktree.repoRoot)
    ? worktree.repoRoot
    : path.resolve(dir);
  while (true) {
    // Never treat the shared OS temp root itself as a project. Tools may drop
    // global instruction files there, which would otherwise hijack detection
    // for arbitrary temp subdirectories.
    if (current === tmpRoot) return null;
    if (current === home || current === resolvedPhrenPath) return null;
    if (current.startsWith(resolvedPhrenPath + path.sep)) return null;
    const hasClaude = fs.existsSync(path.join(current, "CLAUDE.md")) ||
      fs.existsSync(path.join(current, ".claude", "CLAUDE.md"));
    const hasAgents = fs.existsSync(path.join(current, "AGENTS.md"));
    const hasGit = fs.existsSync(path.join(current, ".git"));
    if (hasClaude || hasAgents || hasGit) return current;
    const parent = path.dirname(current);
    if (parent === current || parent === home) break;
    current = parent;
  }
  return null;
}

/**
 * Check if a project name is already tracked in any profile.
 */
export function isProjectTracked(phrenPath: string, projectName: string, profile?: string): boolean {
  const profiles = listProfiles(phrenPath);
  if (profiles.ok) {
    if (profile) {
      return profiles.data.some((entry) => entry.name === profile && entry.projects.includes(projectName));
    }
    return profiles.data.some((entry) => entry.projects.includes(projectName));
  }
  const projDir = path.join(phrenPath, projectName);
  return fs.existsSync(projDir);
}

export function runPostInitVerify(phrenPath: string): { ok: boolean; checks: PostInitCheck[] } {
  const checks: PostInitCheck[] = [];
  const prefs = readInstallPreferences(phrenPath);
  const manifest = readRootManifest(phrenPath);
  const gitVersion = commandVersion("git");
  const nodeVersion = commandVersion("node");
  checks.push({
    name: "git-installed",
    ok: Boolean(gitVersion),
    detail: gitVersion || "git not found in PATH",
    fix: gitVersion ? undefined : "Install git and re-run `phren init`.",
  });
  checks.push({
    name: "node-version",
    ok: versionAtLeast(nodeVersion, 20),
    detail: nodeVersion || "node not found in PATH",
    fix: versionAtLeast(nodeVersion, 20) ? undefined : "Install Node.js 20+ before using phren.",
  });

  if (manifest?.installMode === "project-local") {
    checks.push({
      name: "workspace-root",
      ok: Boolean(manifest.workspaceRoot && fs.existsSync(manifest.workspaceRoot)),
      detail: manifest.workspaceRoot ? `workspace root: ${manifest.workspaceRoot}` : "workspaceRoot missing from phren.root.yaml",
      fix: manifest.workspaceRoot ? undefined : "Re-run `phren init --mode project-local` to repair the root manifest.",
    });
    checks.push({
      name: "hooks-registered",
      ok: prefs.hooksEnabled === false,
      detail: "hooks are unsupported in project-local mode",
      fix: prefs.hooksEnabled === false ? undefined : "Run `phren hooks-mode off` and keep hooks disabled in project-local mode.",
    });
    const workspaceMcp = manifest.workspaceRoot ? path.join(manifest.workspaceRoot, ".vscode", "mcp.json") : "";
    let workspaceMcpOk = false;
    try {
      if (workspaceMcp && fs.existsSync(workspaceMcp)) {
        const cfg = JSON.parse(fs.readFileSync(workspaceMcp, "utf8"));
        workspaceMcpOk = Boolean(cfg.servers?.phren);
      }
    } catch (err: unknown) {
      debugLog(`doctor local workspace mcp parse failed: ${errorMessage(err)}`);
    }
    checks.push({
      name: "mcp-config",
      ok: prefs.mcpEnabled === false ? true : workspaceMcpOk,
      detail: prefs.mcpEnabled === false
        ? "workspace MCP disabled by preference"
        : workspaceMcpOk
          ? "VS Code workspace MCP registered"
          : "VS Code workspace MCP not found in .vscode/mcp.json",
      fix: prefs.mcpEnabled === false ? undefined : "Run `phren mcp-mode on` to register the VS Code workspace server.",
    });
  } else {

    const gitRemote = gitRemoteStatus(phrenPath);
    const wantSync = prefs.syncIntent === "sync";
    const gitRemoteDetail = gitRemote.ok
      ? gitRemote.detail
      : wantSync
        ? `${gitRemote.detail} — sync was configured but remote is missing or unreachable`
        : `${gitRemote.detail} (optional unless you want cross-machine sync)`;
    const gitRemoteFix = gitRemote.ok
      ? undefined
      : wantSync
        ? `Your clone URL didn't work. Fix: cd ${phrenPath} && git remote add origin <URL> && git push -u origin main`
        : "Optional: initialize a repo and add an origin remote for cross-machine sync.";
    checks.push({
      name: "git-remote",
      ok: gitRemote.ok,
      detail: gitRemoteDetail,
      fix: gitRemoteFix,
    });

    const settingsPath = hookConfigPath("claude");
    const configWritable = nearestWritableTarget(settingsPath);
    checks.push({
      name: "config-writable",
      ok: configWritable,
      detail: configWritable ? `writable: ${settingsPath}` : `not writable: ${settingsPath}`,
      fix: configWritable ? undefined : "Fix permissions for ~/.claude or its settings.json before enabling hooks/MCP.",
    });
    let mcpOk = false;
    let hooksOk = false;
    try {
      const cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      mcpOk = Boolean(cfg.mcpServers?.phren);
      const hooks = cfg.hooks || {};
      const hasPrompt = JSON.stringify(hooks.UserPromptSubmit || []).includes("hook-prompt");
      const hasStop = JSON.stringify(hooks.Stop || []).includes("hook-stop");
      const hasStart = JSON.stringify(hooks.SessionStart || []).includes("hook-session-start");
      hooksOk = hasPrompt && hasStop && hasStart;
    } catch (err: unknown) {
      debugLog(`doctor: settings.json missing or unreadable: ${errorMessage(err)}`);
    }
    checks.push({
      name: "mcp-config",
      ok: mcpOk,
      detail: mcpOk
        ? "MCP server registered in Claude settings"
        : prefs.mcpEnabled === false
          ? "MCP server not found in ~/.claude/settings.json (expected while MCP mode is OFF)"
          : "MCP server not found in ~/.claude/settings.json",
      fix: mcpOk
        ? undefined
        : prefs.mcpEnabled === false
          ? "Optional: run `phren mcp-mode on` or `phren init` if you want MCP enabled."
          : "Run `phren init` to register the MCP server",
    });
    checks.push({
      name: "hooks-registered",
      ok: hooksOk,
      detail: hooksOk
        ? "All lifecycle hooks registered"
        : prefs.hooksEnabled === false
          ? "One or more hooks missing from ~/.claude/settings.json (expected while hooks mode is OFF)"
          : "One or more hooks missing from ~/.claude/settings.json",
      fix: hooksOk
        ? undefined
        : prefs.hooksEnabled === false
          ? "Optional: run `phren hooks-mode on` or `phren init` if you want hooks enabled."
          : "Run `phren init` to install or refresh hooks",
    });
  }

  const globalClaude = path.join(phrenPath, "global", "AGENTS.md");
  const globalOk = fs.existsSync(globalClaude);
  checks.push({
    name: "global-claude",
    ok: globalOk,
    detail: globalOk ? "global/AGENTS.md exists" : "global/AGENTS.md missing",
    fix: globalOk ? undefined : "Run `phren init` to create starter files",
  });

  const govDir = path.join(phrenPath, ".config");
  const govOk = fs.existsSync(govDir);
  checks.push({
    name: "config",
    ok: govOk,
    detail: govOk ? ".config/ config directory exists" : ".config/ config directory missing",
    fix: govOk ? undefined : "Run `phren init` to create governance config",
  });

  const installedPrefs = readInstallPreferences(phrenPath);
  const installedVersion = installedPrefs.installedVersion;
  const versionOk = !govOk || installedVersion === VERSION;
  checks.push({
    name: "installed-version",
    ok: versionOk,
    detail: installedVersion
      ? (versionOk ? `install metadata matches running version (${VERSION})` : `install metadata is ${installedVersion}, runtime is ${VERSION}`)
      : "install metadata missing installedVersion",
    fix: versionOk ? undefined : "Run `phren update` or `phren init` to refresh install metadata.",
  });

  let ftsOk = false;
  try {
    const entries = fs.readdirSync(phrenPath, { withFileTypes: true });
    ftsOk = entries.some(d => d.isDirectory() && !d.name.startsWith("."));
  } catch (err: unknown) {
    logger.debug("setup", `runPostInitVerify projectScan: ${errorMessage(err)}`);
    ftsOk = false;
  }
  checks.push({
    name: "fts-index",
    ok: ftsOk,
    detail: ftsOk ? "Project directories found for indexing" : "No project directories found in phren path",
    fix: ftsOk ? undefined : "Create a project: `cd ~/your-project && phren add`",
  });

  checks.push(getHookEntrypointCheck());

  // Check that the CLI wrapper at ~/.local/bin/phren exists and is executable (soft check — not mandatory)
  const cliWrapperPath = homePath(".local", "bin", "phren");
  let cliWrapperOk = false;
  try {
    const stat = fs.statSync(cliWrapperPath);
    cliWrapperOk = stat.isFile();
    if (cliWrapperOk) fs.accessSync(cliWrapperPath, fs.constants.X_OK);
  } catch { cliWrapperOk = false; }
  checks.push({
    name: "cli-wrapper",
    ok: true, // always pass — wrapper is optional (global install or npx work too)
    detail: cliWrapperOk
      ? `CLI wrapper exists: ${cliWrapperPath}`
      : `CLI wrapper not found (optional — use 'npx @phren/cli' instead)`,
  });

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}
