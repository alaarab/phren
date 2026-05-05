/**
 * Native handler implementations for top-level CLI commands.
 *
 * These were the inline if/else branches inside entrypoint.ts's runTopLevelCommand.
 * They moved here so the command registry can dispatch to them without
 * eagerly pulling init/init.js (which is heavy) into every phren invocation.
 *
 * Loaded only when a native command actually runs, via dynamic import from cli-registry.ts.
 */

import * as fs from "fs";
import * as path from "path";
import {
  defaultPhrenPath,
  findPhrenPath,
  isInstallMode,
  parseProactivityLevel,
  type InstallMode,
  type ProactivityLevel,
} from "./shared.js";
import { errorMessage, getOptionValue, getPositionalArgs } from "./utils.js";
import { addProjectFromPath } from "./core/project.js";
import {
  PROJECT_OWNERSHIP_MODES,
  getProjectOwnershipDefault,
  parseProjectOwnershipMode,
  type ProjectOwnershipMode,
} from "./project-config.js";
import { VALID_TASK_MODES, type TaskMode } from "./governance/policy.js";

function parseTaskModeFlag(raw: string | undefined): TaskMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return VALID_TASK_MODES.includes(normalized as TaskMode)
    ? (normalized as TaskMode)
    : undefined;
}

function parseInstallModeFlag(raw: string | undefined): InstallMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim();
  return isInstallMode(normalized) ? normalized : undefined;
}

async function promptProjectOwnership(phrenPath: string, fallback: ProjectOwnershipMode): Promise<ProjectOwnershipMode> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fallback;
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(
      `Project ownership [${PROJECT_OWNERSHIP_MODES.join("/")}] (${fallback}): `,
      (input) => {
        rl.close();
        resolve(parseProjectOwnershipMode(input.trim()) ?? fallback);
      }
    );
  });
}

// ── Native handlers ─────────────────────────────────────────────────────────

export async function runAddCommand(args: string[]): Promise<number> {
  const positional = getPositionalArgs(args, ["--ownership"]);
  const targetPath = positional[0] || process.cwd();
  const ownershipArg = getOptionValue(args, "--ownership");
  const phrenPath = defaultPhrenPath();
  const profile = (process.env.PHREN_PROFILE) || undefined;
  if (!fs.existsSync(phrenPath) || !fs.existsSync(path.join(phrenPath, ".config"))) {
    console.log("phren is not set up yet. Run: phren init");
    return 1;
  }
  const ownership = ownershipArg
    ? parseProjectOwnershipMode(ownershipArg)
    : await promptProjectOwnership(phrenPath, getProjectOwnershipDefault(phrenPath));
  if (ownershipArg && !ownership) {
    console.error(`Invalid --ownership value "${ownershipArg}". Use one of: ${PROJECT_OWNERSHIP_MODES.join(", ")}`);
    return 1;
  }
  try {
    const added = addProjectFromPath(phrenPath, path.resolve(targetPath), profile, ownership);
    if (!added.ok) {
      console.error(added.error);
      return 1;
    }
    console.log(`Added project "${added.data.project}" (${added.data.ownership})`);
    if (added.data.files.claude) console.log(`  ${added.data.files.claude}`);
    console.log(`  ${added.data.files.findings}`);
    console.log(`  ${added.data.files.task}`);
    console.log(`  ${added.data.files.summary}`);
  } catch (e) {
    console.error(`Could not add project: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  return 0;
}

export async function runInitCommand(args: string[]): Promise<number> {
  const { parseMcpMode, runInit } = await import("./init/init.js");
  const machineIdx = args.indexOf("--machine");
  const profileIdx = args.indexOf("--profile");
  const mcpIdx = args.indexOf("--mcp");
  const templateIdx = args.indexOf("--template");
  const modeArg = getOptionValue(args, "--mode");
  const installMode = parseInstallModeFlag(modeArg);
  if (modeArg && !installMode) {
    console.error(`Invalid --mode value "${modeArg}". Use "shared" or "project-local".`);
    return 1;
  }
  const ownershipMode = parseProjectOwnershipMode(getOptionValue(args, "--project-ownership"));
  const taskMode = parseTaskModeFlag(getOptionValue(args, "--task-mode"));
  const findingsProactivity = parseProactivityLevel(getOptionValue(args, "--findings-proactivity"));
  const taskProactivity = parseProactivityLevel(getOptionValue(args, "--task-proactivity"));
  const mcpMode = mcpIdx !== -1 ? parseMcpMode(args[mcpIdx + 1]) : undefined;
  if (mcpIdx !== -1 && !mcpMode) {
    console.error(`Invalid --mcp value "${args[mcpIdx + 1] || ""}". Use "on" or "off".`);
    return 1;
  }
  const ownershipArg = getOptionValue(args, "--project-ownership");
  if (ownershipArg && !ownershipMode) {
    console.error(`Invalid --project-ownership value "${ownershipArg}". Use one of: ${PROJECT_OWNERSHIP_MODES.join(", ")}`);
    return 1;
  }
  const taskModeArg = getOptionValue(args, "--task-mode");
  if (taskModeArg && !taskMode) {
    console.error(`Invalid --task-mode value "${taskModeArg}". Use one of: off, manual, suggest, auto.`);
    return 1;
  }
  const findingsArg = getOptionValue(args, "--findings-proactivity");
  if (findingsArg && !findingsProactivity) {
    console.error(`Invalid --findings-proactivity value "${findingsArg}". Use one of: high, medium, low.`);
    return 1;
  }
  const taskArg = getOptionValue(args, "--task-proactivity");
  if (taskArg && !taskProactivity) {
    console.error(`Invalid --task-proactivity value "${taskArg}". Use one of: high, medium, low.`);
    return 1;
  }
  const cloneUrl = getOptionValue(args, "--clone-url");
  try {
    await runInit({
      mode: installMode,
      machine: machineIdx !== -1 ? args[machineIdx + 1] : undefined,
      profile: profileIdx !== -1 ? args[profileIdx + 1] : undefined,
      mcp: mcpMode,
      projectOwnershipDefault: ownershipMode,
      taskMode,
      findingsProactivity,
      taskProactivity,
      template: templateIdx !== -1 ? args[templateIdx + 1] : undefined,
      applyStarterUpdate: args.includes("--apply-starter-update"),
      dryRun: args.includes("--dry-run"),
      yes: args.includes("--yes") || args.includes("-y"),
      express: args.includes("--express"),
      force: args.includes("--force"),
      _walkthroughCloneUrl: cloneUrl,
    });
  } catch (err: unknown) {
    console.error(errorMessage(err));
    return 1;
  }
  return 0;
}

export async function runUninstallCommand(args: string[]): Promise<number> {
  const { runUninstall } = await import("./init/init.js");
  const skipConfirm = args.includes("--yes") || args.includes("-y");
  await runUninstall({ yes: skipConfirm });
  return 0;
}

export async function runStatusCommand(_args: string[]): Promise<number> {
  const { runStatus } = await import("./status.js");
  await runStatus();
  return 0;
}

export async function runVerifyCommand(_args: string[]): Promise<number> {
  const { runPostInitVerify, getVerifyOutcomeNote } = await import("./init/init.js");
  const { getWorkflowPolicy } = await import("./shared/governance.js");
  const phrenPath = findPhrenPath() || defaultPhrenPath();
  const result = runPostInitVerify(phrenPath);
  console.log(`phren verify: ${result.ok ? "ok" : "issues found"}`);
  console.log(`  tasks: ${getWorkflowPolicy(phrenPath).taskMode} mode`);
  for (const check of result.checks) {
    console.log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
    if (!check.ok && check.fix) {
      console.log(`       fix: ${check.fix}`);
    }
  }
  if (!result.ok) {
    const note = getVerifyOutcomeNote(phrenPath, result.checks);
    if (note) console.log(`\nNote: ${note}`);
    console.log(`\nRun \`phren init\` to fix setup issues.`);
  }
  return result.ok ? 0 : 1;
}

export async function runMcpModeCommand(args: string[]): Promise<number> {
  const { runMcpMode } = await import("./init/init.js");
  try {
    await runMcpMode(args[0]);
    return 0;
  } catch (err: unknown) {
    console.error(errorMessage(err));
    return 1;
  }
}

export async function runHooksModeCommand(args: string[]): Promise<number> {
  const { runHooksMode } = await import("./init/init.js");
  try {
    await runHooksMode(args[0]);
    return 0;
  } catch (err: unknown) {
    console.error(errorMessage(err));
    return 1;
  }
}

export async function runLinkRemovedNotice(_args: string[]): Promise<number> {
  console.error("`phren link` has been removed. Use `phren init` instead.");
  return 1;
}
