import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as shared from "./shared.js";
import { EmbeddingCache } from "./shared-embedding-cache.js";
import { makeTempDir } from "./test-helpers.js";

describe("EmbeddingCache.load", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("embedding-cache-");
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("logs corrupt cache files instead of silently treating them as missing", async () => {
    const runtimeDir = path.join(tmp.path, ".runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "embeddings.json"), "{bad json");
    const debugSpy = vi.spyOn(shared, "debugLog").mockImplementation(() => {});

    const cache = new EmbeddingCache(tmp.path);
    await cache.load();

    expect(cache.size()).toBe(0);
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("EmbeddingCache load failed"));
  });

  it("keeps missing cache files quiet", async () => {
    const debugSpy = vi.spyOn(shared, "debugLog").mockImplementation(() => {});

    const cache = new EmbeddingCache(tmp.path);
    await cache.load();

    expect(cache.size()).toBe(0);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("replaces stale in-memory entries when the on-disk cache is removed", async () => {
    const runtimeDir = path.join(tmp.path, ".runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, "embeddings.json"),
      JSON.stringify({
        "/a.md": { model: "m", vec: [0.1], at: "2026-03-08" },
      })
    );

    const cache = new EmbeddingCache(tmp.path);
    await cache.load();
    expect(cache.getAllEntries()).toHaveLength(1);

    fs.unlinkSync(path.join(runtimeDir, "embeddings.json"));
    await cache.load();

    expect(cache.getAllEntries()).toEqual([]);
  });

  it("merges external on-disk updates during flush instead of overwriting them", async () => {
    const runtimeDir = path.join(tmp.path, ".runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const filePath = path.join(runtimeDir, "embeddings.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        "/seed.md": { model: "m", vec: [0.1], at: "2026-03-08" },
      })
    );

    const cache = new EmbeddingCache(tmp.path);
    await cache.load();

    // Simulate another process persisting a new entry after this cache instance loaded.
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        "/seed.md": { model: "m", vec: [0.1], at: "2026-03-08" },
        "/remote.md": { model: "m", vec: [0.2], at: "2026-03-08" },
      })
    );

    cache.set("/local.md", "m", [0.3]);
    await cache.flush();

    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(persisted).sort()).toEqual(["/local.md", "/remote.md", "/seed.md"]);
  });
});
