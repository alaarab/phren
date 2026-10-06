/**
 * Bootstrap sql.js-fts5: find the WASM binary and initialise the library.
 * Shared across shared-index.ts and embedding.ts to avoid duplication.
 * The require is lazy so importing this module (the Hook bundle pulls it in
 * through the CLI context) does not need the native package on disk.
 */
export declare function bootstrapSqlJs(): Promise<unknown>;
