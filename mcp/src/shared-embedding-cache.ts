import * as fs from "fs";
import * as crypto from "crypto";
import * as path from "path";
import { runtimeFile, debugLog } from "./shared.js";
import { withFileLock } from "./shared-governance.js";

interface EmbeddingEntry {
  model: string;
  vec: number[];
  at: string;
}

type EmbeddingMap = Record<string, EmbeddingEntry>;

export class EmbeddingCache {
  private cortexPath: string;
  private cache: Map<string, EmbeddingEntry> = new Map();
  private dirty = false;

  constructor(cortexPath: string) {
    this.cortexPath = cortexPath;
  }

  async load(): Promise<void> {
    const filePath = runtimeFile(this.cortexPath, "embeddings.json");
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as EmbeddingMap;
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v.model === "string" && Array.isArray(v.vec) && typeof v.at === "string") {
          this.cache.set(k, v);
        }
      }
      debugLog(`EmbeddingCache loaded: ${this.cache.size} entries`);
    } catch {
      // file missing or corrupt — start fresh
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
  }

  delete(docPath: string): void {
    if (this.cache.has(docPath)) {
      this.cache.delete(docPath);
      this.dirty = true;
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    const filePath = runtimeFile(this.cortexPath, "embeddings.json");
    const data: EmbeddingMap = {};
    for (const [k, v] of this.cache.entries()) data[k] = v;
    try {
      withFileLock(filePath, () => {
        const tmp = filePath + `.tmp-${crypto.randomUUID()}`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, filePath);
      });
      this.dirty = false;
    } catch (e) {
      debugLog(`EmbeddingCache flush error: ${e instanceof Error ? e.message : String(e)}`);
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
