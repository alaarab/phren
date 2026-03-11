import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbRow, SqlJsDatabase } from "../shared-index.js";

vi.mock("../shared-search-fallback.js", () => ({
  vectorFallback: vi.fn().mockResolvedValue([]),
}));

vi.mock("../shared-ollama.js", () => ({
  getOllamaUrl: vi.fn().mockReturnValue("http://127.0.0.1:11434"),
  getCloudEmbeddingUrl: vi.fn().mockReturnValue(null),
}));

import { searchDocumentsAsync, shouldRunVectorExpansion } from "../shared-retrieval.js";
import { vectorFallback } from "../shared-search-fallback.js";

function makeDb(ftsRows: DbRow[]): SqlJsDatabase {
  return {
    run: () => {},
    exec: (sql: string) => {
      if (sql.includes("SELECT MIN(rowid), MAX(rowid), COUNT(*) FROM docs")) {
        return [{ columns: ["min", "max", "count"], values: [[1, 1, 0]] }];
      }
      if (sql.includes("SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ?")) {
        if (ftsRows.length === 0) return [];
        return [{
          columns: ["project", "filename", "type", "content", "path"],
          values: ftsRows,
        }];
      }
      return [];
    },
    export: () => new Uint8Array(),
    close: () => {},
  };
}

describe("shouldRunVectorExpansion", () => {
  it("returns false when lexical retrieval already has enough results", () => {
    const rows = [
      { project: "a", filename: "one.md", type: "summary", content: "alpha beta gamma", path: "/tmp/one.md" },
      { project: "a", filename: "two.md", type: "summary", content: "alpha beta gamma", path: "/tmp/two.md" },
      { project: "a", filename: "three.md", type: "summary", content: "alpha beta gamma", path: "/tmp/three.md" },
    ];
    expect(shouldRunVectorExpansion(rows, "alpha beta gamma")).toBe(false);
  });

  it("returns false for a single strong lexical hit", () => {
    const rows = [
      { project: "a", filename: "one.md", type: "summary", content: "semantic search setup during init with ollama", path: "/tmp/one.md" },
    ];
    expect(shouldRunVectorExpansion(rows, "semantic search setup during init with ollama")).toBe(false);
  });

  it("returns true for weak or missing lexical hits", () => {
    const weakRows = [
      { project: "a", filename: "one.md", type: "summary", content: "general project notes", path: "/tmp/one.md" },
    ];
    expect(shouldRunVectorExpansion(null, "external webhook alerts discord")).toBe(true);
    expect(shouldRunVectorExpansion(weakRows, "external webhook alerts discord")).toBe(true);
  });
});

describe("searchDocumentsAsync vector gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips vector fallback when lexical retrieval already has enough hits", async () => {
    const db = makeDb([
      ["proj", "one.md", "summary", "alpha beta gamma", "/tmp/one.md"],
      ["proj", "two.md", "summary", "alpha beta gamma", "/tmp/two.md"],
      ["proj", "three.md", "summary", "alpha beta gamma", "/tmp/three.md"],
    ]);

    await searchDocumentsAsync(db, "\"alpha\"", "alpha beta gamma", "alpha beta gamma", null, true, "/tmpcortex");

    expect(vectorFallback).not.toHaveBeenCalled();
  });

  it("skips vector fallback for a single strong lexical hit", async () => {
    const db = makeDb([
      ["proj", "one.md", "summary", "semantic search setup during init with ollama", "/tmp/one.md"],
    ]);

    await searchDocumentsAsync(
      db,
      "\"semantic\"",
      "semantic search setup during init with ollama",
      "semantic search setup during init with ollama",
      null,
      true,
      "/tmpcortex"
    );

    expect(vectorFallback).not.toHaveBeenCalled();
  });

  it("runs vector fallback when lexical retrieval is empty", async () => {
    const db = makeDb([]);

    await searchDocumentsAsync(db, "\"webhook\"", "external webhook alerts discord", "external webhook alerts discord", null, true, "/tmpcortex");

    expect(vectorFallback).toHaveBeenCalledOnce();
  });

  it("rescues zero-result searches with keyword fallback before vector search", async () => {
    const db: SqlJsDatabase = {
      run: () => {},
      exec: (sql: string) => {
        if (sql.includes("SELECT MIN(rowid), MAX(rowid), COUNT(*) FROM docs")) {
          return [{ columns: ["min", "max", "count"], values: [[1, 1, 0]] }];
        }
        if (sql.includes("SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ?")) {
          return [];
        }
        if (sql === "SELECT project, filename, type, content, path FROM docs") {
          return [{
            columns: ["project", "filename", "type", "content", "path"],
            values: [[
              "cortex",
              "FINDINGS.md",
              "findings",
              "Semantic opt-in during init should finish at the dependency level",
              "/tmpcortex/FINDINGS.md",
            ]],
          }];
        }
        return [];
      },
      export: () => new Uint8Array(),
      close: () => {},
    };

    const rows = await searchDocumentsAsync(
      db,
      "\"semantic\" AND \"search\" AND \"setup\" AND \"init\" AND \"ollama\"",
      "semantic search setup during init with ollama",
      "semantic search setup during init ollama",
      null,
      true,
      "/tmpcortex"
    );

    expect(rows?.[0]?.path).toBe("/tmpcortex/FINDINGS.md");
    expect(vectorFallback).not.toHaveBeenCalled();
  });
});
