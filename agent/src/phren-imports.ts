/**
 * Typed wrappers for dynamic imports from @phren/cli's compiled dist.
 * These resolve at runtime against mcp/dist/ — no type declarations needed.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

async function importModule(path: string): Promise<any> {
  return import(path);
}

// ── Path resolution ──────────────────────────────────────────────────────────

export async function importPhrenPaths() {
  const mod = await importModule("../../mcp/dist/phren-paths.js");
  return {
    findPhrenPath: mod.findPhrenPath as () => string | null,
    getProjectDirs: mod.getProjectDirs as (phrenPath: string, profile?: string) => string[],
  };
}

export async function importRuntimeProfile() {
  const mod = await importModule("../../mcp/dist/runtime-profile.js");
  return {
    resolveRuntimeProfile: mod.resolveRuntimeProfile as (phrenPath: string) => string | null,
  };
}

// ── Search & indexing ────────────────────────────────────────────────────────

interface DocRow {
  project: string;
  filename: string;
  content: string;
  type?: string;
  path?: string;
}

export async function importIndex() {
  const mod = await importModule("../../mcp/dist/shared/index.js");
  return {
    buildIndex: mod.buildIndex as (phrenPath: string, profile?: string) => Promise<unknown>,
  };
}

export async function importRetrieval() {
  const mod = await importModule("../../mcp/dist/shared/retrieval.js");
  return {
    searchKnowledgeRows: mod.searchKnowledgeRows as (
      db: unknown, query: string, opts?: { limit?: number; project?: string }
    ) => DocRow[],
    rankResults: mod.rankResults as (
      db: unknown, rows: DocRow[], query: string, opts?: { project?: string }
    ) => DocRow[],
  };
}

// ── Data layer ───────────────────────────────────────────────────────────────

interface FindingResult {
  ok: boolean;
  error?: string;
  data?: Array<{ text: string }>;
}

interface TaskResult {
  ok: boolean;
  error?: string;
  data: {
    items: Record<string, Array<{ line: string; checked: boolean }>>;
  };
}

export async function importCoreFinding() {
  const mod = await importModule("../../mcp/dist/core/finding.js");
  return {
    addFinding: mod.addFinding as (
      phrenPath: string, project: string, finding: string
    ) => Promise<FindingResult>,
  };
}

export async function importTasks() {
  const mod = await importModule("../../mcp/dist/data/tasks.js");
  return {
    readTasks: mod.readTasks as (phrenPath: string, project: string) => TaskResult,
    completeTasks: mod.completeTasks as (
      phrenPath: string, project: string, items: string[]
    ) => FindingResult,
  };
}

interface FindingItemResult {
  ok: boolean;
  error?: string;
  data?: Array<{ text: string; date: string; status?: string; tier?: string }>;
}

export async function importFindings() {
  const mod = await importModule("../../mcp/dist/data/access.js");
  return {
    readFindings: mod.readFindings as (phrenPath: string, project: string) => FindingItemResult,
  };
}
