import { type PhrenResult } from "../phren-core.js";
interface FindingDecayConfig {
    maxAgeDays: number;
    decayMultiplier: number;
}
/**
 * Decay rule per finding tag. Keyed with `satisfies Record<FindingTag, ...>`
 * so this object is required to have exactly one row per tag in FINDING_TAGS
 * (phren-core.ts) — no more, no less. Add a tag there and TypeScript forces a
 * decay row here; remove one and the corresponding row becomes a compile
 * error instead of silently-dead data.
 *
 * Previously this table had 9 rows against a 6-entry offered enum that
 * disagreed with it in both directions: `anti-pattern`, `observation`, and
 * `tooling` had rows here but nothing ever wrote those tags, while
 * `tradeoff` and `architecture` were offered/writable but had no row here
 * (so they never decayed and had no max-age). The exported type stays
 * `Record<string, FindingDecayConfig>` so existing string-keyed lookups
 * (e.g. content/citation.ts) don't need to change.
 */
export declare const FINDING_TYPE_DECAY: Record<string, FindingDecayConfig>;
export declare function extractFindingType(line: string): string | null;
export declare const FINDING_LIFECYCLE_STATUSES: readonly ["active", "superseded", "contradicted", "stale", "invalid_citation", "retracted"];
export type FindingLifecycleStatus = typeof FINDING_LIFECYCLE_STATUSES[number];
export interface FindingLifecycleMetadata {
    status: FindingLifecycleStatus;
    status_updated?: string;
    status_reason?: string;
    status_ref?: string;
}
export declare function parseFindingLifecycle(line: string): FindingLifecycleMetadata;
export declare function buildLifecycleComments(lifecycle: Partial<FindingLifecycleMetadata> | undefined, fallbackDate?: string): string;
export declare function stripLifecycleComments(line: string): string;
export declare function isInactiveFindingLine(line: string): boolean;
export type ContradictionResolution = "keep_a" | "keep_b" | "keep_both" | "retract_both";
export declare function supersedeFinding(phrenPath: string, project: string, findingText: string, supersededBy: string): PhrenResult<{
    finding: string;
    superseded_by: string;
    status: FindingLifecycleStatus;
}>;
export declare function retractFinding(phrenPath: string, project: string, findingText: string, reason: string): PhrenResult<{
    finding: string;
    reason: string;
    status: FindingLifecycleStatus;
}>;
export declare function resolveFindingContradiction(phrenPath: string, project: string, findingA: string, findingB: string, resolution: ContradictionResolution): PhrenResult<{
    resolution: ContradictionResolution;
    finding_a: {
        text: string;
        status: FindingLifecycleStatus;
    };
    finding_b: {
        text: string;
        status: FindingLifecycleStatus;
    };
}>;
export {};
