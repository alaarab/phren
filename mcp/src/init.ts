/**
 * CLI orchestrator for phren init, mcp-mode, hooks-mode, and uninstall.
 * Delegates to focused helpers in init-config, init-setup, and init-preferences.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { configureAllHooks } from "./hooks.js";
import { getMachineName, machineFilePath, persistMachineName } from "./machine-identity.js";
import {
  atomicWriteText,
  debugLog,
  isRecord,
  hookConfigPath,
  homeDir,
  homePath,
  expandHomePath,
  findPhrenPath,
  getProjectDirs,
  readRootManifest,
  writeRootManifest,
  type InstallMode,
} from "./shared.js";
import { isValidProjectName, errorMessage } from "./utils.js";
import {
  codexJsonCandidates,
  copilotMcpCandidates,
  cursorMcpCandidates,
  vscodeMcpCandidates,
} from "./provider-adapters.js";

// Re-export everything consumers need from the helper modules
export type { McpConfigStatus, McpRootKey, ToolStatus } from "./init-config.js";
export {
  configureClaude,
  configureVSCode,
  configureCursorMcp,
  configureCopilotMcp,
  configureCodexMcp,
  logMcpTargetStatus,
  resetVSCodeProbeCache,
  patchJsonFile,
} from "./init-config.js";

export type { InstallPreferences } from "./init-preferences.js";
export {
  getMcpEnabledPreference,
  setMcpEnabledPreference,
  getHooksEnabledPreference,
  setHooksEnabledPreference,
} from "./init-preferences.js";
export {
  PROJECT_OWNERSHIP_MODES,
  type ProjectOwnershipMode,
  parseProjectOwnershipMode,
  getProjectOwnershipDefault,
} from "./project-config.js";

export {
  PROACTIVITY_LEVELS,
  type ProactivityLevel,
  getProactivityLevel,
  getProactivityLevelForFindings,
  getProactivityLevelForTask,
} from "./proactivity.js";

export type { PostInitCheck, InitProjectDomain, InferredInitScaffold } from "./init-setup.js";
export {
  ensureGovernanceFiles,
  repairPreexistingInstall,
  runPostInitVerify,
  getVerifyOutcomeNote,
  listTemplates,
  detectProjectDir,
  isProjectTracked,
  ensureLocalGitRepo,
  resolvePreferredHomeDir,
  inferInitScaffoldFromRepo,
} from "./init-setup.js";

// Imports from helpers (used internally in this file)
import {
  configureClaude,
  configureVSCode,
  configureCursorMcp,
  configureCopilotMcp,
  configureCodexMcp,
  logMcpTargetStatus,
  removeMcpServerAtPath,
  removeTomlMcpServer,
  isPhrenCommand,
  patchJsonFile,
} from "./init-config.js";
import type { ToolStatus } from "./init-config.js";

import {
  getMcpEnabledPreference,
  getHooksEnabledPreference,
  setMcpEnabledPreference,
  setHooksEnabledPreference,
  writeInstallPreferences,
  writeGovernanceInstallPreferences,
  readInstallPreferences,
} from "./init-preferences.js";

import {
  ensureGovernanceFiles,
  repairPreexistingInstall,
  runPostInitVerify,
  applyStarterTemplateUpdates,
  listTemplates,
  applyTemplate,
  ensureProjectScaffold,
  ensureLocalGitRepo,
  bootstrapFromExisting,
  ensureGitignoreEntry,
  upsertProjectEnvVar,
  updateMachinesYaml,
  detectProjectDir,
  isProjectTracked,
  type InitProjectDomain,
  type InferredInitScaffold,
  inferInitScaffoldFromRepo,
} from "./init-setup.js";

import { DEFAULT_PHREN_PATH, STARTER_DIR, VERSION, log, confirmPrompt } from "./init-shared.js";
import {
  PROJECT_OWNERSHIP_MODES,
  type ProjectOwnershipMode,
  parseProjectOwnershipMode,
  getProjectOwnershipDefault,
} from "./project-config.js";
import { type ProactivityLevel } from "./proactivity.js";
import { getWorkflowPolicy, updateWorkflowPolicy } from "./shared-governance.js";
import { addProjectToProfile } from "./profile-store.js";

export type McpMode = "on" | "off";
type WorkflowRiskSection = "Review" | "Stale" | "Conflicts";
type StorageLocationChoice = "global" | "project" | "custom";
type SkillsScope = "global" | "project";

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}

type HookMap = Partial<Record<"UserPromptSubmit" | "Stop" | "SessionStart" | "PostToolUse", HookEntry[]>> & Record<string, unknown>;

function parseVersion(version: string): { major: number; minor: number; patch: number; pre: string } {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?/);
  if (!match) return { major: 0, minor: 0, patch: 0, pre: "" };
  return {
    major: Number.parseInt(match[1], 10) || 0,
    minor: Number.parseInt(match[2], 10) || 0,
    patch: Number.parseInt(match[3], 10) || 0,
    pre: match[4] || "",
  };
}

/**
 * Compare two semver strings. Returns true when `current` is strictly newer
 * than `previous`. Pre-release versions (e.g. 1.2.3-rc.1) sort before the
 * corresponding release (1.2.3). Among pre-release tags, comparison is
 * lexicographic.
 */
export function isVersionNewer(current: string, previous?: string): boolean {
  if (!previous) return false;
  const c = parseVersion(current);
  const p = parseVersion(previous);
  if (c.major !== p.major) return c.major > p.major;
  if (c.minor !== p.minor) return c.minor > p.minor;
  if (c.patch !== p.patch) return c.patch > p.patch;
  if (c.pre && !p.pre) return false;
  if (!c.pre && p.pre) return true;
  return c.pre > p.pre;
}

export function parseMcpMode(raw?: string): McpMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "on" || normalized === "off") return normalized;
  return undefined;
}

export interface InitOptions {
  mode?: InstallMode;
  machine?: string;
  profile?: string;
  mcp?: McpMode;
  hooks?: McpMode;
  projectOwnershipDefault?: ProjectOwnershipMode;
  findingsProactivity?: ProactivityLevel;
  taskProactivity?: ProactivityLevel;
  lowConfidenceThreshold?: number;
  riskySections?: WorkflowRiskSection[];
  taskMode?: "off" | "manual" | "suggest" | "auto";
  findingSensitivity?: "minimal" | "conservative" | "balanced" | "aggressive";
  skillsScope?: SkillsScope;
  applyStarterUpdate?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  // Built-in template names are directory-based under starter/templates/.
  // Keep string-compatible so custom package templates continue to work.
  template?: "python-project" | "monorepo" | "library" | "frontend" | string;
  /** Set by walkthrough to pass project name to init logic */
  _walkthroughProject?: string;
  /** Set by walkthrough for personalized GitHub next-steps output */
  _walkthroughGithub?: { username?: string; repo: string };
  /** Set by walkthrough to seed project docs/topics by domain */
  _walkthroughDomain?: InitProjectDomain;
  /** Set by walkthrough to seed adaptive project scaffold from current repo content */
  _walkthroughInferredScaffold?: InferredInitScaffold;
  /** Set by walkthrough when user enables auto-capture; triggers writing ~/.phren/.env */
  _walkthroughAutoCapture?: boolean;
  /** Set by walkthrough when user opts into local semantic search */
  _walkthroughSemanticSearch?: boolean;
  /** Set by walkthrough when user enables LLM semantic dedup */
  _walkthroughSemanticDedup?: boolean;
  /** Set by walkthrough when user enables LLM conflict detection */
  _walkthroughSemanticConflict?: boolean;
  /** Set by walkthrough when user provides a git clone URL for existing phren */
  _walkthroughCloneUrl?: string;
  /** Set by walkthrough when the user wants the current repo enrolled immediately */
  _walkthroughBootstrapCurrentProject?: boolean;
  /** Set by walkthrough for the ownership mode selected for the current repo */
  _walkthroughBootstrapOwnership?: ProjectOwnershipMode;
  /** Set by walkthrough to select where phren data is stored */
  _walkthroughStorageChoice?: StorageLocationChoice;
  /** Set by walkthrough to pass resolved storage path to init logic */
  _walkthroughStoragePath?: string;
  /** Set by walkthrough when project-local storage is chosen */
  _walkthroughStorageRepoRoot?: string;
}

function normalizedBootstrapProjectName(projectPath: string): string {
  return path.basename(projectPath).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function getPendingBootstrapTarget(phrenPath: string, opts: InitOptions): { path: string; mode: "explicit" | "detected" } | null {
  const cwdProject = detectProjectDir(process.cwd(), phrenPath);
  if (!cwdProject) return null;
  const projectName = normalizedBootstrapProjectName(cwdProject);
  if (isProjectTracked(phrenPath, projectName)) return null;
  return { path: cwdProject, mode: "detected" };
}

function parseLowConfidenceThreshold(raw: string | undefined | null, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseFloat(raw.trim());
  if (!Number.isFinite(value) || value < 0 || value > 1) return fallback;
  return value;
}

function parseRiskySectionsAnswer(raw: string | undefined | null, fallback: WorkflowRiskSection[]): WorkflowRiskSection[] {
  if (!raw) return [...fallback];
  const aliases: Record<string, WorkflowRiskSection> = {
    review: "Review",
    stale: "Stale",
    conflict: "Conflicts",
    conflicts: "Conflicts",
  };
  const parsed = raw
    .split(/[,\s]+/)
    .map((token) => aliases[token.trim().toLowerCase()])
    .filter((section): section is WorkflowRiskSection => Boolean(section));
  if (!parsed.length) return [...fallback];
  return Array.from(new Set(parsed));
}

function hasInstallMarkers(phrenPath: string): boolean {
  return fs.existsSync(phrenPath) && (
    fs.existsSync(path.join(phrenPath, "machines.yaml")) ||
    fs.existsSync(path.join(phrenPath, ".governance")) ||
    fs.existsSync(path.join(phrenPath, "global"))
  );
}

function resolveInitPhrenPath(opts: InitOptions): string {
  const raw = opts._walkthroughStoragePath || (process.env.PHREN_PATH) || DEFAULT_PHREN_PATH;
  return path.resolve(expandHomePath(raw));
}

function detectRepoRootForStorage(phrenPath: string): string | null {
  return detectProjectDir(process.cwd(), phrenPath);
}

type WalkthroughChoice<T extends string> = {
  value: T;
  name: string;
  description?: string;
};

type WalkthroughPromptUi = {
  input(message: string, initialValue?: string): Promise<string>;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  select<T extends string>(message: string, choices: WalkthroughChoice<T>[], defaultValue?: T): Promise<T>;
};

type WalkthroughStyle = {
  header: (text: string) => string;
  success: (text: string) => string;
  warning: (text: string) => string;
};

function withFallbackColors(style?: {
  header?: (text: string) => string;
  success?: (text: string) => string;
  warning?: (text: string) => string;
}): WalkthroughStyle {
  return {
    header: style?.header ?? ((text: string) => text),
    success: style?.success ?? ((text: string) => text),
    warning: style?.warning ?? ((text: string) => text),
  };
}

async function createWalkthroughStyle(): Promise<WalkthroughStyle> {
  try {
    const chalkModule = await import(String("chalk"));
    const chalkAny = (chalkModule as { default?: unknown; chalk?: unknown }).default
      ?? (chalkModule as { chalk?: unknown }).chalk
      ?? chalkModule;
    const chalk = chalkAny as {
      bold: { cyan: (text: string) => string };
      green: (text: string) => string;
      yellow: (text: string) => string;
    };
    return withFallbackColors({
      header: (text: string) => chalk.bold.cyan(text),
      success: (text: string) => chalk.green(text),
      warning: (text: string) => chalk.yellow(text),
    });
  } catch {
    return withFallbackColors();
  }
}

async function createWalkthroughPrompts(): Promise<WalkthroughPromptUi> {
  try {
    const inquirerModule = await import(String("inquirer"));
    const maybeFns = inquirerModule as {
      input?: (options: { message: string; default?: string }) => Promise<string>;
      confirm?: (options: { message: string; default?: boolean }) => Promise<boolean>;
      select?: <T>(options: {
        message: string;
        choices: Array<{ value: T; name: string; description?: string }>;
        default?: T;
      }) => Promise<T>;
      prompt?: (questions: Array<Record<string, unknown>>) => Promise<Record<string, unknown>>;
      default?: { prompt?: (questions: Array<Record<string, unknown>>) => Promise<Record<string, unknown>> };
    };
    if (
      typeof maybeFns.input === "function"
      && typeof maybeFns.confirm === "function"
      && typeof maybeFns.select === "function"
    ) {
      return {
        input: async (message: string, initialValue?: string) =>
          (await maybeFns.input!({ message, default: initialValue })).trim(),
        confirm: async (message: string, defaultValue = false) =>
          Boolean(await maybeFns.confirm!({ message, default: defaultValue })),
        select: async <T extends string>(
          message: string,
          choices: WalkthroughChoice<T>[],
          defaultValue?: T
        ): Promise<T> =>
          maybeFns.select!({
            message,
            choices: choices.map((choice) => ({ value: choice.value, name: choice.name, description: choice.description })),
            default: defaultValue,
          }) as Promise<T>,
      };
    }
    const prompt = maybeFns.default?.prompt ?? maybeFns.prompt;
    if (typeof prompt === "function") {
      return {
        input: async (message: string, initialValue?: string): Promise<string> => {
          const answer = await prompt([{ type: "input", name: "value", message, default: initialValue }]);
          return String(answer.value ?? "").trim();
        },
        confirm: async (message: string, defaultValue = false): Promise<boolean> => {
          const answer = await prompt([{ type: "confirm", name: "value", message, default: defaultValue }]);
          return Boolean(answer.value);
        },
        select: async <T extends string>(
          message: string,
          choices: WalkthroughChoice<T>[],
          defaultValue?: T
        ): Promise<T> => {
          const answer = await prompt([{
            type: "list",
            name: "value",
            message,
            choices: choices.map((choice) => ({ value: choice.value, name: choice.name })),
            default: defaultValue,
          }]);
          return String(answer.value) as T;
        },
      };
    }
  } catch {
    // fallback below
  }

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (message: string): Promise<string> => new Promise((resolve) => rl.question(message, resolve));
  process.once("exit", () => rl.close());
  return {
    input: async (message: string, initialValue?: string): Promise<string> => {
      const prompt = initialValue ? `${message} (${initialValue}): ` : `${message}: `;
      const answer = (await ask(prompt)).trim();
      return answer || (initialValue ?? "");
    },
    confirm: async (message: string, defaultValue = false): Promise<boolean> => {
      const suffix = defaultValue ? "[Y/n]" : "[y/N]";
      const answer = (await ask(`${message} ${suffix}: `)).trim().toLowerCase();
      if (!answer) return defaultValue;
      return answer === "y" || answer === "yes";
    },
    select: async <T extends string>(
      message: string,
      choices: WalkthroughChoice<T>[],
      defaultValue?: T
    ): Promise<T> => {
      log(`${message}`);
      for (const [index, choice] of choices.entries()) {
        log(`  ${index + 1}. ${choice.name}`);
      }
      const selected = (await ask(`Select [1-${choices.length}]${defaultValue ? " (Enter for default)" : ""}: `)).trim();
      if (!selected && defaultValue) return defaultValue;
      const idx = Number.parseInt(selected, 10) - 1;
      if (!Number.isNaN(idx) && idx >= 0 && idx < choices.length) return choices[idx].value;
      return defaultValue ?? choices[0].value;
    },
  };
}

// Interactive walkthrough for first-time init
async function runWalkthrough(phrenPath: string): Promise<{
  storageChoice: StorageLocationChoice;
  storagePath: string;
  storageRepoRoot?: string;
  machine: string;
  profile: string;
  mcp: McpMode;
  hooks: McpMode;
  projectOwnershipDefault: ProjectOwnershipMode;
  findingsProactivity: ProactivityLevel;
  taskProactivity: ProactivityLevel;
  lowConfidenceThreshold: number;
  riskySections: WorkflowRiskSection[];
  taskMode: "off" | "manual" | "suggest" | "auto";
  bootstrapCurrentProject: boolean;
  bootstrapOwnership?: ProjectOwnershipMode;
  ollamaEnabled: boolean;
  autoCaptureEnabled: boolean;
  semanticDedupEnabled: boolean;
  semanticConflictEnabled: boolean;
  findingSensitivity: "minimal" | "conservative" | "balanced" | "aggressive";
  githubUsername?: string;
  githubRepo?: string;
  cloneUrl?: string;
  domain: InitProjectDomain;
  inferredScaffold?: InferredInitScaffold;
}> {
  const prompts = await createWalkthroughPrompts();
  const style = await createWalkthroughStyle();
  const divider = style.header("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const printSection = (title: string): void => {
    log("");
    log(divider);
    log(style.header(title));
    log(divider);
  };
  const printSummary = (items: string[]): void => {
    printSection("Configuration Summary");
    for (const item of items) {
      log(style.success(`✓ ${item}`));
    }
  };

  const { renderPhrenArt } = await import("./phren-art.js");
  log("");
  log(renderPhrenArt("  "));
  log("");

  printSection("Welcome");
  log("Let's set up persistent memory for your AI agents.");
  log("Every option can be changed later.\n");

  printSection("Storage Location");
  log("Where should phren store data?");
  const storageChoice = await prompts.select<StorageLocationChoice>(
    "Storage location",
    [
      {
        value: "global",
        name: "global (~/.phren/ - default, shared across projects)",
      },
      {
        value: "project",
        name: "per-project (<repo>/.phren/ - scoped to this repo, add to .gitignore)",
      },
      {
        value: "custom",
        name: "custom path",
      },
    ],
    "global"
  );

  let storagePath = path.resolve(homePath(".phren"));
  let storageRepoRoot: string | undefined;
  if (storageChoice === "project") {
    const repoRoot = detectRepoRootForStorage(phrenPath);
    if (!repoRoot) {
      throw new Error("Per-project storage requires running init from a repository directory.");
    }
    storageRepoRoot = repoRoot;
    storagePath = path.join(repoRoot, ".phren");
  } else if (storageChoice === "custom") {
    const customInput = await prompts.input("Custom phren path", phrenPath);
    storagePath = path.resolve(expandHomePath(customInput || phrenPath));
  }

  printSection("Existing Phren");
  log("If you've already set up phren on another machine, paste the git clone URL.");
  log("Otherwise, leave blank.");
  const cloneAnswer = await prompts.input("Clone URL (leave blank to skip)");
  if (cloneAnswer) {
    const cloneConfig: Awaited<ReturnType<typeof runWalkthrough>> = {
      storageChoice,
      storagePath,
      storageRepoRoot,
      machine: getMachineName(),
      profile: "personal",
      mcp: "on" as McpMode,
      hooks: "on" as McpMode,
      projectOwnershipDefault: "phren-managed" as ProjectOwnershipMode,
      findingsProactivity: "high" as ProactivityLevel,
      taskProactivity: "high" as ProactivityLevel,
      lowConfidenceThreshold: 0.7,
      riskySections: ["Stale", "Conflicts"] as WorkflowRiskSection[],
      taskMode: "auto" as const,
      bootstrapCurrentProject: false,
      ollamaEnabled: false,
      autoCaptureEnabled: false,
      semanticDedupEnabled: false,
      semanticConflictEnabled: false,
      findingSensitivity: "balanced" as const,
      cloneUrl: cloneAnswer,
      domain: "software" as InitProjectDomain,
    };
    printSummary([
      `Storage: ${storageChoice} (${storagePath})`,
      `Existing memory clone: ${cloneAnswer}`,
      `Machine: ${cloneConfig.machine}`,
      `Profile: ${cloneConfig.profile}`,
      "MCP: enabled",
      "Hooks: enabled",
      "Project ownership default: phren-managed",
      "Task mode: auto",
      "Domain: software",
    ]);
    return cloneConfig;
  }

  const defaultMachine = getMachineName();
  printSection("Identity");
  const machine = await prompts.input("Machine name", defaultMachine);
  const profile = await prompts.input("Profile name", "personal");

  const repoForInference = detectProjectDir(process.cwd(), storagePath);
  const inferredScaffold = repoForInference
    ? inferInitScaffoldFromRepo(repoForInference)
    : null;
  const inferredDomain = inferredScaffold?.domain ?? "software";

  printSection("Project Domain");
  log("What kind of project is this?");
  if (repoForInference && inferredScaffold) {
    log(`Detected repo signals from ${repoForInference} (${inferredScaffold.reason}).`);
    if (inferredScaffold.referenceHints.length > 0) {
      log(`Reference hints: ${inferredScaffold.referenceHints.join(", ")}`);
    }
  }
  // Use inferred domain directly — adaptive init derives domain from repo content.
  // Only ask if inference was weak (fell back to default "software" with no signals).
  let domain: InitProjectDomain = inferredDomain;
  if (inferredDomain === "software" && !inferredScaffold) {
    domain = await prompts.select<InitProjectDomain>(
      "Project domain",
      [
        { value: "software", name: "software" },
        { value: "research", name: "research" },
        { value: "creative", name: "creative" },
        { value: "other", name: "other" },
      ],
      "software"
    );
  } else {
    log(`Domain: ${inferredDomain} (inferred from project content)`);
  }

  printSection("Project Ownership");
  log("Choose who owns repo-facing instruction files for projects you add.");
  log("  phren-managed: Phren may mirror CLAUDE.md / AGENTS.md into the repo");
  log("  detached: Phren keeps its own docs but does not write into the repo");
  log("  repo-managed: keep the repo's existing CLAUDE/AGENTS files as canonical");
  log("  Change later: npx phren config project-ownership <mode>");
  const projectOwnershipDefault = await prompts.select<ProjectOwnershipMode>(
    "Default project ownership",
    [
      { value: "detached", name: "detached (default)" },
      { value: "phren-managed", name: "phren-managed" },
      { value: "repo-managed", name: "repo-managed" },
    ],
    "detached"
  );

  printSection("MCP");
  log("MCP mode registers phren as a tool server so your AI agent can call it");
  log("directly: search memory, manage tasks, save findings, etc.");
  log("  Recommended for: Claude Code, Cursor, Copilot CLI, Codex");
  log("  Alternative: hooks-only mode (read-only context injection, any agent)");
  log("  Change later: npx phren mcp-mode on|off");
  const mcp: McpMode = (await prompts.confirm("Enable MCP?", true)) ? "on" : "off";

  printSection("Hooks");
  log("Hooks run shell commands at session start, prompt submit, and session end.");
  log("  - SessionStart: git pull (keeps memory in sync across machines)");
  log("  - UserPromptSubmit: searches phren and injects relevant context");
  log("  - Stop: commits and pushes any new findings after each response");
  log("  What they touch: ~/.claude/settings.json (hooks section only)");
  log("  Change later: npx phren hooks-mode on|off");
  const hooks: McpMode = (await prompts.confirm("Enable hooks?", true)) ? "on" : "off";

  printSection("Semantic Search (Optional)");
  log("Phren can use a local embedding model for semantic (fuzzy) search via Ollama.");
  log("  Best fit: paraphrase-heavy or weak-lexical queries.");
  log("  Skip it if you mostly search by filenames, symbols, commands, or exact phrases.");
  log("  - Model: nomic-embed-text (274 MB, one-time download)");
  log("  - Ollama runs locally, no cloud, no cost");
  log("  - Falls back to FTS5 keyword search if disabled or unavailable");
  log("  Change later: set PHREN_OLLAMA_URL=off to disable");
  let ollamaEnabled = false;
  try {
    const { checkOllamaAvailable, checkModelAvailable, getOllamaUrl } = await import("./shared-ollama.js");
    if (getOllamaUrl()) {
      const ollamaUp = await checkOllamaAvailable();
      if (ollamaUp) {
        const modelReady = await checkModelAvailable();
        if (modelReady) {
          log("  Ollama detected with nomic-embed-text ready.");
          ollamaEnabled = await prompts.confirm("Enable semantic search for fuzzy/paraphrase recovery?", false);
        } else {
          log("  Ollama detected, but nomic-embed-text is not pulled yet.");
          ollamaEnabled = await prompts.confirm(
            "Enable semantic search for fuzzy/paraphrase recovery? (will pull nomic-embed-text)",
            false
          );
          if (ollamaEnabled) {
            log("  Run after init: ollama pull nomic-embed-text");
          }
        }
      } else {
        log("  Ollama not detected. Install it to enable semantic search:");
        log("    https://ollama.com  →  then: ollama pull nomic-embed-text");
        ollamaEnabled = await prompts.confirm("Enable semantic search (Ollama not installed yet)?", false);
        if (ollamaEnabled) {
          log(style.success("  Semantic search enabled — will activate once Ollama is running."));
          log("  To disable: set PHREN_OLLAMA_URL=off in your shell profile");
        }
      }
    }
  } catch (err: unknown) {
    if ((process.env.PHREN_DEBUG)) process.stderr.write(`[phren] init ollamaCheck: ${errorMessage(err)}\n`);
  }

  printSection("Auto-Capture (Optional)");
  log("After each session, phren scans the conversation for insight-signal phrases");
  log("(\"always\", \"never\", \"pitfall\", \"gotcha\", etc.) and saves them automatically.");
  log("  - Runs silently in the Stop hook; captured findings go to FINDINGS.md");
  log("  - You can review and remove any auto-captured entry at any time");
  log("  - Can be toggled: set PHREN_FEATURE_AUTO_CAPTURE=0 to disable");
  const autoCaptureEnabled = await prompts.confirm("Enable auto-capture?", true);
  let findingsProactivity: ProactivityLevel = "high";
  if (autoCaptureEnabled) {
    log("  Findings capture level controls how eager phren is to save lessons automatically.");
    log("  Change later: npx phren config proactivity.findings <high|medium|low>");
    findingsProactivity = await prompts.select<ProactivityLevel>(
      "Findings capture level",
      [
        { value: "high", name: "high (recommended)" },
        { value: "medium", name: "medium" },
        { value: "low", name: "low" },
      ],
      "high"
    );
  } else {
    findingsProactivity = "low";
  }

  printSection("Task Management");
  log("Choose how phren handles tasks as you work.");
  log("  auto (recommended): captures tasks naturally as you work, links findings to tasks");
  log("  suggest: proposes tasks but waits for approval before writing");
  log("  manual: tasks are fully manual — you add them yourself");
  log("  off: never touch tasks automatically");
  log("  Change later: npx phren config workflow set --taskMode=<mode>");
  const taskMode = await prompts.select<"off" | "manual" | "suggest" | "auto">(
    "Task mode",
    [
      { value: "auto", name: "auto (recommended)" },
      { value: "suggest", name: "suggest" },
      { value: "manual", name: "manual" },
      { value: "off", name: "off" },
    ],
    "auto"
  );
  let taskProactivity: ProactivityLevel = "high";
  if (taskMode === "auto" || taskMode === "suggest") {
    log("  Task proactivity controls how much evidence phren needs before capturing tasks.");
    log("  high (recommended): captures tasks as they come up naturally");
    log("  medium: only when you explicitly mention a task");
    log("  low: minimal auto-capture");
    log("  Change later: npx phren config proactivity.tasks <high|medium|low>");
    taskProactivity = await prompts.select<ProactivityLevel>(
      "Task proactivity",
      [
        { value: "high", name: "high (recommended)" },
        { value: "medium", name: "medium" },
        { value: "low", name: "low" },
      ],
      "high"
    );
  }

  printSection("Workflow Guardrails");
  log("Choose how strict review gates should be for risky or low-confidence writes.");
  log("  lowConfidenceThreshold: confidence cutoff used to mark writes as risky");
  log("  riskySections: sections always treated as risky");
  log("  Change later: npx phren config workflow set --lowConfidenceThreshold=0.7 --riskySections=Stale,Conflicts");
  const thresholdAnswer = await prompts.input("Low-confidence threshold [0.0-1.0]", "0.7");
  const lowConfidenceThreshold = parseLowConfidenceThreshold(thresholdAnswer, 0.7);
  const riskySectionsAnswer = await prompts.input("Risky sections [Review,Stale,Conflicts]", "Stale,Conflicts");
  const riskySections = parseRiskySectionsAnswer(riskySectionsAnswer, ["Stale", "Conflicts"]);

  // Only offer semantic dedup/conflict when an LLM endpoint is explicitly configured.
  // These features call /chat/completions, not an embedding endpoint, so we gate on
  // PHREN_LLM_ENDPOINT (primary) or the presence of a known API key as a fallback.
  // PHREN_EMBEDDING_API_URL alone is NOT sufficient — it only enables embeddings,
  // not the LLM chat call that callLlm() makes.
  const hasLlmApi = Boolean(
    (process.env.PHREN_LLM_ENDPOINT) ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY
  );

  let semanticDedupEnabled = false;
  let semanticConflictEnabled = false;

  if (hasLlmApi) {
    printSection("LLM-Powered Memory Quality (Optional)");
    log("Phren can use an LLM to catch near-duplicate or conflicting findings.");
    log("  Requires: PHREN_LLM_ENDPOINT or ANTHROPIC_API_KEY/OPENAI_API_KEY set");

    log("");
    log("Semantic dedup: before saving a finding, ask the LLM whether it means the");
    log("same thing as an existing one (catches same idea with different wording).");
    semanticDedupEnabled = await prompts.confirm("Enable LLM-powered duplicate detection?", false);

    log("");
    log("Conflict detection: after saving a finding, check whether it contradicts an");
    log("existing one (e.g. \"always use X\" vs \"never use X\"). Adds an inline annotation.");
    semanticConflictEnabled = await prompts.confirm("Enable LLM-powered conflict detection?", false);

    if (semanticDedupEnabled || semanticConflictEnabled) {
      const currentModel = (process.env.PHREN_LLM_MODEL) || "gpt-4o-mini / claude-haiku-4-5-20251001 (default)";
      log("");
      log("  Cost note: each semantic check is ~80 input + ~5 output tokens, cached 24h.");
      log(`  Current model: ${currentModel}`);
      const llmModel = (process.env.PHREN_LLM_MODEL);
      const isExpensive = llmModel && /opus|sonnet|gpt-4(?!o-mini)/i.test(llmModel);
      if (isExpensive) {
        log(style.warning(`  Warning: ${llmModel} is 20x more expensive than Haiku for yes/no checks.`));
        log("  Consider: PHREN_LLM_MODEL=claude-haiku-4-5-20251001");
      } else {
        log("  With Haiku: fractions of a cent/session. With Opus: ~$0.20/session for heavy use.");
        log("  Tip: set PHREN_LLM_MODEL=claude-haiku-4-5-20251001 to keep costs low.");
      }
    }
  }

  printSection("Finding Sensitivity");
  log("Controls how eagerly agents save findings to memory.");
  log("  minimal      — only when you explicitly ask");
  log("  conservative — decisions and pitfalls only");
  log("  balanced     — non-obvious patterns, decisions, pitfalls, bugs (recommended)");
  log("  aggressive   — everything worth remembering, err on the side of capturing");
  log("  Change later: npx phren config finding-sensitivity <level>");
  const findingSensitivity = await prompts.select<"minimal" | "conservative" | "balanced" | "aggressive">(
    "Finding sensitivity",
    [
      { value: "balanced", name: "balanced (recommended)" },
      { value: "conservative", name: "conservative" },
      { value: "minimal", name: "minimal" },
      { value: "aggressive", name: "aggressive" },
    ],
    "balanced"
  );

  printSection("GitHub Sync");
  log(`Phren stores memory as plain Markdown files in a git repo (${storagePath}).`);
  log("Push it to a private GitHub repo to sync memory across machines.");
  log("  Hooks will auto-commit + push after every session and pull on start.");
  log("  Skip this if you just want to try phren locally first.");
  const githubAnswer = await prompts.input("GitHub username (leave blank to skip)");
  const githubUsername = githubAnswer || undefined;
  let githubRepo: string | undefined;
  if (githubUsername) {
    const repoAnswer = await prompts.input("Repo name", "my-phren");
    githubRepo = repoAnswer || "my-phren";
  }

  let bootstrapCurrentProject = false;
  let bootstrapOwnership: ProjectOwnershipMode | undefined;
  const detectedProject = detectProjectDir(process.cwd(), storagePath);
  if (detectedProject) {
    const detectedProjectName = path.basename(detectedProject);
    printSection("Current Project");
    log(`Detected project: ${detectedProjectName}`);
    bootstrapCurrentProject = await prompts.confirm("Add this project to phren now?", true);
    if (!bootstrapCurrentProject) {
      bootstrapCurrentProject = false;
      log(style.warning(`  Skipped. Later: cd ${detectedProject} && npx phren add`));
    } else {
      bootstrapOwnership = await prompts.select<ProjectOwnershipMode>(
        "Ownership for detected project",
        [
          { value: projectOwnershipDefault, name: `${projectOwnershipDefault} (default)` },
          ...PROJECT_OWNERSHIP_MODES
            .filter((mode) => mode !== projectOwnershipDefault)
            .map((mode) => ({ value: mode, name: mode })),
        ],
        projectOwnershipDefault
      );
    }
  }

  const summaryItems: string[] = [
    `Storage: ${storageChoice} (${storagePath})`,
    `Machine: ${machine}`,
    `Profile: ${profile}`,
    `Domain: ${domain}`,
    `Project ownership default: ${projectOwnershipDefault}`,
    `MCP: ${mcp === "on" ? "enabled" : "disabled"}`,
    `Hooks: ${hooks === "on" ? "enabled" : "disabled"}`,
    `Auto-capture: ${autoCaptureEnabled ? "enabled" : "disabled"}`,
    `Findings capture level: ${findingsProactivity}`,
    `Task mode: ${taskMode}`,
    `Task proactivity: ${taskProactivity}`,
    `Low-confidence threshold: ${lowConfidenceThreshold}`,
    `Risky sections: ${riskySections.join(", ")}`,
    `Finding sensitivity: ${findingSensitivity}`,
    `Semantic search: ${ollamaEnabled ? "enabled" : "disabled"}`,
    `Semantic dedup: ${semanticDedupEnabled ? "enabled" : "disabled"}`,
    `Semantic conflict detection: ${semanticConflictEnabled ? "enabled" : "disabled"}`,
    `GitHub sync: ${githubUsername ? `${githubUsername}/${githubRepo ?? "my-phren"}` : "skipped"}`,
    `Add detected project: ${bootstrapCurrentProject ? `yes (${bootstrapOwnership ?? projectOwnershipDefault})` : "no"}`,
  ];
  if (inferredScaffold) {
    summaryItems.push(`Inference: ${inferredScaffold.reason}`);
  }
  printSummary(summaryItems);

  return {
    storageChoice,
    storagePath,
    storageRepoRoot,
    machine,
    profile,
    mcp,
    hooks,
    projectOwnershipDefault,
    findingsProactivity,
    taskProactivity,
    lowConfidenceThreshold,
    riskySections,
    taskMode,
    bootstrapCurrentProject,
    bootstrapOwnership,
    ollamaEnabled,
    autoCaptureEnabled,
    semanticDedupEnabled,
    semanticConflictEnabled,
    findingSensitivity,
    githubUsername,
    githubRepo,
    domain,
    inferredScaffold: inferredScaffold
      ? (domain === inferredScaffold.domain
          ? inferredScaffold
          : { ...inferredScaffold, domain, topics: [] })
      : undefined,
  };
}

export async function warmSemanticSearch(phrenPath: string, profile?: string): Promise<string> {
  const { checkOllamaAvailable, checkModelAvailable, getOllamaUrl, getEmbeddingModel } = await import("./shared-ollama.js");
  const ollamaUrl = getOllamaUrl();
  if (!ollamaUrl) return "Semantic search: disabled.";

  const model = getEmbeddingModel();
  if (!await checkOllamaAvailable()) {
    return `Semantic search not warmed: Ollama offline at ${ollamaUrl}.`;
  }
  if (!await checkModelAvailable()) {
    return `Semantic search not warmed: model ${model} is not pulled yet.`;
  }

  const { buildIndex, listIndexedDocumentPaths } = await import("./shared-index.js");
  const { getEmbeddingCache, formatEmbeddingCoverage } = await import("./shared-embedding-cache.js");
  const { backgroundEmbedMissingDocs } = await import("./startup-embedding.js");
  const { getPersistentVectorIndex } = await import("./shared-vector-index.js");

  const db = await buildIndex(phrenPath, profile);
  try {
    const cache = getEmbeddingCache(phrenPath);
    await cache.load().catch(() => {});
    const allPaths = listIndexedDocumentPaths(phrenPath, profile);
    const before = cache.coverage(allPaths);
    if (before.missing > 0) {
      await backgroundEmbedMissingDocs(db, cache);
    }
    await cache.load().catch(() => {});
    const after = cache.coverage(allPaths);
    if (cache.size() > 0) {
      getPersistentVectorIndex(phrenPath).ensure(cache.getAllEntries());
    }
    if (after.total === 0) {
      return `Semantic search ready (${model}), but there are no indexed docs yet.`;
    }
    const embeddedNow = Math.max(0, after.embedded - before.embedded);
    const prefix = after.state === "warm" ? "Semantic search warmed" : "Semantic search warming";
    const delta = embeddedNow > 0 ? `; embedded ${embeddedNow} new docs during init` : "";
    return `${prefix}: ${model}, ${formatEmbeddingCoverage(after)}${delta}.`;
  } finally {
    try { db.close(); } catch { /* ignore close errors in init */ }
  }
}

function applyOnboardingPreferences(phrenPath: string, opts: InitOptions): void {
  if (opts.projectOwnershipDefault) {
    writeInstallPreferences(phrenPath, { projectOwnershipDefault: opts.projectOwnershipDefault });
  }
  const runtimePatch: {
    proactivityFindings?: ProactivityLevel;
    proactivityTask?: ProactivityLevel;
  } = {};
  if (opts.findingsProactivity) runtimePatch.proactivityFindings = opts.findingsProactivity;
  if (opts.taskProactivity) runtimePatch.proactivityTask = opts.taskProactivity;
  if (Object.keys(runtimePatch).length > 0) {
    writeInstallPreferences(phrenPath, runtimePatch);
  }
  const governancePatch: {
    proactivityFindings?: ProactivityLevel;
    proactivityTask?: ProactivityLevel;
  } = {};
  if (opts.findingsProactivity) governancePatch.proactivityFindings = opts.findingsProactivity;
  if (opts.taskProactivity) governancePatch.proactivityTask = opts.taskProactivity;
  if (Object.keys(governancePatch).length > 0) {
    writeGovernanceInstallPreferences(phrenPath, governancePatch);
  }
  const workflowPatch: {
    lowConfidenceThreshold?: number;
    riskySections?: WorkflowRiskSection[];
    taskMode?: "off" | "manual" | "suggest" | "auto";
    findingSensitivity?: "minimal" | "conservative" | "balanced" | "aggressive";
  } = {};
  if (typeof opts.lowConfidenceThreshold === "number") workflowPatch.lowConfidenceThreshold = opts.lowConfidenceThreshold;
  if (Array.isArray(opts.riskySections)) workflowPatch.riskySections = opts.riskySections;
  if (opts.taskMode) workflowPatch.taskMode = opts.taskMode;
  if (opts.findingSensitivity) workflowPatch.findingSensitivity = opts.findingSensitivity;
  if (Object.keys(workflowPatch).length > 0) {
    updateWorkflowPolicy(phrenPath, workflowPatch);
  }
}

function writeWalkthroughEnvDefaults(phrenPath: string, opts: InitOptions): string[] {
  const envFile = path.join(phrenPath, ".env");
  let envContent = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "# phren feature flags — generated by init\n";
  const envFlags: { flag: string; label: string }[] = [];
  const autoCaptureChoice = opts._walkthroughAutoCapture;
  const hasAutoCaptureFlag = /^\s*PHREN_FEATURE_AUTO_CAPTURE=.*$/m.test(envContent);
  if (typeof autoCaptureChoice === "boolean") {
    envFlags.push({
      flag: `PHREN_FEATURE_AUTO_CAPTURE=${autoCaptureChoice ? "1" : "0"}`,
      label: `Auto-capture ${autoCaptureChoice ? "enabled" : "disabled"}`,
    });
  } else if (autoCaptureChoice !== false && !hasAutoCaptureFlag) {
    // Default to enabled on fresh installs and non-walkthrough init.
    envFlags.push({ flag: "PHREN_FEATURE_AUTO_CAPTURE=1", label: "Auto-capture enabled" });
  }
  if (opts._walkthroughSemanticDedup) envFlags.push({ flag: "PHREN_FEATURE_SEMANTIC_DEDUP=1", label: "Semantic dedup" });
  if (opts._walkthroughSemanticConflict) envFlags.push({ flag: "PHREN_FEATURE_SEMANTIC_CONFLICT=1", label: "Conflict detection" });

  if (envFlags.length === 0) return [];
  let changed = false;
  const enabledLabels: string[] = [];

  for (const { flag, label } of envFlags) {
    const key = flag.split("=")[0];
    const lineRe = new RegExp(`^\\s*${key}=.*$`, "m");
    if (lineRe.test(envContent)) {
      const before = envContent;
      envContent = envContent.replace(lineRe, flag);
      if (envContent !== before) {
        changed = true;
        enabledLabels.push(label);
      }
    } else {
      if (!envContent.endsWith("\n")) envContent += "\n";
      envContent += `${flag}\n`;
      changed = true;
      enabledLabels.push(label);
    }
  }

  if (changed) {
    const tmpPath = `${envFile}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmpPath, envContent);
    fs.renameSync(tmpPath, envFile);
  }
  return enabledLabels.map((label) => `${label} (${envFile})`);
}

function collectRepairedAssetLabels(repaired: ReturnType<typeof repairPreexistingInstall>): string[] {
  const repairedAssets: string[] = [];
  if (repaired.createdContextFile) repairedAssets.push("~/.phren-context.md");
  if (repaired.createdRootMemory) repairedAssets.push("generated MEMORY.md");
  repairedAssets.push(...repaired.createdGlobalAssets);
  repairedAssets.push(...repaired.createdRuntimeAssets);
  repairedAssets.push(...repaired.createdFeatureDefaults);
  repairedAssets.push(...repaired.createdSkillArtifacts);
  return repairedAssets;
}

function applyProjectStorageBindings(repoRoot: string, phrenPath: string): string[] {
  const updates: string[] = [];
  if (ensureGitignoreEntry(repoRoot, ".phren/")) {
    updates.push(`${path.join(repoRoot, ".gitignore")} (.phren/)`);
  }
  if (upsertProjectEnvVar(repoRoot, "PHREN_PATH", phrenPath)) {
    updates.push(`${path.join(repoRoot, ".env")} (PHREN_PATH=${phrenPath})`);
  }
  return updates;
}

async function runProjectLocalInit(opts: InitOptions = {}): Promise<void> {
  const detectedRoot = detectProjectDir(process.cwd(), path.join(process.cwd(), ".phren")) || process.cwd();
  const hasWorkspaceMarker =
    fs.existsSync(path.join(detectedRoot, ".git")) ||
    fs.existsSync(path.join(detectedRoot, "CLAUDE.md")) ||
    fs.existsSync(path.join(detectedRoot, "AGENTS.md")) ||
    fs.existsSync(path.join(detectedRoot, ".claude", "CLAUDE.md"));
  if (!hasWorkspaceMarker) {
    throw new Error("project-local mode must be run inside a repo or project root");
  }

  const workspaceRoot = path.resolve(detectedRoot);
  const phrenPath = path.join(workspaceRoot, ".phren");
  const existingManifest = readRootManifest(phrenPath);
  if (existingManifest && existingManifest.installMode !== "project-local") {
    throw new Error(`Refusing to reuse non-local phren root at ${phrenPath}`);
  }

  const ownershipDefault = opts.projectOwnershipDefault
    ?? (existingManifest ? getProjectOwnershipDefault(phrenPath) : "detached");
  if (!existingManifest && !opts.projectOwnershipDefault) {
    opts.projectOwnershipDefault = ownershipDefault;
  }
  const mcpEnabled = opts.mcp ? opts.mcp === "on" : true;
  const projectName = path.basename(workspaceRoot).toLowerCase().replace(/[^a-z0-9_-]/g, "-");

  if (opts.dryRun) {
    log("\nInit dry run. No files will be written.\n");
    log(`Mode: project-local`);
    log(`Workspace root: ${workspaceRoot}`);
    log(`Phren root: ${phrenPath}`);
    log(`Project: ${projectName}`);
    log(`VS Code workspace MCP: ${mcpEnabled ? "on" : "off"}`);
    log(`Hooks: unsupported in project-local mode`);
    log("");
    return;
  }

  fs.mkdirSync(phrenPath, { recursive: true });
  writeRootManifest(phrenPath, {
    version: 1,
    installMode: "project-local",
    syncMode: "workspace-git",
    workspaceRoot,
    primaryProject: projectName,
  });
  ensureGovernanceFiles(phrenPath);
  repairPreexistingInstall(phrenPath);
  fs.mkdirSync(path.join(phrenPath, "global", "skills"), { recursive: true });
  fs.mkdirSync(path.join(phrenPath, ".runtime"), { recursive: true });
  fs.mkdirSync(path.join(phrenPath, ".sessions"), { recursive: true });
  if (!fs.existsSync(path.join(phrenPath, ".gitignore"))) {
    atomicWriteText(
      path.join(phrenPath, ".gitignore"),
      [
        ".runtime/",
        ".sessions/",
        "*.lock",
        "*.tmp-*",
        "",
      ].join("\n")
    );
  }
  if (!fs.existsSync(path.join(phrenPath, "global", "CLAUDE.md"))) {
    atomicWriteText(
      path.join(phrenPath, "global", "CLAUDE.md"),
      "# Global Context\n\nRepo-local Phren instructions shared across this workspace.\n"
    );
  }

  const created = bootstrapFromExisting(phrenPath, workspaceRoot, { ownership: ownershipDefault });
  applyOnboardingPreferences(phrenPath, opts);
  writeInstallPreferences(phrenPath, {
    mcpEnabled,
    hooksEnabled: false,
    skillsScope: opts.skillsScope ?? "global",
    installedVersion: VERSION,
  });

  try {
    const vscodeResult = configureVSCode(phrenPath, { mcpEnabled, scope: "workspace" });
    logMcpTargetStatus("VS Code", vscodeResult, existingManifest ? "Updated" : "Configured");
  } catch (err: unknown) {
    debugLog(`configureVSCode(workspace) failed: ${errorMessage(err)}`);
  }

  log(`\n${existingManifest ? "Updated" : "Created"} project-local phren at ${phrenPath}`);
  log(`  Workspace root: ${workspaceRoot}`);
  log(`  Project: ${created.project}`);
  log(`  Ownership: ${created.ownership}`);
  log(`  Sync mode: workspace-git`);
  log(`  Hooks: off (unsupported in project-local mode)`);
  log(`  VS Code MCP: ${mcpEnabled ? "workspace on" : "workspace off"}`);

  const verify = runPostInitVerify(phrenPath);
  log(`\nVerifying setup...`);
  for (const check of verify.checks) {
    log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
  }
}

/**
 * Configure MCP for all detected AI coding tools (Claude, VS Code, Cursor, Copilot, Codex).
 * @param verb - label used in log messages, e.g. "Updated" or "Configured"
 */
function configureMcpTargets(
  phrenPath: string,
  opts: { mcpEnabled: boolean; hooksEnabled: boolean },
  verb: "Configured" | "Updated",
): void {
  try {
    const status = configureClaude(phrenPath, { mcpEnabled: opts.mcpEnabled, hooksEnabled: opts.hooksEnabled });
    if (status === "disabled" || status === "already_disabled") {
      log(`  ${verb} Claude Code hooks (MCP disabled)`);
    } else {
      log(`  ${verb} Claude Code MCP + hooks`);
    }
  } catch (e) {
    log(`  Could not configure Claude Code settings (${e}), add manually`);
  }

  try {
    const vscodeResult = configureVSCode(phrenPath, { mcpEnabled: opts.mcpEnabled });
    logMcpTargetStatus("VS Code", vscodeResult, verb);
  } catch (err: unknown) {
    debugLog(`configureVSCode failed: ${errorMessage(err)}`);
  }

  try {
    logMcpTargetStatus("Cursor", configureCursorMcp(phrenPath, { mcpEnabled: opts.mcpEnabled }), verb);
  } catch (err: unknown) {
    debugLog(`configureCursorMcp failed: ${errorMessage(err)}`);
  }

  try {
    logMcpTargetStatus("Copilot CLI", configureCopilotMcp(phrenPath, { mcpEnabled: opts.mcpEnabled }), verb);
  } catch (err: unknown) {
    debugLog(`configureCopilotMcp failed: ${errorMessage(err)}`);
  }

  try {
    logMcpTargetStatus("Codex", configureCodexMcp(phrenPath, { mcpEnabled: opts.mcpEnabled }), verb);
  } catch (err: unknown) {
    debugLog(`configureCodexMcp failed: ${errorMessage(err)}`);
  }
}

/**
 * Configure hooks if enabled, or log a disabled message.
 * @param verb - label used in log messages, e.g. "Updated" or "Configured"
 */
function configureHooksIfEnabled(phrenPath: string, hooksEnabled: boolean, verb: string): void {
  if (hooksEnabled) {
    try {
      const hooked = configureAllHooks(phrenPath, { allTools: true });
      if (hooked.length) log(`  ${verb} hooks: ${hooked.join(", ")}`);
    } catch (err: unknown) { debugLog(`configureAllHooks failed: ${errorMessage(err)}`); }
  } else {
    log(`  Hooks are disabled by preference (run: npx phren hooks-mode on)`);
  }
}

export async function runInit(opts: InitOptions = {}) {
  if ((opts.mode || "shared") === "project-local") {
    await runProjectLocalInit(opts);
    return;
  }
  let phrenPath = resolveInitPhrenPath(opts);
  const dryRun = Boolean(opts.dryRun);

  // Migrate the legacy hidden store directory into ~/.phren when upgrading
  // from the previous product name. Only runs when the resolved phrenPath
  // doesn't exist yet but the legacy directory does.
  if (!opts._walkthroughStoragePath && !fs.existsSync(phrenPath)) {
    // Pre-rebrand directory name — kept as literal for migration
    const legacyPath = path.resolve(homePath(".cortex"));
    if (legacyPath !== phrenPath && fs.existsSync(legacyPath) && hasInstallMarkers(legacyPath)) {
      if (!dryRun) {
        fs.renameSync(legacyPath, phrenPath);
      }
      console.log(`Migrated legacy store → ~/.phren`);
    }
  }

  // Rename stale legacy skill names left over from the rebrand. Runs on every
  // init so users who already migrated the directory still get the fix.
  const skillsMigrateDir = path.join(phrenPath, "global", "skills");
  if (!dryRun && fs.existsSync(skillsMigrateDir)) {
    const legacySkillName = "cortex.md";
    const legacySkillPrefix = "cortex-";
    for (const entry of fs.readdirSync(skillsMigrateDir)) {
      if (!entry.endsWith(".md")) continue;
      if (entry === legacySkillName) {
        const dest = path.join(skillsMigrateDir, "phren.md");
        if (!fs.existsSync(dest)) {
          fs.renameSync(path.join(skillsMigrateDir, entry), dest);
        }
      } else if (entry.startsWith(legacySkillPrefix)) {
        const newName = `phren-${entry.slice(legacySkillPrefix.length)}`;
        const dest = path.join(skillsMigrateDir, newName);
        if (!fs.existsSync(dest)) {
          fs.renameSync(path.join(skillsMigrateDir, entry), dest);
        }
      }
    }
  }

  let hasExistingInstall = hasInstallMarkers(phrenPath);

  // Interactive walkthrough for first-time installs (skip with --yes or non-TTY)
  if (!hasExistingInstall && !dryRun && !opts.yes && process.stdin.isTTY && process.stdout.isTTY) {
    const answers = await runWalkthrough(phrenPath);
    opts._walkthroughStorageChoice = answers.storageChoice;
    opts._walkthroughStoragePath = answers.storagePath;
    opts._walkthroughStorageRepoRoot = answers.storageRepoRoot;
    phrenPath = resolveInitPhrenPath(opts);
    hasExistingInstall = hasInstallMarkers(phrenPath);
    opts.machine = opts.machine || answers.machine;
    opts.profile = opts.profile || answers.profile;
    opts.mcp = opts.mcp || answers.mcp;
    opts.hooks = opts.hooks || answers.hooks;
    opts.projectOwnershipDefault = opts.projectOwnershipDefault || answers.projectOwnershipDefault;
    opts.findingsProactivity = opts.findingsProactivity || answers.findingsProactivity;
    opts.taskProactivity = opts.taskProactivity || answers.taskProactivity;
    if (typeof opts.lowConfidenceThreshold !== "number") opts.lowConfidenceThreshold = answers.lowConfidenceThreshold;
    if (!Array.isArray(opts.riskySections)) opts.riskySections = answers.riskySections;
    opts.taskMode = opts.taskMode || answers.taskMode;
    if (answers.cloneUrl) {
      opts._walkthroughCloneUrl = answers.cloneUrl;
    }
    if (answers.githubRepo) {
      opts._walkthroughGithub = { username: answers.githubUsername, repo: answers.githubRepo };
    }
    opts._walkthroughDomain = answers.domain;
    if (answers.inferredScaffold) {
      opts._walkthroughInferredScaffold = answers.inferredScaffold;
    }
    if (!answers.ollamaEnabled) {
      // User explicitly declined Ollama — note it but don't set env (they can set it themselves)
      process.env._PHREN_WALKTHROUGH_OLLAMA_SKIP = "1";
    } else {
      opts._walkthroughSemanticSearch = true;
    }
    // Persist the walkthrough choice so init writes an explicit .env default.
    opts._walkthroughAutoCapture = answers.autoCaptureEnabled;
    if (answers.semanticDedupEnabled) {
      opts._walkthroughSemanticDedup = true;
    }
    if (answers.semanticConflictEnabled) {
      opts._walkthroughSemanticConflict = true;
    }
    if (answers.findingSensitivity && answers.findingSensitivity !== "balanced") {
      opts.findingSensitivity = answers.findingSensitivity;
    }
    opts._walkthroughBootstrapCurrentProject = answers.bootstrapCurrentProject;
    opts._walkthroughBootstrapOwnership = answers.bootstrapOwnership;
  }

  // If the walkthrough provided a clone URL, clone it and treat as existing install
  if (opts._walkthroughCloneUrl) {
    log(`\nCloning existing phren from ${opts._walkthroughCloneUrl}...`);
    try {
      execFileSync("git", ["clone", opts._walkthroughCloneUrl, phrenPath], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
      log(`  Cloned to ${phrenPath}`);
      // Re-check: the cloned repo should now be treated as an existing install
      hasExistingInstall = true;
    } catch (e: unknown) {
      log(`  Clone failed: ${e instanceof Error ? e.message : String(e)}`);
      log(`  Continuing with fresh install instead.`);
    }
  }

  const mcpEnabled = opts.mcp ? opts.mcp === "on" : getMcpEnabledPreference(phrenPath);
  const hooksEnabled = opts.hooks ? opts.hooks === "on" : getHooksEnabledPreference(phrenPath);
  const skillsScope: SkillsScope = opts.skillsScope ?? "global";
  const storageChoice = opts._walkthroughStorageChoice;
  const storageRepoRoot = opts._walkthroughStorageRepoRoot;
  const ownershipDefault = opts.projectOwnershipDefault
    ?? (hasExistingInstall ? getProjectOwnershipDefault(phrenPath) : "detached");
  if (!hasExistingInstall && !opts.projectOwnershipDefault) {
    opts.projectOwnershipDefault = ownershipDefault;
  }
  const mcpLabel = mcpEnabled ? "ON (recommended)" : "OFF (hooks-only fallback)";
  const hooksLabel = hooksEnabled ? "ON (active)" : "OFF (disabled)";
  const pendingBootstrap = getPendingBootstrapTarget(phrenPath, opts);
  let shouldBootstrapCurrentProject = opts._walkthroughBootstrapCurrentProject === true;
  let bootstrapOwnership = opts._walkthroughBootstrapOwnership ?? ownershipDefault;

  if (pendingBootstrap && !dryRun) {
    const walkthroughAlreadyHandled = opts._walkthroughBootstrapCurrentProject !== undefined;
    if (walkthroughAlreadyHandled) {
      shouldBootstrapCurrentProject = opts._walkthroughBootstrapCurrentProject === true;
      bootstrapOwnership = opts._walkthroughBootstrapOwnership ?? ownershipDefault;
    } else if (opts.yes || !process.stdin.isTTY || !process.stdout.isTTY) {
      shouldBootstrapCurrentProject = true;
      bootstrapOwnership = ownershipDefault;
    } else {
      const prompts = await createWalkthroughPrompts();
      const style = await createWalkthroughStyle();
      const detectedProjectName = path.basename(pendingBootstrap.path);
      log("");
      log(style.header("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
      log(style.header("Current Project"));
      log(style.header("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
      log(`Detected project: ${detectedProjectName}`);
      shouldBootstrapCurrentProject = await prompts.confirm("Add this project to phren now?", true);
      if (!shouldBootstrapCurrentProject) {
        shouldBootstrapCurrentProject = false;
        log(style.warning(`  Skipped. Later: cd ${pendingBootstrap.path} && npx phren add`));
      } else {
        bootstrapOwnership = await prompts.select<ProjectOwnershipMode>(
          "Ownership for detected project",
          [
            { value: ownershipDefault, name: `${ownershipDefault} (default)` },
            ...PROJECT_OWNERSHIP_MODES
              .filter((mode) => mode !== ownershipDefault)
              .map((mode) => ({ value: mode, name: mode })),
          ],
          ownershipDefault
        );
      }
    }
  }

  if (dryRun) {
    log("\nInit dry run. No files will be written.\n");
    if (storageChoice) {
      log(`Storage location: ${storageChoice} (${phrenPath})`);
      if (storageChoice === "project" && storageRepoRoot) {
        log(`  Would update ${path.join(storageRepoRoot, ".gitignore")} with .phren/`);
        log(`  Would set PHREN_PATH in ${path.join(storageRepoRoot, ".env")}`);
      }
    }
    if (hasExistingInstall) {
      log(`phren install detected at ${phrenPath}`);
      log(`Would update configuration for the existing install:\n`);
      log(`  MCP mode: ${mcpLabel}`);
      log(`  Hooks mode: ${hooksLabel}`);
      log(`  Reconfigure Claude Code MCP/hooks`);
      log(`  Reconfigure VS Code, Cursor, Copilot CLI, and Codex MCP targets`);
      if (hooksEnabled) {
        log(`  Reconfigure lifecycle hooks for detected tools`);
      }
      if (pendingBootstrap?.mode === "detected") {
        log(`  Would offer to add current project directory (${pendingBootstrap.path})`);
      }
      if (opts.applyStarterUpdate) {
        log(`  Apply starter template updates to global/CLAUDE.md and global skills`);
      }
      log(`  Run post-init verification checks`);
      log(`\nDry run complete.\n`);
      return;
    }

    log(`No existing phren install found at ${phrenPath}`);
    log(`Would create a new phren install:\n`);
    log(`  Copy starter files to ${phrenPath} (or create minimal structure)`);
    log(`  Update machines.yaml for machine "${opts.machine || getMachineName()}"`);
    log(`  Create/update config files`);
    log(`  MCP mode: ${mcpLabel}`);
    log(`  Hooks mode: ${hooksLabel}`);
    log(`  Configure Claude Code plus detected MCP targets (VS Code/Cursor/Copilot/Codex)`);
    if (hooksEnabled) {
      log(`  Configure lifecycle hooks for detected tools`);
    }
    if (pendingBootstrap?.mode === "detected") {
      log(`  Would offer to add current project directory (${pendingBootstrap.path})`);
    }
    log(`  Write install preferences and run post-init verification checks`);
    log(`\nDry run complete.\n`);
    return;
  }

  if (storageChoice === "project") {
    if (!storageRepoRoot) {
      throw new Error("Per-project storage requires a detected repository root.");
    }
    const storageChanges = applyProjectStorageBindings(storageRepoRoot, phrenPath);
    for (const change of storageChanges) {
      log(`  Updated storage binding: ${change}`);
    }
  }

  if (hasExistingInstall) {
      writeRootManifest(phrenPath, {
        version: 1,
        installMode: "shared",
        syncMode: "managed-git",
      });
      ensureGovernanceFiles(phrenPath);
      const repaired = repairPreexistingInstall(phrenPath);
      applyOnboardingPreferences(phrenPath, opts);
      const existingGitRepo = ensureLocalGitRepo(phrenPath);
      log(`\nphren already exists at ${phrenPath}`);
      log(`Updating configuration...\n`);
      log(`  MCP mode: ${mcpLabel}`);
      log(`  Hooks mode: ${hooksLabel}`);
      log(`  Default project ownership: ${ownershipDefault}`);
      log(`  Task mode: ${getWorkflowPolicy(phrenPath).taskMode}`);
      log(`  Git repo: ${existingGitRepo.detail}`);

      // Confirmation prompt before writing config
      if (!opts.yes) {
        const settingsPath = hookConfigPath("claude");
        const modifications: string[] = [];
        modifications.push(`  ${settingsPath}  (update MCP server + hooks)`);
        log(`\nWill modify:`);
        for (const mod of modifications) log(mod);

        const confirmed = await confirmPrompt("\nProceed?");
        if (!confirmed) {
          log("Aborted.");
          return;
        }
      }

      // Always reconfigure MCP and hooks (picks up new features on upgrade)
      configureMcpTargets(phrenPath, { mcpEnabled, hooksEnabled }, "Updated");
      configureHooksIfEnabled(phrenPath, hooksEnabled, "Updated");

      const prefs = readInstallPreferences(phrenPath);
      const previousVersion = prefs.installedVersion;
      if (isVersionNewer(VERSION, previousVersion)) {
        log(`\n  Starter template update available: v${previousVersion} -> v${VERSION}`);
        log(`  Run \`npx phren init --apply-starter-update\` to refresh global/CLAUDE.md and global skills.`);
      }
      if (opts.applyStarterUpdate) {
        const updated = applyStarterTemplateUpdates(phrenPath);
        if (updated.length) {
          log(`  Applied starter template updates (${updated.length} file${updated.length === 1 ? "" : "s"}).`);
        } else {
          log(`  No starter template updates were applied (starter files not found).`);
        }
      }
      writeInstallPreferences(phrenPath, { mcpEnabled, hooksEnabled, skillsScope, installedVersion: VERSION });
      if (repaired.removedLegacyProjects > 0) {
        log(`  Removed ${repaired.removedLegacyProjects} legacy starter project entr${repaired.removedLegacyProjects === 1 ? "y" : "ies"} from profiles.`);
      }
      const repairedAssets = collectRepairedAssetLabels(repaired);
      if (repairedAssets.length > 0) {
        log(`  Recreated missing generated assets: ${repairedAssets.join(", ")}`);
      }

      // Post-update verification
      log(`\nVerifying setup...`);
      const verify = runPostInitVerify(phrenPath);
      for (const check of verify.checks) {
        log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
      }

      if (pendingBootstrap && shouldBootstrapCurrentProject) {
        try {
          const created = bootstrapFromExisting(phrenPath, pendingBootstrap.path, {
            profile: opts.profile,
            ownership: bootstrapOwnership,
          });
          log(`\nAdded current project "${created.project}" (${created.ownership})`);
        } catch (e: unknown) {
          debugLog(`Bootstrap from CWD failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      for (const envLabel of writeWalkthroughEnvDefaults(phrenPath, opts)) {
        log(`  ${envLabel}`);
      }

      log(`\n\x1b[95m◆\x1b[0m phren updated successfully`);
      log(`\nNext steps:`);
      log(`  1. Start a new Claude session in your project directory — phren injects context automatically`);
      log(`  2. Run \`npx phren doctor\` to verify everything is wired correctly`);
      log(`  3. Change defaults anytime: \`npx phren config project-ownership\`, \`npx phren config workflow\`, \`npx phren config proactivity.findings\`, \`npx phren config proactivity.tasks\``);
      log(`  4. After your first week, run phren-discover to surface gaps in your project knowledge`);
      log(`  5. After working across projects, run phren-consolidate to find cross-project patterns`);
      log(``);
      return;
  }

  log("\nSetting up phren...\n");

  const walkthroughProject = opts._walkthroughProject;
  if (walkthroughProject) {
    if (!walkthroughProject.trim()) {
      console.error("Error: project name cannot be empty.");
      process.exit(1);
    }
    if (walkthroughProject.length > 100) {
      console.error("Error: project name must be 100 characters or fewer.");
      process.exit(1);
    }
    if (!isValidProjectName(walkthroughProject)) {
      console.error(`Error: invalid project name "${walkthroughProject}". Use lowercase letters, numbers, and hyphens.`);
      process.exit(1);
    }
  }

  // Determine if CWD is a project that should be bootstrapped instead of
  // creating a dummy "my-first-project".
  const cwdProjectPath = !walkthroughProject ? detectProjectDir(process.cwd(), phrenPath) : null;
  const useTemplateProject = Boolean(walkthroughProject) || Boolean(opts.template);
  const firstProjectName = walkthroughProject || "my-first-project";
  const firstProjectDomain: InitProjectDomain = opts._walkthroughDomain ?? "software";

  // Copy bundled starter to ~/.phren
  function copyDir(src: string, dest: string) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (src === STARTER_DIR && entry.isDirectory() && ["my-api", "my-frontend", "my-first-project"].includes(entry.name)) {
        continue;
      }
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  if (fs.existsSync(STARTER_DIR)) {
    copyDir(STARTER_DIR, phrenPath);
    writeRootManifest(phrenPath, {
      version: 1,
      installMode: "shared",
      syncMode: "managed-git",
    });
    if (useTemplateProject) {
      const targetProject = walkthroughProject || firstProjectName;
      const projectDir = path.join(phrenPath, targetProject);
      const templateApplied = Boolean(opts.template && applyTemplate(projectDir, opts.template, targetProject));
      if (templateApplied) {
        log(`  Applied "${opts.template}" template to ${targetProject}`);
      }
      ensureProjectScaffold(projectDir, targetProject, firstProjectDomain, opts._walkthroughInferredScaffold);

      const targetProfile = opts.profile || "default";
      const addToProfile = addProjectToProfile(phrenPath, targetProfile, targetProject);
      if (!addToProfile.ok) {
        debugLog(`fresh init addProjectToProfile failed for ${targetProfile}/${targetProject}: ${addToProfile.error}`);
      }

      if (opts.template && !templateApplied) {
        log(`  Template "${opts.template}" not found. Available: ${listTemplates().join(", ") || "none"}`);
      }
      log(`  Seeded project "${targetProject}"`);
    }
    log(`  Created phren v${VERSION} \u2192 ${phrenPath}`);
  } else {
    log(`  Starter not found in package, creating minimal structure...`);
    writeRootManifest(phrenPath, {
      version: 1,
      installMode: "shared",
      syncMode: "managed-git",
    });
    fs.mkdirSync(path.join(phrenPath, "global", "skills"), { recursive: true });
    fs.mkdirSync(path.join(phrenPath, "profiles"), { recursive: true });
    atomicWriteText(
      path.join(phrenPath, "global", "CLAUDE.md"),
      `# Global Context\n\nThis file is loaded in every project.\n\n## General preferences\n\n<!-- Your coding style, preferred tools, things Claude should always know -->\n`
    );
    if (useTemplateProject) {
      const projectDir = path.join(phrenPath, firstProjectName);
      if (opts.template && applyTemplate(projectDir, opts.template, firstProjectName)) {
        log(`  Applied "${opts.template}" template to ${firstProjectName}`);
      }
      ensureProjectScaffold(projectDir, firstProjectName, firstProjectDomain, opts._walkthroughInferredScaffold);
    }
    const profileName = opts.profile || "default";
    const profileProjects = useTemplateProject
      ? `  - global\n  - ${firstProjectName}`
      : `  - global`;
    atomicWriteText(
      path.join(phrenPath, "profiles", `${profileName}.yaml`),
      `name: ${profileName}\ndescription: Default profile\nprojects:\n${profileProjects}\n`
    );
  }

  // If CWD is a project dir, bootstrap it now when onboarding or defaults allow it.
  if (cwdProjectPath && shouldBootstrapCurrentProject) {
    try {
      const created = bootstrapFromExisting(phrenPath, cwdProjectPath, {
        profile: opts.profile,
        ownership: bootstrapOwnership,
      });
      log(`  Added current project "${created.project}" (${created.ownership})`);
    } catch (e: unknown) {
      // Fresh-install bootstrap is best-effort. If it fails, the install
      // still succeeded and the user can add the project explicitly later.
      debugLog(`Bootstrap from CWD during fresh install failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Persist the local machine alias and map it to the selected profile.
  const effectiveMachine = opts.machine?.trim() || getMachineName();
  persistMachineName(effectiveMachine);
  updateMachinesYaml(phrenPath, effectiveMachine, opts.profile);
  ensureGovernanceFiles(phrenPath);
  const repaired = repairPreexistingInstall(phrenPath);
  applyOnboardingPreferences(phrenPath, opts);
  const localGitRepo = ensureLocalGitRepo(phrenPath);
  log(`  Updated machines.yaml with machine "${effectiveMachine}"`);
  log(`  MCP mode: ${mcpLabel}`);
  log(`  Hooks mode: ${hooksLabel}`);
  log(`  Default project ownership: ${ownershipDefault}`);
  log(`  Task mode: ${getWorkflowPolicy(phrenPath).taskMode}`);
  log(`  Git repo: ${localGitRepo.detail}`);
  if (repaired.removedLegacyProjects > 0) {
    log(`  Removed ${repaired.removedLegacyProjects} legacy starter project entr${repaired.removedLegacyProjects === 1 ? "y" : "ies"} from profiles.`);
  }
  const repairedAssets = collectRepairedAssetLabels(repaired);
  if (repairedAssets.length > 0) {
    log(`  Recreated missing generated assets: ${repairedAssets.join(", ")}`);
  }

  // Confirmation prompt before writing agent config
  if (!opts.yes) {
    const settingsPath = hookConfigPath("claude");
    log(`\nWill modify:`);
    log(`  ${settingsPath}  (add MCP server + hooks)`);

    const confirmed = await confirmPrompt("\nProceed?");
    if (!confirmed) {
      log("Aborted.");
      return;
    }
  }

  // Configure MCP for all detected AI coding tools and hooks
  configureMcpTargets(phrenPath, { mcpEnabled, hooksEnabled }, "Configured");
  configureHooksIfEnabled(phrenPath, hooksEnabled, "Configured");

  writeInstallPreferences(phrenPath, { mcpEnabled, hooksEnabled, skillsScope, installedVersion: VERSION });

  // Post-init verification
  log(`\nVerifying setup...`);
  const verify = runPostInitVerify(phrenPath);
  for (const check of verify.checks) {
    log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
  }

  log(`\nWhat was created:`);
  log(`  ${phrenPath}/global/CLAUDE.md    Global instructions loaded in every session`);
  log(`  ${phrenPath}/global/skills/      Phren slash commands`);
  log(`  ${phrenPath}/profiles/           Machine-to-project mappings`);
  log(`  ${phrenPath}/.governance/        Memory quality settings and config`);

  // Ollama status summary (skip if already covered in walkthrough)
  const walkthroughCoveredOllama = Boolean(process.env._PHREN_WALKTHROUGH_OLLAMA_SKIP) || (!hasExistingInstall && !opts.yes);
  if (!walkthroughCoveredOllama) {
    try {
      const { checkOllamaAvailable, checkModelAvailable, getOllamaUrl } = await import("./shared-ollama.js");
      if (getOllamaUrl()) {
        const ollamaUp = await checkOllamaAvailable();
        if (ollamaUp) {
          const modelReady = await checkModelAvailable();
          if (modelReady) {
            log("\n  Semantic search: Ollama + nomic-embed-text ready.");
          } else {
            log("\n  Semantic search: Ollama running, but nomic-embed-text not pulled.");
            log("  Run: ollama pull nomic-embed-text");
          }
        } else {
          log("\n  Tip: Install Ollama for semantic search (optional).");
          log("  https://ollama.com → then: ollama pull nomic-embed-text");
          log("  (Set PHREN_OLLAMA_URL=off to hide this message)");
        }
      }
    } catch (err: unknown) {
      if ((process.env.PHREN_DEBUG)) process.stderr.write(`[phren] init ollamaInstallHint: ${errorMessage(err)}\n`);
    }
  }

  for (const envLabel of writeWalkthroughEnvDefaults(phrenPath, opts)) {
    log(`  ${envLabel}`);
  }

  if (opts._walkthroughSemanticSearch) {
    log(`\nWarming semantic search...`);
    try {
      log(`  ${await warmSemanticSearch(phrenPath, opts.profile)}`);
    } catch (err: unknown) {
      log(`  Semantic search warmup failed: ${errorMessage(err)}`);
    }
  }

  log(`\n\x1b[95m◆\x1b[0m phren initialized`);
  log(`\nNext steps:`);
  let step = 1;
  log(`  ${step++}. Start a new Claude session in your project directory — phren injects context automatically`);
  log(`  ${step++}. Run \`npx phren doctor\` to verify everything is wired correctly`);
  log(`  ${step++}. Change defaults anytime: \`npx phren config project-ownership\`, \`npx phren config workflow\`, \`npx phren config proactivity.findings\`, \`npx phren config proactivity.tasks\``);

  const gh = opts._walkthroughGithub;
  if (gh) {
    const remote = gh.username
      ? `git@github.com:${gh.username}/${gh.repo}.git`
      : `git@github.com:YOUR_USERNAME/${gh.repo}.git`;
    log(`  ${step++}. Push your phren to GitHub (private repo recommended):`);
    log(`     cd ${phrenPath}`);
    log(`     git add . && git commit -m "Initial phren setup"`);
    if (gh.username) {
      log(`     gh repo create ${gh.username}/${gh.repo} --private --source=. --push`);
      log(`     # or manually: git remote add origin ${remote} && git push -u origin main`);
    } else {
      log(`     git remote add origin ${remote}`);
      log(`     git push -u origin main`);
    }
  } else {
    log(`  ${step++}. Push to GitHub for cross-machine sync (private repo recommended):`);
    log(`     cd ${phrenPath}`);
    log(`     git add . && git commit -m "Initial phren setup"`);
    log(`     git remote add origin git@github.com:YOUR_USERNAME/my-phren.git`);
    log(`     git push -u origin main`);
  }

  log(`  ${step++}. Add more projects: cd ~/your-project && npx phren add`);

  if (!mcpEnabled) {
    log(`  ${step++}. Turn MCP on: npx phren mcp-mode on`);
  }
  log(`  ${step++}. After your first week, run phren-discover to surface gaps in your project knowledge`);
  log(`  ${step++}. After working across projects, run phren-consolidate to find cross-project patterns`);
  log(`\n  Read ${phrenPath}/README.md for a guided tour of each file.`);

  log(``);
}

export async function runMcpMode(modeArg?: string) {
  const phrenPath = findPhrenPath() || (process.env.PHREN_PATH) || DEFAULT_PHREN_PATH;
  const manifest = readRootManifest(phrenPath);
  const normalizedArg = modeArg?.trim().toLowerCase();
  if (!normalizedArg || normalizedArg === "status") {
    const current = getMcpEnabledPreference(phrenPath);
    const hooks = getHooksEnabledPreference(phrenPath);
    log(`MCP mode: ${current ? "on (recommended)" : "off (hooks-only fallback)"}`);
    log(`Hooks mode: ${hooks ? "on (active)" : "off (disabled)"}`);
    log(`Change mode: npx phren mcp-mode on|off`);
    log(`Hooks toggle: npx phren hooks-mode on|off`);
    return;
  }
  const mode = parseMcpMode(normalizedArg);
  if (!mode) {
    throw new Error(`Invalid mode "${modeArg}". Use: on | off | status`);
  }
  const enabled = mode === "on";

  if (manifest?.installMode === "project-local") {
    const vscodeStatus = configureVSCode(phrenPath, { mcpEnabled: enabled, scope: "workspace" });
    setMcpEnabledPreference(phrenPath, enabled);
    log(`MCP mode set to ${mode}.`);
    log(`VS Code status: ${vscodeStatus}`);
    log(`Project-local mode only configures workspace VS Code MCP.`);
    return;
  }

  let claudeStatus: ToolStatus = "no_settings";
  let vscodeStatus: ToolStatus = "no_vscode";
  let cursorStatus: ToolStatus = "no_cursor";
  let copilotStatus: ToolStatus = "no_copilot";
  let codexStatus: ToolStatus = "no_codex";
  try { claudeStatus = configureClaude(phrenPath, { mcpEnabled: enabled }) ?? claudeStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureClaude failed: ${errorMessage(err)}`); }
  try { vscodeStatus = configureVSCode(phrenPath, { mcpEnabled: enabled }) ?? vscodeStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureVSCode failed: ${errorMessage(err)}`); }
  try { cursorStatus = configureCursorMcp(phrenPath, { mcpEnabled: enabled }) ?? cursorStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCursorMcp failed: ${errorMessage(err)}`); }
  try { copilotStatus = configureCopilotMcp(phrenPath, { mcpEnabled: enabled }) ?? copilotStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCopilotMcp failed: ${errorMessage(err)}`); }
  try { codexStatus = configureCodexMcp(phrenPath, { mcpEnabled: enabled }) ?? codexStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCodexMcp failed: ${errorMessage(err)}`); }

  // Persist preference only after config writes have been attempted
  setMcpEnabledPreference(phrenPath, enabled);

  log(`MCP mode set to ${mode}.`);
  log(`Claude status: ${claudeStatus}`);
  log(`VS Code status: ${vscodeStatus}`);
  log(`Cursor status: ${cursorStatus}`);
  log(`Copilot CLI status: ${copilotStatus}`);
  log(`Codex status: ${codexStatus}`);
  log(`Restart your agent to apply changes.`);
}

export async function runHooksMode(modeArg?: string) {
  const phrenPath = findPhrenPath() || (process.env.PHREN_PATH) || DEFAULT_PHREN_PATH;
  const manifest = readRootManifest(phrenPath);
  const normalizedArg = modeArg?.trim().toLowerCase();
  if (!normalizedArg || normalizedArg === "status") {
    const current = getHooksEnabledPreference(phrenPath);
    log(`Hooks mode: ${current ? "on (active)" : "off (disabled)"}`);
    log(`Change mode: npx phren hooks-mode on|off`);
    return;
  }
  const mode = parseMcpMode(normalizedArg);
  if (!mode) {
    throw new Error(`Invalid mode "${modeArg}". Use: on | off | status`);
  }

  if (manifest?.installMode === "project-local") {
    throw new Error("hooks-mode is unsupported in project-local mode");
  }

  const enabled = mode === "on";

  let claudeStatus: ToolStatus = "no_settings";
  try {
    claudeStatus = configureClaude(phrenPath, {
      mcpEnabled: getMcpEnabledPreference(phrenPath),
      hooksEnabled: enabled,
    }) ?? claudeStatus;
  } catch (err: unknown) { debugLog(`hooks-mode: configureClaude failed: ${errorMessage(err)}`); }

  if (enabled) {
    try {
      const hooked = configureAllHooks(phrenPath, { allTools: true });
      if (hooked.length) log(`Updated hooks: ${hooked.join(", ")}`);
    } catch (err: unknown) { debugLog(`hooks-mode: configureAllHooks failed: ${errorMessage(err)}`); }
  } else {
    log("Hooks will no-op immediately via preference and Claude hooks are removed.");
  }

  // Persist preference only after config writes have been attempted
  setHooksEnabledPreference(phrenPath, enabled);

  log(`Hooks mode set to ${mode}.`);
  log(`Claude status: ${claudeStatus}`);
  log(`Restart your agent to apply changes.`);
}

// Agent skill directories to sweep for symlinks during uninstall
function agentSkillDirs(): string[] {
  const home = homeDir();
  return [
    homePath(".claude", "skills"),
    path.join(home, ".cursor", "skills"),
    path.join(home, ".copilot", "skills"),
    path.join(home, ".codex", "skills"),
  ];
}

// Remove skill symlinks that resolve inside phrenPath. Only touches symlinks, never regular files.
function sweepSkillSymlinks(phrenPath: string): void {
  const resolvedPhren = path.resolve(phrenPath);
  for (const dir of agentSkillDirs()) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err: unknown) {
      debugLog(`sweepSkillSymlinks: readdirSync failed for ${dir}: ${errorMessage(err)}`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const target = fs.realpathSync(fullPath);
        if (target.startsWith(resolvedPhren + path.sep) || target === resolvedPhren) {
          fs.unlinkSync(fullPath);
          log(`  Removed skill symlink: ${fullPath}`);
        }
      } catch (err: unknown) {
        debugLog(`sweepSkillSymlinks: could not check/remove ${fullPath}: ${errorMessage(err)}`);
      }
    }
  }
}

// Filter phren hook entries from an agent hooks file. Returns true if the file was changed.
// Deletes the file if no hooks remain. `commandField` is the JSON key holding the command
// string in each hook entry (e.g. "bash" for Copilot, "command" for Codex).
function filterAgentHooks(filePath: string, commandField: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isRecord(raw) || !isRecord(raw.hooks)) return false;
    const hooks = raw.hooks as Record<string, unknown>;
    let changed = false;
    for (const event of Object.keys(hooks)) {
      const entries = hooks[event];
      if (!Array.isArray(entries)) continue;
      const filtered = entries.filter(
        (e: unknown) => !(isRecord(e) && typeof e[commandField] === "string" && isPhrenCommand(e[commandField] as string))
      );
      if (filtered.length !== entries.length) {
        hooks[event] = filtered;
        changed = true;
      }
    }
    if (!changed) return false;
    // Remove empty hook event keys
    for (const event of Object.keys(hooks)) {
      if (Array.isArray(hooks[event]) && (hooks[event] as unknown[]).length === 0) {
        delete hooks[event];
      }
    }
    if (Object.keys(hooks).length === 0) {
      fs.unlinkSync(filePath);
    } else {
      atomicWriteText(filePath, JSON.stringify(raw, null, 2));
    }
    return true;
  } catch (err: unknown) {
    debugLog(`filterAgentHooks: failed for ${filePath}: ${errorMessage(err)}`);
    return false;
  }
}

async function promptUninstallConfirm(phrenPath: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return true;

  // Show summary of what will be deleted
  try {
    const projectDirs = getProjectDirs(phrenPath);
    const projectCount = projectDirs.length;
    let findingCount = 0;
    for (const dir of projectDirs) {
      const findingsFile = path.join(dir, "FINDINGS.md");
      if (fs.existsSync(findingsFile)) {
        const content = fs.readFileSync(findingsFile, "utf8");
        findingCount += content.split("\n").filter((l) => l.startsWith("- ")).length;
      }
    }
    log(`\n  Will delete: ${phrenPath}`);
    log(`  Contains: ${projectCount} project(s), ~${findingCount} finding(s)`);
  } catch (err: unknown) {
    debugLog(`promptUninstallConfirm: summary failed: ${errorMessage(err)}`);
    log(`\n  Will delete: ${phrenPath}`);
  }

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\nThis will permanently delete ${phrenPath} and all phren data. Type 'yes' to confirm: `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

export async function runUninstall(opts: { yes?: boolean } = {}) {
  const phrenPath = findPhrenPath();
  const manifest = phrenPath ? readRootManifest(phrenPath) : null;
  if (manifest?.installMode === "project-local" && phrenPath) {
    log("\nUninstalling project-local phren...\n");
    const workspaceRoot = manifest.workspaceRoot || path.dirname(phrenPath);
    const workspaceMcp = path.join(workspaceRoot, ".vscode", "mcp.json");
    try {
      if (removeMcpServerAtPath(workspaceMcp)) {
        log(`  Removed phren from VS Code workspace MCP config (${workspaceMcp})`);
      }
    } catch (err: unknown) {
      debugLog(`uninstall local vscode cleanup failed: ${errorMessage(err)}`);
    }
    fs.rmSync(phrenPath, { recursive: true, force: true });
    log(`  Removed ${phrenPath}`);
    log("\nProject-local phren uninstalled.");
    return;
  }

  log("\nUninstalling phren...\n");

  // Confirmation prompt (shared-mode only — project-local is low-stakes)
  if (!opts.yes) {
    const confirmed = phrenPath
      ? await promptUninstallConfirm(phrenPath)
      : (process.stdin.isTTY && process.stdout.isTTY
        ? await (async () => {
          const readline = await import("readline");
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          return new Promise<boolean>((resolve) => {
            rl.question("This will remove all phren config and hooks. Type 'yes' to confirm: ", (answer) => {
              rl.close();
              resolve(answer.trim().toLowerCase() === "yes");
            });
          });
        })()
        : true);
    if (!confirmed) {
      log("Uninstall cancelled.");
      return;
    }
  }

  const home = homeDir();
  const machineFile = machineFilePath();
  const settingsPath = hookConfigPath("claude");

  // Remove from Claude Code ~/.claude.json (where MCP servers are actually read)
  const claudeJsonPath = homePath(".claude.json");
  if (fs.existsSync(claudeJsonPath)) {
    try {
      if (removeMcpServerAtPath(claudeJsonPath)) {
        log(`  Removed phren MCP server from ~/.claude.json`);
      }
    } catch (e) {
      log(`  Warning: could not update ~/.claude.json (${e})`);
    }
  }

  // Remove from Claude Code settings.json
  if (fs.existsSync(settingsPath)) {
    try {
      patchJsonFile(settingsPath, (data) => {
        const hooksMap = isRecord(data.hooks) ? data.hooks as HookMap : (data.hooks = {} as HookMap);
        // Remove MCP server
        if (data.mcpServers?.phren) {
          delete data.mcpServers.phren;
          log(`  Removed phren MCP server from Claude Code settings`);
        }

        // Remove hooks containing phren references
        for (const hookEvent of ["UserPromptSubmit", "Stop", "SessionStart", "PostToolUse"] as const) {
          const hooks = hooksMap[hookEvent] as HookEntry[] | undefined;
          if (!Array.isArray(hooks)) continue;
          const before = hooks.length;
          hooksMap[hookEvent] = hooks.filter(
            (h: HookEntry) => !h.hooks?.some(
              (hook) => typeof hook.command === "string" && isPhrenCommand(hook.command)
            )
          );
          const removed = before - (hooksMap[hookEvent] as HookEntry[]).length;
          if (removed > 0) log(`  Removed ${removed} phren hook(s) from ${hookEvent}`);
        }
      });
    } catch (e) {
      log(`  Warning: could not update Claude Code settings (${e})`);
    }
  } else {
    log(`  Claude Code settings not found at ${settingsPath} — skipping`);
  }

  // Remove from VS Code mcp.json
  const vsCandidates = vscodeMcpCandidates().map((dir) => path.join(dir, "mcp.json"));
  for (const mcpFile of vsCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed phren from VS Code MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove from Cursor MCP config
  const cursorCandidates = cursorMcpCandidates();
  for (const mcpFile of cursorCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed phren from Cursor MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove from Copilot CLI MCP config
  const copilotCandidates = copilotMcpCandidates();
  for (const mcpFile of copilotCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed phren from Copilot CLI MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove from Codex MCP config (TOML + JSON)
  const codexToml = path.join(home, ".codex", "config.toml");
  try {
    if (removeTomlMcpServer(codexToml)) {
      log(`  Removed phren from Codex MCP config (${codexToml})`);
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${codexToml}: ${errorMessage(err)}`); }

  const codexCandidates = codexJsonCandidates((process.env.PHREN_PATH) || DEFAULT_PHREN_PATH);
  for (const mcpFile of codexCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed phren from Codex MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove phren entries from Copilot hooks file (filter, don't bulk-delete)
  const copilotHooksFile = hookConfigPath("copilot", (process.env.PHREN_PATH) || DEFAULT_PHREN_PATH);
  try {
    if (filterAgentHooks(copilotHooksFile, "bash")) {
      log(`  Removed phren entries from Copilot hooks (${copilotHooksFile})`);
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${copilotHooksFile}: ${errorMessage(err)}`); }

  // Remove phren entries from Cursor hooks file (may contain non-phren entries)
  const cursorHooksFile = hookConfigPath("cursor", (process.env.PHREN_PATH) || DEFAULT_PHREN_PATH);
  try {
    if (fs.existsSync(cursorHooksFile)) {
      const raw = JSON.parse(fs.readFileSync(cursorHooksFile, "utf8"));
      let changed = false;
      for (const key of ["sessionStart", "beforeSubmitPrompt", "stop"]) {
        if (raw[key]?.command && typeof raw[key].command === "string" && isPhrenCommand(raw[key].command)) {
          delete raw[key];
          changed = true;
        }
      }
      if (changed) {
        atomicWriteText(cursorHooksFile, JSON.stringify(raw, null, 2));
        log(`  Removed phren entries from Cursor hooks (${cursorHooksFile})`);
      }
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${cursorHooksFile}: ${errorMessage(err)}`); }

  // Remove phren entries from Codex hooks file (filter, don't bulk-delete)
  const uninstallPhrenPath = (process.env.PHREN_PATH) || DEFAULT_PHREN_PATH;
  const codexHooksFile = hookConfigPath("codex", uninstallPhrenPath);
  try {
    if (filterAgentHooks(codexHooksFile, "command")) {
      log(`  Removed phren entries from Codex hooks (${codexHooksFile})`);
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${codexHooksFile}: ${errorMessage(err)}`); }

  // Remove session wrapper scripts (written by installSessionWrapper)
  const localBinDir = path.join(home, ".local", "bin");
  for (const tool of ["copilot", "cursor", "codex"]) {
    const wrapperPath = path.join(localBinDir, tool);
    try {
      if (fs.existsSync(wrapperPath)) {
        // Only remove if it's a phren wrapper (check for PHREN_PATH marker)
        const content = fs.readFileSync(wrapperPath, "utf8");
        if (content.includes("PHREN_PATH") && content.includes("phren")) {
          fs.unlinkSync(wrapperPath);
          log(`  Removed ${tool} session wrapper (${wrapperPath})`);
        }
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${wrapperPath}: ${errorMessage(err)}`); }
  }

  try {
    if (fs.existsSync(machineFile)) {
      fs.unlinkSync(machineFile);
      log(`  Removed machine alias (${machineFile})`);
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${machineFile}: ${errorMessage(err)}`); }

  // Sweep agent skill directories for symlinks pointing into the phren store
  if (phrenPath) {
    try {
      sweepSkillSymlinks(phrenPath);
    } catch (err: unknown) {
      debugLog(`uninstall: skill symlink sweep failed: ${errorMessage(err)}`);
    }
  }

  if (phrenPath && fs.existsSync(phrenPath)) {
    try {
      fs.rmSync(phrenPath, { recursive: true, force: true });
      log(`  Removed phren root (${phrenPath})`);
    } catch (err: unknown) {
      debugLog(`uninstall: cleanup failed for ${phrenPath}: ${errorMessage(err)}`);
      log(`  Warning: could not remove phren root (${phrenPath})`);
    }
  }

  log(`\nPhren config, hooks, and installed data removed.`);
  log(`Restart your agent(s) to apply changes.\n`);
}
