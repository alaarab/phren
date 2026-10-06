export interface ContextImportHit {
    scope: string;
    file: string;
    line: number;
    target: string;
}
export declare function findContextImportLines(content: string): Array<{
    line: number;
    target: string;
}>;
/** Turn each run of `@path` lines into one plain reference list. */
export declare function rewriteContextImports(content: string): string;
export declare function scanContextImports(phrenPath: string): ContextImportHit[];
/** Rewrite every flagged file in place; returns the files changed. */
export declare function fixContextImports(phrenPath: string, hits: ContextImportHit[]): string[];
