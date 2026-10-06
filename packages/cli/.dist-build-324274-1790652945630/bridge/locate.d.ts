import { type Json } from "./protocol.js";
/**
 * Where a project lives on this computer, for the phone's "Open on a
 * computer". The store's phren.project.yaml only knows the folder the project
 * was added from — on whichever machine that was — so the answer comes from
 * what this machine has actually seen: the Hook's activity journal (every
 * folder an agent session ran in, newest first), Herdr's saved workspaces,
 * phren's registered path, then the usual project roots. Only folders that
 * exist here are offered.
 */
export interface LocatedFolder {
    directory: string;
    source: "activity" | "herdr" | "phren" | "search";
    lastSeen?: string;
}
export declare function locateProject(project: string, activity: Json[], env?: NodeJS.ProcessEnv): Promise<LocatedFolder[]>;
