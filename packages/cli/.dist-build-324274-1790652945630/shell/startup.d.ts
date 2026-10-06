/**
 * Deep links into the shell: `phren shell --view tasks --here` opens straight
 * on a project's task list instead of the Projects home screen.
 *
 * This exists so an outside launcher — the Herdr plugin, a tmux binding, an
 * editor task — can put the user where they meant to be in one keypress.
 */
import type { ShellView } from "./types.js";
export interface ShellStartup {
    view?: ShellView;
    project?: string;
    /** Graph watch mode. Undefined leaves the default (on). */
    live?: boolean;
    /** Shown on the shell's message line — fullscreen mode eats anything printed before launch. */
    notice?: string;
}
export interface ShellStartupArgs {
    view?: string;
    project?: string;
    here?: boolean;
    live?: boolean;
    unknown?: string;
}
export declare function normalizeShellView(raw: string | undefined): ShellView | undefined;
export declare const SHELL_VIEW_ALIASES: string[];
/** Parse `--view`/`--project`/`--here`, in both `--flag value` and `--flag=value` form. */
export declare function parseShellArgs(args: string[]): ShellStartupArgs;
/**
 * Turn parsed flags into the state the shell should open in. An unresolvable
 * view or project is dropped rather than fatal — a deep link that misses should
 * still land you in the shell, on the home screen, with everything else intact.
 */
export declare function resolveShellStartup(parsed: ShellStartupArgs, opts: {
    phrenPath: string;
    profile?: string;
    cwd?: string;
}): {
    startup: ShellStartup;
    warnings: string[];
};
