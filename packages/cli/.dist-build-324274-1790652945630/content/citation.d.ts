import type { RetentionPolicy } from "../shared/governance.js";
export interface FindingCitation {
    created_at: string;
    repo?: string;
    file?: string;
    line?: number;
    commit?: string;
    /**
     * A symbol the finding is about, as `Name`, `Type.member` or `name()`.
     * Auto-attached on write when the project has a code index and the finding
     * text names exactly one resolvable symbol; an explicit one is validated
     * against the index and stored either way.
     */
    symbol?: string;
    /** True when an explicit symbol citation could not be resolved in the index. */
    symbol_unresolved?: boolean;
    supersedes?: string;
    task_item?: string;
}
export declare const FINDING_PROVENANCE_SOURCES: readonly ["human", "agent", "hook", "extract", "consolidation", "unknown"];
export type FindingProvenanceSource = (typeof FINDING_PROVENANCE_SOURCES)[number];
export declare function isFindingProvenanceSource(value: string | undefined): value is FindingProvenanceSource;
export interface FindingProvenance {
    source?: FindingProvenanceSource;
    machine?: string;
    actor?: string;
    tool?: string;
    model?: string;
    session_id?: string;
    scope?: string;
}
export interface FindingTrustIssue {
    date: string;
    bullet: string;
    reason: "stale" | "invalid_citation";
}
export interface TrustFilterOptions {
    ttlDays?: number;
    minConfidence?: number;
    decay?: Partial<RetentionPolicy["decay"]>;
    project?: string;
    highImpactFindingIds?: Set<string>;
}
export declare function getHeadCommit(cwd: string): string | undefined;
export declare function getRepoRoot(cwd: string): string | undefined;
export declare function inferCitationLocation(repoPath: string, commit: string): {
    file?: string;
    line?: number;
};
export declare function buildCitationComment(citation: FindingCitation): string;
/** Format actor/machine attribution for human-readable display. */
export declare function formatActorAttribution(actor: string | undefined, machine: string | undefined): string;
export declare function buildSourceComment(source: FindingProvenance): string;
/** Build a standalone scope comment. Returns empty string if scope is unset or "shared". */
export declare function buildScopeComment(scope: string | undefined): string;
/** Parse a standalone `<!-- scope:VALUE -->` comment. */
export declare function parseScopeComment(line: string): string | undefined;
export declare function parseSourceComment(line: string): FindingProvenance | null;
export declare function parseCitationComment(line: string): FindingCitation | null;
/** Every distinct `symbol:` value in a document's `phren:cite` comments, in order. */
export declare function collectSymbolCitations(content: string): string[];
export declare function validateFindingCitation(citation: FindingCitation): boolean;
export declare function filterTrustedFindings(content: string, ttlDays: number): string;
export declare function filterTrustedFindingsDetailed(content: string, opts: number | TrustFilterOptions): {
    content: string;
    issues: FindingTrustIssue[];
};
