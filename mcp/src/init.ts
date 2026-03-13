/**
 * CLI orchestrator for cortex init, mcp-mode, hooks-mode, and uninstall.
 * Delegates to focused helpers in init-config, init-setup, and init-preferences.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { configureAllHooks } from "./hooks.js";
import { getMachineName, machineFilePath, persistMachineName } from "./machine-identity.js";
import {
  debugLog,
  isRecord,
  hookConfigPath,
  homeDir,
  homePath,
  expandHomePath,
  findCortexPath,
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
  isCortexCommand,
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

import { DEFAULT_CORTEX_PATH, STARTER_DIR, VERSION, log, confirmPrompt } from "./init-shared.js";
import {
  PROJECT_OWNERSHIP_MODES,
  type ProjectOwnershipMode,
  parseProjectOwnershipMode,
  getProjectOwnershipDefault,
} from "./project-config.js";
import { PROACTIVITY_LEVELS, type ProactivityLevel } from "./proactivity.js";
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

function atomicWriteText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

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
  requireMaintainerApproval?: boolean;
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
  /** Set by walkthrough when user enables auto-capture; triggers writing ~/.cortex/.env */
  _walkthroughAutoCapture?: boolean;
  /** Set by walkthrough when user opts into local semantic search */
  _walkthroughSemanticSearch?: boolean;
  /** Set by walkthrough when user enables LLM semantic dedup */
  _walkthroughSemanticDedup?: boolean;
  /** Set by walkthrough when user enables LLM conflict detection */
  _walkthroughSemanticConflict?: boolean;
  /** Set by walkthrough when user provides a git clone URL for existing cortex */
  _walkthroughCloneUrl?: string;
  /** Set by walkthrough when the user wants the current repo enrolled immediately */
  _walkthroughBootstrapCurrentProject?: boolean;
  /** Set by walkthrough for the ownership mode selected for the current repo */
  _walkthroughBootstrapOwnership?: ProjectOwnershipMode;
  /** Set by walkthrough to select where cortex data is stored */
  _walkthroughStorageChoice?: StorageLocationChoice;
  /** Set by walkthrough to pass resolved storage path to init logic */
  _walkthroughStoragePath?: string;
  /** Set by walkthrough when project-local storage is chosen */
  _walkthroughStorageRepoRoot?: string;
}

function normalizedBootstrapProjectName(projectPath: string): string {
  return path.basename(projectPath).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function getPendingBootstrapTarget(cortexPath: string, opts: InitOptions): { path: string; mode: "explicit" | "detected" } | null {
  const cwdProject = detectProjectDir(process.cwd(), cortexPath);
  if (!cwdProject) return null;
  const projectName = normalizedBootstrapProjectName(cwdProject);
  if (isProjectTracked(cortexPath, projectName)) return null;
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

function hasInstallMarkers(cortexPath: string): boolean {
  return fs.existsSync(cortexPath) && (
    fs.existsSync(path.join(cortexPath, "machines.yaml")) ||
    fs.existsSync(path.join(cortexPath, ".governance")) ||
    fs.existsSync(path.join(cortexPath, "global"))
  );
}

function resolveInitCortexPath(opts: InitOptions): string {
  const raw = opts._walkthroughStoragePath || process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH;
  return path.resolve(expandHomePath(raw));
}

function detectRepoRootForStorage(cortexPath: string): string | null {
  return detectProjectDir(process.cwd(), cortexPath);
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
async function runWalkthrough(cortexPath: string): Promise<{
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
  requireMaintainerApproval: boolean;
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

  log("");
  log(style.header("  _____ ____  _____ _______ ________  ______"));
  log(style.header(" / ____/ __ \\|  __ \\__   __|  ____\\ \\/ /___"));
  log(style.header("| |   | |  | | |__) | | |  | |__   \\  /    "));
  log(style.header("| |   | |  | |  _  /  | |  |  __|  /  \\    "));
  log(style.header("| |___| |__| | | \\ \\  | |  | |____/ /\\ \\   "));
  log(style.header(" \\_____\\____/|_|  \\_\\ |_|  |______/_/  \\_\\  "));

  printSection("Welcome");
  log("Let's set up persistent memory for your AI agents.");
  log("Every option can be changed later.\n");

  printSection("Storage Location");
  log("Where should cortex store data?");
  const storageChoice = await prompts.select<StorageLocationChoice>(
    "Storage location",
    [
      {
        value: "global",
        name: "global (~/.cortex/ - default, shared across projects)",
      },
      {
        value: "project",
        name: "per-project (<repo>/.cortex/ - scoped to this repo, add to .gitignore)",
      },
      {
        value: "custom",
        name: "custom path",
      },
    ],
    "global"
  );

  let storagePath = path.resolve(homePath(".cortex"));
  let storageRepoRoot: string | undefined;
  if (storageChoice === "project") {
    const repoRoot = detectRepoRootForStorage(cortexPath);
    if (!repoRoot) {
      throw new Error("Per-project storage requires running init from a repository directory.");
    }
    storageRepoRoot = repoRoot;
    storagePath = path.join(repoRoot, ".cortex");
  } else if (storageChoice === "custom") {
    const customInput = await prompts.input("Custom cortex path", cortexPath);
    storagePath = path.resolve(expandHomePath(customInput || cortexPath));
  }

  printSection("Existing Cortex");
  log("If you've already set up cortex on another machine, paste the git clone URL.");
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
      projectOwnershipDefault: "cortex-managed" as ProjectOwnershipMode,
      findingsProactivity: "high" as ProactivityLevel,
      taskProactivity: "high" as ProactivityLevel,
      requireMaintainerApproval: false,
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
      "Project ownership default: cortex-managed",
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
  log("  cortex-managed: Cortex may mirror CLAUDE.md / AGENTS.md into the repo");
  log("  detached: Cortex keeps its own docs but does not write into the repo");
  log("  repo-managed: keep the repo's existing CLAUDE/AGENTS files as canonical");
  log("  Change later: npx cortex config project-ownership <mode>");
  const projectOwnershipDefault = await prompts.select<ProjectOwnershipMode>(
    "Default project ownership",
    [
      { value: "detached", name: "detached (default)" },
      { value: "cortex-managed", name: "cortex-managed" },
      { value: "repo-managed", name: "repo-managed" },
    ],
    "detached"
  );

  printSection("MCP");
  log("MCP mode registers cortex as a tool server so your AI agent can call it");
  log("directly: search memory, manage tasks, save findings, etc.");
  log("  Recommended for: Claude Code, Cursor, Copilot CLI, Codex");
  log("  Alternative: hooks-only mode (read-only context injection, any agent)");
  log("  Change later: npx cortex mcp-mode on|off");
  const mcp: McpMode = (await prompts.confirm("Enable MCP?", true)) ? "on" : "off";

  printSection("Hooks");
  log("Hooks run shell commands at session start, prompt submit, and session end.");
  log("  - SessionStart: git pull (keeps memory in sync across machines)");
  log("  - UserPromptSubmit: searches cortex and injects relevant context");
  log("  - Stop: commits and pushes any new findings after each response");
  log("  What they touch: ~/.claude/settings.json (hooks section only)");
  log("  Change later: npx cortex hooks-mode on|off");
  const hooks: McpMode = (await prompts.confirm("Enable hooks?", true)) ? "on" : "off";

  printSection("Semantic Search (Optional)");
  log("Cortex can use a local embedding model for semantic (fuzzy) search via Ollama.");
  log("  Best fit: paraphrase-heavy or weak-lexical queries.");
  log("  Skip it if you mostly search by filenames, symbols, commands, or exact phrases.");
  log("  - Model: nomic-embed-text (274 MB, one-time download)");
  log("  - Ollama runs locally, no cloud, no cost");
  log("  - Falls back to FTS5 keyword search if disabled or unavailable");
  log("  Change later: set CORTEX_OLLAMA_URL=off to disable");
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
          log("  To disable: set CORTEX_OLLAMA_URL=off in your shell profile");
        }
      }
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] init ollamaCheck: ${errorMessage(err)}\n`);
  }

  printSection("Auto-Capture (Optional)");
  log("After each session, cortex scans the conversation for insight-signal phrases");
  log("(\"always\", \"never\", \"pitfall\", \"gotcha\", etc.) and saves them automatically.");
  log("  - Runs silently in the Stop hook; captured findings go to FINDINGS.md");
  log("  - You can review and remove any auto-captured entry at any time");
  log("  - Can be toggled: set CORTEX_FEATURE_AUTO_CAPTURE=0 to disable");
  const autoCaptureEnabled = await prompts.confirm("Enable auto-capture?", true);
  let findingsProactivity: ProactivityLevel = "high";
  if (autoCaptureEnabled) {
    log("  Findings capture level controls how eager cortex is to save lessons automatically.");
    log("  Change later: npx cortex config proactivity.findings <high|medium|low>");
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
  log("Choose how cortex handles tasks as you work.");
  log("  auto (recommended): captures tasks naturally as you work, links findings to tasks");
  log("  suggest: proposes tasks but waits for approval before writing");
  log("  manual: tasks are fully manual — you add them yourself");
  log("  off: never touch tasks automatically");
  log("  Change later: npx cortex config workflow set --taskMode=<mode>");
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
    log("  Task proactivity controls how much evidence cortex needs before capturing tasks.");
    log("  high (recommended): captures tasks as they come up naturally");
    log("  medium: only when you explicitly mention a task");
    log("  low: minimal auto-capture");
    log("  Change later: npx cortex config proactivity.tasks <high|medium|low>");
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
  log("  requireMaintainerApproval: queue risky/low-confidence writes for review");
  log("  lowConfidenceThreshold: confidence cutoff used to mark writes as risky");
  log("  riskySections: sections always treated as risky");
  log("  Change later: npx cortex config workflow set --requireMaintainerApproval=true --lowConfidenceThreshold=0.7 --riskySections=Stale,Conflicts");
  const requireMaintainerApproval = await prompts.confirm("Require maintainer approval for risky writes?", false);
  const thresholdAnswer = await prompts.input("Low-confidence threshold [0.0-1.0]", "0.7");
  const lowConfidenceThreshold = parseLowConfidenceThreshold(thresholdAnswer, 0.7);
  const riskySectionsAnswer = await prompts.input("Risky sections [Review,Stale,Conflicts]", "Stale,Conflicts");
  const riskySections = parseRiskySectionsAnswer(riskySectionsAnswer, ["Stale", "Conflicts"]);

  // Only offer semantic dedup/conflict when an LLM endpoint is explicitly configured.
  // These features call /chat/completions, not an embedding endpoint, so we gate on
  // CORTEX_LLM_ENDPOINT (primary) or the presence of a known API key as a fallback.
  // CORTEX_EMBEDDING_API_URL alone is NOT sufficient — it only enables embeddings,
  // not the LLM chat call that callLlm() makes.
  const hasLlmApi = Boolean(
    process.env.CORTEX_LLM_ENDPOINT ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY
  );

  let semanticDedupEnabled = false;
  let semanticConflictEnabled = false;

  if (hasLlmApi) {
    printSection("LLM-Powered Memory Quality (Optional)");
    log("Cortex can use an LLM to catch near-duplicate or conflicting findings.");
    log("  Requires: CORTEX_LLM_ENDPOINT or ANTHROPIC_API_KEY/OPENAI_API_KEY set");

    log("");
    log("Semantic dedup: before saving a finding, ask the LLM whether it means the");
    log("same thing as an existing one (catches same idea with different wording).");
    semanticDedupEnabled = await prompts.confirm("Enable LLM-powered duplicate detection?", false);

    log("");
    log("Conflict detection: after saving a finding, check whether it contradicts an");
    log("existing one (e.g. \"always use X\" vs \"never use X\"). Adds an inline annotation.");
    semanticConflictEnabled = await prompts.confirm("Enable LLM-powered conflict detection?", false);

    if (semanticDedupEnabled || semanticConflictEnabled) {
      const currentModel = process.env.CORTEX_LLM_MODEL || "gpt-4o-mini / claude-haiku-4-5-20251001 (default)";
      log("");
      log("  Cost note: each semantic check is ~80 input + ~5 output tokens, cached 24h.");
      log(`  Current model: ${currentModel}`);
      const isExpensive = process.env.CORTEX_LLM_MODEL && /opus|sonnet|gpt-4(?!o-mini)/i.test(process.env.CORTEX_LLM_MODEL);
      if (isExpensive) {
        log(style.warning(`  Warning: ${process.env.CORTEX_LLM_MODEL} is 20x more expensive than Haiku for yes/no checks.`));
        log("  Consider: CORTEX_LLM_MODEL=claude-haiku-4-5-20251001");
      } else {
        log("  With Haiku: fractions of a cent/session. With Opus: ~$0.20/session for heavy use.");
        log("  Tip: set CORTEX_LLM_MODEL=claude-haiku-4-5-20251001 to keep costs low.");
      }
    }
  }

  printSection("Finding Sensitivity");
  log("Controls how eagerly agents save findings to memory.");
  log("  minimal      — only when you explicitly ask");
  log("  conservative — decisions and pitfalls only");
  log("  balanced     — non-obvious patterns, decisions, pitfalls, bugs (recommended)");
  log("  aggressive   — everything worth remembering, err on the side of capturing");
  log("  Change later: npx cortex config finding-sensitivity <level>");
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
  log(`Cortex stores memory as plain Markdown files in a git repo (${storagePath}).`);
  log("Push it to a private GitHub repo to sync memory across machines.");
  log("  Hooks will auto-commit + push after every session and pull on start.");
  log("  Skip this if you just want to try cortex locally first.");
  const githubAnswer = await prompts.input("GitHub username (leave blank to skip)");
  const githubUsername = githubAnswer || undefined;
  let githubRepo: string | undefined;
  if (githubUsername) {
    const repoAnswer = await prompts.input("Repo name", "my-cortex");
    githubRepo = repoAnswer || "my-cortex";
  }

  let bootstrapCurrentProject = false;
  let bootstrapOwnership: ProjectOwnershipMode | undefined;
  const detectedProject = detectProjectDir(process.cwd(), storagePath);
  if (detectedProject) {
    const detectedProjectName = path.basename(detectedProject);
    printSection("Current Project");
    log(`Detected project: ${detectedProjectName}`);
    bootstrapCurrentProject = await prompts.confirm("Add this project to cortex now?", true);
    if (!bootstrapCurrentProject) {
      bootstrapCurrentProject = false;
      log(style.warning(`  Skipped. Later: cd ${detectedProject} && npx cortex add`));
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
    `Maintainer approval for risky writes: ${requireMaintainerApproval ? "enabled" : "disabled"}`,
    `Low-confidence threshold: ${lowConfidenceThreshold}`,
    `Risky sections: ${riskySections.join(", ")}`,
    `Finding sensitivity: ${findingSensitivity}`,
    `Semantic search: ${ollamaEnabled ? "enabled" : "disabled"}`,
    `Semantic dedup: ${semanticDedupEnabled ? "enabled" : "disabled"}`,
    `Semantic conflict detection: ${semanticConflictEnabled ? "enabled" : "disabled"}`,
    `GitHub sync: ${githubUsername ? `${githubUsername}/${githubRepo ?? "my-cortex"}` : "skipped"}`,
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
    requireMaintainerApproval,
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

export async function warmSemanticSearch(cortexPath: string, profile?: string): Promise<string> {
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

  const db = await buildIndex(cortexPath, profile);
  try {
    const cache = getEmbeddingCache(cortexPath);
    await cache.load().catch(() => {});
    const allPaths = listIndexedDocumentPaths(cortexPath, profile);
    const before = cache.coverage(allPaths);
    if (before.missing > 0) {
      await backgroundEmbedMissingDocs(db, cache);
    }
    await cache.load().catch(() => {});
    const after = cache.coverage(allPaths);
    if (cache.size() > 0) {
      getPersistentVectorIndex(cortexPath).ensure(cache.getAllEntries());
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

function applyOnboardingPreferences(cortexPath: string, opts: InitOptions): void {
  if (opts.projectOwnershipDefault) {
    writeInstallPreferences(cortexPath, { projectOwnershipDefault: opts.projectOwnershipDefault });
  }
  const runtimePatch: {
    proactivityFindings?: ProactivityLevel;
    proactivityTask?: ProactivityLevel;
  } = {};
  if (opts.findingsProactivity) runtimePatch.proactivityFindings = opts.findingsProactivity;
  if (opts.taskProactivity) runtimePatch.proactivityTask = opts.taskProactivity;
  if (Object.keys(runtimePatch).length > 0) {
    writeInstallPreferences(cortexPath, runtimePatch);
  }
  const governancePatch: {
    proactivityFindings?: ProactivityLevel;
    proactivityTask?: ProactivityLevel;
  } = {};
  if (opts.findingsProactivity) governancePatch.proactivityFindings = opts.findingsProactivity;
  if (opts.taskProactivity) governancePatch.proactivityTask = opts.taskProactivity;
  if (Object.keys(governancePatch).length > 0) {
    writeGovernanceInstallPreferences(cortexPath, governancePatch);
  }
  const workflowPatch: {
    requireMaintainerApproval?: boolean;
    lowConfidenceThreshold?: number;
    riskySections?: WorkflowRiskSection[];
    taskMode?: "off" | "manual" | "suggest" | "auto";
    findingSensitivity?: "minimal" | "conservative" | "balanced" | "aggressive";
  } = {};
  if (typeof opts.requireMaintainerApproval === "boolean") workflowPatch.requireMaintainerApproval = opts.requireMaintainerApproval;
  if (typeof opts.lowConfidenceThreshold === "number") workflowPatch.lowConfidenceThreshold = opts.lowConfidenceThreshold;
  if (Array.isArray(opts.riskySections)) workflowPatch.riskySections = opts.riskySections;
  if (opts.taskMode) workflowPatch.taskMode = opts.taskMode;
  if (opts.findingSensitivity) workflowPatch.findingSensitivity = opts.findingSensitivity;
  if (Object.keys(workflowPatch).length > 0) {
    updateWorkflowPolicy(cortexPath, workflowPatch);
  }
}

function writeWalkthroughEnvDefaults(cortexPath: string, opts: InitOptions): string[] {
  const envFile = path.join(cortexPath, ".env");
  let envContent = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "# cortex feature flags — generated by init\n";
  const envFlags: { flag: string; label: string }[] = [];
  const autoCaptureChoice = opts._walkthroughAutoCapture;
  const hasAutoCaptureFlag = /^\s*CORTEX_FEATURE_AUTO_CAPTURE=.*$/m.test(envContent);
  if (typeof autoCaptureChoice === "boolean") {
    envFlags.push({
      flag: `CORTEX_FEATURE_AUTO_CAPTURE=${autoCaptureChoice ? "1" : "0"}`,
      label: `Auto-capture ${autoCaptureChoice ? "enabled" : "disabled"}`,
    });
  } else if (autoCaptureChoice !== false && !hasAutoCaptureFlag) {
    // Default to enabled on fresh installs and non-walkthrough init.
    envFlags.push({ flag: "CORTEX_FEATURE_AUTO_CAPTURE=1", label: "Auto-capture enabled" });
  }
  if (opts._walkthroughSemanticDedup) envFlags.push({ flag: "CORTEX_FEATURE_SEMANTIC_DEDUP=1", label: "Semantic dedup" });
  if (opts._walkthroughSemanticConflict) envFlags.push({ flag: "CORTEX_FEATURE_SEMANTIC_CONFLICT=1", label: "Conflict detection" });

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
  if (repaired.createdContextFile) repairedAssets.push("~/.cortex-context.md");
  if (repaired.createdRootMemory) repairedAssets.push("generated MEMORY.md");
  repairedAssets.push(...repaired.createdGlobalAssets);
  repairedAssets.push(...repaired.createdRuntimeAssets);
  repairedAssets.push(...repaired.createdFeatureDefaults);
  repairedAssets.push(...repaired.createdSkillArtifacts);
  return repairedAssets;
}

function applyProjectStorageBindings(repoRoot: string, cortexPath: string): string[] {
  const updates: string[] = [];
  if (ensureGitignoreEntry(repoRoot, ".cortex/")) {
    updates.push(`${path.join(repoRoot, ".gitignore")} (.cortex/)`);
  }
  if (upsertProjectEnvVar(repoRoot, "CORTEX_PATH", cortexPath)) {
    updates.push(`${path.join(repoRoot, ".env")} (CORTEX_PATH=${cortexPath})`);
  }
  return updates;
}

async function runProjectLocalInit(opts: InitOptions = {}): Promise<void> {
  const detectedRoot = detectProjectDir(process.cwd(), path.join(process.cwd(), ".cortex")) || process.cwd();
  const hasWorkspaceMarker =
    fs.existsSync(path.join(detectedRoot, ".git")) ||
    fs.existsSync(path.join(detectedRoot, "CLAUDE.md")) ||
    fs.existsSync(path.join(detectedRoot, "AGENTS.md")) ||
    fs.existsSync(path.join(detectedRoot, ".claude", "CLAUDE.md"));
  if (!hasWorkspaceMarker) {
    throw new Error("project-local mode must be run inside a repo or project root");
  }

  const workspaceRoot = path.resolve(detectedRoot);
  const cortexPath = path.join(workspaceRoot, ".cortex");
  const existingManifest = readRootManifest(cortexPath);
  if (existingManifest && existingManifest.installMode !== "project-local") {
    throw new Error(`Refusing to reuse non-local cortex root at ${cortexPath}`);
  }

  const ownershipDefault = opts.projectOwnershipDefault
    ?? (existingManifest ? getProjectOwnershipDefault(cortexPath) : "detached");
  if (!existingManifest && !opts.projectOwnershipDefault) {
    opts.projectOwnershipDefault = ownershipDefault;
  }
  const mcpEnabled = opts.mcp ? opts.mcp === "on" : true;
  const projectName = path.basename(workspaceRoot).toLowerCase().replace(/[^a-z0-9_-]/g, "-");

  if (opts.dryRun) {
    log("\nInit dry run. No files will be written.\n");
    log(`Mode: project-local`);
    log(`Workspace root: ${workspaceRoot}`);
    log(`Cortex root: ${cortexPath}`);
    log(`Project: ${projectName}`);
    log(`VS Code workspace MCP: ${mcpEnabled ? "on" : "off"}`);
    log(`Hooks: unsupported in project-local mode`);
    log("");
    return;
  }

  fs.mkdirSync(cortexPath, { recursive: true });
  writeRootManifest(cortexPath, {
    version: 1,
    installMode: "project-local",
    syncMode: "workspace-git",
    workspaceRoot,
    primaryProject: projectName,
  });
  ensureGovernanceFiles(cortexPath);
  repairPreexistingInstall(cortexPath);
  fs.mkdirSync(path.join(cortexPath, "global", "skills"), { recursive: true });
  fs.mkdirSync(path.join(cortexPath, ".runtime"), { recursive: true });
  fs.mkdirSync(path.join(cortexPath, ".sessions"), { recursive: true });
  if (!fs.existsSync(path.join(cortexPath, ".gitignore"))) {
    atomicWriteText(
      path.join(cortexPath, ".gitignore"),
      [
        ".runtime/",
        ".sessions/",
        "*.lock",
        "*.tmp-*",
        "",
      ].join("\n")
    );
  }
  if (!fs.existsSync(path.join(cortexPath, "global", "CLAUDE.md"))) {
    atomicWriteText(
      path.join(cortexPath, "global", "CLAUDE.md"),
      "# Global Context\n\nRepo-local Cortex instructions shared across this workspace.\n"
    );
  }

  const created = bootstrapFromExisting(cortexPath, workspaceRoot, { ownership: ownershipDefault });
  applyOnboardingPreferences(cortexPath, opts);
  writeInstallPreferences(cortexPath, {
    mcpEnabled,
    hooksEnabled: false,
    skillsScope: opts.skillsScope ?? "global",
    installedVersion: VERSION,
  });

  try {
    const vscodeResult = configureVSCode(cortexPath, { mcpEnabled, scope: "workspace" });
    logMcpTargetStatus("VS Code", vscodeResult, existingManifest ? "Updated" : "Configured");
  } catch (err: unknown) {
    debugLog(`configureVSCode(workspace) failed: ${errorMessage(err)}`);
  }

  log(`\n${existingManifest ? "Updated" : "Created"} project-local cortex at ${cortexPath}`);
  log(`  Workspace root: ${workspaceRoot}`);
  log(`  Project: ${created.project}`);
  log(`  Ownership: ${created.ownership}`);
  log(`  Sync mode: workspace-git`);
  log(`  Hooks: off (unsupported in project-local mode)`);
  log(`  VS Code MCP: ${mcpEnabled ? "workspace on" : "workspace off"}`);

  const verify = runPostInitVerify(cortexPath);
  log(`\nVerifying setup...`);
  for (const check of verify.checks) {
    log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
  }
}

export async function runInit(opts: InitOptions = {}) {
  if ((opts.mode || "shared") === "project-local") {
    await runProjectLocalInit(opts);
    return;
  }
  let cortexPath = resolveInitCortexPath(opts);
  const dryRun = Boolean(opts.dryRun);
  let hasExistingInstall = hasInstallMarkers(cortexPath);

  // Interactive walkthrough for first-time installs (skip with --yes or non-TTY)
  if (!hasExistingInstall && !dryRun && !opts.yes && process.stdin.isTTY && process.stdout.isTTY) {
    const answers = await runWalkthrough(cortexPath);
    opts._walkthroughStorageChoice = answers.storageChoice;
    opts._walkthroughStoragePath = answers.storagePath;
    opts._walkthroughStorageRepoRoot = answers.storageRepoRoot;
    cortexPath = resolveInitCortexPath(opts);
    hasExistingInstall = hasInstallMarkers(cortexPath);
    opts.machine = opts.machine || answers.machine;
    opts.profile = opts.profile || answers.profile;
    opts.mcp = opts.mcp || answers.mcp;
    opts.hooks = opts.hooks || answers.hooks;
    opts.projectOwnershipDefault = opts.projectOwnershipDefault || answers.projectOwnershipDefault;
    opts.findingsProactivity = opts.findingsProactivity || answers.findingsProactivity;
    opts.taskProactivity = opts.taskProactivity || answers.taskProactivity;
    if (typeof opts.requireMaintainerApproval !== "boolean") opts.requireMaintainerApproval = answers.requireMaintainerApproval;
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
      process.env._CORTEX_WALKTHROUGH_OLLAMA_SKIP = "1";
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
    log(`\nCloning existing cortex from ${opts._walkthroughCloneUrl}...`);
    try {
      execFileSync("git", ["clone", opts._walkthroughCloneUrl, cortexPath], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
      log(`  Cloned to ${cortexPath}`);
      // Re-check: the cloned repo should now be treated as an existing install
      hasExistingInstall = true;
    } catch (e: unknown) {
      log(`  Clone failed: ${e instanceof Error ? e.message : String(e)}`);
      log(`  Continuing with fresh install instead.`);
    }
  }

  const mcpEnabled = opts.mcp ? opts.mcp === "on" : getMcpEnabledPreference(cortexPath);
  const hooksEnabled = opts.hooks ? opts.hooks === "on" : getHooksEnabledPreference(cortexPath);
  const skillsScope: SkillsScope = opts.skillsScope ?? "global";
  const storageChoice = opts._walkthroughStorageChoice;
  const storageRepoRoot = opts._walkthroughStorageRepoRoot;
  const ownershipDefault = opts.projectOwnershipDefault
    ?? (hasExistingInstall ? getProjectOwnershipDefault(cortexPath) : "detached");
  if (!hasExistingInstall && !opts.projectOwnershipDefault) {
    opts.projectOwnershipDefault = ownershipDefault;
  }
  const mcpLabel = mcpEnabled ? "ON (recommended)" : "OFF (hooks-only fallback)";
  const hooksLabel = hooksEnabled ? "ON (active)" : "OFF (disabled)";
  const pendingBootstrap = getPendingBootstrapTarget(cortexPath, opts);
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
      shouldBootstrapCurrentProject = await prompts.confirm("Add this project to cortex now?", true);
      if (!shouldBootstrapCurrentProject) {
        shouldBootstrapCurrentProject = false;
        log(style.warning(`  Skipped. Later: cd ${pendingBootstrap.path} && npx cortex add`));
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
      log(`Storage location: ${storageChoice} (${cortexPath})`);
      if (storageChoice === "project" && storageRepoRoot) {
        log(`  Would update ${path.join(storageRepoRoot, ".gitignore")} with .cortex/`);
        log(`  Would set CORTEX_PATH in ${path.join(storageRepoRoot, ".env")}`);
      }
    }
    if (hasExistingInstall) {
      log(`cortex install detected at ${cortexPath}`);
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

    log(`No existing cortex install found at ${cortexPath}`);
    log(`Would create a new cortex install:\n`);
    log(`  Copy starter files to ${cortexPath} (or create minimal structure)`);
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
    const storageChanges = applyProjectStorageBindings(storageRepoRoot, cortexPath);
    for (const change of storageChanges) {
      log(`  Updated storage binding: ${change}`);
    }
  }

  if (hasExistingInstall) {
      writeRootManifest(cortexPath, {
        version: 1,
        installMode: "shared",
        syncMode: "managed-git",
      });
      ensureGovernanceFiles(cortexPath);
      const repaired = repairPreexistingInstall(cortexPath);
      applyOnboardingPreferences(cortexPath, opts);
      const existingGitRepo = ensureLocalGitRepo(cortexPath);
      log(`\ncortex already exists at ${cortexPath}`);
      log(`Updating configuration...\n`);
      log(`  MCP mode: ${mcpLabel}`);
      log(`  Hooks mode: ${hooksLabel}`);
      log(`  Default project ownership: ${ownershipDefault}`);
      log(`  Task mode: ${getWorkflowPolicy(cortexPath).taskMode}`);
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
      try {
        const status = configureClaude(cortexPath, { mcpEnabled, hooksEnabled });
        if (status === "disabled" || status === "already_disabled") {
          log(`  Updated Claude Code hooks (MCP disabled)`);
        } else {
          log(`  Updated Claude Code MCP + hooks`);
        }
      } catch (e) {
        log(`  Could not configure Claude Code settings (${e}), add manually`);
      }

      try {
        const vscodeResult = configureVSCode(cortexPath, { mcpEnabled });
        logMcpTargetStatus("VS Code", vscodeResult, "Updated");
      } catch (err: unknown) {
        debugLog(`configureVSCode failed: ${errorMessage(err)}`);
      }

      try {
        logMcpTargetStatus("Cursor", configureCursorMcp(cortexPath, { mcpEnabled }), "Updated");
      } catch (err: unknown) {
        debugLog(`configureCursorMcp failed: ${errorMessage(err)}`);
      }

      try {
        logMcpTargetStatus("Copilot CLI", configureCopilotMcp(cortexPath, { mcpEnabled }), "Updated");
      } catch (err: unknown) {
        debugLog(`configureCopilotMcp failed: ${errorMessage(err)}`);
      }

      try {
        logMcpTargetStatus("Codex", configureCodexMcp(cortexPath, { mcpEnabled }), "Updated");
      } catch (err: unknown) {
        debugLog(`configureCodexMcp failed: ${errorMessage(err)}`);
      }

      if (hooksEnabled) {
        try {
          const hooked = configureAllHooks(cortexPath, { allTools: true });
          if (hooked.length) log(`  Updated hooks: ${hooked.join(", ")}`);
        } catch (err: unknown) { debugLog(`configureAllHooks failed: ${errorMessage(err)}`); }
      } else {
        log(`  Hooks are disabled by preference (run: npx cortex hooks-mode on)`);
      }

      const prefs = readInstallPreferences(cortexPath);
      const previousVersion = prefs.installedVersion;
      if (isVersionNewer(VERSION, previousVersion)) {
        log(`\n  Starter template update available: v${previousVersion} -> v${VERSION}`);
        log(`  Run \`npx cortex init --apply-starter-update\` to refresh global/CLAUDE.md and global skills.`);
      }
      if (opts.applyStarterUpdate) {
        const updated = applyStarterTemplateUpdates(cortexPath);
        if (updated.length) {
          log(`  Applied starter template updates (${updated.length} file${updated.length === 1 ? "" : "s"}).`);
        } else {
          log(`  No starter template updates were applied (starter files not found).`);
        }
      }
      writeInstallPreferences(cortexPath, { mcpEnabled, hooksEnabled, skillsScope, installedVersion: VERSION });
      if (repaired.removedLegacyProjects > 0) {
        log(`  Removed ${repaired.removedLegacyProjects} legacy starter project entr${repaired.removedLegacyProjects === 1 ? "y" : "ies"} from profiles.`);
      }
      const repairedAssets = collectRepairedAssetLabels(repaired);
      if (repairedAssets.length > 0) {
        log(`  Recreated missing generated assets: ${repairedAssets.join(", ")}`);
      }

      // Post-update verification
      log(`\nVerifying setup...`);
      const verify = runPostInitVerify(cortexPath);
      for (const check of verify.checks) {
        log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
      }

      if (pendingBootstrap && shouldBootstrapCurrentProject) {
        try {
          const created = bootstrapFromExisting(cortexPath, pendingBootstrap.path, {
            profile: opts.profile,
            ownership: bootstrapOwnership,
          });
          log(`\nAdded current project "${created.project}" (${created.ownership})`);
        } catch (e: unknown) {
          debugLog(`Bootstrap from CWD failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      for (const envLabel of writeWalkthroughEnvDefaults(cortexPath, opts)) {
        log(`  ${envLabel}`);
      }

      log(`\ncortex updated successfully`);
      log(`\nNext steps:`);
      log(`  1. Start a new Claude session in your project directory — cortex injects context automatically`);
      log(`  2. Run \`npx cortex doctor\` to verify everything is wired correctly`);
      log(`  3. Change defaults anytime: \`npx cortex config project-ownership\`, \`npx cortex config workflow\`, \`npx cortex config proactivity.findings\`, \`npx cortex config proactivity.tasks\``);
      log(`  4. After your first week, run cortex-discover to surface gaps in your project knowledge`);
      log(`  5. After working across projects, run cortex-consolidate to find cross-project patterns`);
      log(``);
      return;
  }

  log("\nSetting up cortex...\n");

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
  const cwdProjectPath = !walkthroughProject ? detectProjectDir(process.cwd(), cortexPath) : null;
  const useTemplateProject = Boolean(walkthroughProject) || Boolean(opts.template);
  const firstProjectName = walkthroughProject || "my-first-project";
  const firstProjectDomain: InitProjectDomain = opts._walkthroughDomain ?? "software";

  // Copy bundled starter to ~/.cortex
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
    copyDir(STARTER_DIR, cortexPath);
    writeRootManifest(cortexPath, {
      version: 1,
      installMode: "shared",
      syncMode: "managed-git",
    });
    if (useTemplateProject) {
      const targetProject = walkthroughProject || firstProjectName;
      const projectDir = path.join(cortexPath, targetProject);
      const templateApplied = Boolean(opts.template && applyTemplate(projectDir, opts.template, targetProject));
      if (templateApplied) {
        log(`  Applied "${opts.template}" template to ${targetProject}`);
      }
      ensureProjectScaffold(projectDir, targetProject, firstProjectDomain, opts._walkthroughInferredScaffold);

      const targetProfile = opts.profile || "default";
      const addToProfile = addProjectToProfile(cortexPath, targetProfile, targetProject);
      if (!addToProfile.ok) {
        debugLog(`fresh init addProjectToProfile failed for ${targetProfile}/${targetProject}: ${addToProfile.error}`);
      }

      if (opts.template && !templateApplied) {
        log(`  Template "${opts.template}" not found. Available: ${listTemplates().join(", ") || "none"}`);
      }
      log(`  Seeded project "${targetProject}"`);
    }
    log(`  Created cortex v${VERSION} \u2192 ${cortexPath}`);
  } else {
    log(`  Starter not found in package, creating minimal structure...`);
    writeRootManifest(cortexPath, {
      version: 1,
      installMode: "shared",
      syncMode: "managed-git",
    });
    fs.mkdirSync(path.join(cortexPath, "global", "skills"), { recursive: true });
    fs.mkdirSync(path.join(cortexPath, "profiles"), { recursive: true });
    atomicWriteText(
      path.join(cortexPath, "global", "CLAUDE.md"),
      `# Global Context\n\nThis file is loaded in every project.\n\n## General preferences\n\n<!-- Your coding style, preferred tools, things Claude should always know -->\n`
    );
    if (useTemplateProject) {
      const projectDir = path.join(cortexPath, firstProjectName);
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
      path.join(cortexPath, "profiles", `${profileName}.yaml`),
      `name: ${profileName}\ndescription: Default profile\nprojects:\n${profileProjects}\n`
    );
  }

  // If CWD is a project dir, bootstrap it now when onboarding or defaults allow it.
  if (cwdProjectPath && shouldBootstrapCurrentProject) {
    try {
      const created = bootstrapFromExisting(cortexPath, cwdProjectPath, {
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
  updateMachinesYaml(cortexPath, effectiveMachine, opts.profile);
  ensureGovernanceFiles(cortexPath);
  const repaired = repairPreexistingInstall(cortexPath);
  applyOnboardingPreferences(cortexPath, opts);
  const localGitRepo = ensureLocalGitRepo(cortexPath);
  log(`  Updated machines.yaml with machine "${effectiveMachine}"`);
  log(`  MCP mode: ${mcpLabel}`);
  log(`  Hooks mode: ${hooksLabel}`);
  log(`  Default project ownership: ${ownershipDefault}`);
  log(`  Task mode: ${getWorkflowPolicy(cortexPath).taskMode}`);
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

  // Configure Claude Code
  try {
    const status = configureClaude(cortexPath, { mcpEnabled, hooksEnabled });
    if (status === "disabled" || status === "already_disabled") {
      log(`  Configured Claude Code hooks (MCP disabled)`);
    } else {
      log(`  Configured Claude Code MCP + hooks`);
    }
  } catch (e) {
    log(`  Could not configure Claude Code settings (${e}), add manually`);
  }

  // Configure VS Code
  try {
    const vscodeResult = configureVSCode(cortexPath, { mcpEnabled });
    logMcpTargetStatus("VS Code", vscodeResult, "Configured");
  } catch (err: unknown) {
    debugLog(`configureVSCode failed: ${errorMessage(err)}`);
  }

  try {
    logMcpTargetStatus("Cursor", configureCursorMcp(cortexPath, { mcpEnabled }), "Configured");
  } catch (err: unknown) {
    debugLog(`configureCursorMcp failed: ${errorMessage(err)}`);
  }

  try {
    logMcpTargetStatus("Copilot CLI", configureCopilotMcp(cortexPath, { mcpEnabled }), "Configured");
  } catch (err: unknown) {
    debugLog(`configureCopilotMcp failed: ${errorMessage(err)}`);
  }

  try {
    logMcpTargetStatus("Codex", configureCodexMcp(cortexPath, { mcpEnabled }), "Configured");
  } catch (err: unknown) {
    debugLog(`configureCodexMcp failed: ${errorMessage(err)}`);
  }

  // Configure hooks for other detected AI coding tools (Copilot CLI, Cursor, Codex)
  if (hooksEnabled) {
    try {
      const hooked = configureAllHooks(cortexPath, { allTools: true });
      if (hooked.length) log(`  Configured hooks: ${hooked.join(", ")}`);
    } catch (err: unknown) { debugLog(`configureAllHooks failed: ${errorMessage(err)}`); }
  } else {
    log(`  Hooks are disabled by preference (run: npx cortex hooks-mode on)`);
  }

  writeInstallPreferences(cortexPath, { mcpEnabled, hooksEnabled, skillsScope, installedVersion: VERSION });

  // Post-init verification
  log(`\nVerifying setup...`);
  const verify = runPostInitVerify(cortexPath);
  for (const check of verify.checks) {
    log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
  }

  log(`\nWhat was created:`);
  log(`  ${cortexPath}/global/CLAUDE.md    Global instructions loaded in every session`);
  log(`  ${cortexPath}/global/skills/      Cortex slash commands`);
  log(`  ${cortexPath}/profiles/           Machine-to-project mappings`);
  log(`  ${cortexPath}/.governance/        Memory quality settings and config`);

  // Ollama status summary (skip if already covered in walkthrough)
  const walkthroughCoveredOllama = Boolean(process.env._CORTEX_WALKTHROUGH_OLLAMA_SKIP) || (!hasExistingInstall && !opts.yes);
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
          log("  (Set CORTEX_OLLAMA_URL=off to hide this message)");
        }
      }
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] init ollamaInstallHint: ${errorMessage(err)}\n`);
    }
  }

  for (const envLabel of writeWalkthroughEnvDefaults(cortexPath, opts)) {
    log(`  ${envLabel}`);
  }

  if (opts._walkthroughSemanticSearch) {
    log(`\nWarming semantic search...`);
    try {
      log(`  ${await warmSemanticSearch(cortexPath, opts.profile)}`);
    } catch (err: unknown) {
      log(`  Semantic search warmup failed: ${errorMessage(err)}`);
    }
  }

  log(`\ncortex initialized`);
  log(`\nNext steps:`);
  let step = 1;
  log(`  ${step++}. Start a new Claude session in your project directory — cortex injects context automatically`);
  log(`  ${step++}. Run \`npx cortex doctor\` to verify everything is wired correctly`);
  log(`  ${step++}. Change defaults anytime: \`npx cortex config project-ownership\`, \`npx cortex config workflow\`, \`npx cortex config proactivity.findings\`, \`npx cortex config proactivity.tasks\``);

  const gh = opts._walkthroughGithub;
  if (gh) {
    const remote = gh.username
      ? `git@github.com:${gh.username}/${gh.repo}.git`
      : `git@github.com:YOUR_USERNAME/${gh.repo}.git`;
    log(`  ${step++}. Push your cortex to GitHub (private repo recommended):`);
    log(`     cd ${cortexPath}`);
    log(`     git add . && git commit -m "Initial cortex setup"`);
    if (gh.username) {
      log(`     gh repo create ${gh.username}/${gh.repo} --private --source=. --push`);
      log(`     # or manually: git remote add origin ${remote} && git push -u origin main`);
    } else {
      log(`     git remote add origin ${remote}`);
      log(`     git push -u origin main`);
    }
  } else {
    log(`  ${step++}. Push to GitHub for cross-machine sync (private repo recommended):`);
    log(`     cd ${cortexPath}`);
    log(`     git add . && git commit -m "Initial cortex setup"`);
    log(`     git remote add origin git@github.com:YOUR_USERNAME/my-cortex.git`);
    log(`     git push -u origin main`);
  }

  log(`  ${step++}. Add more projects: cd ~/your-project && npx cortex add`);

  if (!mcpEnabled) {
    log(`  ${step++}. Turn MCP on: npx cortex mcp-mode on`);
  }
  log(`  ${step++}. After your first week, run cortex-discover to surface gaps in your project knowledge`);
  log(`  ${step++}. After working across projects, run cortex-consolidate to find cross-project patterns`);
  log(`\n  Read ${cortexPath}/README.md for a guided tour of each file.`);

  log(``);
}

export async function runMcpMode(modeArg?: string) {
  const cortexPath = findCortexPath() || process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH;
  const manifest = readRootManifest(cortexPath);
  const normalizedArg = modeArg?.trim().toLowerCase();
  if (!normalizedArg || normalizedArg === "status") {
    const current = getMcpEnabledPreference(cortexPath);
    const hooks = getHooksEnabledPreference(cortexPath);
    log(`MCP mode: ${current ? "on (recommended)" : "off (hooks-only fallback)"}`);
    log(`Hooks mode: ${hooks ? "on (active)" : "off (disabled)"}`);
    log(`Change mode: npx cortex mcp-mode on|off`);
    log(`Hooks toggle: npx cortex hooks-mode on|off`);
    return;
  }
  const mode = parseMcpMode(normalizedArg);
  if (!mode) {
    throw new Error(`Invalid mode "${modeArg}". Use: on | off | status`);
  }
  const enabled = mode === "on";

  if (manifest?.installMode === "project-local") {
    const vscodeStatus = configureVSCode(cortexPath, { mcpEnabled: enabled, scope: "workspace" });
    setMcpEnabledPreference(cortexPath, enabled);
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
  try { claudeStatus = configureClaude(cortexPath, { mcpEnabled: enabled }) ?? claudeStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureClaude failed: ${errorMessage(err)}`); }
  try { vscodeStatus = configureVSCode(cortexPath, { mcpEnabled: enabled }) ?? vscodeStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureVSCode failed: ${errorMessage(err)}`); }
  try { cursorStatus = configureCursorMcp(cortexPath, { mcpEnabled: enabled }) ?? cursorStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCursorMcp failed: ${errorMessage(err)}`); }
  try { copilotStatus = configureCopilotMcp(cortexPath, { mcpEnabled: enabled }) ?? copilotStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCopilotMcp failed: ${errorMessage(err)}`); }
  try { codexStatus = configureCodexMcp(cortexPath, { mcpEnabled: enabled }) ?? codexStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCodexMcp failed: ${errorMessage(err)}`); }

  // Persist preference only after config writes have been attempted
  setMcpEnabledPreference(cortexPath, enabled);

  log(`MCP mode set to ${mode}.`);
  log(`Claude status: ${claudeStatus}`);
  log(`VS Code status: ${vscodeStatus}`);
  log(`Cursor status: ${cursorStatus}`);
  log(`Copilot CLI status: ${copilotStatus}`);
  log(`Codex status: ${codexStatus}`);
  log(`Restart your agent to apply changes.`);
}

export async function runHooksMode(modeArg?: string) {
  const cortexPath = findCortexPath() || process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH;
  const manifest = readRootManifest(cortexPath);
  const normalizedArg = modeArg?.trim().toLowerCase();
  if (!normalizedArg || normalizedArg === "status") {
    const current = getHooksEnabledPreference(cortexPath);
    log(`Hooks mode: ${current ? "on (active)" : "off (disabled)"}`);
    log(`Change mode: npx cortex hooks-mode on|off`);
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
    claudeStatus = configureClaude(cortexPath, {
      mcpEnabled: getMcpEnabledPreference(cortexPath),
      hooksEnabled: enabled,
    }) ?? claudeStatus;
  } catch (err: unknown) { debugLog(`hooks-mode: configureClaude failed: ${errorMessage(err)}`); }

  if (enabled) {
    try {
      const hooked = configureAllHooks(cortexPath, { allTools: true });
      if (hooked.length) log(`Updated hooks: ${hooked.join(", ")}`);
    } catch (err: unknown) { debugLog(`hooks-mode: configureAllHooks failed: ${errorMessage(err)}`); }
  } else {
    log("Hooks will no-op immediately via preference and Claude hooks are removed.");
  }

  // Persist preference only after config writes have been attempted
  setHooksEnabledPreference(cortexPath, enabled);

  log(`Hooks mode set to ${mode}.`);
  log(`Claude status: ${claudeStatus}`);
  log(`Restart your agent to apply changes.`);
}

export async function runUninstall() {
  const cortexPath = findCortexPath();
  const manifest = cortexPath ? readRootManifest(cortexPath) : null;
  if (manifest?.installMode === "project-local" && cortexPath) {
    log("\nUninstalling project-local cortex...\n");
    const workspaceRoot = manifest.workspaceRoot || path.dirname(cortexPath);
    const workspaceMcp = path.join(workspaceRoot, ".vscode", "mcp.json");
    try {
      if (removeMcpServerAtPath(workspaceMcp)) {
        log(`  Removed cortex from VS Code workspace MCP config (${workspaceMcp})`);
      }
    } catch (err: unknown) {
      debugLog(`uninstall local vscode cleanup failed: ${errorMessage(err)}`);
    }
    fs.rmSync(cortexPath, { recursive: true, force: true });
    log(`  Removed ${cortexPath}`);
    log("\nProject-local cortex uninstalled.");
    return;
  }

  log("\nUninstalling cortex...\n");

  const home = homeDir();
  const machineFile = machineFilePath();
  const settingsPath = hookConfigPath("claude");

  // Remove from Claude Code ~/.claude.json (where MCP servers are actually read)
  const claudeJsonPath = homePath(".claude.json");
  if (fs.existsSync(claudeJsonPath)) {
    try {
      if (removeMcpServerAtPath(claudeJsonPath)) {
        log(`  Removed cortex MCP server from ~/.claude.json`);
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
        if (data.mcpServers?.cortex) {
          delete data.mcpServers.cortex;
          log(`  Removed cortex MCP server from Claude Code settings`);
        }

        // Remove hooks containing cortex references
        for (const hookEvent of ["UserPromptSubmit", "Stop", "SessionStart", "PostToolUse"] as const) {
          const hooks = hooksMap[hookEvent] as HookEntry[] | undefined;
          if (!Array.isArray(hooks)) continue;
          const before = hooks.length;
          hooksMap[hookEvent] = hooks.filter(
            (h: HookEntry) => !h.hooks?.some(
              (hook) => typeof hook.command === "string" && isCortexCommand(hook.command)
            )
          );
          const removed = before - (hooksMap[hookEvent] as HookEntry[]).length;
          if (removed > 0) log(`  Removed ${removed} cortex hook(s) from ${hookEvent}`);
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
        log(`  Removed cortex from VS Code MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove from Cursor MCP config
  const cursorCandidates = cursorMcpCandidates();
  for (const mcpFile of cursorCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed cortex from Cursor MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove from Copilot CLI MCP config
  const copilotCandidates = copilotMcpCandidates();
  for (const mcpFile of copilotCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed cortex from Copilot CLI MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove from Codex MCP config (TOML + JSON)
  const codexToml = path.join(home, ".codex", "config.toml");
  try {
    if (removeTomlMcpServer(codexToml)) {
      log(`  Removed cortex from Codex MCP config (${codexToml})`);
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${codexToml}: ${errorMessage(err)}`); }

  const codexCandidates = codexJsonCandidates(process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH);
  for (const mcpFile of codexCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed cortex from Codex MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove Copilot hooks file (written by configureAllHooks)
  const copilotHooksFile = hookConfigPath("copilot", process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH);
  try {
    if (fs.existsSync(copilotHooksFile)) {
      fs.unlinkSync(copilotHooksFile);
      log(`  Removed Copilot hooks file (${copilotHooksFile})`);
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${copilotHooksFile}: ${errorMessage(err)}`); }

  // Remove cortex entries from Cursor hooks file (may contain non-cortex entries)
  const cursorHooksFile = hookConfigPath("cursor", process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH);
  try {
    if (fs.existsSync(cursorHooksFile)) {
      const raw = JSON.parse(fs.readFileSync(cursorHooksFile, "utf8"));
      let changed = false;
      for (const key of ["sessionStart", "beforeSubmitPrompt", "stop"]) {
        if (raw[key]?.command && typeof raw[key].command === "string" && isCortexCommand(raw[key].command)) {
          delete raw[key];
          changed = true;
        }
      }
      if (changed) {
        atomicWriteText(cursorHooksFile, JSON.stringify(raw, null, 2));
        log(`  Removed cortex entries from Cursor hooks (${cursorHooksFile})`);
      }
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${cursorHooksFile}: ${errorMessage(err)}`); }

  // Remove Codex hooks file in cortex path
  const uninstallCortexPath = process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH;
  const codexHooksFile = hookConfigPath("codex", uninstallCortexPath);
  try {
    if (fs.existsSync(codexHooksFile)) {
      fs.unlinkSync(codexHooksFile);
      log(`  Removed Codex hooks file (${codexHooksFile})`);
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${codexHooksFile}: ${errorMessage(err)}`); }

  // Remove session wrapper scripts (written by installSessionWrapper)
  const localBinDir = path.join(home, ".local", "bin");
  for (const tool of ["copilot", "cursor", "codex"]) {
    const wrapperPath = path.join(localBinDir, tool);
    try {
      if (fs.existsSync(wrapperPath)) {
        // Only remove if it's a cortex wrapper (check for CORTEX_PATH marker)
        const content = fs.readFileSync(wrapperPath, "utf8");
        if (content.includes("CORTEX_PATH") && content.includes("cortex")) {
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

  if (cortexPath && fs.existsSync(cortexPath)) {
    try {
      fs.rmSync(cortexPath, { recursive: true, force: true });
      log(`  Removed cortex root (${cortexPath})`);
    } catch (err: unknown) {
      debugLog(`uninstall: cleanup failed for ${cortexPath}: ${errorMessage(err)}`);
      log(`  Warning: could not remove cortex root (${cortexPath})`);
    }
  }

  log(`\nCortex config, hooks, and installed data removed.`);
  log(`Restart your agent(s) to apply changes.\n`);
}
