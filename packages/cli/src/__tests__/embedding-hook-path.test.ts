import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, writeFile } from "../test-helpers.js";

// search-fallback pulls the embedding cache in; stub it so "did the hook parse
// the multi-megabyte embeddings.json?" is directly observable.
const { cacheState } = vi.hoisted(() => ({
  cacheState: {
    entries: [] as Array<{ path: string; model: string; vec: number[] }>,
    loadCalls: 0,
  },
}));

vi.mock("../shared/embedding-cache.js", () => ({
  getEmbeddingCache: () => ({
    size: () => cacheState.entries.length,
    load: async () => { cacheState.loadCalls += 1; },
    getAllEntries: () => cacheState.entries,
    sourceMarker: () => null,
  }),
}));

const { vectorFallback } = await import("../shared/search-fallback.js");
const { getVectorQueryTimeoutMs } = await import("../shared/ollama.js");
const { getPersistentVectorIndex } = await import("../shared/vector-index.js");

let tmp: { path: string; cleanup: () => void };
let fetched: string[] = [];

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<unknown>): void {
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    fetched.push(String(url));
    return handler(String(url), init);
  });
}

function embeddingResponse(): unknown {
  return { ok: true, json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }) };
}

beforeEach(() => {
  tmp = makeTempDir("embedding-hook-path-");
  fetched = [];
  cacheState.entries = [];
  cacheState.loadCalls = 0;
  process.env.PHREN_OLLAMA_URL = "http://localhost:11434";
  delete process.env.PHREN_EMBEDDING_API_URL;
  delete process.env.PHREN_VECTOR_QUERY_TIMEOUT_MS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.PHREN_OLLAMA_URL;
  delete process.env.PHREN_VECTOR_QUERY_TIMEOUT_MS;
  tmp.cleanup();
});

describe("vectorFallback on the blocking hook path", () => {
  it("skips the embeddings cache load and the embed call when the backend is unreachable", async () => {
    // PHREN_OLLAMA_URL defaults to localhost, so "configured" does not mean
    // "running". An unreachable backend can only ever produce zero results, so
    // nothing downstream of the probe should run.
    stubFetch(async () => { throw new Error("ECONNREFUSED"); });

    const results = await vectorFallback(tmp.path, "anything", new Set(), 5);

    expect(results).toEqual([]);
    expect(cacheState.loadCalls).toBe(0);
    expect(fetched.filter((url) => url.includes("/api/embed"))).toEqual([]);
  });

  it("does not touch the network at all when the backend is switched off", async () => {
    process.env.PHREN_OLLAMA_URL = "off";
    stubFetch(async () => embeddingResponse());

    expect(await vectorFallback(tmp.path, "anything", new Set(), 5)).toEqual([]);
    expect(fetched).toEqual([]);
    expect(cacheState.loadCalls).toBe(0);
  });

  it("probes an unreachable backend once, then answers from the cached marker", async () => {
    // Hooks are separate processes, so the marker has to survive on disk.
    stubFetch(async () => { throw new Error("ECONNREFUSED"); });

    await vectorFallback(tmp.path, "anything", new Set(), 5);
    await vectorFallback(tmp.path, "anything else", new Set(), 5);
    await vectorFallback(tmp.path, "third prompt", new Set(), 5);

    expect(fetched.filter((url) => url.includes("/api/tags")).length).toBe(1);
    expect(fs.existsSync(path.join(tmp.path, ".runtime", "embedding-backend-health.json"))).toBe(true);
  });

  it("still runs vector search when the backend answers", async () => {
    const docPath = path.join(tmp.path, "proj", "FINDINGS.md");
    writeFile(docPath, "# findings\n- a durable insight about caching\n");
    cacheState.entries = [{ path: docPath, model: "nomic-embed-text", vec: [0.1, 0.2, 0.3] }];
    stubFetch(async (url) => {
      if (url.includes("/api/tags")) return { ok: true, json: async () => ({ models: [] }) };
      return embeddingResponse();
    });

    const results = await vectorFallback(tmp.path, "caching insight", new Set(), 5);

    expect(cacheState.loadCalls).toBe(0); // entries already resident
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("durable insight about caching");
  });

  it("gives up on a reachable-but-silent backend inside its own budget", async () => {
    process.env.PHREN_VECTOR_QUERY_TIMEOUT_MS = "150";
    cacheState.entries = [{ path: path.join(tmp.path, "proj", "x.md"), model: "nomic-embed-text", vec: [1, 0] }];
    stubFetch(async (url, init) => {
      if (url.includes("/api/tags")) return { ok: true, json: async () => ({ models: [] }) };
      // A socket that accepts and never answers — the case that used to burn
      // the entire 10s UserPromptSubmit budget.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const started = Date.now();
    const results = await vectorFallback(tmp.path, "anything", new Set(), 5);

    expect(results).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reads the query embedding budget from the environment", () => {
    expect(getVectorQueryTimeoutMs()).toBe(5_000);
    process.env.PHREN_VECTOR_QUERY_TIMEOUT_MS = "1200";
    expect(getVectorQueryTimeoutMs()).toBe(1_200);
    process.env.PHREN_VECTOR_QUERY_TIMEOUT_MS = "nonsense";
    expect(getVectorQueryTimeoutMs()).toBe(5_000);
  });
});

describe("PersistentVectorIndex source marker", () => {
  function writeEmbeddings(store: string, paths: string[]): { mtimeMs: number; size: number } {
    const data: Record<string, unknown> = {};
    for (const [i, p] of paths.entries()) {
      data[p] = { model: "m", vec: [i + 1, i + 2, i + 3], at: "2026-01-01" };
    }
    const file = path.join(store, ".runtime", "embeddings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
    const stat = fs.statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  }

  it("never stamps an index with a revision it was not built from", () => {
    // A long-lived MCP server loads embeddings.json once; hooks and background
    // reindexes keep rewriting it underneath. Stamping a fresh stat onto tables
    // built from the older entry list makes every later process accept a
    // permanently incomplete index as fresh.
    const entries = (paths: string[]) =>
      paths.map((p, i) => ({ path: p, model: "m", vec: [i + 1, i + 2, i + 3] }));

    const firstMarker = writeEmbeddings(tmp.path, ["/docs/a.md", "/docs/b.md"]);
    const index = getPersistentVectorIndex(tmp.path);
    index.ensure(entries(["/docs/a.md", "/docs/b.md"]), firstMarker);

    // Someone else appends a third document.
    const secondMarker = writeEmbeddings(tmp.path, ["/docs/a.md", "/docs/b.md", "/docs/c.md"]);
    expect(secondMarker.size).not.toBe(firstMarker.size);

    // The long-lived holder still has the two-entry view; it must say so.
    index.ensure(entries(["/docs/a.md", "/docs/b.md"]), firstMarker);

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmp.path, ".runtime", "embedding-index.json"), "utf8")
    ) as { source: { mtimeMs: number; size: number }; models: Record<string, { allPaths: string[] }> };

    expect(onDisk.models.m.allPaths).not.toContain("/docs/c.md");
    expect(onDisk.source.size).toBe(firstMarker.size);
    expect(onDisk.source.size).not.toBe(secondMarker.size);
  });

  it("rebuilds when the entries it is handed come from a newer revision", () => {
    const firstMarker = writeEmbeddings(tmp.path, ["/docs/a.md"]);
    const index = getPersistentVectorIndex(tmp.path);
    index.ensure([{ path: "/docs/a.md", model: "m", vec: [1, 2, 3] }], firstMarker);

    const secondMarker = writeEmbeddings(tmp.path, ["/docs/a.md", "/docs/c.md"]);
    index.ensure(
      [
        { path: "/docs/a.md", model: "m", vec: [1, 2, 3] },
        { path: "/docs/c.md", model: "m", vec: [3, 4, 5] },
      ],
      secondMarker
    );

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmp.path, ".runtime", "embedding-index.json"), "utf8")
    ) as { source: { size: number }; models: Record<string, { allPaths: string[] }> };

    expect(onDisk.models.m.allPaths).toContain("/docs/c.md");
    expect(onDisk.source.size).toBe(secondMarker.size);
  });
});
