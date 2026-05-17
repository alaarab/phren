import { getPhrenPath, readRootManifest } from "../shared.js";
import { installPreferencesFile } from "../phren-paths.js";
import {
  getIndexPolicy,
  updateIndexPolicy,
  getRetentionPolicy,
  updateRetentionPolicy,
  getWorkflowPolicy,
  updateWorkflowPolicy,
  mergeConfig,
  VALID_TASK_MODES,
  VALID_FINDING_SENSITIVITY,
  type FindingSensitivityLevel,
} from "../shared/governance.js";
import { listMachines as listMachinesStore, listProfiles as listProfilesStore, listProfiles } from "../data/access.js";
import { setTelemetryEnabled, getTelemetrySummary, resetTelemetry } from "../telemetry.js";
import {
  governanceInstallPreferencesFile,
  readInstallPreferences,
  readGovernanceInstallPreferences,
  writeInstallPreferences,
  writeGovernanceInstallPreferences,
} from "../init/preferences.js";
import {
  PROACTIVITY_LEVELS,
  getProactivityLevel,
  getProactivityLevelForTask,
  getProactivityLevelForFindings,
  type ProactivityLevel,
} from "../proactivity.js";
import {
  PROJECT_OWNERSHIP_MODES,
  getProjectOwnershipDefault,
  parseProjectOwnershipMode,
  updateProjectConfigOverrides,
  readProjectConfig,
  writeProjectConfig,
  type ProjectAccessControl,
} from "../project-config.js";
import * as fs from "fs";
import * as path from "path";
import { buildConfigView, type ConfigView } from "../config/resolve.js";
import { CONFIG_DOMAINS } from "../config/schema.js";
import {
  isValidProjectName,
  learnedSynonymsPath,
  learnSynonym,
  loadLearnedSynonyms,
  removeLearnedSynonym,
} from "../utils.js";
// ── Shared helpers ────────────────────────────────────────────────────────────

function parseProjectArg(args: string[]): { project?: string; rest: string[] } {
  const project = args.find((a) => a.startsWith("--project="))?.slice("--project=".length)
    ?? (args.indexOf("--project") !== -1 ? args[args.indexOf("--project") + 1] : undefined);
  const rest = args.filter((a, i) =>
    a !== "--project" && !a.startsWith("--project=") && args[i - 1] !== "--project"
  );
  return { project, rest };
}

export function checkProjectInProfile(phrenPath: string, project: string): string | null {
  const profiles = listProfiles(phrenPath);
  if (profiles.ok) {
    const registered = profiles.data.some((entry) => entry.projects.includes(project));
    if (!registered) {
      return `Warning: Project '${project}' not found in active profile. Run 'phren add /path/to/${project}' first.\n  Config was written to ${phrenPath}/${project}/phren.project.yaml but won't be used until the project is registered.`;
    }
  }
  return null;
}

function warnIfUnregistered(phrenPath: string, project: string): void {
  const warning = checkProjectInProfile(phrenPath, project);
  if (warning) console.error(warning);
}

export function buildProactivitySnapshot(phrenPath: string) {
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

// ── Config show ───────────────────────────────────────────────────────────────

function formatConfigValue(value: unknown): string {
  if (value === undefined || value === null) return "(unset)";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "(none)";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/**
 * Render a resolved {@link ConfigView} grouped by domain, with a source column
 * that names where each value came from (default / global / project) and the
 * file that set it.
 */
function renderConfigView(view: ConfigView, opts: { diff: boolean }): void {
  const heading = view.scope === "project"
    ? `phren config — project: ${view.project}`
    : "phren config — global (applies to all projects unless overridden)";
  console.log(`\n${heading}`);
  if (opts.diff) console.log("(showing only values customised away from defaults)");

  let shownAny = false;
  for (const domain of CONFIG_DOMAINS) {
    const rows: Array<{ label: string; value: string; source: string }> = [];
    for (const field of domain.fields) {
      const resolved = view.fields[field.key];
      if (!resolved) continue; // topic fields are resolved separately
      if (opts.diff && resolved.source === "default") continue;
      const file = resolved.sourcePath ? path.basename(resolved.sourcePath) : "";
      rows.push({
        label: field.label,
        value: formatConfigValue(resolved.value),
        source: resolved.source === "default"
          ? "default"
          : `${resolved.source}${file ? ` (${file})` : ""}`,
      });
    }
    if (!rows.length) continue;
    shownAny = true;
    console.log(`\n${domain.label}  —  ${domain.summary}`);
    const labelW = Math.max(...rows.map((r) => r.label.length));
    const valueW = Math.max(...rows.map((r) => r.value.length), 6);
    for (const r of rows) {
      console.log(`  ${r.label.padEnd(labelW)}  ${r.value.padEnd(valueW)}  ${r.source}`);
    }
  }
  if (!shownAny) {
    console.log(opts.diff ? "\nEverything is at its default value." : "\n(no config)");
  }
  console.log("");
}

function handleConfigShow(args: string[]): void {
  const phrenPath = getPhrenPath();
  const { project: projectArg, rest } = parseProjectArg(args);
  const asJson = rest.includes("--json");
  const diff = rest.includes("--diff");

  if (projectArg && !isValidProjectName(projectArg)) {
    console.error(`Invalid project name: "${projectArg}"`);
    process.exit(1);
  }

  const view = buildConfigView(phrenPath, projectArg);

  if (asJson) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }

  renderConfigView(view, { diff });

  if (projectArg) {
    const notRegistered = checkProjectInProfile(phrenPath, projectArg);
    if (notRegistered) {
      console.error(`Run 'phren add /path/to/${projectArg}' to register this project.\n`);
    }
  } else {
    console.log("Tips: '--project <name>' for a project's merged config, '--diff' for only customised values, '--json' for machine-readable output.\n");
  }
}

// ── Config router ────────────────────────────────────────────────────────────

export async function handleConfig(args: string[]) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "show":
      return handleConfigShow(rest);
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
    case "access":
      return handleConfigAccess(rest);
    case "llm":
      return handleConfigLlm(rest);
    case "synonyms":
      return handleConfigSynonyms(rest);
    default:
      console.log(`phren config - manage settings and policies

Subcommands:
  phren config show [--project <name>] [--diff] [--json]
                                        Full merged config grouped by domain, with the
                                        source (default/global/project) of every value
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
  phren config access [--project <name>] [get|set --admins=...]
                                        Role-based access lists (admins|contributors|readers)
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

function handleConfigProactivity(subcommand: "proactivity" | "proactivity.findings" | "proactivity.tasks", args: string[]) {
  const phrenPath = getPhrenPath();
  const { project: projectArg, rest: filteredArgs } = parseProjectArg(args);
  const value = filteredArgs[0];

  if (value === undefined) {
    if (projectArg) {
      if (!isValidProjectName(projectArg)) {
        console.error(`Invalid project name: "${projectArg}"`);
        process.exit(1);
      }
      const resolved = mergeConfig(phrenPath, projectArg);
      console.log(JSON.stringify({
        _project: projectArg,
        base: resolved.proactivity.base ?? null,
        findings: resolved.proactivity.findings ?? null,
        tasks: resolved.proactivity.tasks ?? null,
      }, null, 2));
      return;
    }
    console.log(JSON.stringify(buildProactivitySnapshot(phrenPath), null, 2));
    return;
  }

  if (filteredArgs.length !== 1) {
    printProactivityUsage(subcommand);
    process.exit(1);
  }

  const level = normalizeProactivityLevel(value);
  if (!level) {
    printProactivityUsage(subcommand);
    process.exit(1);
  }

  if (projectArg) {
    if (!isValidProjectName(projectArg)) {
      console.error(`Invalid project name: "${projectArg}"`);
      process.exit(1);
    }
    warnIfUnregistered(phrenPath, projectArg);
    const key = subcommand === "proactivity" ? "proactivity"
      : subcommand === "proactivity.findings" ? "proactivityFindings"
      : "proactivityTask";
    updateProjectConfigOverrides(phrenPath, projectArg, (current) => ({ ...current, [key]: level }));
    const resolved = mergeConfig(phrenPath, projectArg);
    console.log(JSON.stringify({
      _project: projectArg,
      base: resolved.proactivity.base ?? null,
      findings: resolved.proactivity.findings ?? null,
      tasks: resolved.proactivity.tasks ?? null,
    }, null, 2));
    return;
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

  console.log(JSON.stringify(buildProactivitySnapshot(phrenPath), null, 2));
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

// ── Finding sensitivity config ────────────────────────────────────────────────

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

// ── Generic workflow field handler ────────────────────────────────────────────

interface WorkflowFieldHandlerOpts<T extends string> {
  fieldName: string;
  validValues: readonly T[];
  normalize: (raw: string | undefined) => T | null;
  getSnapshot: (phrenPath: string) => Record<string, unknown>;
  getProjectValue: (resolved: ReturnType<typeof mergeConfig>) => T;
  formatProjectOutput: (projectArg: string, value: T) => Record<string, unknown>;
  workflowPatchKey: string;
  projectOverrideKey: string;
}

function handleWorkflowField<T extends string>(args: string[], opts: WorkflowFieldHandlerOpts<T>) {
  const phrenPath = getPhrenPath();
  const { project: projectArg, rest: filteredArgs } = parseProjectArg(args);
  const action = filteredArgs[0];

  if (!action || action === "get") {
    if (projectArg) {
      if (!isValidProjectName(projectArg)) {
        console.error(`Invalid project name: "${projectArg}"`);
        process.exit(1);
      }
      const resolved = mergeConfig(phrenPath, projectArg);
      const value = opts.getProjectValue(resolved);
      console.log(JSON.stringify(opts.formatProjectOutput(projectArg, value), null, 2));
      return;
    }
    console.log(JSON.stringify(opts.getSnapshot(phrenPath), null, 2));
    return;
  }

  const applyValue = (value: T) => {
    if (projectArg) {
      if (!isValidProjectName(projectArg)) {
        console.error(`Invalid project name: "${projectArg}"`);
        process.exit(1);
      }
      warnIfUnregistered(phrenPath, projectArg);
      updateProjectConfigOverrides(phrenPath, projectArg, (current) => ({ ...current, [opts.projectOverrideKey]: value }));
      const resolved = mergeConfig(phrenPath, projectArg);
      const eff = opts.getProjectValue(resolved);
      console.log(JSON.stringify(opts.formatProjectOutput(projectArg, eff), null, 2));
      return;
    }
    const result = updateWorkflowPolicy(phrenPath, { [opts.workflowPatchKey]: value });
    if (!result.ok) {
      console.error(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(opts.getSnapshot(phrenPath), null, 2));
  };

  if (action === "set") {
    const value = opts.normalize(filteredArgs[1]);
    if (!value) {
      console.error(`Usage: phren config ${opts.fieldName} set [${opts.validValues.join("|")}]`);
      process.exit(1);
    }
    return applyValue(value);
  }

  const value = opts.normalize(action);
  if (value) return applyValue(value);

  console.error(`Usage: phren config ${opts.fieldName} [--project <name>] [get|set <value>|<value>]  — values: ${opts.validValues.join("|")}`);
  process.exit(1);
}

function normalizeFromList<T extends string>(raw: string | undefined, validValues: readonly T[]): T | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  return validValues.includes(lower as T) ? lower as T : null;
}

function handleConfigTaskMode(args: string[]) {
  handleWorkflowField(args, {
    fieldName: "task-mode",
    validValues: VALID_TASK_MODES,
    normalize: (raw) => normalizeFromList(raw, VALID_TASK_MODES),
    getSnapshot: (phrenPath) => ({ taskMode: getWorkflowPolicy(phrenPath).taskMode }),
    getProjectValue: (resolved) => resolved.taskMode,
    formatProjectOutput: (proj, value) => ({ _project: proj, taskMode: value }),
    workflowPatchKey: "taskMode",
    projectOverrideKey: "taskMode",
  });
}

function handleConfigFindingSensitivity(args: string[]) {
  handleWorkflowField(args, {
    fieldName: "finding-sensitivity",
    validValues: VALID_FINDING_SENSITIVITY,
    normalize: (raw) => normalizeFromList(raw, VALID_FINDING_SENSITIVITY),
    getSnapshot: (phrenPath) => {
      const policy = getWorkflowPolicy(phrenPath);
      const level = policy.findingSensitivity;
      return { level, ...FINDING_SENSITIVITY_CONFIG[level] };
    },
    getProjectValue: (resolved) => resolved.findingSensitivity,
    formatProjectOutput: (proj, value) => ({ _project: proj, level: value, ...FINDING_SENSITIVITY_CONFIG[value] }),
    workflowPatchKey: "findingSensitivity",
    projectOverrideKey: "findingSensitivity",
  });
}

// ── LLM config ───────────────────────────────────────────────────────────────

const EXPENSIVE_MODEL_RE = /opus|sonnet|gpt-4(?!o-mini)/i;
const DEFAULT_LLM_MODEL = "gpt-4o-mini / claude-haiku-4-5-20251001";

function printSemanticCostNotice(model?: string): void {
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
      console.error(result.error);
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
  const phrenPath = getPhrenPath();
  const { project: projectArg, rest: filteredArgs } = parseProjectArg(args);

  if (!filteredArgs.length || filteredArgs[0] === "get") {
    if (projectArg) {
      if (!isValidProjectName(projectArg)) {
        console.error(`Invalid project name: "${projectArg}"`);
        process.exit(1);
      }
      const resolved = mergeConfig(phrenPath, projectArg);
      console.log(JSON.stringify({ _project: projectArg, ...resolved.retentionPolicy }, null, 2));
      return;
    }
    console.log(JSON.stringify(getRetentionPolicy(phrenPath), null, 2));
    const conflictOn = process.env.PHREN_FEATURE_SEMANTIC_CONFLICT === "1";
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
  if (filteredArgs[0] === "set") {
    if (projectArg) {
      if (!isValidProjectName(projectArg)) {
        console.error(`Invalid project name: "${projectArg}"`);
        process.exit(1);
      }
      warnIfUnregistered(phrenPath, projectArg);
      updateProjectConfigOverrides(phrenPath, projectArg, (current) => {
        const existingRetention = current.retentionPolicy ?? {};
        const retentionPatch: NonNullable<typeof existingRetention> = { ...existingRetention };
        for (const arg of filteredArgs.slice(1)) {
          if (!arg.startsWith("--")) continue;
          const [k, v] = arg.slice(2).split("=");
          if (!k || v === undefined) continue;
          const num = Number(v);
          const value = Number.isNaN(num) ? v : num;
          if (k.startsWith("decay.")) {
            retentionPatch.decay = { ...(retentionPatch.decay ?? {}) };
            (retentionPatch.decay as Record<string, unknown>)[k.slice("decay.".length)] = value;
          } else {
            (retentionPatch as Record<string, unknown>)[k] = value;
          }
        }
        return { ...current, retentionPolicy: retentionPatch };
      });
      const resolved = mergeConfig(phrenPath, projectArg);
      console.log(JSON.stringify({ _project: projectArg, ...resolved.retentionPolicy }, null, 2));
      return;
    }
    const patch: Record<string, unknown> = {};
    for (const arg of filteredArgs.slice(1)) {
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
    const result = updateRetentionPolicy(phrenPath, patch);
    if (!result.ok) {
      console.error(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }
  console.error("Usage: phren config policy [--project <name>] [get|set --ttlDays=120 --retentionDays=365 --autoAcceptThreshold=0.75 --minInjectConfidence=0.35 --decay.d30=1 --decay.d60=0.85 --decay.d90=0.65 --decay.d120=0.45]");
  process.exit(1);
}

// ── Memory workflow ──────────────────────────────────────────────────────────

export async function handleWorkflowPolicy(args: string[]) {
  const phrenPath = getPhrenPath();
  const { project: projectArg, rest: filteredArgs } = parseProjectArg(args);

  if (!filteredArgs.length || filteredArgs[0] === "get") {
    if (projectArg) {
      if (!isValidProjectName(projectArg)) {
        console.error(`Invalid project name: "${projectArg}"`);
        process.exit(1);
      }
      const resolved = mergeConfig(phrenPath, projectArg);
      console.log(JSON.stringify({ _project: projectArg, ...resolved.workflowPolicy }, null, 2));
      return;
    }
    console.log(JSON.stringify(getWorkflowPolicy(phrenPath), null, 2));
    return;
  }
  if (filteredArgs[0] === "set") {
    if (projectArg) {
      if (!isValidProjectName(projectArg)) {
        console.error(`Invalid project name: "${projectArg}"`);
        process.exit(1);
      }
      warnIfUnregistered(phrenPath, projectArg);
      updateProjectConfigOverrides(phrenPath, projectArg, (current) => {
        const nextConfig = { ...current };
        const existingWorkflow = current.workflowPolicy ?? {};
        const workflowPatch: Record<string, unknown> = { ...existingWorkflow };
        for (const arg of filteredArgs.slice(1)) {
          if (!arg.startsWith("--")) continue;
          const [k, v] = arg.slice(2).split("=");
          if (!k || v === undefined) continue;
          if (k === "riskySections") {
            workflowPatch.riskySections = v.split(",").map((s) => s.trim()).filter(Boolean);
          } else if (k === "taskMode") {
            nextConfig.taskMode = v as typeof nextConfig.taskMode;
          } else if (k === "findingSensitivity") {
            nextConfig.findingSensitivity = v as typeof nextConfig.findingSensitivity;
          } else {
            const num = Number(v);
            workflowPatch[k] = Number.isNaN(num) ? v : num;
          }
        }
        if (Object.keys(workflowPatch).length > 0 || existingWorkflow !== current.workflowPolicy) {
          nextConfig.workflowPolicy = workflowPatch as typeof nextConfig.workflowPolicy;
        }
        return nextConfig;
      });
      const resolved = mergeConfig(phrenPath, projectArg);
      console.log(JSON.stringify({ _project: projectArg, ...resolved.workflowPolicy }, null, 2));
      return;
    }
    const patch: Record<string, unknown> = {};
    for (const arg of filteredArgs.slice(1)) {
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
    const result = updateWorkflowPolicy(phrenPath, patch);
    if (!result.ok) {
      console.log(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }
  console.error("Usage: phren config workflow [--project <name>] [get|set --lowConfidenceThreshold=0.7 --riskySections=Stale,Conflicts --taskMode=manual]");
  process.exit(1);
}

// ── Access control ───────────────────────────────────────────────────────────

const ACCESS_ROLES = ["admins", "contributors", "readers"] as const;

function globalAccessFile(phrenPath: string): string {
  return path.join(phrenPath, ".config", "access-control.json");
}

function readGlobalAccess(phrenPath: string): ProjectAccessControl {
  const file = globalAccessFile(phrenPath);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseRoleList(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function printAccessSnapshot(phrenPath: string, projectArg: string | undefined): void {
  const view = buildConfigView(phrenPath, projectArg);
  console.log(JSON.stringify({
    _project: projectArg ?? null,
    _note: "Effective lists are the union of global and per-project roles. All lists empty everywhere = open mode.",
    admins: view.fields["access.admins"].value,
    contributors: view.fields["access.contributors"].value,
    readers: view.fields["access.readers"].value,
  }, null, 2));
}

export function handleConfigAccess(args: string[]) {
  const phrenPath = getPhrenPath();
  const { project: projectArg, rest } = parseProjectArg(args);
  const action = rest[0];

  if (projectArg && !isValidProjectName(projectArg)) {
    console.error(`Invalid project name: "${projectArg}"`);
    process.exit(1);
  }

  if (!action || action === "get") {
    printAccessSnapshot(phrenPath, projectArg);
    return;
  }

  if (action === "set") {
    const patch: ProjectAccessControl = {};
    let touched = false;
    for (const arg of rest.slice(1)) {
      if (!arg.startsWith("--")) continue;
      const [k, v] = arg.slice(2).split("=");
      if (!k || v === undefined) continue;
      if ((ACCESS_ROLES as readonly string[]).includes(k)) {
        patch[k as keyof ProjectAccessControl] = parseRoleList(v);
        touched = true;
      }
    }
    if (!touched) {
      console.error("Usage: phren config access [--project <name>] set --admins=a,b --contributors=c --readers=d");
      process.exit(1);
    }
    if (projectArg) {
      warnIfUnregistered(phrenPath, projectArg);
      const current = readProjectConfig(phrenPath, projectArg);
      writeProjectConfig(phrenPath, projectArg, {
        access: { ...(current.access ?? {}), ...patch },
      });
    } else {
      const next = { ...readGlobalAccess(phrenPath), ...patch };
      const file = globalAccessFile(phrenPath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
    }
    printAccessSnapshot(phrenPath, projectArg);
    return;
  }

  console.error("Usage: phren config access [--project <name>] [get|set --admins=a,b --contributors=c --readers=d]");
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
