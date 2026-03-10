import * as fs from "fs";
import * as path from "path";
import { bootstrapCortexDotEnv } from "./cortex-dotenv.js";
import { debugLog, defaultCortexPath, homePath } from "./cortex-paths.js";
import { readInstallPreferences } from "./init-preferences.js";
import { errorMessage } from "./utils.js";

export const PROACTIVITY_LEVELS = ["high", "medium", "low"] as const;
export type ProactivityLevel = typeof PROACTIVITY_LEVELS[number];

const DEFAULT_PROACTIVITY_LEVEL: ProactivityLevel = "high";

function parseProactivityLevel(raw: string | undefined | null): ProactivityLevel | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return PROACTIVITY_LEVELS.includes(normalized as ProactivityLevel)
    ? normalized as ProactivityLevel
    : undefined;
}

function readLegacyGovernanceProactivityPreference(): ProactivityLevel | undefined {
  const candidates = new Set<string>([
    path.join(defaultCortexPath(), ".governance", "install-preferences.json"),
    homePath(".cortex", ".governance", "install-preferences.json"),
  ]);

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { proactivity?: string };
      const level = parseProactivityLevel(parsed?.proactivity);
      if (level) return level;
    } catch (err: unknown) {
      debugLog(`readLegacyGovernanceProactivityPreference: failed to parse ${filePath}: ${errorMessage(err)}`);
    }
  }

  return undefined;
}

function getConfiguredProactivityDefault(): ProactivityLevel {
  const runtimePreference = parseProactivityLevel(readInstallPreferences(defaultCortexPath()).proactivity);
  if (runtimePreference) return runtimePreference;

  return readLegacyGovernanceProactivityPreference() ?? DEFAULT_PROACTIVITY_LEVEL;
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
  return resolveProactivityLevel(process.env.CORTEX_PROACTIVITY_FINDINGS, getProactivityLevel());
}

export function getProactivityLevelForBacklog(): ProactivityLevel {
  bootstrapCortexDotEnv();
  return resolveProactivityLevel(process.env.CORTEX_PROACTIVITY_BACKLOG, getProactivityLevel());
}
