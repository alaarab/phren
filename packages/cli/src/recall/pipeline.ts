// The prompt-time recall pipeline: keywords, search, trust, rank, relevance floor, selection.
// The UserPromptSubmit hook wraps it and the recall eval calls it directly. It writes no session
// files, markers, scores or lookup events (only PHREN_DEBUG lines); those stay in the hook.

import { mergeConfig } from "../shared/governance.js";
import type { DocRow } from "../shared/index.js";
import {
  applyRelevanceFloor,
  applyTrustFilter,
  DEFAULT_MIN_QUERY_RELEVANCE,
  detectTaskIntent,
  promptRarity,
  rankResults,
  searchDocumentsAsync,
  selectSnippets,
  wantsTasks,
} from "../shared/retrieval.js";
import { debugLog } from "../shared.js";
import { buildRobustFtsQuery, clampFloat, clampInt, extractKeywordEntries } from "../utils.js";
import { isMachinePrompt } from "./prompt-source.js";
import type { RecallAbstainReason, RecallDocRef, RecallPipelineInput, RecallResult } from "./types.js";

function docRef(row: DocRow): RecallDocRef {
  return { project: row.project, filename: row.filename, type: row.type, path: row.path };
}

export async function runPromptPipeline(input: RecallPipelineInput): Promise<RecallResult> {
  const { prompt, phrenPath, db, detectedProject, cwd } = input;
  const gitCtx = input.gitCtx ?? null;
  const hotTopics = input.hotTopics ?? [];
  const keywordEntries = extractKeywordEntries(prompt);
  const keywords = keywordEntries.join(" ");
  const intent = detectTaskIntent(prompt);
  const result: RecallResult = {
    keywords: keywordEntries,
    intent,
    detectedProject,
    abstained: null,
    trustSurvivors: 0,
    candidates: [],
    floor: [],
    selected: [],
    selectedRows: [],
    suppressedRepeats: 0,
    usedTokens: 0,
    tokenBudget: 0,
    stageMs: { searchMs: 0, trustMs: 0, rankMs: 0, selectMs: 0 },
  };
  const abstain = (reason: RecallAbstainReason): RecallResult => {
    result.abstained = reason;
    return result;
  };

  if (isMachinePrompt(prompt)) return abstain("machine-prompt");
  if (!keywords) return abstain("no-keywords");

  const safeQuery = buildRobustFtsQuery(keywords, detectedProject, phrenPath);
  if (!safeQuery) return abstain("no-query");

  const tSearch0 = Date.now();
  let rows = await searchDocumentsAsync(db, safeQuery, prompt, keywords, detectedProject, false, phrenPath);
  result.stageMs.searchMs = Date.now() - tSearch0;
  if (!rows || !rows.length) return abstain("no-search-results");

  const policy = mergeConfig(phrenPath, detectedProject ?? undefined).retentionPolicy;
  const tTrust0 = Date.now();
  const memoryTtlDays = Number.parseInt(
    process.env.PHREN_MEMORY_TTL_DAYS || String(policy.ttlDays), 10
  );
  const trustResult = applyTrustFilter(
    rows,
    Number.isNaN(memoryTtlDays) ? policy.ttlDays : memoryTtlDays,
    policy.minInjectConfidence, policy.decay,
    phrenPath
  );
  rows = trustResult.rows;
  // Notes are intentionally available to explicit search, but are personal scratch
  // context and should never be injected into an agent prompt automatically.
  rows = rows.filter((row) => row.type !== "notes");
  // Tasks are a backlog, not memory: only when the prompt is about the work.
  if (!wantsTasks(prompt, intent)) rows = rows.filter((row) => row.type !== "task");
  result.stageMs.trustMs = Date.now() - tTrust0;
  result.trustSurvivors = rows.length;
  if (!rows.length) return abstain("trust-filtered");

  const tRank0 = Date.now();
  rows = rankResults(rows, intent, gitCtx, detectedProject, phrenPath, db, cwd, keywords, undefined,
    (row, score) => result.candidates.push({ ...docRef(row), score }));
  result.stageMs.rankMs = Date.now() - tRank0;
  if (!rows.length) return abstain("ranked-empty");

  // Relevance floor: inject signal or nothing. Ranking scores on priors too,
  // so a doc can rank well with no real tie to this prompt — drop those rather
  // than pad to a quota with noise (env PHREN_MIN_QUERY_RELEVANCE=0 disables).
  const relevanceFloor = clampFloat(process.env.PHREN_MIN_QUERY_RELEVANCE, DEFAULT_MIN_QUERY_RELEVANCE, 0, 1);
  const preFloorCount = rows.length;
  debugLog(`relevance-floor candidates: ${rows.slice(0, 12).map((row) => `${row.project}/${row.filename}`).join(", ")}`);
  const rarity = promptRarity(db, keywords);
  rows = applyRelevanceFloor(rows, keywords, gitCtx, detectedProject, relevanceFloor, rarity,
    (row, decision) => result.floor.push({ ...docRef(row), ...decision }));
  if (rows.length !== preFloorCount) {
    debugLog(`relevance-floor: ${preFloorCount} -> ${rows.length} rows (floor=${relevanceFloor})`);
  }
  if (!rows.length) return abstain("below-floor");

  let tokenBudget = clampInt(process.env.PHREN_CONTEXT_TOKEN_BUDGET, 550, 180, 10000);
  const lineBudget = clampInt(process.env.PHREN_CONTEXT_SNIPPET_LINES, 6, 2, 100);
  const charBudget = clampInt(process.env.PHREN_CONTEXT_SNIPPET_CHARS, 520, 120, 10000);
  // Session momentum: boost token budget for hot topics
  if (hotTopics.length > 0) {
    tokenBudget = Math.min(
      Math.floor(tokenBudget * 1.3),
      parseInt(process.env.PHREN_MAX_INJECT_TOKENS ?? "2000", 10)
    );
  }
  result.tokenBudget = tokenBudget;

  const tSelect0 = Date.now();
  const { selected, usedTokens, suppressedRepeats } = selectSnippets(rows, keywords, tokenBudget, lineBudget, charBudget, rarity, input.recentlyInjected);
  result.stageMs.selectMs = Date.now() - tSelect0;
  result.usedTokens = usedTokens;
  result.suppressedRepeats = suppressedRepeats;
  result.selectedRows = selected;
  result.selected = selected.map((s) => ({ ...docRef(s.doc), key: s.key, snippet: s.snippet }));
  if (!selected.length) return abstain(suppressedRepeats > 0 ? "all-repeats" : "nothing-selected");

  // Reads stay side-effect free: trust filter output informs ranking/snippets now,
  // while queue/audit mutation is deferred to explicit governance maintenance.
  if (trustResult.queueItems.length > 0 || trustResult.auditEntries.length > 0) {
    debugLog(`hook-prompt deferred trust governance items=${trustResult.queueItems.length} audit=${trustResult.auditEntries.length}`);
  }
  return result;
}
