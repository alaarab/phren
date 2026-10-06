interface FindingResult {
    ok: boolean;
    message: string;
    data?: unknown;
}
/**
 * Prepend `[findingType]` to a finding only when the text doesn't already
 * start with a bracketed tag. Prevents accumulation like `[pattern] [pattern] X`
 * when callers pass both `findingType` and a finding that's already tagged
 * (a common shape — many MCP callers prefix manually for human readability).
 */
export declare function applyFindingTypePrefix(finding: string, findingType?: string): string;
/**
 * Validate and add a single finding. Shared validation logic used by
 * both CLI `phren add-finding` and MCP `add_finding` tool.
 */
export declare function addFinding(phrenPath: string, project: string, finding: string, citation?: {
    file?: string;
    line?: number;
    repo?: string;
    commit?: string;
    supersedes?: string;
}, findingType?: string): FindingResult;
/**
 * Remove a finding by partial text match.
 */
export declare function removeFinding(phrenPath: string, project: string, finding: string): FindingResult;
/**
 * Remove multiple findings by partial text match.
 */
export declare function removeFindings(phrenPath: string, project: string, findings: string[]): FindingResult;
export {};
