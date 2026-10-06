import { type Json } from "./protocol.js";
/**
 * "Add project" from the phone: the repositories on this computer that phren
 * does not track yet, and enrolling one — an existing checkout, or a fresh
 * clone — the way `phren add` would from its folder. The store is committed
 * and pushed afterwards when it has a remote, since the phone reads the store
 * through GitHub and would otherwise never see the new project.
 */
export interface RepoCandidate {
    directory: string;
    name: string;
    source: "activity" | "herdr" | "search";
    registered: boolean;
    lastSeen?: string;
}
/** Git checkouts on this computer, newest activity first, then Herdr's
 * saved workspaces, then one level under the usual project roots. */
export declare function candidateRepos(activity: Json[], env?: NodeJS.ProcessEnv): Promise<RepoCandidate[]>;
export interface EnrollInput {
    directory?: string;
    cloneUrl?: string;
}
export interface Enrolled {
    ok: true;
    project: string;
    directory: string;
    cloned: boolean;
    store: "pushed" | "committed" | "unchanged" | "error";
    storeDetail?: string;
}
export declare function enrollProject(input: EnrollInput, env?: NodeJS.ProcessEnv): Promise<Enrolled>;
