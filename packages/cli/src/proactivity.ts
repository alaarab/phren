import * as fs from "fs";
import { bootstrapPhrenDotEnv } from "./phren-dotenv.js";
import { debugLog, findPhrenPath } from "./phren-paths.js";
import { governanceInstallPreferencesFile, readInstallPreferences } from "./init/preferences.js";
import { errorMessage } from "./utils.js";
import { getWorkflowPolicy } from "./governance/policy.js";

export const PROACTIVITY_LEVELS = ["high", "medium", "low"] as const;
export type ProactivityLevel = typeof PROACTIVITY_LEVELS[number];

const DEFAULT_PROACTIVITY_LEVEL: ProactivityLevel = "high";
const EXPLICIT_FINDING_SIGNAL_PATTERN = /\b(add finding|worth remembering)\b/i;
const EXPLICIT_FINDING_TAG_PATTERN = /\[(pitfall|decision|pattern|bug|workaround|context)\]/i;

export function parseProactivityLevel(raw: string | undefined | null): ProactivityLevel | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return PROACTIVITY_LEVELS.includes(normalized as ProactivityLevel)
    ? normalized as ProactivityLevel
    : undefined;
}

interface GovernanceProactivityPreferences {
  proactivity?: ProactivityLevel;
  proactivityFindings?: ProactivityLevel;
}

function resolveProactivityPhrenPath(explicitPhrenPath?: string): string | null {
  return explicitPhrenPath ?? findPhrenPath();
}

interface UserPreferences {
  proactivity?: "high" | "medium" | "low";
  proactivityFindings?: "high" | "medium" | "low";
  findingSensitivity?: "minimal" | "conservative" | "balanced" | "aggressive";
}

/** Read per-user preferences from ~/.phren/.users/<actor>/preferences.json. Actor from PHREN_ACTOR env var. */
function readUserPreferences(explicitPhrenPath?: string): UserPreferences {
  const phrenPath = resolveProactivityPhrenPath(explicitPhrenPath);
  if (!phrenPath) return {};

  const actor = (process.env.PHREN_ACTOR || "").trim();
  if (!actor || !/^[a-zA-Z0-9_@.-]{1,128}$/.test(actor)) return {};

  // Sanitize actor name to safe path component (no path traversal)
  const safeActor = actor.replace(/[^a-zA-Z0-9_@.-]/g, "_");
  const prefsFile = `${phrenPath}/.users/${safeActor}/preferences.json`;
  if (!fs.existsSync(prefsFile)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(prefsFile, "utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return {
      proactivity: parseProactivityLevel(parsed.proactivity as string | undefined),
      proactivityFindings: parseProactivityLevel(parsed.proactivityFindings as string | undefined),
      findingSensitivity: ["minimal", "conservative", "balanced", "aggressive"].includes(String(parsed.findingSensitivity))
        ? parsed.findingSensitivity as UserPreferences["findingSensitivity"]
        : undefined,
    };
  } catch (err: unknown) {
    debugLog(`readUserPreferences: failed to parse ${prefsFile}: ${errorMessage(err)}`);
    return {};
  }
}

function readGovernanceProactivityPreferences(explicitPhrenPath?: string): GovernanceProactivityPreferences {
  const phrenPath = resolveProactivityPhrenPath(explicitPhrenPath);
  if (!phrenPath) return {};

  const filePath = governanceInstallPreferencesFile(phrenPath);
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      proactivity?: string;
      proactivityFindings?: string;
    };
    return {
      proactivity: parseProactivityLevel(parsed?.proactivity),
      proactivityFindings: parseProactivityLevel(parsed?.proactivityFindings),
    };
  } catch (err: unknown) {
    debugLog(`readGovernanceProactivityPreferences: failed to parse ${filePath}: ${errorMessage(err)}`);
  }

  return {};
}

function getConfiguredProactivityDefault(explicitPhrenPath?: string): ProactivityLevel {
  // Resolution chain: user prefs (highest) → governance prefs → install prefs → default
  const userPrefs = readUserPreferences(explicitPhrenPath);
  if (userPrefs.proactivity) return userPrefs.proactivity;

  const governancePreference = readGovernanceProactivityPreferences(explicitPhrenPath).proactivity;
  if (governancePreference) return governancePreference;

  const phrenPath = resolveProactivityPhrenPath(explicitPhrenPath);
  if (phrenPath) {
    const runtimePreference = parseProactivityLevel(readInstallPreferences(phrenPath).proactivity);
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

function getWorkflowPolicySensitivityLevel(explicitPhrenPath?: string): ProactivityLevel | undefined {
  const phrenPath = resolveProactivityPhrenPath(explicitPhrenPath);
  if (!phrenPath) return undefined;
  try {
    const policy = getWorkflowPolicy(phrenPath);
    return sensitivityToProactivity(policy.findingSensitivity);
  } catch {
    return undefined;
  }
}

function getConfiguredProactivityLevelForFindingsDefault(explicitPhrenPath?: string): ProactivityLevel {
  // User prefs take priority over governance prefs
  const userPrefs = readUserPreferences(explicitPhrenPath);
  if (userPrefs.proactivityFindings) return userPrefs.proactivityFindings;
  if (userPrefs.proactivity) return userPrefs.proactivity;

  const prefs = readGovernanceProactivityPreferences(explicitPhrenPath);
  return prefs.proactivityFindings
    ?? prefs.proactivity
    ?? getWorkflowPolicySensitivityLevel(explicitPhrenPath)
    ?? getConfiguredProactivityDefault(explicitPhrenPath);
}


function resolveProactivityLevel(raw: string | undefined, fallback: ProactivityLevel): ProactivityLevel {
  return parseProactivityLevel(raw) ?? fallback;
}

export function getProactivityLevel(explicitPhrenPath?: string): ProactivityLevel {
  bootstrapPhrenDotEnv();
  return resolveProactivityLevel(process.env.PHREN_PROACTIVITY, getConfiguredProactivityDefault(explicitPhrenPath));
}

export function getProactivityLevelForFindings(explicitPhrenPath?: string): ProactivityLevel {
  bootstrapPhrenDotEnv();
  const findingsPreference = parseProactivityLevel(process.env.PHREN_PROACTIVITY_FINDINGS);
  if (findingsPreference) return findingsPreference;
  return resolveProactivityLevel(process.env.PHREN_PROACTIVITY, getConfiguredProactivityLevelForFindingsDefault(explicitPhrenPath));
}


export function hasExplicitFindingSignal(...texts: Array<string | undefined | null>): boolean {
  return texts.some((text) => {
    if (!text) return false;
    return EXPLICIT_FINDING_SIGNAL_PATTERN.test(text) || EXPLICIT_FINDING_TAG_PATTERN.test(text);
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
