import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbRow, SqlJsDatabase } from "../shared/index.js";

vi.mock("../shared/search-fallback.js", () => ({
  vectorFallback: vi.fn().mockResolvedValue([]),
}));

vi.mock("../shared/ollama.js", () => ({
  getOllamaUrl: vi.fn().mockReturnValue("http://127.0.0.1:11434"),
  getCloudEmbeddingUrl: vi.fn().mockReturnValue(null),
}));

import { searchDocumentsAsync } from "../shared/retrieval.js";
import { vectorFallback } from "../shared/search-fallback.js";

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

    await searchDocumentsAsync(db, "\"alpha\"", "alpha beta gamma", "alpha beta gamma", null, true, "/tmpphren");

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
      "/tmpphren"
    );

    expect(vectorFallback).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", []],
    ["a single weak hit", [["proj", "one.md", "summary", "general project notes", "/tmp/one.md"]]],
  ] as [string, DbRow[]][])("runs vector fallback when lexical retrieval is %s", async (_label, rows) => {
    const db = makeDb(rows);

    await searchDocumentsAsync(db, "\"webhook\"", "external webhook alerts discord", "external webhook alerts discord", null, true, "/tmpphren");

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
              "phren",
              "FINDINGS.md",
              "findings",
              "Semantic opt-in during init should finish at the dependency level",
              "/tmpphren/FINDINGS.md",
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
      "/tmpphren"
    );

    expect(rows?.[0]?.path).toBe("/tmpphren/FINDINGS.md");
    expect(vectorFallback).not.toHaveBeenCalled();
  });
});
