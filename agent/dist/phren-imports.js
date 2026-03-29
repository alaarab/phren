/**
 * Typed wrappers for dynamic imports from @phren/cli's compiled dist.
 * These resolve at runtime against mcp/dist/ — no type declarations needed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
async function importModule(path) {
    return import(path);
}
// ── Path resolution ──────────────────────────────────────────────────────────
export async function importPhrenPaths() {
    const mod = await importModule("../../mcp/dist/phren-paths.js");
    return {
        findPhrenPath: mod.findPhrenPath,
        getProjectDirs: mod.getProjectDirs,
    };
}
export async function importRuntimeProfile() {
    const mod = await importModule("../../mcp/dist/runtime-profile.js");
    return {
        resolveRuntimeProfile: mod.resolveRuntimeProfile,
    };
}
export async function importIndex() {
    const mod = await importModule("../../mcp/dist/shared/index.js");
    return {
        buildIndex: mod.buildIndex,
    };
}
export async function importRetrieval() {
    const mod = await importModule("../../mcp/dist/shared/retrieval.js");
    return {
        searchKnowledgeRows: mod.searchKnowledgeRows,
        rankResults: mod.rankResults,
    };
}
export async function importCoreFinding() {
    const mod = await importModule("../../mcp/dist/core/finding.js");
    return {
        addFinding: mod.addFinding,
    };
}
export async function importTasks() {
    const mod = await importModule("../../mcp/dist/data/tasks.js");
    return {
        readTasks: mod.readTasks,
        completeTasks: mod.completeTasks,
    };
}
export async function importFindings() {
    const mod = await importModule("../../mcp/dist/data/access.js");
    return {
        readFindings: mod.readFindings,
    };
}
