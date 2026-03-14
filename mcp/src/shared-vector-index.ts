import * as fs from "fs";
import * as crypto from "crypto";
import { runtimeFile, debugLog } from "./shared.js";
import { withFileLock } from "./shared-governance.js";
import { errorMessage } from "./utils.js";

const VECTOR_INDEX_VERSION = 1;
const VECTOR_INDEX_TABLE_COUNT = 4;
const VECTOR_INDEX_BITS_PER_TABLE = 12;
const VECTOR_INDEX_TARGET_MULTIPLIER = 8;
const VECTOR_INDEX_MIN_CANDIDATES = 24;
const VECTOR_INDEX_FALLBACK_CAP = 64;

interface SourceMarker {
  mtimeMs: number;
  size: number;
}

interface ModelVectorIndex {
  dims: number;
  allPaths: string[];
  tables: Array<Record<string, string[]>>;
}

interface VectorIndexFile {
  version: number;
  source: SourceMarker | null;
  models: Record<string, ModelVectorIndex>;
}

interface EmbeddingEntryLike {
  path: string;
  model: string;
  vec: number[];
}

function embeddingsFilePath(phrenPath: string): string {
  return runtimeFile(phrenPath, "embeddings.json");
}

function vectorIndexPath(phrenPath: string): string {
  return runtimeFile(phrenPath, "embedding-index.json");
}

function readSourceMarker(phrenPath: string): SourceMarker | null {
  try {
    const stat = fs.statSync(embeddingsFilePath(phrenPath));
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function markersMatch(a: SourceMarker | null, b: SourceMarker | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function stepSeed(seed: number): number {
  return (Math.imul(seed, 1664525) + 1013904223) >>> 0;
}

function pairSeed(model: string, table: number, bit: number): number {
  const raw = crypto.createHash("sha256").update(`${model}:${table}:${bit}`).digest();
  return raw.readUInt32LE(0);
}

function dimensionPair(dims: number, model: string, table: number, bit: number): [number, number] {
  if (dims <= 1) return [0, 0];
  let seed = pairSeed(model, table, bit);
  const a = seed % dims;
  seed = stepSeed(seed);
  let b = seed % dims;
  if (b === a) b = (b + 1) % dims;
  return [a, b];
}

function bucketKey(vec: number[], model: string, table: number): string {
  const dims = vec.length;
  if (dims === 0) return "";
  let bits = "";
  for (let bit = 0; bit < VECTOR_INDEX_BITS_PER_TABLE; bit++) {
    const [a, b] = dimensionPair(dims, model, table, bit);
    bits += (vec[a] ?? 0) >= (vec[b] ?? 0) ? "1" : "0";
  }
  return bits;
}

function oneBitNeighbors(key: string): string[] {
  const neighbors: string[] = [];
  for (let i = 0; i < key.length; i++) {
    neighbors.push(`${key.slice(0, i)}${key[i] === "1" ? "0" : "1"}${key.slice(i + 1)}`);
  }
  return neighbors;
}

function buildVectorIndexData(entries: EmbeddingEntryLike[]): Record<string, ModelVectorIndex> {
  const byModel = new Map<string, EmbeddingEntryLike[]>();
  for (const entry of entries) {
    if (!entry.model || entry.vec.length === 0) continue;
    const arr = byModel.get(entry.model) ?? [];
    arr.push(entry);
    byModel.set(entry.model, arr);
  }

  const models: Record<string, ModelVectorIndex> = {};
  for (const [model, modelEntries] of byModel.entries()) {
    const dims = modelEntries[0]?.vec.length ?? 0;
    const tables = Array.from({ length: VECTOR_INDEX_TABLE_COUNT }, () => ({} as Record<string, string[]>));
    const allPaths: string[] = [];
    for (const entry of modelEntries) {
      allPaths.push(entry.path);
      for (let table = 0; table < VECTOR_INDEX_TABLE_COUNT; table++) {
        const key = bucketKey(entry.vec, model, table);
        const bucket = tables[table][key] ?? [];
        bucket.push(entry.path);
        tables[table][key] = bucket;
      }
    }
    models[model] = { dims, allPaths, tables };
  }
  return models;
}

class PersistentVectorIndex {
  private phrenPath: string;
  private loaded = false;
  private source: SourceMarker | null = null;
  private models: Record<string, ModelVectorIndex> = {};

  constructor(phrenPath: string) {
    this.phrenPath = phrenPath;
  }

  private loadFromDisk(): void {
    if (this.loaded) return;
    this.loaded = true;
    const filePath = vectorIndexPath(this.phrenPath);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as VectorIndexFile;
      if (parsed?.version !== VECTOR_INDEX_VERSION || !parsed.models || typeof parsed.models !== "object") return;
      this.source = parsed.source ?? null;
      this.models = parsed.models;
    } catch (err: unknown) {
      const code = err instanceof Error && "code" in err ? String((err as NodeJS.ErrnoException).code ?? "") : "";
      if (code !== "ENOENT") debugLog(`PersistentVectorIndex load failed: ${errorMessage(err)}`);
    }
  }

  private saveToDisk(): void {
    const filePath = vectorIndexPath(this.phrenPath);
    try {
      withFileLock(filePath, () => {
        const tmp = `${filePath}.tmp-${crypto.randomUUID()}`;
        const payload: VectorIndexFile = {
          version: VECTOR_INDEX_VERSION,
          source: this.source,
          models: this.models,
        };
        fs.writeFileSync(tmp, JSON.stringify(payload));
        fs.renameSync(tmp, filePath);
      });
    } catch (err: unknown) {
      debugLog(`PersistentVectorIndex save failed: ${errorMessage(err)}`);
    }
  }

  ensure(entries: EmbeddingEntryLike[]): void {
    this.loadFromDisk();
    const currentSource = readSourceMarker(this.phrenPath);
    if (markersMatch(this.source, currentSource) && Object.keys(this.models).length > 0) return;
    this.models = buildVectorIndexData(entries);
    this.source = currentSource;
    this.saveToDisk();
  }

  query(model: string, queryVec: number[], limit: number, eligiblePaths?: Set<string>): string[] {
    if (queryVec.length === 0) return [];
    const modelIndex = this.models[model];
    if (!modelIndex || modelIndex.dims === 0) return [];

    const target = Math.max(VECTOR_INDEX_MIN_CANDIDATES, limit * VECTOR_INDEX_TARGET_MULTIPLIER);
    const seen = new Set<string>();
    const keys = Array.from({ length: VECTOR_INDEX_TABLE_COUNT }, (_, table) => bucketKey(queryVec, model, table));

    const addBucket = (table: number, key: string) => {
      const bucket = modelIndex.tables[table]?.[key] ?? [];
      for (const entryPath of bucket) {
        if (eligiblePaths && !eligiblePaths.has(entryPath)) continue;
        seen.add(entryPath);
        if (seen.size >= target) return;
      }
    };

    for (let table = 0; table < keys.length && seen.size < target; table++) {
      addBucket(table, keys[table]);
    }
    for (let table = 0; table < keys.length && seen.size < target; table++) {
      for (const neighbor of oneBitNeighbors(keys[table])) {
        addBucket(table, neighbor);
        if (seen.size >= target) break;
      }
    }

    if (seen.size === 0) {
      for (const entryPath of modelIndex.allPaths) {
        if (eligiblePaths && !eligiblePaths.has(entryPath)) continue;
        seen.add(entryPath);
        if (seen.size >= VECTOR_INDEX_FALLBACK_CAP) break;
      }
    }

    return [...seen];
  }
}

const vectorIndexInstances = new Map<string, PersistentVectorIndex>();

export function getPersistentVectorIndex(phrenPath: string): PersistentVectorIndex {
  const existing = vectorIndexInstances.get(phrenPath);
  if (existing) return existing;
  const created = new PersistentVectorIndex(phrenPath);
  vectorIndexInstances.set(phrenPath, created);
  return created;
}
