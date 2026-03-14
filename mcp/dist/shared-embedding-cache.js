import * as fs from "fs";
import * as crypto from "crypto";
import { runtimeFile, debugLog } from "./shared.js";
import { withFileLock } from "./shared-governance.js";
import { errorMessage } from "./utils.js";
function isEmbeddingEntry(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const candidate = value;
    return typeof candidate.model === "string"
        && Array.isArray(candidate.vec)
        && candidate.vec.every((n) => typeof n === "number" && Number.isFinite(n))
        && typeof candidate.at === "string";
}
function readEmbeddingMapFromDisk(filePath) {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Embedding cache must be a JSON object");
    }
    const data = {};
    for (const [k, v] of Object.entries(parsed)) {
        if (isEmbeddingEntry(v))
            data[k] = v;
    }
    return data;
}
export class EmbeddingCache {
    phrenPath;
    cache = new Map();
    dirty = false;
    dirtyUpserts = new Set();
    dirtyDeletes = new Set();
    constructor(phrenPath) {
        this.phrenPath = phrenPath;
    }
    async load() {
        if (this.dirty)
            return;
        const filePath = runtimeFile(this.phrenPath, "embeddings.json");
        try {
            const data = readEmbeddingMapFromDisk(filePath);
            this.cache = new Map(Object.entries(data));
            debugLog(`EmbeddingCache loaded: ${this.cache.size} entries`);
        }
        catch (err) {
            const code = err instanceof Error && "code" in err ? String(err.code ?? "") : "";
            if (code === "ENOENT") {
                this.cache.clear();
                return;
            }
            debugLog(`EmbeddingCache load failed for ${filePath}: ${errorMessage(err)}`);
        }
    }
    get(docPath, model) {
        const entry = this.cache.get(docPath);
        if (!entry || entry.model !== model)
            return null;
        return entry.vec;
    }
    set(docPath, model, vec) {
        this.cache.set(docPath, { model, vec, at: new Date().toISOString().slice(0, 10) });
        this.dirty = true;
        this.dirtyUpserts.add(docPath);
        this.dirtyDeletes.delete(docPath);
    }
    delete(docPath) {
        this.cache.delete(docPath);
        this.dirty = true;
        this.dirtyDeletes.add(docPath);
        this.dirtyUpserts.delete(docPath);
    }
    async flush() {
        if (!this.dirty)
            return;
        const filePath = runtimeFile(this.phrenPath, "embeddings.json");
        try {
            withFileLock(filePath, () => {
                let data = {};
                try {
                    if (fs.existsSync(filePath))
                        data = readEmbeddingMapFromDisk(filePath);
                }
                catch (err) {
                    debugLog(`EmbeddingCache flush merge read failed for ${filePath}: ${errorMessage(err)}`);
                }
                for (const key of this.dirtyDeletes)
                    delete data[key];
                for (const key of this.dirtyUpserts) {
                    const entry = this.cache.get(key);
                    if (entry)
                        data[key] = entry;
                }
                const tmp = filePath + `.tmp-${crypto.randomUUID()}`;
                fs.writeFileSync(tmp, JSON.stringify(data));
                fs.renameSync(tmp, filePath);
                this.cache = new Map(Object.entries(data));
            });
            this.dirty = false;
            this.dirtyUpserts.clear();
            this.dirtyDeletes.clear();
        }
        catch (err) {
            debugLog(`EmbeddingCache flush error: ${errorMessage(err)}`);
        }
    }
    getAllEntries() {
        return [...this.cache.entries()].map(([p, e]) => ({ path: p, vec: e.vec, model: e.model }));
    }
    size() {
        return this.cache.size;
    }
    coverage(allPaths) {
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
export function formatEmbeddingCoverage(coverage) {
    if (coverage.total === 0)
        return "0 indexed docs";
    return `${coverage.embedded}/${coverage.total} docs embedded (${coverage.pct}% warm, ${coverage.missingPct}% cold)`;
}
// Module-level singleton per phrenPath
const cacheInstances = new Map();
export function getEmbeddingCache(phrenPath) {
    const existing = cacheInstances.get(phrenPath);
    if (existing)
        return existing;
    const instance = new EmbeddingCache(phrenPath);
    cacheInstances.set(phrenPath, instance);
    return instance;
}
