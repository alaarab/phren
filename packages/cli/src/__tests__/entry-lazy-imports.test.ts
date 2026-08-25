/**
 * `src/index.ts` is the entry point for the long-lived MCP server *and* for
 * every lifecycle hook — hook-prompt, hook-session-start, hook-stop and
 * hook-tool, the last of which is spawned once per tool call. Only the MCP
 * server ever reaches main(), so anything the server alone needs (MCP SDK,
 * tool registries, startup-embedding) must be behind `await import()` inside
 * main(). Hoisting any of it back to module scope taxes every hook process.
 *
 * Measured on this repo (median of 10 runs, node 23, 390-file store), with the
 * MCP-only graph moved back to static top-level imports:
 *
 *   phren --version      80ms -> 184ms
 *   phren hook-tool     138ms -> 204ms
 *   phren hook-prompt   310ms -> 369ms
 *
 * A static import is a one-character change to review and shows up nowhere in
 * the test suite, so this file asserts the property directly.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const entrySource = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts"),
  "utf-8",
);

/**
 * Module specifiers of every *static* `import ... from "x"` in the file,
 * excluding type-only imports (erased at build time, so they cost nothing).
 */
function staticImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /^import\s+(type\s+)?([\s\S]*?)from\s+["']([^"']+)["'];/gm;
  for (const match of source.matchAll(pattern)) {
    const isTypeOnly = Boolean(match[1]) || /^\s*\{\s*type\s/.test(match[2]);
    if (!isTypeOnly) specifiers.push(match[3]);
  }
  return specifiers;
}

/** Specifiers that must only ever appear inside `await import(...)`. */
const MCP_SERVER_ONLY = [
  "@modelcontextprotocol/sdk/server/mcp.js",
  "@modelcontextprotocol/sdk/server/stdio.js",
  "./startup-embedding.js",
  "./shared/index.js",
  "./shared/embedding-cache.js",
  "./telemetry.js",
];

describe("phren entry point stays cheap for hooks", () => {
  const statics = staticImportSpecifiers(entrySource);

  it.each(MCP_SERVER_ONLY)("does not statically import %s", (specifier) => {
    expect(statics).not.toContain(specifier);
  });

  it("does not statically import any MCP SDK module", () => {
    expect(statics.filter((s) => s.startsWith("@modelcontextprotocol/"))).toEqual([]);
  });

  it("does not statically import any tool registry module", () => {
    expect(statics.filter((s) => s.startsWith("./tools/"))).toEqual([]);
  });

  it("still loads the MCP server graph dynamically inside main()", () => {
    // Guards against the opposite failure: someone "fixing" the lint above by
    // deleting the imports instead of deferring them.
    for (const specifier of ["@modelcontextprotocol/sdk/server/mcp.js", "./shared/index.js"]) {
      expect(entrySource).toContain(`import("${specifier}")`);
    }
    expect(entrySource).toMatch(/import\("\.\/tools\/search\.js"\)/);
  });
});
