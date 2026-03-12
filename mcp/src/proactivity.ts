import * as fs from "fs";
import { bootstrapCortexDotEnv } from "./cortex-dotenv.js";
import { debugLog, findCortexPath } from "./cortex-paths.js";
import { governanceInstallPreferencesFile, readInstallPreferences } from "./init-preferences.js";
import { errorMessage } from "./utils.js";
import { getWorkflowPolicy } from "./governance-policy.js";

export const PROACTIVITY_LEVELS = ["high", "medium", "low"] as const;
export type ProactivityLevel = typeof PROACTIVITY_LEVELS[number];

const DEFAULT_PROACTIVITY_LEVEL: ProactivityLevel = "high";
const EXPLICIT_FINDING_SIGNAL_PATTERN = /\b(add finding|worth remembering)\b/i;
const EXPLICIT_FINDING_TAG_PATTERN = /\[(pitfall|decision|pattern|tradeoff|architecture|bug)\]/i;
const EXPLICIT_TASK_SIGNAL_PATTERN = /\b(?:add(?:\s+(?:this|that|it))?\s+(?:to\s+(?:the\s+)?)?(?:task|todo(?:\s+list)?|task(?:\s+list)?)|add\s+(?:a\s+)?task|put(?:\s+(?:this|that|it))?\s+(?:in|on)\s+(?:the\s+)?(?:task|todo(?:\s+list)?|task(?:\s+list)?))\b/i;

function parseProactivityLevel(raw: string | undefined | null): ProactivityLevel | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return PROACTIVITY_LEVELS.includes(normalized as ProactivityLevel)
    ? normalized as ProactivityLevel
    : undefined;
}

interface GovernanceProactivityPreferences {
  proactivity?: ProactivityLevel;
  proactivityFindings?: ProactivityLevel;
  proactivityTask?: ProactivityLevel;
}

function resolveProactivityCortexPath(explicitCortexPath?: string): string | null {
  return explicitCortexPath ?? findCortexPath();
}

function readGovernanceProactivityPreferences(explicitCortexPath?: string): GovernanceProactivityPreferences {
  const cortexPath = resolveProactivityCortexPath(explicitCortexPath);
  if (!cortexPath) return {};

  const filePath = governanceInstallPreferencesFile(cortexPath);
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      proactivity?: string;
      proactivityFindings?: string;
      proactivityTask?: string;
    };
    return {
      proactivity: parseProactivityLevel(parsed?.proactivity),
      proactivityFindings: parseProactivityLevel(parsed?.proactivityFindings),
      proactivityTask: parseProactivityLevel(parsed?.proactivityTask),
    };
  } catch (err: unknown) {
    debugLog(`readGovernanceProactivityPreferences: failed to parse ${filePath}: ${errorMessage(err)}`);
  }

  return {};
}

function getConfiguredProactivityDefault(explicitCortexPath?: string): ProactivityLevel {
  const governancePreference = readGovernanceProactivityPreferences(explicitCortexPath).proactivity;
  if (governancePreference) return governancePreference;

  const cortexPath = resolveProactivityCortexPath(explicitCortexPath);
  if (cortexPath) {
    const runtimePreference = parseProactivityLevel(readInstallPreferences(cortexPath).proactivity);
    if (runtimePreference) return runtimePreference;
  }

  return DEFAULT_PROACTIVITY_LEVEL;
}

/** Map findingSensitivity from workflow-policy.json to a ProactivityLevel. */
function sensitivityToProactivity(sensitivity: string | undefined): ProactivityLevel | undefined {
  switch (sensitivity) {
    case "minimal": return "low";
    case "conservative": return "medium";
    case "balanced": return "high";
    case "aggressive": return "high";
    default: return undefined;
  }
}

function getWorkflowPolicySensitivityLevel(explicitCortexPath?: string): ProactivityLevel | undefined {
  const cortexPath = resolveProactivityCortexPath(explicitCortexPath);
  if (!cortexPath) return undefined;
  try {
    const policy = getWorkflowPolicy(cortexPath);
    return sensitivityToProactivity(policy.findingSensitivity);
  } catch {
    return undefined;
  }
}

function getConfiguredProactivityLevelForFindingsDefault(explicitCortexPath?: string): ProactivityLevel {
  const prefs = readGovernanceProactivityPreferences(explicitCortexPath);
  return prefs.proactivityFindings
    ?? prefs.proactivity
    ?? getWorkflowPolicySensitivityLevel(explicitCortexPath)
    ?? getConfiguredProactivityDefault(explicitCortexPath);
}

function getConfiguredProactivityLevelForTaskDefault(explicitCortexPath?: string): ProactivityLevel {
  const prefs = readGovernanceProactivityPreferences(explicitCortexPath);
  return prefs.proactivityTask
    ?? prefs.proactivity
    ?? getWorkflowPolicySensitivityLevel(explicitCortexPath)
    ?? getConfiguredProactivityDefault(explicitCortexPath);
}

function resolveProactivityLevel(raw: string | undefined, fallback: ProactivityLevel): ProactivityLevel {
  return parseProactivityLevel(raw) ?? fallback;
}

export function getProactivityLevel(explicitCortexPath?: string): ProactivityLevel {
  bootstrapCortexDotEnv();
  return resolveProactivityLevel(process.env.CORTEX_PROACTIVITY, getConfiguredProactivityDefault(explicitCortexPath));
}

export function getProactivityLevelForFindings(explicitCortexPath?: string): ProactivityLevel {
  bootstrapCortexDotEnv();
  const findingsPreference = parseProactivityLevel(process.env.CORTEX_PROACTIVITY_FINDINGS);
  if (findingsPreference) return findingsPreference;
  return resolveProactivityLevel(process.env.CORTEX_PROACTIVITY, getConfiguredProactivityLevelForFindingsDefault(explicitCortexPath));
}

export function getProactivityLevelForTask(explicitCortexPath?: string): ProactivityLevel {
  bootstrapCortexDotEnv();
  const taskPreference = parseProactivityLevel(process.env.CORTEX_PROACTIVITY_TASKS);
  if (taskPreference) return taskPreference;
  return resolveProactivityLevel(process.env.CORTEX_PROACTIVITY, getConfiguredProactivityLevelForTaskDefault(explicitCortexPath));
}

export function hasExplicitFindingSignal(...texts: Array<string | undefined | null>): boolean {
  return texts.some((text) => {
    if (!text) return false;
    return EXPLICIT_FINDING_SIGNAL_PATTERN.test(text) || EXPLICIT_FINDING_TAG_PATTERN.test(text);
  });
}

export function hasExplicitTaskSignal(...texts: Array<string | undefined | null>): boolean {
  return texts.some((text) => {
    if (!text) return false;
    return EXPLICIT_TASK_SIGNAL_PATTERN.test(text);
  });
}

export function shouldAutoCaptureFindingsForLevel(
  level: ProactivityLevel,
  ...texts: Array<string | undefined | null>
): boolean {
  if (level === "high") return true;
  if (level === "low") return false;
  return hasExplicitFindingSignal(...texts);
}

export function shouldAutoCaptureTaskForLevel(
  level: ProactivityLevel,
  ...texts: Array<string | undefined | null>
): boolean {
  if (level === "high") return true;
  if (level === "low") return false;
  return hasExplicitTaskSignal(...texts);
}

// ── Intent-aware auto task signals ──────────────────────────────────────────

const EXECUTION_INTENT_PATTERN = /\b(?:yes\s+do\s+it|do\s+it|go\s+ahead|work\s+on\s+(?:these|this|that|it)|let(?:'|')s\s+(?:build|ship|implement|start|do|go)|approve(?:d)?|ship\s+it|merge\s+it|commit|proceed|execute|deploy|push\s+it|make\s+it\s+happen|get\s+(?:it|this|that)\s+done)\b/i;

const DISCOVERY_INTENT_PATTERN = /\b(?:brainstorm|explore|what\s+if|ideas?\b|review\s+findings|think\s+about|consider|hypothetical|might\s+we|could\s+we\s+try|what\s+are\s+(?:the|some)\s+(?:options|alternatives|possibilities)|pros?\s+(?:and|&)\s+cons?|compare|evaluate|assess|weigh)\b/i;

export function hasExecutionIntent(...texts: Array<string | undefined | null>): boolean {
  return texts.some((text) => {
    if (!text) return false;
    return EXECUTION_INTENT_PATTERN.test(text);
  });
}

export function hasDiscoveryIntent(...texts: Array<string | undefined | null>): boolean {
  return texts.some((text) => {
    if (!text) return false;
    return DISCOVERY_INTENT_PATTERN.test(text);
  });
}

const SUPPRESS_TASK_PATTERN = /\b(?:don(?:'|\u2019)t\s+(?:create|add|track|make)\s+(?:a\s+)?task|no\s+task|skip\s+(?:the\s+)?task|don(?:'|\u2019)t\s+add\s+(?:that|this|those)\s+to\s+task|do\s+not\s+add|not\s+a\s+task|just\s+(?:a\s+)?question|just\s+asking|hypothetically|just\s+curious|ignore\s+(?:this|that))\b/i;

export function hasSuppressTaskIntent(...texts: Array<string | undefined | null>): boolean {
  return texts.some((text) => {
    if (!text) return false;
    return SUPPRESS_TASK_PATTERN.test(text);
  });
}

const CODE_CHANGE_PATTERN = /\b(?:git\s+(?:diff|status|add|commit|log)|npm\s+(?:run|test|build)|(?:edit|fix|change|update|modify)\s+(?:the\s+)?(?:file|code|function|method|class)|diff|patch|pull\s+request|pr\s+#?\d+|changed\s+file|modified\s+file|deleted\s+file|added\s+file|renamed\s+file)\b/i;

export function hasCodeChangeContext(...texts: Array<string | undefined | null>): boolean {
  return texts.some((text) => {
    if (!text) return false;
    return CODE_CHANGE_PATTERN.test(text);
  });
}
