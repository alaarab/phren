/** Graph node id for a finding, derived from its score key (mirrors data.ts stableId("finding", …)). */
export declare function findingStableId(scoreKey: string): string;
/**
 * Graph node id for a single FINDINGS.md bullet line, or null if the line is
 * not a node-bearing finding. Covers tagged (`- [tag] text`) and plain
 * (`- text`) bullets; heading-based findings are intentionally not matched
 * here (they need multi-line context and are rare).
 */
export declare function findingNodeIdForLine(project: string, line: string): string | null;
/**
 * Pick the graph node id of the finding bullet in `content` that best matches
 * `query` (by query-term overlap). Returns null when no bullet shares a query
 * term, so callers can fall back to the project node.
 */
export declare function bestFindingNodeId(project: string, content: string, query: string): string | null;
