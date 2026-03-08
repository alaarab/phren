import * as fs from "fs";
import * as crypto from "crypto";
import { runtimeFile, debugLog } from "./shared.js";
import { withFileLock } from "./shared-governance.js";
import { errorMessage } from "./utils.js";

interface EmbeddingEntry {
  model: string;
  vec: number[];
  at: string;
}

type EmbeddingMap = Record<string, EmbeddingEntry>;

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
  private cortexPath: string;
  private cache: Map<string, EmbeddingEntry> = new Map();
  private dirty = false;
  private dirtyUpserts = new Set<string>();
  private dirtyDeletes = new Set<string>();

  constructor(cortexPath: string) {
    this.cortexPath = cortexPath;
  }

  async load(): Promise<void> {
    if (this.dirty) return;
    const filePath = runtimeFile(this.cortexPath, "embeddings.json");
    try {
      const data = readEmbeddingMapFromDisk(filePath);
      this.cache = new Map(Object.entries(data));
      debugLog(`EmbeddingCache loaded: ${this.cache.size} entries`);
    } catch (err: unknown) {
      const code = err instanceof Error && "code" in err ? String((err as NodeJS.ErrnoException).code ?? "") : "";
      if (code === "ENOENT") {
        this.cache.clear();
        return;
      }
      debugLog(`EmbeddingCache load failed for ${filePath}: ${errorMessage(err)}`);
    }
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
    const filePath = runtimeFile(this.cortexPath, "embeddings.json");
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

  coverage(allPaths: string[]): { total: number; embedded: number; pct: number } {
    const total = allPaths.length;
    const embedded = allPaths.filter(p => this.cache.has(p)).length;
    const pct = total === 0 ? 0 : Math.round((embedded / total) * 100);
    return { total, embedded, pct };
  }
}

// Module-level singleton per cortexPath
const cacheInstances = new Map<string, EmbeddingCache>();

export function getEmbeddingCache(cortexPath: string): EmbeddingCache {
  const existing = cacheInstances.get(cortexPath);
  if (existing) return existing;
  const instance = new EmbeddingCache(cortexPath);
  cacheInstances.set(cortexPath, instance);
  return instance;
}
