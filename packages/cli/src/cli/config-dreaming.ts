import { getPhrenPath } from "../shared.js";
import { isValidProjectName } from "../utils.js";
import {
  DREAMING_KEYS,
  getDreamingConfig,
  parseDreamingPatch,
  updateDreamingConfig,
  type DreamingConfig,
} from "../config/dreaming.js";
import { parseProjectArg, warnIfUnregistered } from "./config-shared.js";

export const CONFIG_DREAMING_USAGE =
  "Usage: phren config dreaming [--project <name>] [get | set key=value ... | unset key ...]\n"
  + `  keys: ${DREAMING_KEYS.join(", ")}\n`
  + "  e.g. phren config dreaming set enabled=true cadence=idle idleMinutes=60\n"
  + "       phren config dreaming --project api set mode=apply phases=correct,organize\n"
  + "       phren config dreaming --project api unset mode   (inherit the global value again)";

/** `key=value` and `--key=value` arguments, as strings for {@link parseDreamingPatch}. */
export function parseDreamingAssignments(args: string[]): { values: Record<string, string>; bad: string[] } {
  const values: Record<string, string> = {};
  const bad: string[] = [];
  for (const arg of args) {
    const token = arg.startsWith("--") ? arg.slice(2) : arg;
    const eq = token.indexOf("=");
    if (eq <= 0) { bad.push(arg); continue; }
    values[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return { values, bad };
}

export function handleConfigDreaming(args: string[]): void {
  const phrenPath = getPhrenPath();
  const { project, rest } = parseProjectArg(args);
  const action = rest[0] ?? "get";
  if (project && !isValidProjectName(project)) {
    console.error(`Invalid project name: "${project}"`);
    process.exitCode = 1;
    return;
  }
  const print = () => console.log(JSON.stringify({ _project: project ?? null, ...getDreamingConfig(phrenPath, project) }, null, 2));

  if (action === "get") return print();

  if (action === "set") {
    const { values, bad } = parseDreamingAssignments(rest.slice(1));
    const parsed = parseDreamingPatch(values);
    const problems = [
      ...bad.map((arg) => `"${arg}" is not key=value.`),
      ...parsed.unknown.map((key) => `Unknown key "${key}".`),
      ...parsed.errors,
    ];
    if (problems.length || !Object.keys(parsed.patch).length) {
      for (const line of problems) console.error(line);
      console.error(CONFIG_DREAMING_USAGE);
      process.exitCode = 1;
      return;
    }
    if (project) warnIfUnregistered(phrenPath, project);
    updateDreamingConfig(phrenPath, parsed.patch, project);
    return print();
  }

  if (action === "unset") {
    const keys = rest.slice(1);
    const unknown = keys.filter((key) => !(DREAMING_KEYS as string[]).includes(key));
    if (!keys.length || unknown.length) {
      if (unknown.length) console.error(`Unknown key(s): ${unknown.join(", ")}`);
      console.error(CONFIG_DREAMING_USAGE);
      process.exitCode = 1;
      return;
    }
    updateDreamingConfig(phrenPath, {}, project, keys as Array<keyof DreamingConfig>);
    return print();
  }

  console.error(CONFIG_DREAMING_USAGE);
  process.exitCode = 1;
}
