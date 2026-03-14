import { getPhrenPath, readRootManifest } from "./shared.js";
import { installPreferencesFile } from "./phren-paths.js";
import {
  getIndexPolicy,
  updateIndexPolicy,
  getRetentionPolicy,
  updateRetentionPolicy,
  getWorkflowPolicy,
  updateWorkflowPolicy,
} from "./shared-governance.js";
import { listMachines as listMachinesStore, listProfiles as listProfilesStore } from "./data-access.js";
import { setTelemetryEnabled, getTelemetrySummary, resetTelemetry } from "./telemetry.js";
import {
  governanceInstallPreferencesFile,
  readInstallPreferences,
  readGovernanceInstallPreferences,
  writeInstallPreferences,
  writeGovernanceInstallPreferences,
} from "./init-preferences.js";
import {
  PROACTIVITY_LEVELS,
  getProactivityLevel,
  getProactivityLevelForTask,
  getProactivityLevelForFindings,
  type ProactivityLevel,
} from "./proactivity.js";
import {
  PROJECT_OWNERSHIP_MODES,
  getProjectOwnershipDefault,
  parseProjectOwnershipMode,
} from "./project-config.js";
import {
  isValidProjectName,
  learnedSynonymsPath,
  learnSynonym,
  loadLearnedSynonyms,
  removeLearnedSynonym,
} from "./utils.js";
// ── Config router ────────────────────────────────────────────────────────────

export async function handleConfig(args: string[]) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "policy":
      return handleRetentionPolicy(rest);
    case "workflow":
      return handleWorkflowPolicy(rest);
    case "index":
      return handleIndexPolicy(rest);
    case "machines":
      return handleConfigMachines();
    case "profiles":
      return handleConfigProfiles();
    case "telemetry":
      return handleConfigTelemetry(rest);
    case "proactivity":
    case "proactivity.findings":
    case "proactivity.tasks":
      return handleConfigProactivity(sub, rest);
    case "project-ownership":
      return handleConfigProjectOwnership(rest);
    case "task-mode":
      return handleConfigTaskMode(rest);
    case "finding-sensitivity":
      return handleConfigFindingSensitivity(rest);
    case "llm":
      return handleConfigLlm(rest);
    case "synonyms":
      return handleConfigSynonyms(rest);
    default:
      console.log(`phren config - manage settings and policies

Subcommands:
  phren config policy [get|set ...]     Memory retention, TTL, confidence, decay
  phren config workflow [get|set ...]   Risky-memory thresholds, task automation mode
  phren config index [get|set ...]      Indexer include/exclude globs
  phren config proactivity [level]      Base auto-capture level (high|medium|low)
  phren config proactivity.findings [level]
                                        Findings-specific auto-capture level override
  phren config proactivity.tasks [level]
                                        Task-specific auto-capture level override
  phren config task-mode [get|set <mode>]
                                        Task automation mode (off|manual|suggest|auto)
  phren config finding-sensitivity [get|set <level>]
                                        Finding capture level (minimal|conservative|balanced|aggressive)
  phren config project-ownership [mode]
                                        Default ownership for future project enrollments
  phren config llm [get|set model|endpoint|key]
                                        LLM config for semantic dedup/conflict features
  phren config synonyms [list|add|remove] ...
                                        Manage project learned synonyms
  phren config machines                 Registered machines and profiles
  phren config profiles                 All profiles and their projects
  phren config telemetry [on|off|reset] Local usage stats (opt-in, no external reporting)`);
      if (sub) {
        console.error(`\nUnknown config subcommand: "${sub}"`);
        process.exit(1);
      }
  }
}

function normalizeProactivityLevel(raw: string | undefined): ProactivityLevel | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return PROACTIVITY_LEVELS.includes(normalized as ProactivityLevel)
    ? normalized as ProactivityLevel
    : undefined;
}

function printProactivityUsage(subcommand: string): void {
  console.error(`Usage: phren config ${subcommand} [high|medium|low]`);
}

function printSynonymsUsage(): void {
  console.error("Usage: phren config synonyms list <project>");
  console.error("       phren config synonyms add <project> <term> <syn1,syn2,...>");
  console.error("       phren config synonyms remove <project> <term> [syn1,syn2,...]");
}

function parseSynonymItems(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function handleConfigSynonyms(args: string[]) {
  const phrenPath = getPhrenPath();
  let action = args[0] || "list";
  let project = args[1];
  if (action !== "list" && action !== "add" && action !== "remove" && isValidProjectName(action)) {
    project = action;
    action = "list";
  }

  if (!project || !isValidProjectName(project)) {
    printSynonymsUsage();
    process.exit(1);
  }

  if (action === "list") {
    console.log(JSON.stringify({
      project,
      path: learnedSynonymsPath(phrenPath, project),
      synonyms: loadLearnedSynonyms(project, phrenPath),
    }, null, 2));
    return;
  }

  if (action === "add") {
    const term = args[2];
    const synonyms = parseSynonymItems(args[3]);
    if (!term || synonyms.length === 0) {
      printSynonymsUsage();
      process.exit(1);
    }
    const updated = learnSynonym(phrenPath, project, term, synonyms);
    console.log(JSON.stringify({ project, term, synonyms: updated[term.toLowerCase()] ?? [], updated }, null, 2));
    return;
  }

  if (action === "remove") {
    const term = args[2];
    if (!term) {
      printSynonymsUsage();
      process.exit(1);
    }
    const updated = removeLearnedSynonym(phrenPath, project, term, parseSynonymItems(args[3]));
    console.log(JSON.stringify({ project, term: term.toLowerCase(), updated }, null, 2));
    return;
  }

  printSynonymsUsage();
  process.exit(1);
}

function proactivityConfigSnapshot(phrenPath: string) {
  const prefs = readGovernanceInstallPreferences(phrenPath);
  return {
    path: governanceInstallPreferencesFile(phrenPath),
    configured: {
      proactivity: prefs.proactivity ?? null,
      proactivityFindings: prefs.proactivityFindings ?? null,
      proactivityTask: prefs.proactivityTask ?? null,
    },
    effective: {
      proactivity: getProactivityLevel(phrenPath),
      proactivityFindings: getProactivityLevelForFindings(phrenPath),
      proactivityTask: getProactivityLevelForTask(phrenPath),
    },
  };
}

function handleConfigProactivity(subcommand: "proactivity" | "proactivity.findings" | "proactivity.tasks", args: string[]) {
  const phrenPath = getPhrenPath();
  const value = args[0];

  if (value === undefined) {
    console.log(JSON.stringify(proactivityConfigSnapshot(phrenPath), null, 2));
    return;
  }

  if (args.length !== 1) {
    printProactivityUsage(subcommand);
    process.exit(1);
  }

  const level = normalizeProactivityLevel(value);
  if (!level) {
    printProactivityUsage(subcommand);
    process.exit(1);
  }

  switch (subcommand) {
    case "proactivity":
      writeGovernanceInstallPreferences(phrenPath, { proactivity: level });
      break;
    case "proactivity.findings":
      writeGovernanceInstallPreferences(phrenPath, { proactivityFindings: level });
      break;
    case "proactivity.tasks":
      writeGovernanceInstallPreferences(phrenPath, { proactivityTask: level });
      break;
  }

  console.log(JSON.stringify(proactivityConfigSnapshot(phrenPath), null, 2));
}

function projectOwnershipConfigSnapshot(phrenPath: string) {
  const prefs = readInstallPreferences(phrenPath);
  return {
    path: installPreferencesFile(phrenPath),
    configured: {
      projectOwnershipDefault: prefs.projectOwnershipDefault ?? null,
    },
    effective: {
      projectOwnershipDefault: getProjectOwnershipDefault(phrenPath),
    },
  };
}

function handleConfigProjectOwnership(args: string[]) {
  const phrenPath = getPhrenPath();
  const value = args[0];

  if (value === undefined) {
    console.log(JSON.stringify(projectOwnershipConfigSnapshot(phrenPath), null, 2));
    return;
  }

  if (args.length !== 1) {
    console.error(`Usage: phren config project-ownership [${PROJECT_OWNERSHIP_MODES.join("|")}]`);
    process.exit(1);
  }

  const ownership = parseProjectOwnershipMode(value);
  if (!ownership) {
    console.error(`Usage: phren config project-ownership [${PROJECT_OWNERSHIP_MODES.join("|")}]`);
    process.exit(1);
  }

  writeInstallPreferences(phrenPath, { projectOwnershipDefault: ownership });
  console.log(JSON.stringify(projectOwnershipConfigSnapshot(phrenPath), null, 2));
}

// ── Task mode ─────────────────────────────────────────────────────────────────

const TASK_MODES = ["off", "manual", "suggest", "auto"] as const;
type TaskMode = typeof TASK_MODES[number];

function normalizeTaskMode(raw: string | undefined): TaskMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return TASK_MODES.includes(normalized as TaskMode) ? normalized as TaskMode : undefined;
}

function taskModeConfigSnapshot(phrenPath: string) {
  const policy = getWorkflowPolicy(phrenPath);
  return {
    taskMode: policy.taskMode,
  };
}

function handleConfigTaskMode(args: string[]) {
  const phrenPath = getPhrenPath();
  const action = args[0];

  if (!action || action === "get") {
    console.log(JSON.stringify(taskModeConfigSnapshot(phrenPath), null, 2));
    return;
  }

  if (action === "set") {
    const mode = normalizeTaskMode(args[1]);
    if (!mode) {
      console.error(`Usage: phren config task-mode set [${TASK_MODES.join("|")}]`);
      process.exit(1);
    }
    const result = updateWorkflowPolicy(phrenPath, { taskMode: mode });
    if (!result.ok) {
      console.error(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(taskModeConfigSnapshot(phrenPath), null, 2));
    return;
  }

  // Bare value: phren config task-mode auto
  const mode = normalizeTaskMode(action);
  if (mode) {
    const result = updateWorkflowPolicy(phrenPath, { taskMode: mode });
    if (!result.ok) {
      console.error(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(taskModeConfigSnapshot(phrenPath), null, 2));
    return;
  }

  console.error(`Usage: phren config task-mode [get|set <mode>|<mode>]  — modes: ${TASK_MODES.join("|")}`);
  process.exit(1);
}

// ── Finding sensitivity ───────────────────────────────────────────────────────

const FINDING_SENSITIVITY_LEVELS = ["minimal", "conservative", "balanced", "aggressive"] as const;
type FindingSensitivityLevel = typeof FINDING_SENSITIVITY_LEVELS[number];

export const FINDING_SENSITIVITY_CONFIG: Record<FindingSensitivityLevel, {
  sessionCap: number;
  proactivityFindings: string;
  agentInstruction: string;
}> = {
  minimal: {
    sessionCap: 0,
    proactivityFindings: "low",
    agentInstruction: "Only save findings when the user explicitly asks you to remember something.",
  },
  conservative: {
    sessionCap: 3,
    proactivityFindings: "medium",
    agentInstruction: "Save decisions and pitfalls only — skip patterns and observations.",
  },
  balanced: {
    sessionCap: 10,
    proactivityFindings: "high",
    agentInstruction: "Save non-obvious patterns, decisions, pitfalls, and bugs worth remembering next session.",
  },
  aggressive: {
    sessionCap: 20,
    proactivityFindings: "high",
    agentInstruction: "Save everything worth remembering — err on the side of capturing.",
  },
};

function normalizeFindingSensitivity(v: string | undefined): FindingSensitivityLevel | null {
  if (!v) return null;
  const lower = v.toLowerCase();
  if (FINDING_SENSITIVITY_LEVELS.includes(lower as FindingSensitivityLevel)) return lower as FindingSensitivityLevel;
  return null;
}

function findingSensitivityConfigSnapshot(phrenPath: string) {
  const policy = getWorkflowPolicy(phrenPath);
  const level = policy.findingSensitivity;
  const config = FINDING_SENSITIVITY_CONFIG[level];
  return { level, ...config };
}

function handleConfigFindingSensitivity(args: string[]) {
  const phrenPath = getPhrenPath();
  const action = args[0];

  if (!action || action === "get") {
    console.log(JSON.stringify(findingSensitivityConfigSnapshot(phrenPath), null, 2));
    return;
  }

  if (action === "set") {
    const level = normalizeFindingSensitivity(args[1]);
    if (!level) {
      console.error(`Usage: phren config finding-sensitivity set [${FINDING_SENSITIVITY_LEVELS.join("|")}]`);
      process.exit(1);
    }
    const result = updateWorkflowPolicy(phrenPath, { findingSensitivity: level });
    if (!result.ok) {
      console.error(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(findingSensitivityConfigSnapshot(phrenPath), null, 2));
    return;
  }

  // Bare value: phren config finding-sensitivity balanced
  const level = normalizeFindingSensitivity(action);
  if (level) {
    const result = updateWorkflowPolicy(phrenPath, { findingSensitivity: level });
    if (!result.ok) {
      console.error(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(findingSensitivityConfigSnapshot(phrenPath), null, 2));
    return;
  }

  console.error(`Usage: phren config finding-sensitivity [get|set <level>|<level>]  — levels: ${FINDING_SENSITIVITY_LEVELS.join("|")}`);
  process.exit(1);
}

// ── LLM config ───────────────────────────────────────────────────────────────

const EXPENSIVE_MODEL_RE = /opus|sonnet|gpt-4(?!o-mini)/i;
const DEFAULT_LLM_MODEL = "gpt-4o-mini / claude-haiku-4-5-20251001";

export function printSemanticCostNotice(model?: string): void {
  const effectiveModel = model || process.env.PHREN_LLM_MODEL || DEFAULT_LLM_MODEL;
  console.log(`  Note: Each semantic check is ~80 input + ~5 output tokens (one call per 'maybe' pair, cached 24h).`);
  console.log(`  Current model: ${effectiveModel}`);
  if (model && EXPENSIVE_MODEL_RE.test(model)) {
    console.log(`  Warning: This model is 20x more expensive than Haiku for yes/no checks.`);
    console.log(`  Consider: PHREN_LLM_MODEL=claude-haiku-4-5-20251001`);
  }
}

function llmConfigSnapshot() {
  return {
    model: process.env.PHREN_LLM_MODEL || null,
    endpoint: process.env.PHREN_LLM_ENDPOINT || null,
    keySet: Boolean(process.env.PHREN_LLM_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY),
    note: `Set via environment variables. Each semantic check: ~80 input + ~5 output tokens. Default model: ${DEFAULT_LLM_MODEL}.`,
  };
}

function handleConfigLlm(args: string[]) {
  const action = args[0];

  if (!action || action === "get") {
    const snapshot = llmConfigSnapshot();
    console.log(JSON.stringify(snapshot, null, 2));
    const model = process.env.PHREN_LLM_MODEL;
    if (model && EXPENSIVE_MODEL_RE.test(model)) {
      process.stderr.write(`\nWarning: PHREN_LLM_MODEL=${model} is expensive for yes/no semantic checks.\n`);
      process.stderr.write(`Consider: PHREN_LLM_MODEL=claude-haiku-4-5-20251001\n`);
    }
    return;
  }

  if (action === "set") {
    const key = args[1];
    const value = args[2];
    if (!key || !value) {
      console.error("Usage: phren config llm set model <name>");
      console.error("       phren config llm set endpoint <url>");
      console.error("       phren config llm set key <api-key>");
      process.exit(1);
    }
    const envMap: Record<string, string> = {
      model: "PHREN_LLM_MODEL",
      endpoint: "PHREN_LLM_ENDPOINT",
      key: "PHREN_LLM_KEY",
    };
    const envVar = envMap[key];
    if (!envVar) {
      console.error(`Unknown setting "${key}". Valid: model, endpoint, key`);
      process.exit(1);
    }
    console.log(`Set ${envVar}=${value} in your shell or ~/.phren/.env`);
    if (key === "model") {
      printSemanticCostNotice(value);
    }
    return;
  }

  console.error("Usage: phren config llm [get|set model <name>|set endpoint <url>|set key <api-key>]");
  process.exit(1);
}

// ── Index policy ─────────────────────────────────────────────────────────────

export async function handleIndexPolicy(args: string[]) {
  if (!args.length || args[0] === "get") {
    console.log(JSON.stringify(getIndexPolicy(getPhrenPath()), null, 2));
    return;
  }
  if (args[0] === "set") {
    const patch: {
      includeGlobs?: string[];
      excludeGlobs?: string[];
      includeHidden?: boolean;
    } = {};
    for (const arg of args.slice(1)) {
      if (!arg.startsWith("--")) continue;
      const [k, v] = arg.slice(2).split("=");
      if (!k || v === undefined) continue;
      if (k === "include") {
        patch.includeGlobs = v.split(",").map((s) => s.trim()).filter(Boolean);
      } else if (k === "exclude") {
        patch.excludeGlobs = v.split(",").map((s) => s.trim()).filter(Boolean);
      } else if (k === "includeHidden") {
        patch.includeHidden = /^(1|true|yes|on)$/i.test(v);
      }
    }
    const result = updateIndexPolicy(getPhrenPath(), patch);
    if (!result.ok) {
      console.log(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }
  console.error("Usage: phren index-policy [get|set --include=**/*.md,**/skills/**/*.md,.claude/skills/**/*.md --exclude=**/node_modules/**,**/.git/** --includeHidden=false]");
  process.exit(1);
}

// ── Memory policy ────────────────────────────────────────────────────────────

export async function handleRetentionPolicy(args: string[]) {
  if (!args.length || args[0] === "get") {
    console.log(JSON.stringify(getRetentionPolicy(getPhrenPath()), null, 2));
    const dedupOn = (process.env.PHREN_FEATURE_SEMANTIC_DEDUP ?? (process.env.PHREN_FEATURE_SEMANTIC_DEDUP || process.env.PHREN_FEATURE_SEMANTIC_DEDUP)) === "1";
    const conflictOn = (process.env.PHREN_FEATURE_SEMANTIC_CONFLICT ?? (process.env.PHREN_FEATURE_SEMANTIC_CONFLICT || process.env.PHREN_FEATURE_SEMANTIC_CONFLICT)) === "1";
    process.stderr.write(`\nDedup: free Jaccard similarity scan on every add_finding (no API key needed).\n`);
    process.stderr.write(`  Near-matches (30–55% overlap) are returned in the response for the agent to decide.\n`);
    if (conflictOn) {
      process.stderr.write(`\nConflict detection (PHREN_FEATURE_SEMANTIC_CONFLICT=1): active.\n`);
      process.stderr.write(`  Uses an LLM for batch conflict checks. See: phren config llm\n`);
    } else {
      process.stderr.write(`\nConflict detection: disabled (set PHREN_FEATURE_SEMANTIC_CONFLICT=1 to enable for batch ops).\n`);
      process.stderr.write(`  LLM needed only for batch operations (phren maintain consolidate/extract).\n`);
    }
    return;
  }
  if (args[0] === "set") {
    const patch: Record<string, unknown> = {};
    for (const arg of args.slice(1)) {
      if (!arg.startsWith("--")) continue;
      const [k, v] = arg.slice(2).split("=");
      if (!k || v === undefined) continue;
      const num = Number(v);
      const value = Number.isNaN(num) ? v : num;
      if (k.startsWith("decay.")) {
        patch.decay = patch.decay || {};
        (patch.decay as Record<string, unknown>)[k.slice("decay.".length)] = value;
      } else {
        patch[k] = value;
      }
    }
    const result = updateRetentionPolicy(getPhrenPath(), patch);
    if (!result.ok) {
      console.log(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }
  console.error("Usage: phren config policy [get|set --ttlDays=120 --retentionDays=365 --autoAcceptThreshold=0.75 --minInjectConfidence=0.35 --decay.d30=1 --decay.d60=0.85 --decay.d90=0.65 --decay.d120=0.45]");
  process.exit(1);
}

// ── Memory workflow ──────────────────────────────────────────────────────────

export async function handleWorkflowPolicy(args: string[]) {
  if (!args.length || args[0] === "get") {
    console.log(JSON.stringify(getWorkflowPolicy(getPhrenPath()), null, 2));
    return;
  }
  if (args[0] === "set") {
    const patch: Record<string, unknown> = {};
    for (const arg of args.slice(1)) {
      if (!arg.startsWith("--")) continue;
      const [k, v] = arg.slice(2).split("=");
      if (!k || v === undefined) continue;
      if (k === "riskySections") {
        patch.riskySections = v.split(",").map((s) => s.trim()).filter(Boolean);
      } else {
        const num = Number(v);
        patch[k] = Number.isNaN(num) ? v : num;
      }
    }
    const result = updateWorkflowPolicy(getPhrenPath(), patch);
    if (!result.ok) {
      console.log(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }
  console.error("Usage: phren config workflow [get|set --lowConfidenceThreshold=0.7 --riskySections=Stale,Conflicts --taskMode=manual]");
  process.exit(1);
}

// ── Machines and profiles ────────────────────────────────────────────────────

function handleConfigMachines() {
  const manifest = readRootManifest(getPhrenPath());
  if (manifest?.installMode === "project-local") {
    console.log("config machines is shared-mode only");
    return;
  }
  const result = listMachinesStore(getPhrenPath());
  if (!result.ok) {
    console.log(result.error);
    return;
  }
  const lines = Object.entries(result.data).map(([machine, prof]) => `  ${machine}: ${prof}`);
  console.log(`Registered Machines\n${lines.join("\n")}`);
}

function handleConfigProfiles() {
  const manifest = readRootManifest(getPhrenPath());
  if (manifest?.installMode === "project-local") {
    console.log("config profiles is shared-mode only");
    return;
  }
  const result = listProfilesStore(getPhrenPath());
  if (!result.ok) {
    console.log(result.error);
    return;
  }
  for (const p of result.data) {
    console.log(`\n${p.name}`);
    for (const proj of p.projects) console.log(`  - ${proj}`);
    if (!p.projects.length) console.log("  (no projects)");
  }
}

function handleConfigTelemetry(args: string[]) {
  const action = args[0];
  switch (action) {
    case "on":
      setTelemetryEnabled(getPhrenPath(), true);
      console.log("Telemetry enabled. Local usage stats will be collected.");
      console.log("No data is sent externally. Stats are stored in .runtime/telemetry.json.");
      return;
    case "off":
      setTelemetryEnabled(getPhrenPath(), false);
      console.log("Telemetry disabled.");
      return;
    case "reset":
      resetTelemetry(getPhrenPath());
      console.log("Telemetry stats reset.");
      return;
    default:
      console.log(getTelemetrySummary(getPhrenPath()));
  }
}
