export interface WiringConflict {
    location: string;
    existingPath: string;
}
/**
 * A path counts as a "valid phren root" only if it currently looks like one
 * — root manifest, machines.yaml, or the global skills tree. We deliberately
 * tolerate partial roots so a clean `phren init` repair still works.
 */
export declare function looksLikePhrenRoot(candidate: string): boolean;
/**
 * True when `candidate` is a *different* phren root than the one being
 * installed and still looks live. That combination is the one case where
 * rewriting a global file destroys wiring someone is actually using; a stale
 * root (deleted, or never a root) is exactly what init exists to repair.
 */
export declare function isLiveForeignPhrenRoot(candidate: string, newPhrenPath: string): boolean;
/**
 * Recover the phren root that owns a `~/.claude/CLAUDE.md` symlink, from the
 * link target's shape (`<root>/global/AGENTS.md`). Returns null when the
 * target is not structured like a phren global file, i.e. it belongs to
 * something that is not phren and must not be touched.
 */
export declare function phrenRootFromGlobalClaudeLink(target: string): string | null;
export declare function findConflictingGlobalWiring(newPhrenPath: string): WiringConflict[];
export declare function assertNoGlobalWiringConflict(newPhrenPath: string, force: boolean): void;
