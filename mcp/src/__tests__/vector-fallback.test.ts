import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";
import { makeTempDir, writeFile } from "../test-helpers.js";

// Mock the ollama/embedding modules before importing vectorFallback
vi.mock("../shared-ollama.js", () => ({
  embedText: vi.fn(),
  cosineSimilarity: vi.fn(),
  getEmbeddingModel: vi.fn().mockReturnValue("nomic-embed-text"),
  getOllamaUrl: vi.fn().mockReturnValue("http://localhost:11434"),
  getCloudEmbeddingUrl: vi.fn().mockReturnValue(null),
}));

vi.mock("../shared-embedding-cache.js", () => {
  let entries: Array<{ path: string; model: string; vec: number[] }> = [];
  return {
    getEmbeddingCache: vi.fn().mockReturnValue({
      size: () => entries.length,
      load: vi.fn(),
      getAllEntries: () => entries,
      _setEntries: (e: typeof entries) => { entries = e; },
    }),
  };
});

import { vectorFallback } from "../shared-search-fallback.js";
import { deriveVectorDocIdentity } from "../shared-search-fallback.js";
import { embedText, cosineSimilarity } from "../shared-ollama.js";
import { getEmbeddingCache } from "../shared-embedding-cache.js";

describe("vectorFallback content hydration", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("vector-fallback-");
    vi.mocked(embedText).mockResolvedValue([0.1, 0.2, 0.3]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("returned docs have non-empty content when file exists", async () => {
    const filePath = path.join(tmp.path, "test-project", "FINDINGS.md");
    writeFile(filePath, "# Findings\n- Some insight about testing");

    const cache = getEmbeddingCache(tmp.path);
    (cache as any)._setEntries([
      { path: filePath, model: "nomic-embed-text", vec: [0.1, 0.2, 0.3] },
    ]);

    vi.mocked(cosineSimilarity).mockReturnValue(0.8); // above 0.50 threshold

    const results = await vectorFallback(tmp.path, "test query", new Set(), 5);
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("Some insight about testing");
  });

  it("gracefully returns empty content when file not found (no throw)", async () => {
    const fakePath = path.join(tmp.path, "nonexistent", "FINDINGS.md");

    const cache = getEmbeddingCache(tmp.path);
    (cache as any)._setEntries([
      { path: fakePath, model: "nomic-embed-text", vec: [0.1, 0.2, 0.3] },
    ]);

    vi.mocked(cosineSimilarity).mockReturnValue(0.8);

    const results = await vectorFallback(tmp.path, "test query", new Set(), 5);
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("");
  });

  it("only reads files for results passing the 0.50 cosine threshold", async () => {
    const highFile = path.join(tmp.path, "proj", "high.md");
    const lowFile = path.join(tmp.path, "proj", "low.md");
    writeFile(highFile, "high score content");
    writeFile(lowFile, "low score content");

    const cache = getEmbeddingCache(tmp.path);
    (cache as any)._setEntries([
      { path: highFile, model: "nomic-embed-text", vec: [0.1, 0.2, 0.3] },
      { path: lowFile, model: "nomic-embed-text", vec: [0.4, 0.5, 0.6] },
    ]);

    // Return different scores for different vectors
    vi.mocked(cosineSimilarity).mockImplementation((_query, docVec) => {
      if (docVec[0] === 0.1) return 0.8;  // high score
      return 0.3;  // below threshold
    });

    const results = await vectorFallback(tmp.path, "test query", new Set(), 5);
    // Only the high-scoring doc should be returned
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("high score content");
  });

  it("strips task Done items the same way the indexer does", async () => {
    const taskPath = path.join(tmp.path, "proj", "tasks.md");
    writeFile(
      taskPath,
      "# Task\n\n## Active\n- Keep this visible\n\n## Done\n- Hidden completed task\n"
    );

    const cache = getEmbeddingCache(tmp.path);
    (cache as any)._setEntries([
      { path: taskPath, model: "nomic-embed-text", vec: [0.1, 0.2, 0.3] },
    ]);

    vi.mocked(cosineSimilarity).mockReturnValue(0.8);

    const results = await vectorFallback(tmp.path, "task query", new Set(), 5);
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("Keep this visible");
    expect(results[0].content).not.toContain("Hidden completed task");
  });

  it("classifies Windows-style task paths correctly during hydration", async () => {
    expect(deriveVectorDocIdentity("C:\\cortex", "C:\\cortex\\proj\\tasks.md")).toEqual({
      project: "proj",
      filename: "tasks.md",
      relFile: "tasks.md",
    });
  });
});
