/**
 * Governance files, root file migration, verification, starter templates, bootstrap.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as yaml from "js-yaml";
import {
  atomicWriteText,
  debugLog,
  canonicalLocksFile,
  findProjectNameCaseInsensitive,
  hookConfigPath,
  EXEC_TIMEOUT_QUICK_MS,
  readRootManifest,
  sessionsDir,
  runtimeHealthFile,
  isRecord,
} from "./shared.js";
import { addProjectToProfile, listProfiles, resolveActiveProfile, setMachineProfile } from "./profile-store.js";
import { getMachineName } from "./machine-identity.js";
import { execFileSync } from "child_process";
import {
  GOVERNANCE_SCHEMA_VERSION,
  ensureLocalActorAccess,
} from "./shared-governance.js";
import { STOP_WORDS, errorMessage } from "./utils.js";
import { ROOT, STARTER_DIR, VERSION, resolveEntryScript } from "./init-shared.js";
import { readInstallPreferences } from "./init-preferences.js";
import { TASKS_FILENAME } from "./data-tasks.js";
import {
  getProjectOwnershipDefault,
  parseProjectOwnershipMode,
  readProjectConfig,
  writeProjectConfig,
  type ProjectOwnershipMode,
} from "./project-config.js";
import { getBuiltinTopicConfig, normalizeBuiltinTopicDomain, type BuiltinTopic } from "./project-topics.js";
import { writeSkillMd } from "./link-skills.js";
import { syncScopeSkillsToDir } from "./skill-files.js";

export interface PostInitCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface BootstrapProjectOptions {
  profile?: string;
  ownership?: ProjectOwnershipMode;
}

export interface BootstrapProjectResult {
  project: string;
  ownership: ProjectOwnershipMode;
  claudePath: string | null;
}

export interface LocalGitRepoStatus {
  ok: boolean;
  initialized: boolean;
  detail: string;
}

export type InitProjectDomain =
  | "software"
  | "music"
  | "game"
  | "research"
  | "writing"
  | "creative"
  | "other";

const LEGACY_SAMPLE_PROJECTS = new Set(["my-api", "my-frontend"]);

function normalizeProjects(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => String(entry));
}

function profileLooksRealProject(project: string): boolean {
  return project === "global" || !LEGACY_SAMPLE_PROJECTS.has(project);
}

function pruneLegacySampleProjectsFromProfiles(cortexPath: string): { filesUpdated: number; removed: number } {
  const profilesDir = path.join(cortexPath, "profiles");
  if (!fs.existsSync(profilesDir)) return { filesUpdated: 0, removed: 0 };

  let filesUpdated = 0;
  let removed = 0;
  for (const file of fs.readdirSync(profilesDir)) {
    if (!file.endsWith(".yaml")) continue;
    const fullPath = path.join(profilesDir, file);
    try {
      const parsed = yaml.load(fs.readFileSync(fullPath, "utf8"), { schema: yaml.CORE_SCHEMA });
      if (!isRecord(parsed)) continue;
      const originalProjects = normalizeProjects(parsed.projects);
      const nextProjects = originalProjects.filter(profileLooksRealProject);
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

export function resolvePreferredHomeDir(cortexPath: string): string {
  const scoreAgentFootprint = (candidate: string): number => {
    let score = 0;
    if (fs.existsSync(path.join(candidate, ".claude"))) score += 1;
    if (fs.existsSync(path.join(candidate, ".claude", "settings.json"))) score += 2;
    if (fs.existsSync(path.join(candidate, ".claude", "projects"))) score += 4;
    if (fs.existsSync(path.join(candidate, ".cortex-context.md"))) score += 3;
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

  const candidates = [
    resolvedHome,
    resolvedUserProfile,
    path.resolve(os.homedir()),
    path.resolve(path.dirname(cortexPath)),
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
  const contextFile = path.join(home, ".cortex-context.md");
  if (fs.existsSync(contextFile)) return false;
  atomicWriteText(
    contextFile,
    [
      "<!-- cortex-managed -->",
      "# cortex context",
      "Machine/profile context will be refreshed on the next link/init pass.",
      "<!-- cortex-managed -->",
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
      "Read `~/.cortex-context.md` for profile, active projects, and sync metadata.",
      "",
      "<!-- cortex:projects:start -->",
      "<!-- Auto-generated by cortex init/doctor repair. -->",
      "",
      "## Active Projects",
      "",
      "| Project | What | Memory |",
      "|---------|------|--------|",
      "",
      "<!-- cortex:projects:end -->",
      "",
    ].join("\n"),
  );
  return true;
}

export interface RepairInstallResult {
  profileFilesUpdated: number;
  removedLegacyProjects: number;
  createdContextFile: boolean;
  createdRootMemory: boolean;
  createdGlobalAssets: string[];
  createdRuntimeAssets: string[];
  createdFeatureDefaults: string[];
  createdSkillArtifacts: string[];
}

function ensureGlobalStarterAssets(cortexPath: string): string[] {
  const created: string[] = [];
  const starterGlobal = path.join(STARTER_DIR, "global");
  if (!fs.existsSync(starterGlobal)) return created;

  const targetGlobalDir = path.join(cortexPath, "global");
  fs.mkdirSync(targetGlobalDir, { recursive: true });

  const starterClaude = path.join(starterGlobal, "CLAUDE.md");
  const targetClaude = path.join(targetGlobalDir, "CLAUDE.md");
  if (fs.existsSync(starterClaude) && !fs.existsSync(targetClaude)) {
    fs.copyFileSync(starterClaude, targetClaude);
    created.push("global/CLAUDE.md");
  }

  const starterSkillsDir = path.join(starterGlobal, "skills");
  const targetSkillsDir = path.join(targetGlobalDir, "skills");
  if (fs.existsSync(starterSkillsDir)) {
    fs.mkdirSync(targetSkillsDir, { recursive: true });
    for (const entry of fs.readdirSync(starterSkillsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const source = path.join(starterSkillsDir, entry.name);
      const target = path.join(targetSkillsDir, entry.name);
      if (fs.existsSync(target)) continue;
      fs.copyFileSync(source, target);
      created.push(path.join("global", "skills", entry.name));
    }
  }

  return created;
}

function ensureRuntimeAssets(cortexPath: string): string[] {
  const created: string[] = [];
  const runtimeDir = path.join(cortexPath, ".runtime");
  if (!fs.existsSync(runtimeDir)) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    created.push(".runtime/");
  }

  const sessions = sessionsDir(cortexPath);
  if (!fs.existsSync(sessions)) {
    fs.mkdirSync(sessions, { recursive: true });
    created.push(".sessions/");
  }

  const canonicalLocks = canonicalLocksFile(cortexPath);
  if (!fs.existsSync(canonicalLocks)) {
    atomicWriteText(canonicalLocks, "{}\n");
    created.push(".runtime/canonical-locks.json");
  }

  return created;
}

function ensureDefaultFeatureFlags(cortexPath: string): string[] {
  const created: string[] = [];
  const envPath = path.join(cortexPath, ".env");
  const header = "# cortex feature flags — generated by init\n";
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : header;
  let changed = !fs.existsSync(envPath);
  const lines = content.split("\n");
  const hasAutoCaptureFlag = lines.some((line) => line.trimStart().startsWith("CORTEX_FEATURE_AUTO_CAPTURE="));
  if (!hasAutoCaptureFlag) {
    if (!content.endsWith("\n")) content += "\n";
    content += "CORTEX_FEATURE_AUTO_CAPTURE=1\n";
    changed = true;
    created.push(".env:CORTEX_FEATURE_AUTO_CAPTURE=1");
  }
  if (changed) {
    atomicWriteText(envPath, content);
  }
  return created;
}

function ensureGeneratedSkillArtifacts(cortexPath: string, preferredHome: string): string[] {
  const created: string[] = [];
  const homeClaudeDir = path.join(preferredHome, ".claude");
  const globalSkillsDir = path.join(homeClaudeDir, "skills");
  const manifestPath = path.join(homeClaudeDir, "skill-manifest.json");
  const commandsPath = path.join(homeClaudeDir, "skill-commands.json");
  const hadManifest = fs.existsSync(manifestPath);
  const hadCommands = fs.existsSync(commandsPath);

  try {
    syncScopeSkillsToDir(cortexPath, "global", globalSkillsDir);
    if (!hadManifest && fs.existsSync(manifestPath)) created.push("~/.claude/skill-manifest.json");
    if (!hadCommands && fs.existsSync(commandsPath)) created.push("~/.claude/skill-commands.json");
  } catch (err: unknown) {
    debugLog(`ensureGeneratedSkillArtifacts: global skill mirror sync failed: ${errorMessage(err)}`);
  }

  const skillMdPath = path.join(cortexPath, "cortex.SKILL.md");
  if (!fs.existsSync(skillMdPath)) {
    try {
      writeSkillMd(cortexPath);
      if (fs.existsSync(skillMdPath)) created.push("cortex.SKILL.md");
    } catch (err: unknown) {
      debugLog(`ensureGeneratedSkillArtifacts: writeSkillMd failed: ${errorMessage(err)}`);
    }
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

export function repairPreexistingInstall(cortexPath: string): RepairInstallResult {
  const createdGovernanceAssets = ensureGovernanceFiles(cortexPath);
  const createdGlobalAssets = ensureGlobalStarterAssets(cortexPath);
  const createdRuntimeAssets = [...createdGovernanceAssets, ...ensureRuntimeAssets(cortexPath)];
  const createdFeatureDefaults = ensureDefaultFeatureFlags(cortexPath);
  const profileRepair = pruneLegacySampleProjectsFromProfiles(cortexPath);
  const preferredHome = resolvePreferredHomeDir(cortexPath);
  const createdSkillArtifacts = ensureGeneratedSkillArtifacts(cortexPath, preferredHome);
  return {
    profileFilesUpdated: profileRepair.filesUpdated,
    removedLegacyProjects: profileRepair.removed,
    createdContextFile: ensureGeneratedContextFile(preferredHome),
    createdRootMemory: ensureGeneratedRootMemory(preferredHome),
    createdGlobalAssets,
    createdRuntimeAssets,
    createdFeatureDefaults,
    createdSkillArtifacts,
  };
}

function isExpectedVerifyFailure(cortexPath: string, check: Pick<PostInitCheck, "name" | "ok">): boolean {
  if (check.ok) return false;
  if (check.name === "git-remote") return true;
  const prefs = readInstallPreferences(cortexPath);
  if (check.name === "mcp-config" && prefs.mcpEnabled === false) return true;
  if (check.name === "hooks-registered" && prefs.hooksEnabled === false) return true;
  return false;
}

export function getVerifyOutcomeNote(cortexPath: string, checks: PostInitCheck[]): string | null {
  const failures = checks.filter((check) => !check.ok);
  if (failures.length === 0) return null;
  const expectedFailures = failures.filter((check) => isExpectedVerifyFailure(cortexPath, check));
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

function commandVersion(cmd: string, args: string[] = ["--version"]): string | null {
  const effectiveCmd = process.platform === "win32" && (cmd === "npm" || cmd === "npx") ? `${cmd}.cmd` : cmd;
  try {
    return execFileSync(effectiveCmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32" && effectiveCmd.endsWith(".cmd"),
      timeout: EXEC_TIMEOUT_QUICK_MS,
    }).trim();
  } catch (err: unknown) {
    debugLog(`commandVersion ${effectiveCmd} failed: ${errorMessage(err)}`);
    return null;
  }
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
    fix: hookEntrypointOk ? undefined : "Rebuild cortex: `npm run build` or reinstall the package, and ensure npm/npx is available for hook fallbacks",
  };
}

function parseSemverTriple(raw: string): [number, number, number] | null {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)];
}

function versionAtLeast(raw: string | null, major: number, minor: number = 0): boolean {
  if (!raw) return false;
  const parsed = parseSemverTriple(raw);
  if (!parsed) return false;
  const [m, n] = parsed;
  if (m !== major) return m > major;
  return n >= minor;
}

function nearestWritableTarget(filePath: string): boolean {
  let probe = fs.existsSync(filePath) ? filePath : path.dirname(filePath);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  try {
    fs.accessSync(probe, fs.constants.W_OK);
    return true;
  } catch (err: unknown) {
    debugLog(`nearestWritableTarget failed for ${filePath}: ${errorMessage(err)}`);
    return false;
  }
}

function gitRemoteStatus(cortexPath: string): { ok: boolean; detail: string } {
  try {
    execFileSync("git", ["-C", cortexPath, "rev-parse", "--is-inside-work-tree"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    });
  } catch {
    return { ok: false, detail: "cortex path is not a git repository" };
  }
  try {
    const remote = execFileSync("git", ["-C", cortexPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    }).trim();
    return remote ? { ok: true, detail: `origin=${remote}` } : { ok: false, detail: "git origin remote not configured" };
  } catch {
    return { ok: false, detail: "git origin remote not configured" };
  }
}

function copyStarterFile(cortexPath: string, src: string, dest: string): string | null {
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

  const relative = path.relative(cortexPath, dest);
  const stagingDir = path.join(cortexPath, ".runtime", "starter-updates", path.dirname(relative));
  fs.mkdirSync(stagingDir, { recursive: true });
  const currentPath = path.join(stagingDir, `${path.basename(dest)}.current`);
  const stagedPath = path.join(stagingDir, `${path.basename(dest)}.new`);
  fs.copyFileSync(dest, currentPath);
  fs.copyFileSync(src, stagedPath);
  return stagedPath;
}

export function applyStarterTemplateUpdates(cortexPath: string): string[] {
  const updates: string[] = [];
  const starterGlobal = path.join(STARTER_DIR, "global");
  if (!fs.existsSync(starterGlobal)) return updates;

  const starterClaude = path.join(starterGlobal, "CLAUDE.md");
  const targetClaude = path.join(cortexPath, "global", "CLAUDE.md");
  if (fs.existsSync(starterClaude)) {
    const written = copyStarterFile(cortexPath, starterClaude, targetClaude);
    if (written) updates.push(path.relative(cortexPath, written));
  }

  const starterSkillsDir = path.join(starterGlobal, "skills");
  const targetSkillsDir = path.join(cortexPath, "global", "skills");
  if (fs.existsSync(starterSkillsDir)) {
    fs.mkdirSync(targetSkillsDir, { recursive: true });
    for (const f of fs.readdirSync(starterSkillsDir, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      const written = copyStarterFile(cortexPath, path.join(starterSkillsDir, f.name), path.join(targetSkillsDir, f.name));
      if (written) updates.push(path.relative(cortexPath, written));
    }
  }

  return updates;
}

export function ensureGovernanceFiles(cortexPath: string): string[] {
  const created: string[] = [];
  const govDir = path.join(cortexPath, ".governance");
  if (!fs.existsSync(govDir)) created.push(".governance/");
  fs.mkdirSync(govDir, { recursive: true });
  const sv = GOVERNANCE_SCHEMA_VERSION;
  const policy = path.join(govDir, "retention-policy.json");
  const access = path.join(govDir, "access-control.json");
  const workflow = path.join(govDir, "workflow-policy.json");
  const indexPolicy = path.join(govDir, "index-policy.json");
  const runtimeHealth = runtimeHealthFile(cortexPath);

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
    created.push(".governance/retention-policy.json");
  }
  if (!fs.existsSync(access)) {
    atomicWriteText(
      access,
      JSON.stringify({
        schemaVersion: sv,
        admins: [],
        maintainers: [],
        contributors: [],
        viewers: [],
      }, null, 2) + "\n"
    );
    created.push(".governance/access-control.json");
  }
  if (!fs.existsSync(workflow)) {
    atomicWriteText(
      workflow,
      JSON.stringify({
        schemaVersion: sv,
        requireMaintainerApproval: false,
        lowConfidenceThreshold: 0.7,
        riskySections: ["Stale", "Conflicts"],
        taskMode: "auto",
      }, null, 2) + "\n"
    );
    created.push(".governance/workflow-policy.json");
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
    created.push(".governance/index-policy.json");
  }
  ensureLocalActorAccess(cortexPath);

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
      const src = path.join(srcDir, entry.name);
      const dest = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        copyTemplateDir(src, dest);
      } else {
        let content = fs.readFileSync(src, "utf8");
        content = content.replace(/\{\{project\}\}/g, projectName);
        content = content.replace(/\{\{date\}\}/g, new Date().toISOString().slice(0, 10));
        atomicWriteText(dest, content);
      }
    }
  }
  copyTemplateDir(templateDir, projectDir);
  return true;
}

export interface InferredInitScaffold {
  domain: InitProjectDomain;
  topics: BuiltinTopic[];
  referenceHints: string[];
  commandHints: string[];
  confidence: number;
  reason: string;
}

type DomainScoreMap = Record<InitProjectDomain, number>;

const DOMAIN_KEYWORD_HINTS: Record<Exclude<InitProjectDomain, "other">, string[]> = {
  software: [
    "api", "backend", "frontend", "typescript", "javascript", "python", "rust", "golang", "cli", "sdk", "library", "service",
    "server", "database", "auth", "module", "package", "build", "test", "deploy",
  ],
  music: [
    "music", "audio", "mix", "master", "track", "daw", "synth", "midi", "song", "composition", "arrangement", "producer",
  ],
  game: [
    "game", "gameplay", "level", "shader", "physics", "npc", "engine", "unity", "godot", "unreal", "sprite", "multiplayer",
  ],
  research: [
    "research", "paper", "study", "experiment", "dataset", "analysis", "methodology", "hypothesis", "results", "evaluation",
  ],
  writing: [
    "writing", "manuscript", "chapter", "outline", "narrative", "character", "plot", "draft", "editorial",
  ],
  creative: [
    "creative", "story", "design", "worldbuilding", "script", "concept", "illustration", "art direction",
  ],
};

const DOMAIN_CONFIG_HINTS: Record<string, Partial<Record<InitProjectDomain, number>>> = {
  "package.json": { software: 3 },
  "tsconfig.json": { software: 3 },
  "Cargo.toml": { software: 4, game: 1 },
  "pyproject.toml": { software: 3, research: 1 },
  "requirements.txt": { software: 2, research: 1 },
  "go.mod": { software: 3 },
  "CMakeLists.txt": { software: 3, game: 1 },
  "pom.xml": { software: 3 },
  "build.gradle": { software: 3 },
  "project.godot": { game: 5 },
  ".uproject": { game: 5 },
  "paper.tex": { research: 4, writing: 1 },
  "references.bib": { research: 4 },
};

const EXTENSION_DOMAIN_HINTS: Record<string, Partial<Record<InitProjectDomain, number>>> = {
  ".ts": { software: 1 },
  ".tsx": { software: 1, game: 1 },
  ".js": { software: 1 },
  ".jsx": { software: 1 },
  ".py": { software: 1, research: 1 },
  ".rs": { software: 1, game: 1 },
  ".go": { software: 1 },
  ".java": { software: 1 },
  ".kt": { software: 1 },
  ".swift": { software: 1 },
  ".c": { software: 1, game: 1 },
  ".cc": { software: 1, game: 1 },
  ".cpp": { software: 1, game: 1 },
  ".h": { software: 1, game: 1 },
  ".hpp": { software: 1, game: 1 },
  ".cs": { software: 1, game: 1 },
  ".ipynb": { research: 2 },
  ".tex": { research: 2, writing: 1 },
  ".bib": { research: 2 },
  ".wav": { music: 2 },
  ".mp3": { music: 2 },
  ".flac": { music: 2 },
  ".mid": { music: 2 },
  ".midi": { music: 2 },
  ".als": { music: 2 },
  ".logicx": { music: 2 },
  ".unity": { game: 2 },
  ".gd": { game: 2 },
  ".glsl": { game: 2 },
};

interface RepoScanSignal {
  domainScores: DomainScoreMap;
  terms: Map<string, number>;
  docsText: string;
  referenceHints: string[];
  commandHints: string[];
  usefulSignals: number;
}

function titleCase(text: string): string {
  return text
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((token) => token.slice(0, 1).toUpperCase() + token.slice(1))
    .join(" ");
}

function addTermCount(terms: Map<string, number>, rawText: string, weight: number = 1): void {
  const tokens = rawText
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && token.length <= 48 && !STOP_WORDS.has(token));
  for (const token of tokens) {
    terms.set(token, (terms.get(token) ?? 0) + weight);
  }
}

function maybeReadUtf8(filePath: string, maxBytes = 256_000): string {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function addDomainScores(target: DomainScoreMap, patch: Partial<Record<InitProjectDomain, number>>, weight = 1): void {
  for (const [domain, score] of Object.entries(patch)) {
    const typedDomain = domain as InitProjectDomain;
    target[typedDomain] += (score ?? 0) * weight;
  }
}

function scoreTopicsFromTerms(domain: InitProjectDomain, terms: Map<string, number>, docsText: string): BuiltinTopic[] {
  const baseTopics = getBuiltinTopicConfig(domain);
  const scored = baseTopics
    .filter((topic) => topic.name.toLowerCase() !== "general")
    .map((topic) => {
      const baseTerm = topic.name.toLowerCase();
      let score = terms.get(baseTerm) ?? 0;
      for (const keyword of topic.keywords) {
        const normalized = keyword.toLowerCase().trim();
        if (!normalized) continue;
        score += terms.get(normalized) ?? 0;
        if (normalized.includes(" ") && docsText.includes(normalized)) score += 1;
      }
      return { topic, score };
    });

  const ranked = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.topic.name.localeCompare(b.topic.name));

  const takenNames = new Set(baseTopics.map((topic) => topic.name.toLowerCase()));
  const customTopics: BuiltinTopic[] = [];
  for (const [term, count] of [...terms.entries()].sort((a, b) => b[1] - a[1])) {
    if (customTopics.length >= 4) break;
    if (count < 3) break;
    if (term.includes("_")) continue;
    const topicName = titleCase(term);
    const normalizedName = topicName.toLowerCase();
    if (takenNames.has(normalizedName)) continue;
    if (DOMAIN_KEYWORD_HINTS.software.includes(term) || DOMAIN_KEYWORD_HINTS.music.includes(term) || DOMAIN_KEYWORD_HINTS.game.includes(term)) {
      continue;
    }
    takenNames.add(normalizedName);
    customTopics.push({
      name: topicName,
      description: "Suggested from repeated terminology in project docs.",
      keywords: [term],
    });
  }

  if (ranked.length === 0 && customTopics.length === 0) return baseTopics;

  const orderedBase = [
    ...ranked.map((entry) => entry.topic),
    ...baseTopics.filter((topic) =>
      topic.name.toLowerCase() !== "general"
      && !ranked.some((entry) => entry.topic.name === topic.name)
    ),
  ];
  const topics = [...orderedBase.slice(0, 8), ...customTopics];
  if (!topics.some((topic) => topic.name.toLowerCase() === "general")) {
    topics.push({ name: "General", description: "Fallback bucket for uncategorized findings.", keywords: [] });
  }
  return topics;
}

export function inferInitScaffoldFromRepo(repoRoot: string, fallbackDomain: InitProjectDomain = "software"): InferredInitScaffold | null {
  const resolvedRoot = path.resolve(repoRoot);
  if (!fs.existsSync(resolvedRoot)) return null;

  const signal: RepoScanSignal = {
    domainScores: { software: 0, music: 0, game: 0, research: 0, writing: 0, creative: 0, other: 0 },
    terms: new Map<string, number>(),
    docsText: "",
    referenceHints: [],
    commandHints: [],
    usefulSignals: 0,
  };
  const skipDirs = new Set([".git", ".cortex", "node_modules", "dist", "build", "coverage", ".next", ".turbo", "target"]);

  const packageJsonPath = path.join(resolvedRoot, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    signal.usefulSignals++;
    addDomainScores(signal.domainScores, DOMAIN_CONFIG_HINTS["package.json"]);
    try {
      const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      if (typeof parsed.description === "string") {
        addTermCount(signal.terms, parsed.description, 3);
        signal.docsText += ` ${parsed.description.toLowerCase()}`;
      }
      if (Array.isArray(parsed.keywords)) {
        for (const keyword of parsed.keywords) {
          if (typeof keyword === "string") {
            addTermCount(signal.terms, keyword, 3);
            signal.docsText += ` ${keyword.toLowerCase()}`;
          }
        }
      }
      if (parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)) {
        const scriptObject = parsed.scripts as Record<string, unknown>;
        for (const scriptName of ["dev", "start", "build", "test", "lint"]) {
          if (typeof scriptObject[scriptName] === "string") {
            signal.commandHints.push(`npm run ${scriptName}`);
          }
        }
      }
    } catch (err: unknown) {
      debugLog(`inferInitScaffoldFromRepo package.json parse failed: ${errorMessage(err)}`);
    }
  }

  const topLevelConfigs = Object.keys(DOMAIN_CONFIG_HINTS)
    .filter((fileName) => fs.existsSync(path.join(resolvedRoot, fileName)));
  for (const configName of topLevelConfigs) {
    signal.usefulSignals++;
    const configScore = DOMAIN_CONFIG_HINTS[configName];
    if (configScore) addDomainScores(signal.domainScores, configScore);
  }

  const readmeCandidates = [
    path.join(resolvedRoot, "README.md"),
    path.join(resolvedRoot, "readme.md"),
  ];
  for (const readmePath of readmeCandidates) {
    if (!fs.existsSync(readmePath)) continue;
    const content = maybeReadUtf8(readmePath);
    if (!content) continue;
    signal.usefulSignals++;
    signal.referenceHints.push(path.relative(resolvedRoot, readmePath));
    addTermCount(signal.terms, content, 2);
    signal.docsText += ` ${content.toLowerCase()}`;
    break;
  }

  const docsDir = path.join(resolvedRoot, "docs");
  if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
    signal.referenceHints.push("docs/");
    for (const entry of fs.readdirSync(docsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(md|txt|rst)$/i.test(entry.name)) continue;
      const docsContent = maybeReadUtf8(path.join(docsDir, entry.name));
      if (!docsContent) continue;
      signal.usefulSignals++;
      addTermCount(signal.terms, docsContent, 1);
      signal.docsText += ` ${docsContent.toLowerCase()}`;
    }
  }

  for (const folderName of ["reference", "specs", "design", "architecture", "src", "packages", "apps"]) {
    const fullPath = path.join(resolvedRoot, folderName);
    if (fs.existsSync(fullPath)) {
      signal.referenceHints.push(`${folderName}/`);
    }
  }

  let scannedFiles = 0;
  const maxFiles = 3000;
  const walk = (dir: string): void => {
    if (scannedFiles >= maxFiles) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (scannedFiles >= maxFiles) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      scannedFiles++;
      const ext = path.extname(entry.name).toLowerCase();
      if (!ext) continue;
      const extScore = EXTENSION_DOMAIN_HINTS[ext];
      if (extScore) {
        addDomainScores(signal.domainScores, extScore);
        signal.usefulSignals++;
      }
    }
  };
  walk(resolvedRoot);

  for (const [domain, hints] of Object.entries(DOMAIN_KEYWORD_HINTS)) {
    for (const hint of hints) {
      const hitCount = signal.terms.get(hint) ?? 0;
      if (hitCount > 0) {
        signal.domainScores[domain as InitProjectDomain] += Math.min(4, hitCount);
        signal.usefulSignals++;
      }
    }
  }

  const rankedDomains = Object.entries(signal.domainScores)
    .sort((a, b) => b[1] - a[1]) as Array<[InitProjectDomain, number]>;
  const [bestDomain, bestScore] = rankedDomains[0] ?? [fallbackDomain, 0];
  const secondScore = rankedDomains[1]?.[1] ?? 0;
  const inferredDomain = bestScore >= 2 ? bestDomain : fallbackDomain;
  const confidence = bestScore <= 0
    ? 0
    : Math.max(0.15, Math.min(0.98, (bestScore - secondScore + 1) / (bestScore + 2)));

  const topics = scoreTopicsFromTerms(inferredDomain, signal.terms, signal.docsText);
  const references = Array.from(new Set(signal.referenceHints)).slice(0, 8);
  const commands = Array.from(new Set(signal.commandHints)).slice(0, 5);
  const reason = bestScore > 0
    ? `inferred from repo files, config, and docs terminology (score ${bestScore})`
    : "fallback defaults";

  if (signal.usefulSignals === 0) return null;
  return {
    domain: inferredDomain,
    topics: topics.length > 0 ? topics : getBuiltinTopicConfig(inferredDomain),
    referenceHints: references,
    commandHints: commands,
    confidence: Number(confidence.toFixed(2)),
    reason,
  };
}

function appendInferredSections(base: string, inference?: InferredInitScaffold | null): string {
  if (!inference) return base;
  const lines: string[] = [];
  if (inference.referenceHints.length > 0) {
    lines.push("## Reference Structure");
    for (const hint of inference.referenceHints) {
      lines.push(`- ${hint}`);
    }
    lines.push("");
  }
  if (inference.topics.length > 0) {
    lines.push("## Initial Focus Topics");
    for (const topic of inference.topics.slice(0, 6)) {
      lines.push(`- ${topic.name}: ${topic.description}`);
    }
    lines.push("");
  }
  if (inference.commandHints.length > 0) {
    lines.push("## Commands");
    lines.push("```bash");
    for (const cmd of inference.commandHints) lines.push(cmd);
    lines.push("```");
    lines.push("");
  }
  return lines.length > 0 ? `${base.trimEnd()}\n\n${lines.join("\n")}` : base;
}

function getDomainClaudeTemplate(projectName: string, domain: InitProjectDomain, inference?: InferredInitScaffold | null): string {
  if (domain === "software") {
    return appendInferredSections(
      `# ${projectName}\n\nOne paragraph about what this project is.\n\n## Commands\n\n\`\`\`bash\n# Install:\n# Run:\n# Test:\n\`\`\`\n`,
      inference
    );
  }
  if (domain === "music") {
    return appendInferredSections(
      `# ${projectName}\n\nThis is a music project. Keep notes on composition intent, arrangement choices, production workflow, and mixing/mastering decisions.\n\n## Session Focus\n\n- Capture creative intent before technical tweaks\n- Track instrument/sound-design decisions and why\n- Log mix/master changes with listening context\n`,
      inference
    );
  }
  if (domain === "game") {
    return appendInferredSections(
      `# ${projectName}\n\nThis is a game project. Prioritize clear notes on mechanics, rendering/performance tradeoffs, level and UI decisions, and iteration outcomes.\n\n## Development Focus\n\n- Record gameplay/mechanics decisions with player impact\n- Track rendering/physics/AI issues with repro context\n- Note level-design and networking constraints early\n`,
      inference
    );
  }
  if (domain === "research") {
    return appendInferredSections(
      `# ${projectName}\n\nThis is a research project. Focus on methodology, source quality, analysis assumptions, and review feedback loops.\n\n## Working Approach\n\n- Document hypotheses and evaluation criteria explicitly\n- Track source provenance and confidence level\n- Record analysis decisions and revision rationale\n`,
      inference
    );
  }
  if (domain === "writing" || domain === "creative") {
    return appendInferredSections(
      `# ${projectName}\n\nThis is a creative writing project. Track worldbuilding rules, character arcs, plot structure, style constraints, and revision decisions.\n\n## Writing Workflow\n\n- Keep narrative intent and tone constraints visible\n- Capture character/plot changes with consequences\n- Log revision notes and unresolved questions\n`,
      inference
    );
  }
  return appendInferredSections(
    `# ${projectName}\n\nThis project is not software-first. Keep practical notes, references, and task decisions so future sessions can resume quickly.\n\n## Workflow\n\n- Capture non-obvious lessons and reusable patterns\n- Keep references curated and current\n- Track active tasks and follow-ups\n`,
    inference
  );
}

export function ensureProjectScaffold(
  projectDir: string,
  projectName: string,
  domain: InitProjectDomain = "software",
  inference?: InferredInitScaffold | null,
): void {
  const normalizedDomain = normalizeBuiltinTopicDomain(inference?.domain ?? domain);
  const inferredTopics = Array.isArray(inference?.topics) && inference.topics.length > 0
    ? inference.topics
    : getBuiltinTopicConfig(normalizedDomain);
  fs.mkdirSync(projectDir, { recursive: true });

  if (!fs.existsSync(path.join(projectDir, "summary.md"))) {
    atomicWriteText(
      path.join(projectDir, "summary.md"),
      `# ${projectName}\n\n**What:** Replace this with one sentence about what the project does\n**Stack:** The key tech\n**Status:** active\n**Run:** the command you use most\n**Watch out:** the one thing that will bite you if you forget\n`
    );
  }

  if (!fs.existsSync(path.join(projectDir, "CLAUDE.md"))) {
    atomicWriteText(
      path.join(projectDir, "CLAUDE.md"),
      getDomainClaudeTemplate(projectName, inference?.domain ?? domain, inference)
    );
  }

  if (!fs.existsSync(path.join(projectDir, "topic-config.json"))) {
    atomicWriteText(
      path.join(projectDir, "topic-config.json"),
      JSON.stringify({ version: 1, domain: normalizedDomain, topics: inferredTopics }, null, 2) + "\n"
    );
  }

  if (!fs.existsSync(path.join(projectDir, "FINDINGS.md"))) {
    atomicWriteText(
      path.join(projectDir, "FINDINGS.md"),
      `# ${projectName} FINDINGS\n\n<!-- Findings are captured automatically during sessions and committed on exit -->\n`
    );
  }

  if (!fs.existsSync(path.join(projectDir, TASKS_FILENAME))) {
    atomicWriteText(
      path.join(projectDir, TASKS_FILENAME),
      `# ${projectName} tasks\n\n## Active\n\n## Queue\n\n## Done\n`
    );
  }
}

export function ensureLocalGitRepo(cortexPath: string): LocalGitRepoStatus {
  try {
    execFileSync("git", ["-C", cortexPath, "rev-parse", "--is-inside-work-tree"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    });
    return { ok: true, initialized: false, detail: "existing git repo" };
  } catch {
    // Fall through to initialization below.
  }

  try {
    try {
      execFileSync("git", ["-C", cortexPath, "init", "--initial-branch=main"], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: EXEC_TIMEOUT_QUICK_MS,
      });
    } catch {
      execFileSync("git", ["-C", cortexPath, "init"], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: EXEC_TIMEOUT_QUICK_MS,
      });
      try {
        execFileSync("git", ["-C", cortexPath, "branch", "-M", "main"], {
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

/** Bootstrap a cortex project from an existing project directory with CLAUDE.md.
 * @param profile - if provided, only this profile YAML is updated (avoids leaking project to unrelated profiles).
 */
export function bootstrapFromExisting(
  cortexPath: string,
  projectPath: string,
  opts: string | BootstrapProjectOptions = {}
): BootstrapProjectResult {
  const profile = typeof opts === "string" ? opts : opts.profile;
  const resolvedPath = path.resolve(projectPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Path does not exist: ${resolvedPath}`);
  }
  const manifest = readRootManifest(cortexPath);
  const isProjectLocal = manifest?.installMode === "project-local";
  const sourceRoot = isProjectLocal ? path.resolve(manifest.workspaceRoot || resolvedPath) : resolvedPath;
  if (isProjectLocal) {
    const matchesWorkspace = resolvedPath === sourceRoot || resolvedPath.startsWith(sourceRoot + path.sep);
    if (!matchesWorkspace) {
      throw new Error(`Project-local cortex can only enroll the owning workspace: ${sourceRoot}`);
    }
  }

  let claudeMdPath: string | null = null;
  const candidates = [
    path.join(sourceRoot, "CLAUDE.md"),
    path.join(sourceRoot, ".claude", "CLAUDE.md"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      claudeMdPath = c;
      break;
    }
  }

  const claudeContent = claudeMdPath ? fs.readFileSync(claudeMdPath, "utf8") : null;
  const projectName = isProjectLocal
    ? String(manifest?.primaryProject)
    : path.basename(sourceRoot).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const existingProject = findProjectNameCaseInsensitive(cortexPath, projectName);
  if (existingProject && existingProject !== projectName) {
    throw new Error(
      `Project "${existingProject}" already exists with different casing. Refusing to bootstrap "${projectName}" because it would split the same project on case-sensitive filesystems.`
    );
  }
  const projDir = path.join(cortexPath, projectName);
  fs.mkdirSync(projDir, { recursive: true });
  const inferredScaffold = inferInitScaffoldFromRepo(sourceRoot);
  const existingConfig = readProjectConfig(cortexPath, projectName);
  const ownership = typeof opts === "string"
    ? (parseProjectOwnershipMode(existingConfig.ownership) ?? getProjectOwnershipDefault(cortexPath))
    : (opts.ownership ?? parseProjectOwnershipMode(existingConfig.ownership) ?? getProjectOwnershipDefault(cortexPath));

  const claudePath = path.join(projDir, "CLAUDE.md");
  if (ownership !== "repo-managed") {
    if (claudeContent) {
      if (!fs.existsSync(claudePath)) {
        atomicWriteText(claudePath, claudeContent);
      }
    } else {
      // No CLAUDE.md found — create a starter one
      if (!fs.existsSync(claudePath)) {
        atomicWriteText(
          claudePath,
          getDomainClaudeTemplate(projectName, inferredScaffold?.domain ?? "software", inferredScaffold)
        );
      }
    }
  }

  const summaryLines: string[] = [];
  if (claudeContent) {
    const lines = claudeContent.split("\n");
    let foundHeading = false;
    for (const line of lines) {
      if (line.startsWith("# ") && !foundHeading) {
        foundHeading = true;
        summaryLines.push(line);
        continue;
      }
      if (foundHeading && line.trim() === "") {
        if (summaryLines.length > 1) break;
        continue;
      }
      if (foundHeading && summaryLines.length < 10) {
        summaryLines.push(line);
      }
    }
  }

  const sourceInfo = claudeMdPath ? `**Source CLAUDE.md:** ${claudeMdPath}` : `**Source:** ${sourceRoot}`;
  const summaryPath = path.join(projDir, "summary.md");
  if (!fs.existsSync(summaryPath)) {
    atomicWriteText(
      summaryPath,
      `# ${projectName}\n\n**What:** Bootstrapped from ${sourceRoot}\n${sourceInfo}\n\n${summaryLines.length > 1 ? summaryLines.slice(1).join("\n") : ""}\n`
    );
  }

  if (!fs.existsSync(path.join(projDir, "FINDINGS.md"))) {
    atomicWriteText(
      path.join(projDir, "FINDINGS.md"),
      `# ${projectName} FINDINGS\n\n<!-- Bootstrapped from ${sourceRoot} -->\n`
    );
  }
  if (!fs.existsSync(path.join(projDir, TASKS_FILENAME))) {
    atomicWriteText(
      path.join(projDir, TASKS_FILENAME),
      `# ${projectName} tasks\n\n## Active\n\n## Queue\n\n## Done\n`
    );
  }
  if (!fs.existsSync(path.join(projDir, "topic-config.json"))) {
    const inferredDomain = normalizeBuiltinTopicDomain(inferredScaffold?.domain ?? "software");
    const inferredTopics = inferredScaffold?.topics?.length
      ? inferredScaffold.topics
      : getBuiltinTopicConfig(inferredDomain);
    atomicWriteText(
      path.join(projDir, "topic-config.json"),
      JSON.stringify({ version: 1, domain: inferredDomain, topics: inferredTopics }, null, 2) + "\n"
    );
  }

  const activeProfile = resolveActiveProfile(cortexPath, profile);
  if (activeProfile.ok && activeProfile.data) {
    const addResult = addProjectToProfile(cortexPath, activeProfile.data, projectName);
    if (!addResult.ok) {
      throw new Error(addResult.error);
    }
  } else if (!activeProfile.ok && activeProfile.code !== "FILE_NOT_FOUND") {
    throw new Error(activeProfile.error);
  }

  writeProjectConfig(cortexPath, projectName, { ownership, sourcePath: sourceRoot });

  return {
    project: projectName,
    ownership,
    claudePath: ownership === "repo-managed"
      ? (claudeMdPath ?? null)
      : (fs.existsSync(claudePath) ? claudePath : null),
  };
}

export function updateMachinesYaml(cortexPath: string, machine?: string, profile?: string) {
  const machinesFile = path.join(cortexPath, "machines.yaml");
  if (!fs.existsSync(machinesFile)) return;
  const machineName = (machine?.trim() || getMachineName()).trim();
  if (!machineName) return;
  const activeProfile = resolveActiveProfile(cortexPath, profile);
  const profileName = profile?.trim() || (activeProfile.ok ? (activeProfile.data || "") : "") || "personal";

  let hasExistingMapping = false;
  try {
    const loaded = yaml.load(fs.readFileSync(machinesFile, "utf8"), { schema: yaml.CORE_SCHEMA });
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
      hasExistingMapping = Object.prototype.hasOwnProperty.call(loaded, machineName);
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] updateMachinesYaml parse: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // Passive init/link refreshes should keep an existing mapping; explicit overrides can remap.
  if (hasExistingMapping && !machine && !profile) return;
  const mapping = setMachineProfile(cortexPath, machineName, profileName);
  if (!mapping.ok && process.env.CORTEX_DEBUG) {
    process.stderr.write(`[cortex] updateMachinesYaml setMachineProfile: ${mapping.error}\n`);
  }
}

/**
 * Detect if a directory looks like a project that should be bootstrapped.
 * Returns the path if it qualifies, null otherwise.
 * A directory qualifies if it:
 * - Is not the home directory or cortex directory
 * - Has a CLAUDE.md, AGENTS.md, .claude/CLAUDE.md, or .git directory
 */
export function detectProjectDir(dir: string, cortexPath: string): string | null {
  const home = os.homedir();
  const resolvedCortexPath = path.resolve(cortexPath);
  let current = path.resolve(dir);
  while (true) {
    if (current === home || current === resolvedCortexPath) return null;
    if (current.startsWith(resolvedCortexPath + path.sep)) return null;
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
export function isProjectTracked(cortexPath: string, projectName: string, profile?: string): boolean {
  const profiles = listProfiles(cortexPath);
  if (profiles.ok) {
    if (profile) {
      return profiles.data.some((entry) => entry.name === profile && entry.projects.includes(projectName));
    }
    return profiles.data.some((entry) => entry.projects.includes(projectName));
  }
  const projDir = path.join(cortexPath, projectName);
  return fs.existsSync(projDir);
}

export function runPostInitVerify(cortexPath: string): { ok: boolean; checks: PostInitCheck[] } {
  const checks: PostInitCheck[] = [];
  const prefs = readInstallPreferences(cortexPath);
  const manifest = readRootManifest(cortexPath);
  const gitVersion = commandVersion("git");
  const nodeVersion = commandVersion("node");
  checks.push({
    name: "git-installed",
    ok: Boolean(gitVersion),
    detail: gitVersion || "git not found in PATH",
    fix: gitVersion ? undefined : "Install git and re-run `cortex init`.",
  });
  checks.push({
    name: "node-version",
    ok: versionAtLeast(nodeVersion, 20),
    detail: nodeVersion || "node not found in PATH",
    fix: versionAtLeast(nodeVersion, 20) ? undefined : "Install Node.js 20+ before using cortex.",
  });

  if (manifest?.installMode === "project-local") {
    checks.push({
      name: "workspace-root",
      ok: Boolean(manifest.workspaceRoot && fs.existsSync(manifest.workspaceRoot)),
      detail: manifest.workspaceRoot ? `workspace root: ${manifest.workspaceRoot}` : "workspaceRoot missing from cortex.root.yaml",
      fix: manifest.workspaceRoot ? undefined : "Re-run `cortex init --mode project-local` to repair the root manifest.",
    });
    checks.push({
      name: "hooks-registered",
      ok: prefs.hooksEnabled === false,
      detail: "hooks are unsupported in project-local mode",
      fix: prefs.hooksEnabled === false ? undefined : "Run `cortex hooks-mode off` and keep hooks disabled in project-local mode.",
    });
    const workspaceMcp = manifest.workspaceRoot ? path.join(manifest.workspaceRoot, ".vscode", "mcp.json") : "";
    let workspaceMcpOk = false;
    try {
      if (workspaceMcp && fs.existsSync(workspaceMcp)) {
        const cfg = JSON.parse(fs.readFileSync(workspaceMcp, "utf8"));
        workspaceMcpOk = Boolean(cfg.servers?.cortex);
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
      fix: prefs.mcpEnabled === false ? undefined : "Run `cortex mcp-mode on` to register the VS Code workspace server.",
    });
  } else {

    const gitRemote = gitRemoteStatus(cortexPath);
    const gitRemoteDetail = gitRemote.ok
      ? gitRemote.detail
      : `${gitRemote.detail} (optional unless you want cross-machine sync)`;
    checks.push({
      name: "git-remote",
      ok: gitRemote.ok,
      detail: gitRemoteDetail,
      fix: gitRemote.ok ? undefined : "Optional: initialize a repo and add an origin remote for cross-machine sync.",
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
      mcpOk = Boolean(cfg.mcpServers?.cortex);
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
          ? "Optional: run `cortex mcp-mode on` or `cortex init` if you want MCP enabled."
          : "Run `cortex init` to register the MCP server",
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
          ? "Optional: run `cortex hooks-mode on` or `cortex init` if you want hooks enabled."
          : "Run `cortex init` to install or refresh hooks",
    });
  }

  const globalClaude = path.join(cortexPath, "global", "CLAUDE.md");
  const globalOk = fs.existsSync(globalClaude);
  checks.push({
    name: "global-claude",
    ok: globalOk,
    detail: globalOk ? "global/CLAUDE.md exists" : "global/CLAUDE.md missing",
    fix: globalOk ? undefined : "Run `cortex init` to create starter files",
  });

  const govDir = path.join(cortexPath, ".governance");
  const govOk = fs.existsSync(govDir);
  checks.push({
    name: "config",
    ok: govOk,
    detail: govOk ? ".governance/ config directory exists" : ".governance/ config directory missing",
    fix: govOk ? undefined : "Run `cortex init` to create governance config",
  });

  const installedPrefs = readInstallPreferences(cortexPath);
  const installedVersion = installedPrefs.installedVersion;
  const versionOk = !govOk || installedVersion === VERSION;
  checks.push({
    name: "installed-version",
    ok: versionOk,
    detail: installedVersion
      ? (versionOk ? `install metadata matches running version (${VERSION})` : `install metadata is ${installedVersion}, runtime is ${VERSION}`)
      : "install metadata missing installedVersion",
    fix: versionOk ? undefined : "Run `cortex update` or `cortex init` to refresh install metadata.",
  });

  let ftsOk = false;
  try {
    const entries = fs.readdirSync(cortexPath, { withFileTypes: true });
    ftsOk = entries.some(d => d.isDirectory() && !d.name.startsWith("."));
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] runPostInitVerify projectScan: ${err instanceof Error ? err.message : String(err)}\n`);
    ftsOk = false;
  }
  checks.push({
    name: "fts-index",
    ok: ftsOk,
    detail: ftsOk ? "Project directories found for indexing" : "No project directories found in cortex path",
    fix: ftsOk ? undefined : "Create a project: `cd ~/your-project && cortex add`",
  });

  checks.push(getHookEntrypointCheck());

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}
