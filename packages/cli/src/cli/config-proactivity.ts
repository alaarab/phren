import { getPhrenPath } from "../shared.js";
import { installPreferencesFile } from "../phren-paths.js";
import { mergeConfig } from "../shared/governance.js";
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
} from "../project-config.js";
import { isValidProjectName } from "../utils.js";
import { parseProjectArg, warnIfUnregistered } from "./config-shared.js";

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

export function handleConfigProactivity(subcommand: "proactivity" | "proactivity.findings" | "proactivity.tasks", args: string[]) {
  const phrenPath = getPhrenPath();
  const { project: projectArg, rest: filteredArgs } = parseProjectArg(args);
  const value = filteredArgs[0];

  if (value === undefined) {
    if (projectArg) {
      if (!isValidProjectName(projectArg)) {
        console.error(`Invalid project name: "${projectArg}"`);
        process.exitCode = 1;
        return;
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
    process.exitCode = 1;
    return;
  }

  const level = normalizeProactivityLevel(value);
  if (!level) {
    printProactivityUsage(subcommand);
    process.exitCode = 1;
    return;
  }

  if (projectArg) {
    if (!isValidProjectName(projectArg)) {
      console.error(`Invalid project name: "${projectArg}"`);
      process.exitCode = 1;
      return;
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

export function handleConfigProjectOwnership(args: string[]) {
  const phrenPath = getPhrenPath();
  const value = args[0];

  if (value === undefined) {
    console.log(JSON.stringify(projectOwnershipConfigSnapshot(phrenPath), null, 2));
    return;
  }

  if (args.length !== 1) {
    console.error(`Usage: phren config project-ownership [${PROJECT_OWNERSHIP_MODES.join("|")}]`);
    process.exitCode = 1;
    return;
  }

  const ownership = parseProjectOwnershipMode(value);
  if (!ownership) {
    console.error(`Usage: phren config project-ownership [${PROJECT_OWNERSHIP_MODES.join("|")}]`);
    process.exitCode = 1;
    return;
  }

  writeInstallPreferences(phrenPath, { projectOwnershipDefault: ownership });
  console.log(JSON.stringify(projectOwnershipConfigSnapshot(phrenPath), null, 2));
}
