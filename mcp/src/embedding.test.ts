import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { SqlJsDatabase } from "./embedding.js";
import {
  cosineSimilarity,
  embeddingOps,
  encodeEmbedding,
  decodeEmbedding,
  getCachedEmbedding,
  getCachedEmbeddings,
} from "./embedding.js";

function makeMockDb(): SqlJsDatabase {
  return {
    run: vi.fn(),
    exec: vi.fn(() => []),
    export: vi.fn(() => new Uint8Array()),
    close: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// encodeEmbedding / decodeEmbedding
// ---------------------------------------------------------------------------

describe("encodeEmbedding / decodeEmbedding", () => {
  it("round-trips a vector through encode then decode", () => {
    const vec = [0.1, 0.2, 0.3, -0.5, 1.0];
    const blob = encodeEmbedding(vec);
    const restored = decodeEmbedding(blob);
    expect(restored.length).toBe(vec.length);
    for (let i = 0; i < vec.length; i++) {
      expect(restored[i]).toBeCloseTo(vec[i], 5);
    }
  });

  it("handles empty vector", () => {
    const blob = encodeEmbedding([]);
    const restored = decodeEmbedding(blob);
    expect(restored).toEqual([]);
  });

  it("produces a Buffer of correct byte length (4 bytes per float)", () => {
    const vec = [1, 2, 3];
    const blob = encodeEmbedding(vec);
    expect(blob.byteLength).toBe(vec.length * 4);
  });
});

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  it("returns 1 for identical unit vectors", () => {
    const v = [1, 0, 0];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 when a vector is all zeros", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// embedding cache helpers
// ---------------------------------------------------------------------------

describe("embedding cache helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getCachedEmbeddings returns cached result on second call", async () => {
    const db = makeMockDb();
    const cache = new Map<string, number[]>();

    vi.spyOn(embeddingOps, "openCacheDb").mockResolvedValue(db);
    vi.spyOn(embeddingOps, "lookupCache").mockImplementation((_db, model, hash) => cache.get(`${model}:${hash}`) ?? null);
    vi.spyOn(embeddingOps, "insertCache").mockImplementation((_db, model, hash, embedding) => {
      cache.set(`${model}:${hash}`, embedding);
    });
    vi.spyOn(embeddingOps, "persistDb").mockImplementation(() => {});
    const apiSpy = vi.spyOn(embeddingOps, "getApiEmbeddings").mockResolvedValue([[0.1, 0.2, 0.3]]);

    const first = await getCachedEmbeddings("/tmp/cortex", ["hello"], "key", "model");
    const second = await getCachedEmbeddings("/tmp/cortex", ["hello"], "key", "model");

    expect(first).toEqual([[0.1, 0.2, 0.3]]);
    expect(second).toEqual([[0.1, 0.2, 0.3]]);
    expect(apiSpy).toHaveBeenCalledTimes(1);
    expect((db.close as Mock).mock.calls.length).toBe(2);
  });

  it("embedding errors return empty results instead of throwing", async () => {
    const db = makeMockDb();

    vi.spyOn(embeddingOps, "openCacheDb").mockResolvedValue(db);
    vi.spyOn(embeddingOps, "lookupCache").mockReturnValue(null);
    vi.spyOn(embeddingOps, "getApiEmbedding").mockRejectedValue(new Error("boom"));
    vi.spyOn(embeddingOps, "getApiEmbeddings").mockRejectedValue(new Error("boom"));

    await expect(getCachedEmbedding("/tmp/cortex", "hello", "key", "model")).resolves.toEqual([]);
    await expect(getCachedEmbeddings("/tmp/cortex", ["hello", "world"], "key", "model")).resolves.toEqual([[], []]);
  });

  it("closes the DB after a successful cached operation", async () => {
    const db = makeMockDb();

    vi.spyOn(embeddingOps, "openCacheDb").mockResolvedValue(db);
    vi.spyOn(embeddingOps, "lookupCache").mockReturnValue([0.5, 0.25]);

    const result = await getCachedEmbedding("/tmp/cortex", "hello", "key", "model");

    expect(result).toEqual([0.5, 0.25]);
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("closes the DB even when the API call throws (single)", async () => {
    const db = makeMockDb();

    vi.spyOn(embeddingOps, "openCacheDb").mockResolvedValue(db);
    vi.spyOn(embeddingOps, "lookupCache").mockReturnValue(null);
    vi.spyOn(embeddingOps, "getApiEmbedding").mockRejectedValue(new Error("network error"));

    await getCachedEmbedding("/tmp/cortex", "fail", "key", "model");

    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("closes the DB even when the API call throws (batch)", async () => {
    const db = makeMockDb();

    vi.spyOn(embeddingOps, "openCacheDb").mockResolvedValue(db);
    vi.spyOn(embeddingOps, "lookupCache").mockReturnValue(null);
    vi.spyOn(embeddingOps, "getApiEmbeddings").mockRejectedValue(new Error("network error"));

    await getCachedEmbeddings("/tmp/cortex", ["a", "b"], "key", "model");

    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("getCachedEmbeddings returns empty array for empty input", async () => {
    const result = await getCachedEmbeddings("/tmp/cortex", [], "key", "model");
    expect(result).toEqual([]);
  });

  it("getCachedEmbeddings batches uncached texts and preserves order", async () => {
    const db = makeMockDb();
    let callCount = 0;

    vi.spyOn(embeddingOps, "openCacheDb").mockResolvedValue(db);
    // First text cached, second and third not cached
    vi.spyOn(embeddingOps, "lookupCache").mockImplementation((_db, _model, _hash) => {
      callCount++;
      if (callCount === 1) return [0.1]; // first text is cached
      return null;
    });
    vi.spyOn(embeddingOps, "insertCache").mockImplementation(() => {});
    vi.spyOn(embeddingOps, "persistDb").mockImplementation(() => {});
    vi.spyOn(embeddingOps, "getApiEmbeddings").mockResolvedValue([[0.2], [0.3]]);

    const result = await getCachedEmbeddings("/tmp/cortex", ["a", "b", "c"], "key", "model");

    expect(result).toEqual([[0.1], [0.2], [0.3]]);
    expect(embeddingOps.getApiEmbeddings).toHaveBeenCalledTimes(1);
  });

  it("getCachedEmbedding calls insertCache and persistDb on cache miss", async () => {
    const db = makeMockDb();

    vi.spyOn(embeddingOps, "openCacheDb").mockResolvedValue(db);
    vi.spyOn(embeddingOps, "lookupCache").mockReturnValue(null);
    vi.spyOn(embeddingOps, "getApiEmbedding").mockResolvedValue([0.9, 0.8]);
    const insertSpy = vi.spyOn(embeddingOps, "insertCache").mockImplementation(() => {});
    const persistSpy = vi.spyOn(embeddingOps, "persistDb").mockImplementation(() => {});

    const result = await getCachedEmbedding("/tmp/cortex", "hello", "key", "model");

    expect(result).toEqual([0.9, 0.8]);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  it("getCachedEmbedding skips insertCache on cache hit", async () => {
    const db = makeMockDb();

    vi.spyOn(embeddingOps, "openCacheDb").mockResolvedValue(db);
    vi.spyOn(embeddingOps, "lookupCache").mockReturnValue([0.5]);
    const insertSpy = vi.spyOn(embeddingOps, "insertCache").mockImplementation(() => {});
    const apiSpy = vi.spyOn(embeddingOps, "getApiEmbedding").mockResolvedValue([0.9]);

    const result = await getCachedEmbedding("/tmp/cortex", "hello", "key", "model");

    expect(result).toEqual([0.5]);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(apiSpy).not.toHaveBeenCalled();
  });
});
