import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { SqlJsDatabase } from "./embedding.js";
import { embeddingOps, getCachedEmbedding, getCachedEmbeddings } from "./embedding.js";

function makeMockDb(): SqlJsDatabase {
  return {
    run: vi.fn(),
    exec: vi.fn(() => []),
    export: vi.fn(() => new Uint8Array()),
    close: vi.fn(),
  };
}

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
});
