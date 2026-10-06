/** One real computer. `name` is what dispatch, hand_off and grants accept: the
 * hooks.yaml peer name, or this computer's short hostname. `aliases` are
 * every other name it answers to. */
export interface Computer {
    /** The Hook's computer id, when its Hook answered. */
    id?: string;
    name: string;
    aliases: string[];
    /** The store profile machines.yaml maps its names to. */
    profile?: string;
    local: boolean;
    /** Reachable through a verified connection (this computer, or a hooks.yaml peer). */
    linked: boolean;
    /** Whether a peer's Hook answered just now; unknown when not probed, absent for unlinked. */
    reachable?: boolean;
}
/** `name` and `address` come from hooks.yaml, which the owner writes. `names`
 * is what the peer's own Hook says it is called: display only, never trusted. */
export interface PeerFacts {
    name: string;
    address: string;
    id?: string;
    names?: readonly string[];
    reachable?: boolean;
}
export interface IdentityFacts {
    local: {
        id?: string;
        names: readonly string[];
    };
    peers: readonly PeerFacts[];
    /** machines.yaml: machine name to profile. */
    machines: Readonly<Record<string, string>>;
}
/** A computer name's first DNS label, lowercased: `Desk`, `desk.local` and
 * `Desk.example.net` are one computer. DHCP and Bonjour add domains to the
 * same machine's name, so full names do not identify a computer. */
export declare function computerLabel(name: string): string;
/** Folds what this Hook knows into one row per real computer. A machines.yaml
 * name joins a computer when its first label matches any name that computer
 * has, or when it shares a profile with names already folded into exactly one
 * computer (a profile two computers claim folds nothing). The rest become
 * unlinked rows: names sharing a label or a profile are one computer. */
export declare function foldComputers(facts: IdentityFacts, options?: {
    trusted?: boolean;
}): Computer[];
/** The computer a name refers to: an exact name or alias, else the same first
 * label (case-insensitive), so `Desk.local` finds `Desk`. `local` is this
 * computer. A name two rows answer to resolves to nothing. */
export declare function resolveComputer(computers: readonly Computer[], name: string): Computer | undefined;
export interface ReadOptions {
    /** Ask each peer's Hook for its identity (parallel, short timeout) and report `reachable`. */
    probe?: boolean;
    /** Only names the owner wrote (this computer's, hooks.yaml, machines.yaml): what grants match against. */
    trusted?: boolean;
    local?: {
        id?: string;
        names?: readonly string[];
    };
    store?: string | null;
    root?: string;
}
/** Never throws: a missing hooks.yaml or machines.yaml only means fewer rows. */
export declare function readComputers(options?: ReadOptions): Promise<{
    computers: Computer[];
    peerError?: string;
}>;
/** What a dispatch or hand-off's `computer` names, by owner-written names only: an alias,
 * a machines.yaml name or `Desk.local` finds the enrolled peer (by its hooks.yaml name) or
 * this computer. Unknown, ambiguous or unlinked names resolve to nothing. */
export declare function linkedComputer(name: string, root?: string): Promise<{
    local: true;
} | {
    peer: string;
} | undefined>;
