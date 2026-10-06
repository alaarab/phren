interface ImpactLogInput {
    findingId: string;
    project: string;
    sessionId: string;
}
export declare function findingIdFromLine(line: string): string;
export declare function extractFindingIdsFromSnippet(snippet: string): string[];
export declare function logImpact(phrenPath: string, entries: ImpactLogInput[]): void;
export declare function getHighImpactFindings(phrenPath: string, minSurfaceCount?: number): Set<string>;
export declare function markImpactEntriesCompletedForSession(phrenPath: string, sessionId: string, project?: string): number;
export {};
