import { ShellState } from "../data/access.js";
import { type DoctorResultLike } from "./types.js";
import type { GraphController } from "./graph/controller.js";
/** Shared rendering state passed from the orchestrator */
export interface ViewContext {
    phrenPath: string;
    profile: string;
    state: ShellState;
    currentCursor: () => number;
    currentScroll: () => number;
    setScroll: (n: number) => void;
    /** The knowledge-graph view's controller (created on first use). Absent in hosts that only render menus. */
    graph?: () => GraphController;
}
export interface SubsectionsCache {
    project: string;
    /** Keys are stable item IDs (bid hash when present, else "row:N") mapped to subsection name */
    map: Map<string, string>;
}
export interface SkillEntry {
    name: string;
    path: string;
    enabled: boolean;
    /** "global" or "project" — the scope key enable/disable is recorded under. */
    scopeType?: string;
    /** The store this skill was read from, which may be a team store. */
    storePath?: string;
}
export declare function getProjectSkills(phrenPath: string, project: string): SkillEntry[];
export interface HookEntry {
    event: string;
    description: string;
    enabled: boolean;
}
export declare function getHookEntries(phrenPath: string, project?: string | null): HookEntry[];
export { writeInstallPreferences } from "../init/preferences.js";
export declare function renderShell(ctx: ViewContext, navMode: "navigate" | "input", inputCtx: string, inputBuf: string, showHelp: boolean, helpScroll: number, message: string, doctorSnapshot: () => Promise<DoctorResultLike>, subsectionsCache: SubsectionsCache | null, setHealthLineCount: (n: number) => void, setSubsectionsCache: (c: SubsectionsCache | null) => void): Promise<string>;
