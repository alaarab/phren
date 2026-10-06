import * as fs from "fs";
import * as crypto from "crypto";
import { runtimeFile, debugLog } from "../shared.js";
import { withFileLock } from "./governance.js";
import { errorMessage } from "../utils.js";

interface EmbeddingEntry {
  model: string;
  vec: number[];
  at: string;
}

type EmbeddingMap = Record<string, EmbeddingEntry>;

export interface EmbeddingCoverage {
  total: number;
  embedded: number;
  missing: number;
  pct: number;
  missingPct: number;
  state: "empty" | "cold" | "warming" | "warm";
}

/**
 * `[mtimeMs, size]` of the embeddings.json the in-memory map was last built
 * from. Derived caches (the LSH vector index) stamp *this*, not a fresh stat of
 * the file, so an index can never claim to describe bytes it never saw.
 */
export interface EmbeddingSourceMarker {
  mtimeMs: number;
  size: number;
}

function statSourceMarker(filePath: string): EmbeddingSourceMarker | null {
  try {
    const stat = fs.statSync(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function isEmbeddingEntry(value: unknown): value is EmbeddingEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<EmbeddingEntry>;
  return typeof candidate.model === "string"
    && Array.isArray(candidate.vec)
    && candidate.vec.every((n) => typeof n === "number" && Number.isFinite(n))
    && typeof candidate.at === "string";
}

function readEmbeddingMapFromDisk(filePath: string): EmbeddingMap {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Embedding cache must be a JSON object");
  }
  const data: EmbeddingMap = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (isEmbeddingEntry(v)) data[k] = v;
  }
  return data;
}

export class EmbeddingCache {
  private phrenPath: string;
  private cache: Map<string, EmbeddingEntry> = new Map();
  private dirty = false;
  private dirtyUpserts = new Set<string>();
  private dirtyDeletes = new Set<string>();
  private source: EmbeddingSourceMarker | null = null;

  constructor(phrenPath: string) {
    this.phrenPath = phrenPath;
  }

  async load(): Promise<void> {
    if (this.dirty) return;
    const filePath = runtimeFile(this.phrenPath, "embeddings.json");
    // Stat before the read: if the file is rewritten mid-read, the recorded
    // marker is the older one, so derived caches report stale rather than fresh.
    const marker = statSourceMarker(filePath);
    try {
      const data = readEmbeddingMapFromDisk(filePath);
      this.cache = new Map(Object.entries(data));
      this.source = marker;
      debugLog(`EmbeddingCache loaded: ${this.cache.size} entries`);
    } catch (err: unknown) {
      const code = err instanceof Error && "code" in err ? String((err as NodeJS.ErrnoException).code ?? "") : "";
      if (code === "ENOENT") {
        this.cache.clear();
        this.source = null;
        return;
      }
      debugLog(`EmbeddingCache load failed for ${filePath}: ${errorMessage(err)}`);
    }
  }

  /**
   * Marker for the embeddings.json revision this in-memory map reflects, or
   * null when it was never loaded from a file. Pass it to anything that
   * persists a derived view of `getAllEntries()`.
   */
  sourceMarker(): EmbeddingSourceMarker | null {
    return this.source;
  }

  get(docPath: string, model: string): number[] | null {
    const entry = this.cache.get(docPath);
    if (!entry || entry.model !== model) return null;
    return entry.vec;
  }

  set(docPath: string, model: string, vec: number[]): void {
    this.cache.set(docPath, { model, vec, at: new Date().toISOString().slice(0, 10) });
    this.dirty = true;
    this.dirtyUpserts.add(docPath);
    this.dirtyDeletes.delete(docPath);
  }

  delete(docPath: string): void {
    this.cache.delete(docPath);
    this.dirty = true;
    this.dirtyDeletes.add(docPath);
    this.dirtyUpserts.delete(docPath);
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    const filePath = runtimeFile(this.phrenPath, "embeddings.json");
    try {
      withFileLock(filePath, () => {
        let data: EmbeddingMap = {};
        try {
          if (fs.existsSync(filePath)) data = readEmbeddingMapFromDisk(filePath);
        } catch (err: unknown) {
          debugLog(`EmbeddingCache flush merge read failed for ${filePath}: ${errorMessage(err)}`);
        }
        for (const key of this.dirtyDeletes) delete data[key];
        for (const key of this.dirtyUpserts) {
          const entry = this.cache.get(key);
          if (entry) data[key] = entry;
        }
        const tmp = filePath + `.tmp-${crypto.randomUUID()}`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, filePath);
        this.cache = new Map(Object.entries(data));
        this.source = statSourceMarker(filePath);
      });
      this.dirty = false;
      this.dirtyUpserts.clear();
      this.dirtyDeletes.clear();
    } catch (err: unknown) {
      debugLog(`EmbeddingCache flush error: ${errorMessage(err)}`);
    }
  }

  getAllEntries(): Array<{ path: string; vec: number[]; model: string }> {
    return [...this.cache.entries()].map(([p, e]) => ({ path: p, vec: e.vec, model: e.model }));
  }

  size(): number {
    return this.cache.size;
  }

  coverage(allPaths: string[]): EmbeddingCoverage {
    const total = allPaths.length;
    const embedded = allPaths.filter(p => this.cache.has(p)).length;
    const missing = Math.max(0, total - embedded);
    const pct = total === 0 ? 0 : Math.round((embedded / total) * 100);
    const missingPct = total === 0 ? 0 : Math.max(0, 100 - pct);
    const state = total === 0
      ? "empty"
      : embedded === 0
        ? "cold"
        : embedded === total
          ? "warm"
          : "warming";
    return { total, embedded, missing, pct, missingPct, state };
  }
}

export function formatEmbeddingCoverage(coverage: EmbeddingCoverage): string {
  if (coverage.total === 0) return "0 indexed docs";
  return `${coverage.embedded}/${coverage.total} docs embedded (${coverage.pct}% warm, ${coverage.missingPct}% cold)`;
}

// Module-level singleton per phrenPath
const cacheInstances = new Map<string, EmbeddingCache>();

export function getEmbeddingCache(phrenPath: string): EmbeddingCache {
  const existing = cacheInstances.get(phrenPath);
  if (existing) return existing;
  const instance = new EmbeddingCache(phrenPath);
  cacheInstances.set(phrenPath, instance);
  return instance;
}
