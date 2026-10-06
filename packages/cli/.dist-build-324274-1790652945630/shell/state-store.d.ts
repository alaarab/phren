import { type PhrenResult } from "../shared.js";
export interface ShellState {
    version: number;
    view: "Projects" | "Tasks" | "Findings" | "Review Queue" | "Skills" | "Hooks" | "Machines/Profiles" | "Health" | "Graph";
    project?: string;
    filter?: string;
    page?: number;
    perPage?: number;
    introMode?: "always" | "once-per-version" | "off";
    introSeenVersion?: string;
}
export declare function loadShellState(phrenPath: string): ShellState;
export declare function saveShellState(phrenPath: string, state: ShellState): void;
export declare function resetShellState(phrenPath: string): PhrenResult<string>;
