import { registeredStoreIdentity } from "../store-registry.js";
import { cachedCitationFreshness, refreshCitationFreshness, type CitationFreshness, type CitationFreshnessOptions } from "../content/citation-freshness.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { readFindings, type FindingItem } from "../data/access.js";
import { FINDING_TAGS } from "../phren-core.js";
import { getProjectRemote, readProjectConfig } from "../project-config.js";
import { redactSecretsForLog } from "../content/secrets.js";
import { resolveProject } from "../store-routing.js";
import { isValidProjectName } from "../utils.js";
import { BridgeError } from "./protocol.js";
import { moduleEnabled } from "../modules/runtime.js";
import { loadCodePackage } from "../modules/code-package.js";
import { bestChunkMatch, tokenizeForOverlap } from "../shared/retrieval.js";
import { findingWriteSchema, isRepoPath, isSearchText, MAX_FILE_PATHS, MAX_FINDING_BODY, MAX_SEARCH_LIMIT } from "./gitboy-contract.js";

// `GET /v1/projects/:project/memory`: one project's findings, truths and
// the repository (gitboy). Phren stays the source of truth; nothing here
// writes. The scoped `gitboy-read` SSH key reaches only this route
// (scoped-gateway.ts). Contract: docs/phren-hook.md#gitboy-read-only-memory.

export const PROJECT_MEMORY_ROUTE = /^\/v1\/projects\/([^/]+)\/(memory|memory\/files|memory\/search|findings)$/;
export const MEMORY_LIMITS = { findings: 500 } as const;

export interface MemoryFinding {
  id: string; text: string; type: string | null; status: FindingItem["status"]; created: string | null;
  citationFreshness?: CitationFreshness;
  citation: { file: string | null; line: number | null; commit: string | null; name: string | null } | null;
}
export interface ProjectMemory {
  project: string; store_id: string | null; remote: string | null; truncated: boolean;
  findings: MemoryFinding[]; truths: { text: string }[];
  tasks: { active: []; queue: []; done: [] };
}

const TAG = new RegExp(`^\\[(${FINDING_TAGS.join("|")})\\]\\s*`, "i");
const DATE = /^\d{4}-\d{2}-\d{2}/;

/** Text that trips phren's credential detector is withheld whole, never cut. */
const safe = (text: string) => redactSecretsForLog(text);

function freshnessOptions(root: string, project: string): CitationFreshnessOptions {
  return { phrenPath: root, projectRemote: getProjectRemote(root, project, readProjectConfig(root, project)) };
}

function finding(item: FindingItem, opts: CitationFreshnessOptions): MemoryFinding {
  const citationFreshness = item.citationData ? cachedCitationFreshness(item.citationData, opts) : undefined;
  const tag = TAG.exec(item.text);
  const cite = item.citationData;
  const citation = cite && (cite.file || cite.line || cite.commit || cite.symbol)
    ? { file: cite.file ?? null, line: Number.isInteger(cite.line) ? cite.line! : null, commit: cite.commit ?? null, name: cite.symbol ?? null }
    : null;
  const created = DATE.test(item.date) ? item.date.slice(0, 10) : cite?.created_at && DATE.test(cite.created_at) ? cite.created_at.slice(0, 10) : null;
  return {
    id: item.stableId ? `fid:${item.stableId}` : item.id,
    text: safe(tag ? item.text.slice(tag[0].length) : item.text),
    type: tag ? tag[1].toLowerCase() : null,
    status: item.status, created, citation,
    ...(citationFreshness ? { citationFreshness } : {}),
  };
}

function locate(base: string, rawProject: string): { project: string; root: string; storeId: string | null } {
  let project: string;
  try { project = decodeURIComponent(rawProject); } catch { throw new BridgeError(400, "Invalid project name."); }
  if (!isValidProjectName(project)) throw new BridgeError(400, "Invalid project name.");
  let root: string;
  try { root = resolveProject(base, project).store.path; }
  catch { throw new BridgeError(404, "Project not found."); }
  return { project, root, storeId: registeredStoreIdentity(root) ?? null };
}

/** Newest first, so a cap drops the oldest. Undated findings sort last. */
function sortedFindings(root: string, project: string, opts: CitationFreshnessOptions): FindingItem[] {
  const result = readFindings(root, project);
  if (!result.ok) throw new BridgeError(404, "Project not found.");
  const citations = result.data.flatMap(item => item.citationData ? [item.citationData] : []);
  // One batch per poll, after the response has been shaped. Refresh deduplicates overlapping polls.
  if (citations.length) setImmediate(() => { void refreshCitationFreshness(citations, { ...opts, budgetMs: 1500 }); });
  return result.data.map((item, index) => ({ item, index, date: DATE.test(item.date) ? item.date : "" }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.index - b.index).map(entry => entry.item);
}

function readTruths(root: string, project: string): string[] {
  const file = path.join(root, project, "truths.md");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(line => line.startsWith("- ")).map(line => line.slice(2).trim()) : [];
}

export function projectMemory(base: string, rawProject: string): ProjectMemory {
  const { project, root, storeId } = locate(base, rawProject);
  const opts = freshnessOptions(root, project);
  const allFindings = sortedFindings(root, project, opts);
  const truths = readTruths(root, project).map(text => ({ text: safe(text) }));

  const truncated = allFindings.length > MEMORY_LIMITS.findings;
  return {
    project, store_id: storeId, remote: opts.projectRemote ?? null, truncated,
    findings: allFindings.slice(0, MEMORY_LIMITS.findings).map(item => finding(item, opts)),
    truths,
    tasks: { active: [], queue: [], done: [] },
  };
}

// ── /memory/files ────────────────────────────────────────────────────────────

export interface FileFinding extends MemoryFinding { match: "file" | "symbol" }

/** Findings about these repository files: cited by file, or citing a function,
 *  type or variable the code index places in one of them. */
export async function memoryForFiles(base: string, rawProject: string, paths: string[]) {
  const { project, root, storeId } = locate(base, rawProject);
  const opts = freshnessOptions(root, project);
  if (paths.length < 1 || paths.length > MAX_FILE_PATHS || !paths.every(isRepoPath)) {
    throw new BridgeError(400, `Send 1 to ${MAX_FILE_PATHS} repository-relative paths.`);
  }
  const wanted = new Set(paths);
  const all = sortedFindings(root, project, opts);
  const citedFile = (item: FindingItem) => item.citationData?.file?.replace(/^\.\//, "");
  const named = all.filter(item => item.citationData?.symbol && !wanted.has(citedFile(item) ?? ""));
  let symbols: "indexed" | "unavailable" = "unavailable";
  let files: Record<string, string> = {};
  if (named.length && moduleEnabled(root, "code")) {
    const code = await loadCodePackage(root).catch(() => undefined);
    if (code && typeof code.resolveSymbolFiles === "function") {
      const resolved = await code.resolveSymbolFiles(root, project, named.map(item => item.citationData!.symbol!)).catch(() => undefined);
      if (resolved?.available) { symbols = "indexed"; files = resolved.value; }
    }
  }
  const matches: FileFinding[] = [];
  for (const item of all) {
    const file = citedFile(item), name = item.citationData?.symbol;
    if (file && wanted.has(file)) matches.push({ ...finding(item, opts), match: "file" });
    else if (name && files[name] && wanted.has(files[name])) matches.push({ ...finding(item, opts), match: "symbol" });
  }
  return { project, store_id: storeId, symbols, truncated: matches.length > MEMORY_LIMITS.findings,
    findings: matches.slice(0, MEMORY_LIMITS.findings) };
}

// ── /memory/search ───────────────────────────────────────────────────────────

export interface SearchHit {
  kind: "finding" | "truth"; score: number; matched: number;
  text: string; finding: MemoryFinding | null;
}

/**
 * Findings and truths ranked against `q` with phren's retrieval tokenizer and
 * chunk matcher (the hook's relevance floor). Each query token is weighted by
 * how rare it is across this project's findings and truths (the normalised IDF
 * `tokenRarity` uses), so a stack trace's common words count for little.
 * `score` is the matched share of that weight, 0 to 1; findings that are no
 * longer active count half.
 */
export function memorySearch(base: string, rawProject: string, q: string, limit: number) {
  const { project, root } = locate(base, rawProject);
  const opts = freshnessOptions(root, project);
  if (!isSearchText(q)) throw new BridgeError(400, "q must be 1 to 1000 characters of text.");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) throw new BridgeError(400, `limit must be 1 to ${MAX_SEARCH_LIMIT}.`);
  const entries = [
    ...sortedFindings(root, project, opts).map(item => ({ kind: "finding" as const, text: item.text, item })),
    ...readTruths(root, project).map(text => ({ kind: "truth" as const, text, item: undefined })),
  ];
  const tokens = tokenizeForOverlap(q, 64);
  const corpus = entries.map(entry => new Set(tokenizeForOverlap(entry.text, Number.POSITIVE_INFINITY)));
  const total = entries.length, scale = Math.log(total + 1);
  const rarity = new Map<string, number>();
  for (const token of tokens) {
    const df = corpus.filter(set => set.has(token)).length;
    if (df > 0) rarity.set(token, total > 1 ? Math.max(0.05, Math.min(1, Math.log((total + 1) / (df + 1)) / scale)) : 1);
  }
  const present = [...rarity.keys()];
  const weight = present.reduce((sum, token) => sum + rarity.get(token)!, 0);
  const minimum = Math.min(2, present.length);
  const hits: SearchHit[] = [];
  if (weight > 0) for (const entry of entries) {
    const best = bestChunkMatch(present, { content: entry.text }, rarity);
    if (!best || best.distinct < minimum) continue;
    const inactive = entry.item && entry.item.status !== "active";
    const score = Math.round((best.rarity / weight) * (inactive ? 0.5 : 1) * 1000) / 1000;
    const shaped = entry.item ? finding(entry.item, opts) : null;
    hits.push({ kind: entry.kind, score, matched: best.distinct, text: shaped ? shaped.text : safe(entry.text), finding: shaped });
  }
  hits.sort((a, b) => b.score - a.score || b.matched - a.matched);
  return { project, query: q, results: hits.slice(0, limit) };
}

// ── POST /findings ───────────────────────────────────────────────────────────

let writes: Promise<unknown> = Promise.resolve();

/** Save one finding through the same path as the add_finding MCP tool: the
 *  project's write permission, duplicate and conflict checks, the secret
 *  scan and citation validation against the code index. */
export async function saveFinding(base: string, rawProject: string, input: unknown) {
  const { project, root } = locate(base, rawProject);
  const opts = freshnessOptions(root, project);
  if (Buffer.byteLength(JSON.stringify(input ?? null)) > MAX_FINDING_BODY) throw new BridgeError(413, `The body must be at most ${MAX_FINDING_BODY} bytes.`);
  const body = findingWriteSchema.parse(input);
  const { handleAddFinding } = await import("../tools/finding.js");
  const ctx = {
    phrenPath: base, profile: process.env.PHREN_PROFILE ?? "",
    db: () => { throw new Error("No index in the Hook."); }, rebuildIndex: async () => {}, updateFileInIndex: () => {},
    withWriteQueue: <T>(fn: () => Promise<T>) => { const next = writes.then(fn, fn); writes = next.catch(() => undefined); return next; },
  };
  const response = await handleAddFinding(ctx as never, {
    project, finding: body.text, findingType: body.type, tool: "gitboy",
    ...(body.citation && Object.keys(body.citation).length ? { citation: body.citation } : {}),
  }) as { content: Array<{ text: string }> };
  const result = JSON.parse(response.content[0].text) as { ok: boolean; error?: string; message?: string; data?: { status?: string; finding?: string; potentialDuplicates?: unknown[] } };
  if (!result.ok) {
    const error = result.error ?? "The finding was not saved.";
    throw new BridgeError(/permission|denied|not allowed/i.test(error) ? 403 : 400, safe(error));
  }
  const status = result.data?.status === "skipped" ? "duplicate" : "saved";
  const saved = status === "saved" ? sortedFindings(root, project, opts)
    .find(item => item.text === (result.data?.finding ?? "").replace(/^-\s+/, "").trim()) : undefined;
  return { project, status, finding: saved ? finding(saved, opts) : null };
}
