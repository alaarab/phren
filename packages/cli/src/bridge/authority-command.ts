import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  clearProjectAuthority, confirmAuthority, confirmInputSchema, listConfirmations, projectAuthority, projectEntrySchema, readAuthority, releaseAction,
  setProjectAuthority, type ProjectEntry, type ReleaseAction,
} from "./authority.js";

const USAGE = [
  "Usage: phren authority [list]",
  "       phren authority show <project>",
  "       phren authority set <project> [--default go|ask] [--go <actions>] [--ask <actions>] [--max-permission-mode <mode>|none] [--note <text>]",
  "       phren authority clear <project>",
  "       phren authority confirm <project> <actions> [--minutes <n>]",
  "Actions: merge, publish, deploy, app-store, github-admin (comma-separated).",
].join("\n");

/** The harness whose shell this is, when an agent runs the command. */
export function agentShell(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_SESSION_ID) return "Claude Code";
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return "Codex";
  if (env.PHREN_FANOUT_JOB || env.PHREN_FANOUT_DIR) return "a phren fan-out worker";
  return undefined;
}

export interface OwnerTerminal {
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  ask: (question: string) => Promise<string>;
}

function processTerminal(): OwnerTerminal {
  return {
    env: process.env,
    interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
    ask: async question => {
      const lines = createInterface({ input: process.stdin, output: process.stderr });
      try { return await lines.question(question); } finally { lines.close(); }
    },
  };
}

/** Changes are the owner's: refused in an agent's shell or without a
 * terminal, and made only after the owner types the project name. */
export async function ownerConfirms(change: string, project: string, terminal: OwnerTerminal): Promise<void> {
  const agent = agentShell(terminal.env);
  if (agent) throw new Error(`The release authority policy is the owner's. ${agent} can read it (phren authority show ${project}) but not change it; ask the owner to run this in their own terminal or use the phone.`);
  if (!terminal.interactive) throw new Error("Changing the release authority policy needs an interactive terminal: the owner types the project name to confirm.");
  const typed = await terminal.ask(`${change}\nType ${project} to confirm: `);
  if (typed.trim() !== project) throw new Error("Not confirmed; nothing changed.");
}

function actionList(value: string | undefined): ReleaseAction[] {
  if (value === undefined) return [];
  return value.split(",").map(item => item.trim()).filter(Boolean).map(item => releaseAction.parse(item));
}

/** The entry `set` saves: the current one with the flags applied. */
export function mergedEntry(current: ProjectEntry | undefined, values: { default?: string; go?: string; ask?: string; "max-permission-mode"?: string; note?: string }): ProjectEntry {
  const entry: ProjectEntry = { ...current, ...(current?.actions ? { actions: { ...current.actions } } : {}) };
  if (values.default !== undefined) entry.default = values.default as ProjectEntry["default"];
  const go = actionList(values.go), ask = actionList(values.ask);
  const overlap = go.filter(action => ask.includes(action));
  if (overlap.length) throw new Error(`${overlap.join(", ")} cannot be both go and ask.`);
  if (go.length || ask.length) entry.actions = { ...entry.actions, ...Object.fromEntries([...go.map(a => [a, "go"]), ...ask.map(a => [a, "ask"])]) };
  const mode = values["max-permission-mode"];
  if (mode === "none") delete entry.maxPermissionMode;
  else if (mode !== undefined) entry.maxPermissionMode = mode as ProjectEntry["maxPermissionMode"];
  if (values.note === "") delete entry.note;
  else if (values.note !== undefined) entry.note = values.note;
  return entry;
}

export async function runAuthority(args: string[], terminal: OwnerTerminal = processTerminal()): Promise<number> {
  const [action = "list", ...rest] = args;
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (action === "list" && !rest.length) {
    const policy = await readAuthority();
    print({ source: policy.source, ...(policy.updatedAt ? { updatedAt: policy.updatedAt, updatedBy: policy.updatedBy } : {}),
      projects: Object.keys(policy.projects).sort().map(name => projectAuthority(policy, name)), confirmations: await listConfirmations() });
    return 0;
  }
  if (action === "show" && rest.length === 1) {
    print(projectAuthority(await readAuthority(), rest[0]));
    return 0;
  }
  if (action === "set") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
      default: { type: "string" }, go: { type: "string" }, ask: { type: "string" }, "max-permission-mode": { type: "string" }, note: { type: "string" },
    } });
    if (positionals.length !== 1) throw new Error(USAGE);
    const project = positionals[0];
    const entry = projectEntrySchema.parse(mergedEntry((await readAuthority()).projects[project], values));
    // Validated before the owner is asked, so a typo never waits on a confirmation.
    const preview = projectAuthority({ projects: { [project]: entry } }, project);
    await ownerConfirms(`New policy: ${preview.line}`, project, terminal);
    print(await setProjectAuthority({ project, ...entry }, "cli"));
    return 0;
  }
  if (action === "clear" && rest.length === 1) {
    await ownerConfirms(`Remove ${rest[0]} from the release authority policy (it becomes go for every release action).`, rest[0], terminal);
    print(await clearProjectAuthority({ project: rest[0] }, "cli"));
    return 0;
  }
  if (action === "confirm") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { minutes: { type: "string" } } });
    if (positionals.length !== 2) throw new Error(USAGE);
    const [project, actions] = positionals;
    const minutes = values.minutes !== undefined ? Number(values.minutes) : undefined;
    const input = confirmInputSchema.parse({ project, actions: actionList(actions), ...(minutes !== undefined ? { minutes } : {}) });
    await ownerConfirms(`Let one agent dispatch to ${project} do ${input.actions.join(", ")} within ${minutes ?? 30} minutes.`, project, terminal);
    print(await confirmAuthority(input, "cli"));
    return 0;
  }
  throw new Error(USAGE);
}
