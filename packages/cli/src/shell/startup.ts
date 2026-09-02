/**
 * Deep links into the shell: `phren shell --view tasks --here` opens straight
 * on a project's task list instead of the Projects home screen.
 *
 * This exists so an outside launcher — the Herdr plugin, a tmux binding, an
 * editor task — can put the user where they meant to be in one keypress.
 */

import { detectProject } from "../shared/index.js";
import type { ShellView } from "./types.js";

export interface ShellStartup {
  view?: ShellView;
  project?: string;
  /** Shown on the shell's message line — fullscreen mode eats anything printed before launch. */
  notice?: string;
}

export interface ShellStartupArgs {
  view?: string;
  project?: string;
  here?: boolean;
  unknown?: string;
}

/** Spelling of a view a person would actually type, mapped to the canonical name. */
const VIEW_ALIASES: Record<string, ShellView> = {
  projects: "Projects",
  project: "Projects",
  tasks: "Tasks",
  task: "Tasks",
  todo: "Tasks",
  todos: "Tasks",
  findings: "Findings",
  finding: "Findings",
  memory: "Findings",
  review: "Review Queue",
  "review queue": "Review Queue",
  "review-queue": "Review Queue",
  queue: "Review Queue",
  skills: "Skills",
  skill: "Skills",
  hooks: "Hooks",
  hook: "Hooks",
  health: "Health",
  doctor: "Health",
  graph: "Graph",
  map: "Graph",
  network: "Graph",
  machines: "Machines/Profiles",
  profiles: "Machines/Profiles",
  "machines/profiles": "Machines/Profiles",
};

export function normalizeShellView(raw: string | undefined): ShellView | undefined {
  if (!raw) return undefined;
  return VIEW_ALIASES[raw.trim().toLowerCase()];
}

export const SHELL_VIEW_ALIASES = Object.keys(VIEW_ALIASES);

/** Views that render nothing useful until a project is in context. */
const PROJECT_SCOPED_VIEWS = new Set<ShellView>(["Tasks", "Findings", "Review Queue", "Skills"]);

/** Parse `--view`/`--project`/`--here`, in both `--flag value` and `--flag=value` form. */
export function parseShellArgs(args: string[]): ShellStartupArgs {
  const parsed: ShellStartupArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    // `--view tasks` consumes the next argv entry; `--view=tasks` does not.
    const take = (): string | undefined => (inline !== undefined ? inline : args[++i]);

    switch (flag) {
      case "--view": parsed.view = take(); break;
      case "--project": parsed.project = take(); break;
      case "--here": parsed.here = true; break;
      default:
        if (flag.startsWith("-") && parsed.unknown === undefined) parsed.unknown = flag;
    }
  }

  return parsed;
}

/**
 * Turn parsed flags into the state the shell should open in. An unresolvable
 * view or project is dropped rather than fatal — a deep link that misses should
 * still land you in the shell, on the home screen, with everything else intact.
 */
export function resolveShellStartup(
  parsed: ShellStartupArgs,
  opts: { phrenPath: string; profile?: string; cwd?: string },
): { startup: ShellStartup; warnings: string[] } {
  const warnings: string[] = [];
  const startup: ShellStartup = {};

  if (parsed.unknown) warnings.push(`Unknown flag ${parsed.unknown} — ignored.`);

  if (parsed.view) {
    const view = normalizeShellView(parsed.view);
    if (view) startup.view = view;
    else warnings.push(`Unknown view "${parsed.view}" — opening on Projects.`);
  }

  if (parsed.project) {
    startup.project = parsed.project;
  } else if (parsed.here) {
    const detected = detectProject(opts.phrenPath, opts.cwd ?? process.cwd(), opts.profile);
    if (detected) startup.project = detected;
    else warnings.push("No phren project for this directory — opening without a project.");
  }

  // These views render an empty "no project selected" screen without a project,
  // which is a worse landing spot than the project list the user came from.
  if (!startup.project && startup.view && PROJECT_SCOPED_VIEWS.has(startup.view)) {
    startup.view = undefined;
  }

  return { startup, warnings };
}
