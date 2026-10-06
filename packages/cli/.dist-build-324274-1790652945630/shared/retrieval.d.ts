import { type RetentionPolicy } from "./governance.js";
import { type DocRow, type SqlJsDatabase } from "./index.js";
import type { GitContext } from "../cli/hooks-session.js";
export type { GitContext } from "../cli/hooks-session.js";
/**
 * Per-snippet overhead charged against the token budget: the header line
 * (`[<source key>] (<type>) fb:<score key>`) plus its blank separator.
 *
 * Selection and rendering MUST charge the same amount. When they drifted
 * apart, `selectSnippets` admitted a snippet on one estimate and
 * `buildHookOutput` re-checked it against a larger one, silently dropping a
 * middle snippet that legitimately fit.
 */
export declare const SNIPPET_OVERHEAD_TOKENS = 24;
/** Query-relevance floor (see applyRelevanceFloor). A doc with no structural
 * signal must clear this query-overlap score to be worth injecting; on the
 * overlapScore scale (matched / max(2, min(tokens, 10))) ~0.12 means "shares at
 * least one query token" — enough to drop priors-only noise without hurting
 * recall. Cross-project docs face a higher bar. Tunable via
 * PHREN_MIN_QUERY_RELEVANCE (0 disables the floor). */
declare const DEFAULT_MIN_QUERY_RELEVANCE = 0.12;
/**
 * Tasks are a backlog, not memory: a to-do list injected into a debugging
 * question is noise that costs findings their budget. They go in only when the
 * prompt is about building or asks about the work itself.
 */
export declare function wantsTasks(prompt: string, intent: ReturnType<typeof detectTaskIntent>): boolean;
export declare function detectTaskIntent(prompt: string): "debug" | "review" | "build" | "docs" | "skill" | "general";
export declare function fileRelevanceBoost(filePath: string, changedFiles: Set<string>): number;
export declare function branchMatchBoost(content: string, branch: string | undefined): number;
/** A doc's bullets (with their continuation lines) or, with none, its
 * paragraphs: the unit relevance is judged on. Topic archives are one doc
 * with hundreds of bullets, so a whole-file score matches almost anything. */
export declare function contentChunks(content: string, maxChunks?: number): string[];
export interface ChunkMatch {
    chunk: string;
    distinct: number;
    rarity: number;
}
/** The doc's best chunk for this prompt: most summed keyword rarity among
 * chunks with the most distinct keyword matches. */
export declare function bestChunkMatch(queryTokens: string[], doc: Pick<DocRow, "content">, rarity?: Map<string, number>): ChunkMatch | null;
/** How rare each prompt token is across the index: normalised IDF, 1 for a
 * token in one doc, near 0 for one in every doc. One FTS count per token. */
/** `tokenRarity` for a prompt's keywords, tokenised as the floor tokenises them. */
export declare function promptRarity(db: SqlJsDatabase | null | undefined, keywords: string): Map<string, number>;
export declare function tokenRarity(db: SqlJsDatabase | null | undefined, queryTokens: string[]): Map<string, number>;
/**
 * Item 4: Reciprocal Rank Fusion — merges ranked result lists from multiple search tiers.
 * Documents appearing in multiple tiers get a higher combined score.
 * Formula: score(d) = Σ 1/(k + rank_i) for each tier i containing d, where k=60 (standard).
 */
/** @internal Exported for tests. */
export declare function rrfMerge(tiers: DocRow[][], k?: number): DocRow[];
declare function approximateTokens(text: string): number;
export declare function filterTaskByPriority(items: string[], allowedPriorities?: string[]): string[];
export declare function searchDocuments(db: SqlJsDatabase, safeQuery: string, prompt: string, keywords: string, detectedProject: string | null, searchAllProjects?: boolean, phrenPath?: string): DocRow[] | null;
/**
 * Async variant of searchDocuments that also runs real vector search (Tier 3)
 * when cloud embeddings (PHREN_EMBEDDING_API_URL) or Ollama are available.
 * Falls back to the sync result if vector search is unavailable or fails.
 */
export declare function searchDocumentsAsync(db: SqlJsDatabase, safeQuery: string, prompt: string, keywords: string, detectedProject: string | null, searchAllProjects?: boolean, phrenPath?: string): Promise<DocRow[] | null>;
export interface SearchKnowledgeRowsOptions {
    query: string;
    maxResults: number;
    fetchLimit?: number;
    filterProject?: string | null;
    filterType?: string | null;
    phrenPath: string;
}
export interface SearchKnowledgeRowsResult {
    safeQuery: string;
    rows: DocRow[] | null;
    usedFallback: boolean;
}
export declare function searchKnowledgeRows(db: SqlJsDatabase, options: SearchKnowledgeRowsOptions): Promise<SearchKnowledgeRowsResult>;
export interface FederatedDocRow extends DocRow {
    /** The phren store path this result came from (undefined = local store). */
    federationSource?: string;
    /** Human-readable store name from the registry. */
    storeName?: string;
    /** Immutable store ID from the registry. */
    storeId?: string;
}
/**
 * Search additional phren stores defined in the store registry (or PHREN_FEDERATION_PATHS).
 * Returns an array of results tagged with their source store. Read-only — no mutations.
 */
export declare function searchFederatedStores(localPhrenPath: string, options: Omit<SearchKnowledgeRowsOptions, "phrenPath">): Promise<FederatedDocRow[]>;
/**
 * Doc types that must never be pushed into an agent's prompt automatically.
 *
 * - `notes` — personal scratch context; the user's, not the agent's.
 * - `review-queue` — review.md, which is a *quarantine*. Its entries are candidates
 *   nobody has approved yet, and the trust filter does not even look at them (they are
 *   not in TRUST_FILTERED_TYPES), so an unreviewed line would reach a prompt with no
 *   staleness, confidence, or citation checks at all. Injecting the queue would also
 *   defeat the point of having a queue: approve/reject would decide nothing, because
 *   the content is already in play.
 *
 * Both remain indexed and reachable through explicit `search_knowledge` — a pull the
 * caller asked for, tagged with its doc type — which is how a user answers "why is this
 * in my review queue?" without the content leaking into every prompt.
 */
export declare const NON_INJECTABLE_TYPES: Set<string>;
/** True when a doc type is allowed on the automatic injection path. */
export declare function isInjectableDocType(type: string): boolean;
export type TrustFilterQueueItem = {
    project: string;
    section: "Stale" | "Conflicts";
    items: string[];
};
export type TrustFilterResult = {
    rows: DocRow[];
    queueItems: TrustFilterQueueItem[];
    auditEntries: string[];
};
/** Apply trust filter to rows. Returns filtered rows plus any queue/audit items to be written
 * by the caller — retrieval itself should remain side-effect-free.
 *
 * This runs only on the automatic injection path, so it is also where non-injectable
 * doc types (notes, review-queue) are dropped. */
export declare function applyTrustFilter(rows: DocRow[], ttlDays: number, minConfidence: number, decay: Partial<RetentionPolicy["decay"]>, phrenPath?: string): TrustFilterResult;
/** Item 3: Recency boost for findings. Recent findings rank higher. Accepts pre-computed date string. */
export declare function recencyBoost(docType: string, latestDate: string): number;
export declare function rankResults(rows: DocRow[], intent: string, gitCtx: GitContext | null, detectedProject: string | null, phrenPathLocal: string, db: SqlJsDatabase, cwd?: string, query?: string, opts?: {
    filterType?: string | null;
    skipTaskFilter?: boolean;
}): DocRow[];
export interface SelectedSnippet {
    doc: DocRow;
    snippet: string;
    key: string;
}
/** Mark snippet lines with stale citations (cited file missing or line content changed).
 * @internal Exported for tests. */
export declare function markStaleCitations(snippet: string): string;
export { DEFAULT_MIN_QUERY_RELEVANCE };
/**
 * Relevance floor: drop ranked docs that aren't actually relevant to *this*
 * prompt, so the hook injects signal or nothing — never noise to fill a quota.
 *
 * `rankResults` intentionally scores on priors too (intent, recency, project,
 * feedback history), so a doc can rank well with zero query overlap. That's the
 * right call for *ordering*, but the wrong thing to *inject*. This stage keeps a
 * doc only when it has a real connection to the prompt:
 *   - a structural signal: it's a changed file, or matches the branch name, or
 *   - it's a canonical doc for the project you're actually in, or
 *   - its text clears a query-overlap floor (higher for cross-project docs).
 *
 * When there's no usable query signal (no tokens) it is a no-op. Setting the
 * floor to 0 (env PHREN_MIN_QUERY_RELEVANCE=0) disables it and restores the
 * previous always-fill behavior.
 */
export declare function applyRelevanceFloor(rows: DocRow[], keywords: string, gitCtx: {
    branch?: string;
    changedFiles?: Set<string>;
} | null, detectedProject: string | null, floor?: number, rarity?: Map<string, number>): DocRow[];
export declare function selectSnippets(rows: DocRow[], keywords: string, tokenBudget: number, lineBudget: number, charBudget: number): {
    selected: SelectedSnippet[];
    usedTokens: number;
};
export { approximateTokens };
