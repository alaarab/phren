import { type Json } from "./protocol.js";
export declare function git(cwd: string, ...args: string[]): Promise<string>;
export declare function gitRoot(dir: string): Promise<string | undefined>;
/** The pane's working tree, plus anything the command named: files in the
 * same repository that a hook already committed, and files in other
 * repositories — the phren store, a sibling checkout — grouped by root. */
export declare function repositoryDiff(cwd: string, touched?: unknown[], allowedPaths?: string[]): Promise<Json>;
/** The HEAD file of the repository holding `cwd` (`.git/HEAD`, or a linked
 * worktree's through its `.git` file), found without spawning git. */
export declare function headFile(cwd: string): Promise<string | undefined>;
export declare function repositoryBranch(cwd: string): Promise<string | undefined>;
export interface LocalServer {
    name: string;
    port: number;
    origin: string;
    process?: string;
    pid?: number;
}
export declare function webServers(): Promise<LocalServer[]>;
/** Launch only in real local directories under home or a locator candidate. */
export declare function launchDirectory(raw: unknown, activity?: Json[], located?: Iterable<string>): Promise<string>;
