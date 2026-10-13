import { stat } from "node:fs/promises";
import path from "node:path";
import { getProjectSourcePath } from "../project-config.js";
import { listMachines } from "../profile-store.js";
import { getProjectDirs } from "../shared.js";
import { canonicalComputer, type Schedule } from "./schedule-format.js";

/**
 * Why a schedule can never fire, so a list or the app says it instead of the
 * schedule sitting silent: a computer the store does not know (no Hook answers
 * to the name), or, on the computer that owns it, a target project with no
 * source directory or one that is gone. `locate` finds a checkout the Hook
 * discovered; only the owning computer can know its own paths.
 */
export async function scheduleProblems(schedule: Schedule, project: string, options: {
  store: string; owned: boolean; locate?: (project: string) => Promise<string | undefined>;
}): Promise<string[]> {
  const problems: string[] = [];
  // A heredoc slip once saved the prompt ">" and the schedule fired an empty brief every hour.
  if ((schedule.prompt.match(/[\p{L}\p{N}]/gu) ?? []).length < 3) {
    problems.push("The prompt has no words in it, so every run would start with an empty brief. Set a prompt with --prompt or --prompt-file.");
  }
  const machines = listMachines(options.store);
  if (!options.owned && machines.ok && !Object.keys(machines.data).some(name => canonicalComputer(name) === canonicalComputer(schedule.computer))) {
    problems.push(`Computer "${schedule.computer}" is not a machine in this store, so no Hook will run this schedule.`);
  }
  if (!options.owned) return problems;
  for (const name of schedule.projects ?? [project]) {
    const directory = getProjectDirs(options.store).find(candidate => path.basename(candidate).toLowerCase() === name.toLowerCase());
    if (!directory) { problems.push(`Project "${name}" is not in this store.`); continue; }
    const target = path.basename(directory);
    const source = getProjectSourcePath(options.store, target) ?? await options.locate?.(target);
    if (!source) {
      if (schedule.projects) problems.push(`No source directory for project "${target}" on this computer.`);
      continue;
    }
    if (!await stat(source).then(info => info.isDirectory()).catch(() => false)) problems.push(`Source directory for project "${target}" is unavailable: ${source}`);
  }
  return problems;
}
