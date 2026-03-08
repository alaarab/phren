// cli-hooks.ts — Thin orchestrator. Delegates to focused modules:
//   cli-hooks-retrieval.ts  — search, scoring, ranking, snippet selection
//   cli-hooks-citations.ts  — citation parsing and validation
//   cli-hooks-session.ts    — session lifecycle hooks, metrics, background maintenance
//   cli-hooks-output.ts     — hook output formatting
//   cli-hooks-globs.ts      — project glob matching

import {
  debugLog,
  sessionMarker,
  sessionsDir,
  ensureCortexPath,
} from "./shared.js";
import {
  getRetentionPolicy,
  flushEntryScores,
} from "./shared-governance.js";
import {
  buildIndex,
  detectProject,
} from "./shared-index.js";
import {
  checkConsolidationNeeded,
} from "./shared-content.js";
import { buildRobustFtsQuery, extractKeywords, isFeatureEnabled, clampInt } from "./utils.js";
import { getHooksEnabledPreference } from "./init.js";
import { handleExtractMemories } from "./cli-extract.js";
import { appendAuditLog } from "./shared.js";
import { updateRuntimeHealth } from "./shared-governance.js";
import * as fs from "fs";

// ── Re-exports from focused modules ─────────────────────────────────────────

// Citations
export {
  parseCitations,
  validateCitation,
  annotateStale,
  clearCitationValidCache,
  type ParsedCitation,
} from "./cli-hooks-citations.js";

// Globs
export {
  getProjectGlobBoost,
  clearProjectGlobCache,
} from "./cli-hooks-globs.js";

// Retrieval
export {
  detectTaskIntent,
  filterBacklogByPriority,
  searchDocuments,
  applyTrustFilter,
  rankResults,
  selectSnippets,
  type SelectedSnippet,
  type GitContext,
} from "./cli-hooks-retrieval.js";

// Output
export {
  buildHookOutput,
} from "./cli-hooks-output.js";

// Session
export {
  handleHookSessionStart,
  handleHookStop,
  handleHookContext,
  handleHookTool,
  trackSessionMetrics,
  extractToolFindings,
  scheduleBackgroundMaintenance,
  resolveSubprocessArgs,
  getGitContext,
} from "./cli-hooks-session.js";

// ── Imports for the orchestrator ─────────────────────────────────────────────

import {
  searchDocuments,
  applyTrustFilter,
  rankResults,
  selectSnippets,
  detectTaskIntent,
  type SelectedSnippet,
} from "./cli-hooks-retrieval.js";
import { buildHookOutput } from "./cli-hooks-output.js";
import {
  getGitContext,
  trackSessionMetrics,
  scheduleBackgroundMaintenance,
} from "./cli-hooks-session.js";
import { approximateTokens } from "./cli-hooks-retrieval.js";

let _cortexPath: string | undefined;
function getCortexPath(): string {
  if (!_cortexPath) _cortexPath = ensureCortexPath();
  return _cortexPath;
}
const profile = process.env.CORTEX_PROFILE || "";

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer | string) => chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

// ── hook-prompt pipeline input parsing ───────────────────────────────────────

export interface HookPromptInput {
  prompt: string;
  cwd?: string;
  sessionId?: string;
}

export function parseHookInput(raw: string): HookPromptInput | null {
  try {
    const data = JSON.parse(raw);
    const prompt = data.prompt || "";
    if (!prompt.trim()) return null;
    return { prompt, cwd: data.cwd, sessionId: data.session_id };
  } catch (err: unknown) {
    debugLog(`parseHookInput: failed to parse hook JSON: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── handleHookPrompt: orchestrator using extracted stages ────────────────────

export async function handleHookPrompt() {
  const stage = { indexMs: 0, searchMs: 0, trustMs: 0, rankMs: 0, selectMs: 0 };

  let raw = "";
  try { raw = await readStdin(); } catch { process.exit(0); }

  const input = parseHookInput(raw);
  if (!input) process.exit(0);

  const { prompt, cwd, sessionId } = input;

  if (!getHooksEnabledPreference(getCortexPath())) {
    appendAuditLog(getCortexPath(), "hook_prompt", "status=disabled");
    process.exit(0);
  }

  updateRuntimeHealth(getCortexPath(), { lastPromptAt: new Date().toISOString() });

  const keywords = extractKeywords(prompt);
  if (!keywords) process.exit(0);
  debugLog(`hook-prompt keywords: "${keywords}"`);

  const tIndex0 = Date.now();
  const db = await buildIndex(getCortexPath(), profile);
  stage.indexMs = Date.now() - tIndex0;

  const gitCtx = getGitContext(cwd);
  const intent = detectTaskIntent(prompt);
  const detectedProject = cwd ? detectProject(getCortexPath(), cwd, profile) : null;
  if (detectedProject) debugLog(`Detected project: ${detectedProject}`);

  const safeQuery = buildRobustFtsQuery(keywords, detectedProject);
  if (!safeQuery) process.exit(0);

  try {
    const tSearch0 = Date.now();
    let rows = searchDocuments(db, safeQuery, prompt, keywords, detectedProject);
    stage.searchMs = Date.now() - tSearch0;
    if (!rows || !rows.length) process.exit(0);

    const tTrust0 = Date.now();
    const policy = getRetentionPolicy(getCortexPath());
    const memoryTtlDays = Number.parseInt(
      process.env.CORTEX_MEMORY_TTL_DAYS || String(policy.ttlDays), 10
    );
    rows = applyTrustFilter(
      rows, getCortexPath(),
      Number.isNaN(memoryTtlDays) ? policy.ttlDays : memoryTtlDays,
      policy.minInjectConfidence, policy.decay
    );
    stage.trustMs = Date.now() - tTrust0;
    if (!rows.length) process.exit(0);

    if (isFeatureEnabled("CORTEX_FEATURE_AUTO_EXTRACT", true) && sessionId && detectedProject && cwd) {
      const marker = sessionMarker(getCortexPath(), `extracted-${sessionId}-${detectedProject}`);
      if (!fs.existsSync(marker)) {
        try {
          await handleExtractMemories(detectedProject, cwd, true);
          fs.writeFileSync(marker, "");
        } catch (err: unknown) {
          debugLog(`auto-extract failed for ${detectedProject}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const tRank0 = Date.now();
    rows = rankResults(rows, intent, gitCtx, detectedProject, getCortexPath(), db, cwd, keywords);
    stage.rankMs = Date.now() - tRank0;
    if (!rows.length) process.exit(0);

    const safeTokenBudget = clampInt(process.env.CORTEX_CONTEXT_TOKEN_BUDGET, 550, 180, 10000);
    const safeLineBudget = clampInt(process.env.CORTEX_CONTEXT_SNIPPET_LINES, 6, 2, 100);
    const safeCharBudget = clampInt(process.env.CORTEX_CONTEXT_SNIPPET_CHARS, 520, 120, 10000);

    const tSelect0 = Date.now();
    const { selected, usedTokens } = selectSnippets(rows, keywords, safeTokenBudget, safeLineBudget, safeCharBudget);
    stage.selectMs = Date.now() - tSelect0;
    if (!selected.length) process.exit(0);

    // Injection budget: cap total injected tokens across all content
    const maxInjectTokens = clampInt(process.env.CORTEX_MAX_INJECT_TOKENS, 2000, 200, 20000);
    let budgetSelected = selected;
    let budgetUsedTokens = usedTokens;
    if (budgetUsedTokens > maxInjectTokens) {
      const priorityOrder = (s: SelectedSnippet): number => {
        if (s.doc.type === "findings") return 0;
        if (s.doc.type === "canonical") return 1;
        if (s.doc.type === "summary" || s.doc.type === "claude") return 2;
        if (s.doc.type === "reference") return 4;
        return 3;
      };
      const sorted = [...budgetSelected].sort((a, b) => priorityOrder(a) - priorityOrder(b));
      const kept: SelectedSnippet[] = [];
      let runningTokens = 36;
      for (const s of sorted) {
        const est = approximateTokens(s.snippet) + 14;
        if (runningTokens + est <= maxInjectTokens || kept.length === 0) {
          kept.push(s);
          runningTokens += est;
        }
      }
      budgetSelected = kept;
      budgetUsedTokens = runningTokens;
      debugLog(`injection-budget: trimmed ${selected.length} -> ${kept.length} snippets to fit ${maxInjectTokens} token budget`);
    }

    const parts = buildHookOutput(budgetSelected, budgetUsedTokens, intent, gitCtx, detectedProject, stage, safeTokenBudget, getCortexPath(), sessionId);
    // Add budget info to trace
    if (parts.length > 0) {
      const traceIdx = parts.findIndex(p => p.includes("trace:"));
      if (traceIdx !== -1) {
        parts[traceIdx] = parts[traceIdx].replace(/tokens/, `budget=${budgetUsedTokens}/${maxInjectTokens};tokens`);
      }
    }

    const changedCount = gitCtx?.changedFiles.size ?? 0;
    if (sessionId) {
      trackSessionMetrics(getCortexPath(), sessionId, selected, changedCount);
    }

    flushEntryScores(getCortexPath());
    scheduleBackgroundMaintenance(getCortexPath());

    const noticeFile = sessionId ? sessionMarker(getCortexPath(), `noticed-${sessionId}`) : null;
    const alreadyNoticed = noticeFile ? fs.existsSync(noticeFile) : false;

    if (!alreadyNoticed) {
      // Clean up stale session markers (>24h old) from .sessions/ dir
      try {
        const cutoff = Date.now() - 86400000;
        const sessDir = sessionsDir(getCortexPath());
        if (fs.existsSync(sessDir)) {
          for (const f of fs.readdirSync(sessDir)) {
            if (!f.startsWith("noticed-") && !f.startsWith("extracted-")) continue;
            const fp = `${sessDir}/${f}`;
            if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
          }
        }
        // Also clean legacy markers from root
        for (const f of fs.readdirSync(getCortexPath())) {
          if (!f.startsWith(".noticed-") && !f.startsWith(".extracted-")) continue;
          const fp = `${getCortexPath()}/${f}`;
          try { fs.unlinkSync(fp); } catch { /* best effort */ }
        }
      } catch (err: unknown) {
        debugLog(`stale notice cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      const needed = checkConsolidationNeeded(getCortexPath(), profile);
      if (needed.length > 0) {
        const notices = needed.map((n) => {
          const since = n.lastConsolidated ? ` since ${n.lastConsolidated}` : "";
          return `  ${n.project}: ${n.entriesSince} new findings${since}`;
        });
        parts.push(`\u25c8 cortex \u00b7 consolidation ready`);
        parts.push(`<cortex-notice>`);
        parts.push(`Findings ready for consolidation:`);
        parts.push(notices.join("\n"));
        parts.push(`Run /cortex-consolidate when ready.`);
        parts.push(`</cortex-notice>`);
      }

      if (noticeFile) {
        try { fs.writeFileSync(noticeFile, ""); } catch { /* best effort */ }
      }
    }

    const totalMs = stage.indexMs + stage.searchMs + stage.trustMs + stage.rankMs + stage.selectMs;
    const slowThreshold = Number.parseInt(process.env.CORTEX_SLOW_FS_WARN_MS || "3000", 10) || 3000;
    if (totalMs > slowThreshold) {
      debugLog(`slow-fs: hook-prompt took ${totalMs}ms (index=${stage.indexMs} search=${stage.searchMs} trust=${stage.trustMs} rank=${stage.rankMs} select=${stage.selectMs})`);
      process.stderr.write(`cortex: hook-prompt took ${totalMs}ms, check if ~/.cortex is on a slow or network filesystem\n`);
    }

    console.log(parts.join("\n"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`\n<cortex-error>cortex hook failed: ${msg}. Check ~/.cortex/.runtime/debug.log for details.</cortex-error>\n`);
    debugLog(`hook-prompt error: ${msg}`);
    process.exit(0);
  }
}
