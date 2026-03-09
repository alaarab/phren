import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

/**
 * Locate the sql.js-fts5 WASM binary by require.resolve with path-probe fallback.
 * Shared between shared-index.ts and embedding.ts to avoid duplication.
 */
function findWasmBinary(): Buffer | undefined {
  try {
    const resolved = require.resolve("sql.js-fts5/dist/sql-wasm.wasm") as string;
    if (fs.existsSync(resolved)) return fs.readFileSync(resolved);
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] findWasmBinary requireResolve: ${err instanceof Error ? err.message : String(err)}\n`);
    // fall through to path probing
  }

  const __filename = fileURLToPath(import.meta.url);
  let dir = path.dirname(__filename);
  for (let i = 0; i < 5; i++) {
    const candidateA = path.join(dir, "node_modules", "sql.js-fts5", "dist", "sql-wasm.wasm");
    if (fs.existsSync(candidateA)) return fs.readFileSync(candidateA);
    const candidateB = path.join(dir, "sql.js-fts5", "dist", "sql-wasm.wasm");
    if (fs.existsSync(candidateB)) return fs.readFileSync(candidateB);
    dir = path.dirname(dir);
  }
  return undefined;
}

const _initSqlJs = require("sql.js-fts5") as (config?: Record<string, unknown>) => Promise<unknown>;

/**
 * Bootstrap sql.js-fts5: find the WASM binary and initialise the library.
 * Shared across shared-index.ts and embedding.ts to avoid duplication.
 */
export async function bootstrapSqlJs(): Promise<unknown> {
  const wasmBinary = findWasmBinary();
  return _initSqlJs(wasmBinary ? { wasmBinary } : {});
}
