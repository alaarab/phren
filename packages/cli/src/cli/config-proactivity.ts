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
  console.error(subcommand === "proactivity"
    ? "Usage: phren config proactivity [high|medium|low] [--scope base|findings|tasks] [--project <name>]"
    : `Usage: phren config ${subcommand} [high|medium|low] [--project <name>]`);
}

type ProactivitySubcommand = "proactivity" | "proactivity.findings" | "proactivity.tasks";
const SCOPE_SUBCOMMANDS: Record<string, ProactivitySubcommand> = {
  base: "proactivity", findings: "proactivity.findings", tasks: "proactivity.tasks", task: "proactivity.tasks",
};

/** `--scope tasks` on the base command is the same as `proactivity.tasks`. */
function parseScopeArg(args: string[]): { scope?: ProactivitySubcommand; rest: string[]; invalid?: string } {
  const rest: string[] = [];
  let scope: ProactivitySubcommand | undefined, invalid: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const inline = arg.startsWith("--scope=") ? arg.slice("--scope=".length) : undefined;
    if (arg === "--scope" || inline !== undefined) {
      const raw = inline ?? args[++i] ?? "";
      const match = SCOPE_SUBCOMMANDS[raw.trim().toLowerCase()];
      if (match) scope = match; else invalid = raw;
      continue;
    }
    rest.push(arg);
  }
  return { scope, rest, invalid };
}

export function handleConfigProactivity(requested: ProactivitySubcommand, args: string[]) {
  const phrenPath = getPhrenPath();
  const scoped = parseScopeArg(args);
  if (scoped.invalid !== undefined || (scoped.scope && requested !== "proactivity")) {
    printProactivityUsage(requested);
    process.exitCode = 1;
    return;
  }
  const subcommand = scoped.scope ?? requested;
  const { project: projectArg, rest: filteredArgs } = parseProjectArg(scoped.rest);
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
