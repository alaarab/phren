export interface SearchOptions {
    query: string;
    limit: number;
    project?: string;
    type?: string;
    showHistory?: boolean;
    fromHistory?: number;
    searchAll?: boolean;
}
export declare function parseSearchArgs(phrenPath: string, args: string[]): SearchOptions | null;
export declare function runSearch(opts: SearchOptions, phrenPath: string, profile: string): Promise<{
    lines: string[];
    exitCode: number;
}>;
export declare function runFragmentSearch(query: string, phrenPath: string, profile: string, opts: {
    project?: string;
    limit?: number;
}): Promise<{
    lines: string[];
    exitCode: number;
}>;
export declare function parseFragmentSearchArgs(args: string[]): {
    query: string;
    project?: string;
    limit?: number;
} | null;
export declare function runRelatedDocs(entity: string, phrenPath: string, profile: string, opts: {
    project?: string;
    limit?: number;
}): Promise<{
    lines: string[];
    exitCode: number;
}>;
export declare function parseRelatedDocsArgs(args: string[]): {
    entity: string;
    project?: string;
    limit?: number;
} | null;
