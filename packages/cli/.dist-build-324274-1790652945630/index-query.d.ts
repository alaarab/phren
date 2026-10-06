export type SqlValue = string | number | null | Uint8Array;
export type DbRow = SqlValue[];
export interface SqlJsDatabase {
    run(sql: string, params?: SqlValue[]): void;
    exec(sql: string, params?: SqlValue[]): {
        columns: string[];
        values: DbRow[];
    }[];
    export(): Uint8Array;
    close(): void;
}
export interface DocRow {
    project: string;
    filename: string;
    type: string;
    content: string;
    path: string;
}
export declare function buildSourceDocKey(project: string, docPath: string, phrenPath: string, fallbackFilename?: string): string;
export declare function decodeStringRow(row: DbRow, width: number, context: string): string[];
export declare function decodeFiniteNumber(value: SqlValue | undefined, context: string): number;
export declare function getDocSourceKey(doc: Pick<DocRow, "project" | "filename" | "path">, phrenPath: string): string;
/** Normalize a memory ID to canonical format: `mem:project/path/to/file.md`. */
export declare function normalizeMemoryId(rawId: string): string;
export declare function rowToDoc(row: DbRow): DocRow;
export declare function rowToDocWithRowid(row: DbRow): {
    rowid: number;
    doc: DocRow;
};
export declare function queryRows(db: SqlJsDatabase, sql: string, params: (string | number)[]): DbRow[] | null;
export declare function queryDocRows(db: SqlJsDatabase, sql: string, params: (string | number)[]): DocRow[] | null;
export declare function queryDocBySourceKey(db: SqlJsDatabase, phrenPath: string, sourceKey: string): DocRow | null;
export declare function extractSnippet(content: string, query: string, lines?: number): string;
