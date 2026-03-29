/**
 * Interactive walkthrough for first-time phren init.
 * Prompts the user through storage, identity, MCP, hooks, and feature configuration.
 */
import * as path from "path";
import type { ProjectOwnershipMode } from "../project-config.js";
import { PROJECT_OWNERSHIP_MODES } from "../project-config.js";
import type { ProactivityLevel } from "../proactivity.js";
import { getMachineName } from "../machine-identity.js";
import { expandHomePath, homePath } from "../shared.js";
import { errorMessage } from "../utils.js";
import { logger } from "../logger.js";
import { log } from "./shared.js";
import {
  detectProjectDir,
  type InitProjectDomain,
  type InferredInitScaffold,
  inferInitScaffoldFromRepo,
} from "./setup.js";
import type { McpMode } from "./shared.js";

type WorkflowRiskSection = "Review" | "Stale" | "Conflicts";
type StorageLocationChoice = "global" | "project" | "custom";

export type WalkthroughChoice<T extends string> = {
  value: T;
  name: string;
  description?: string;
};

export type WalkthroughPromptUi = {
  input(message: string, initialValue?: string): Promise<string>;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  select<T extends string>(message: string, choices: WalkthroughChoice<T>[], defaultValue?: T): Promise<T>;
};

export type WalkthroughStyle = {
  header: (text: string) => string;
  success: (text: string) => string;
  warning: (text: string) => string;
};

export function withFallbackColors(style?: {
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

export async function createWalkthroughStyle(): Promise<WalkthroughStyle> {
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

export async function createWalkthroughPrompts(): Promise<WalkthroughPromptUi> {
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

function detectRepoRootForStorage(phrenPath: string): string | null {
  return detectProjectDir(process.cwd(), phrenPath);
}

export interface WalkthroughResult {
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
}

export interface WalkthroughOptions {
  /** When true, skip the express prompt and use recommended defaults immediately */
  express?: boolean;
}

// Interactive walkthrough for first-time init
export async function runWalkthrough(phrenPath: string, options?: WalkthroughOptions): Promise<WalkthroughResult> {
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

  const { renderPhrenArt } = await import("../phren-art.js");
  log("");
  log(renderPhrenArt("  "));
  log("");

  printSection("Welcome");
  log("Let's set up persistent memory for your AI agents.");
  log("Every option can be changed later.\n");

  // Express mode: skip the entire walkthrough with recommended defaults
  const useExpress = options?.express === true
    || (options?.express !== false && await prompts.confirm(
      "Use recommended settings? (global storage, MCP on, hooks on, auto tasks)",
      true
    ));

  if (useExpress) {
    const expressResult: WalkthroughResult = {
      storageChoice: "global",
      storagePath: path.resolve(homePath(".phren")),
      machine: getMachineName(),
      profile: "personal",
      mcp: "on" as McpMode,
      hooks: "on" as McpMode,
      projectOwnershipDefault: "phren-managed" as ProjectOwnershipMode,
      findingsProactivity: "high" as ProactivityLevel,
      taskProactivity: "high" as ProactivityLevel,
      lowConfidenceThreshold: 0.7,
      riskySections: ["Stale", "Conflicts"],
      taskMode: "auto" as const,
      bootstrapCurrentProject: false,
      ollamaEnabled: false,
      autoCaptureEnabled: false,
      semanticDedupEnabled: false,
      semanticConflictEnabled: false,
      findingSensitivity: "balanced" as const,
      domain: "software" as InitProjectDomain,
    };
    printSummary([
      `Storage: global (${expressResult.storagePath})`,
      `Machine: ${expressResult.machine}`,
      "MCP: enabled",
      "Hooks: enabled",
      "Project ownership: phren-managed",
      "Task mode: auto",
      "Domain: software",
    ]);
    return expressResult;
  }

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
    const cloneConfig: WalkthroughResult = {
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
  log("  Change later: phren config project-ownership <mode>");
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
  log("  Change later: phren mcp-mode on|off");
  const mcp: McpMode = (await prompts.confirm("Enable MCP?", true)) ? "on" : "off";

  printSection("Hooks");
  log("Hooks run shell commands at session start, prompt submit, and session end.");
  log("  - SessionStart: git pull (keeps memory in sync across machines)");
  log("  - UserPromptSubmit: searches phren and injects relevant context");
  log("  - Stop: commits and pushes any new findings after each response");
  log("  What they touch: ~/.claude/settings.json (hooks section only)");
  log("  Change later: phren hooks-mode on|off");
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
    const { checkOllamaStatus } = await import("../shared/ollama.js");
    const status = await checkOllamaStatus();
    if (status === "ready") {
      log("  Ollama detected with nomic-embed-text ready.");
      ollamaEnabled = await prompts.confirm("Enable semantic search for fuzzy/paraphrase recovery?", false);
    } else if (status === "no_model") {
      log("  Ollama detected, but nomic-embed-text is not pulled yet.");
      ollamaEnabled = await prompts.confirm(
        "Enable semantic search for fuzzy/paraphrase recovery? (will pull nomic-embed-text)",
        false
      );
      if (ollamaEnabled) {
        log("  Run after init: ollama pull nomic-embed-text");
      }
    } else if (status === "not_running") {
      log("  Ollama not detected. Install it to enable semantic search:");
      log("    https://ollama.com  →  then: ollama pull nomic-embed-text");
      ollamaEnabled = await prompts.confirm("Enable semantic search (Ollama not installed yet)?", false);
      if (ollamaEnabled) {
        log(style.success("  Semantic search enabled — will activate once Ollama is running."));
        log("  To disable: set PHREN_OLLAMA_URL=off in your shell profile");
      }
    }
  } catch (err: unknown) {
    logger.debug("init", `init ollamaCheck: ${errorMessage(err)}`);
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
    log("  Change later: phren config proactivity.findings <high|medium|low>");
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
  log("  Change later: phren config workflow set --taskMode=<mode>");
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
    log("  Change later: phren config proactivity.tasks <high|medium|low>");
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
  log("  Change later: phren config workflow set --lowConfidenceThreshold=0.7 --riskySections=Stale,Conflicts");
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
  log("  Change later: phren config finding-sensitivity <level>");
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
      log(style.warning(`  Skipped. Later: cd ${detectedProject} && phren add`));
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
