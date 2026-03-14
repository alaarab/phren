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
function embeddingsFilePath(phrenPath) {
    return runtimeFile(phrenPath, "embeddings.json");
}
function vectorIndexPath(phrenPath) {
    return runtimeFile(phrenPath, "embedding-index.json");
}
function readSourceMarker(phrenPath) {
    try {
        const stat = fs.statSync(embeddingsFilePath(phrenPath));
        return { mtimeMs: stat.mtimeMs, size: stat.size };
    }
    catch {
        return null;
    }
}
function markersMatch(a, b) {
    if (!a && !b)
        return true;
    if (!a || !b)
        return false;
    return a.mtimeMs === b.mtimeMs && a.size === b.size;
}
function stepSeed(seed) {
    return (Math.imul(seed, 1664525) + 1013904223) >>> 0;
}
function pairSeed(model, table, bit) {
    const raw = crypto.createHash("sha256").update(`${model}:${table}:${bit}`).digest();
    return raw.readUInt32LE(0);
}
function dimensionPair(dims, model, table, bit) {
    if (dims <= 1)
        return [0, 0];
    let seed = pairSeed(model, table, bit);
    const a = seed % dims;
    seed = stepSeed(seed);
    let b = seed % dims;
    if (b === a)
        b = (b + 1) % dims;
    return [a, b];
}
function bucketKey(vec, model, table) {
    const dims = vec.length;
    if (dims === 0)
        return "";
    let bits = "";
    for (let bit = 0; bit < VECTOR_INDEX_BITS_PER_TABLE; bit++) {
        const [a, b] = dimensionPair(dims, model, table, bit);
        bits += (vec[a] ?? 0) >= (vec[b] ?? 0) ? "1" : "0";
    }
    return bits;
}
function oneBitNeighbors(key) {
    const neighbors = [];
    for (let i = 0; i < key.length; i++) {
        neighbors.push(`${key.slice(0, i)}${key[i] === "1" ? "0" : "1"}${key.slice(i + 1)}`);
    }
    return neighbors;
}
function buildVectorIndexData(entries) {
    const byModel = new Map();
    for (const entry of entries) {
        if (!entry.model || entry.vec.length === 0)
            continue;
        const arr = byModel.get(entry.model) ?? [];
        arr.push(entry);
        byModel.set(entry.model, arr);
    }
    const models = {};
    for (const [model, modelEntries] of byModel.entries()) {
        const dims = modelEntries[0]?.vec.length ?? 0;
        const tables = Array.from({ length: VECTOR_INDEX_TABLE_COUNT }, () => ({}));
        const allPaths = [];
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
    phrenPath;
    loaded = false;
    source = null;
    models = {};
    constructor(phrenPath) {
        this.phrenPath = phrenPath;
    }
    loadFromDisk() {
        if (this.loaded)
            return;
        this.loaded = true;
        const filePath = vectorIndexPath(this.phrenPath);
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
            if (parsed?.version !== VECTOR_INDEX_VERSION || !parsed.models || typeof parsed.models !== "object")
                return;
            this.source = parsed.source ?? null;
            this.models = parsed.models;
        }
        catch (err) {
            const code = err instanceof Error && "code" in err ? String(err.code ?? "") : "";
            if (code !== "ENOENT")
                debugLog(`PersistentVectorIndex load failed: ${errorMessage(err)}`);
        }
    }
    saveToDisk() {
        const filePath = vectorIndexPath(this.phrenPath);
        try {
            withFileLock(filePath, () => {
                const tmp = `${filePath}.tmp-${crypto.randomUUID()}`;
                const payload = {
                    version: VECTOR_INDEX_VERSION,
                    source: this.source,
                    models: this.models,
                };
                fs.writeFileSync(tmp, JSON.stringify(payload));
                fs.renameSync(tmp, filePath);
            });
        }
        catch (err) {
            debugLog(`PersistentVectorIndex save failed: ${errorMessage(err)}`);
        }
    }
    ensure(entries) {
        this.loadFromDisk();
        const currentSource = readSourceMarker(this.phrenPath);
        if (markersMatch(this.source, currentSource) && Object.keys(this.models).length > 0)
            return;
        this.models = buildVectorIndexData(entries);
        this.source = currentSource;
        this.saveToDisk();
    }
    query(model, queryVec, limit, eligiblePaths) {
        if (queryVec.length === 0)
            return [];
        const modelIndex = this.models[model];
        if (!modelIndex || modelIndex.dims === 0)
            return [];
        const target = Math.max(VECTOR_INDEX_MIN_CANDIDATES, limit * VECTOR_INDEX_TARGET_MULTIPLIER);
        const seen = new Set();
        const keys = Array.from({ length: VECTOR_INDEX_TABLE_COUNT }, (_, table) => bucketKey(queryVec, model, table));
        const addBucket = (table, key) => {
            const bucket = modelIndex.tables[table]?.[key] ?? [];
            for (const entryPath of bucket) {
                if (eligiblePaths && !eligiblePaths.has(entryPath))
                    continue;
                seen.add(entryPath);
                if (seen.size >= target)
                    return;
            }
        };
        for (let table = 0; table < keys.length && seen.size < target; table++) {
            addBucket(table, keys[table]);
        }
        for (let table = 0; table < keys.length && seen.size < target; table++) {
            for (const neighbor of oneBitNeighbors(keys[table])) {
                addBucket(table, neighbor);
                if (seen.size >= target)
                    break;
            }
        }
        if (seen.size === 0) {
            for (const entryPath of modelIndex.allPaths) {
                if (eligiblePaths && !eligiblePaths.has(entryPath))
                    continue;
                seen.add(entryPath);
                if (seen.size >= VECTOR_INDEX_FALLBACK_CAP)
                    break;
            }
        }
        return [...seen];
    }
}
const vectorIndexInstances = new Map();
export function getPersistentVectorIndex(phrenPath) {
    const existing = vectorIndexInstances.get(phrenPath);
    if (existing)
        return existing;
    const created = new PersistentVectorIndex(phrenPath);
    vectorIndexInstances.set(phrenPath, created);
    return created;
}
