import * as fs from "fs";
import { bootstrapCortexDotEnv } from "./cortex-dotenv.js";
import { debugLog, defaultCortexPath, homePath } from "./cortex-paths.js";
import { governanceInstallPreferencesFile, readInstallPreferences } from "./init-preferences.js";
import { errorMessage } from "./utils.js";

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

function readGovernanceProactivityPreferences(): GovernanceProactivityPreferences {
  const candidates = new Set<string>([
    governanceInstallPreferencesFile(defaultCortexPath()),
    governanceInstallPreferencesFile(homePath(".cortex")),
  ]);

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
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
  }

  return {};
}

function getConfiguredProactivityDefault(): ProactivityLevel {
  const governancePreference = readGovernanceProactivityPreferences().proactivity;
  if (governancePreference) return governancePreference;

  const runtimePreference = parseProactivityLevel(readInstallPreferences(defaultCortexPath()).proactivity);
  if (runtimePreference) return runtimePreference;

  return DEFAULT_PROACTIVITY_LEVEL;
}

function getConfiguredProactivityLevelForFindingsDefault(): ProactivityLevel {
  const sharedEnvPreference = parseProactivityLevel(process.env.CORTEX_PROACTIVITY);
  if (sharedEnvPreference) return sharedEnvPreference;

  return readGovernanceProactivityPreferences().proactivityFindings ?? getConfiguredProactivityDefault();
}

function getConfiguredProactivityLevelForTaskDefault(): ProactivityLevel {
  const sharedEnvPreference = parseProactivityLevel(process.env.CORTEX_PROACTIVITY);
  if (sharedEnvPreference) return sharedEnvPreference;

  return readGovernanceProactivityPreferences().proactivityTask ?? getConfiguredProactivityDefault();
}

function resolveProactivityLevel(raw: string | undefined, fallback: ProactivityLevel): ProactivityLevel {
  return parseProactivityLevel(raw) ?? fallback;
}

export function getProactivityLevel(): ProactivityLevel {
  bootstrapCortexDotEnv();
  return resolveProactivityLevel(process.env.CORTEX_PROACTIVITY, getConfiguredProactivityDefault());
}

export function getProactivityLevelForFindings(): ProactivityLevel {
  bootstrapCortexDotEnv();
  return resolveProactivityLevel(process.env.CORTEX_PROACTIVITY_FINDINGS, getConfiguredProactivityLevelForFindingsDefault());
}

export function getProactivityLevelForTask(): ProactivityLevel {
  bootstrapCortexDotEnv();
  return resolveProactivityLevel(process.env.CORTEX_PROACTIVITY_TASKS, getConfiguredProactivityLevelForTaskDefault());
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
