// cli-hooks.ts — Thin orchestrator. Delegates to focused modules:
//   shared-retrieval.ts     — shared search, scoring, ranking, snippet selection
//   cli-hooks-citations.ts  — citation parsing and validation
//   cli-hooks-session.ts    — session lifecycle hooks, metrics, background maintenance
//   cli-hooks-output.ts     — hook output formatting
//   cli-hooks-globs.ts      — project glob matching

import {
  debugLog,
  sessionMarker,
  sessionsDir,
  getCortexPath,
} from "./shared.js";
import {
  getRetentionPolicy,
  getWorkflowPolicy,
} from "./shared-governance.js";
import {
  buildIndex,
  detectProject,
} from "./shared-index.js";
import { isProjectHookEnabled } from "./project-config.js";
import {
  checkConsolidationNeeded,
} from "./shared-content.js";
import {
  buildRobustFtsQuery,
  extractKeywordEntries,
  isFeatureEnabled,
  clampInt,
  errorMessage,
  loadSynonymMap,
  learnSynonym,
  STOP_WORDS,
} from "./utils.js";
import { getHooksEnabledPreference } from "./init.js";
import { isToolHookEnabled } from "./hooks.js";
import { handleExtractMemories } from "./cli-extract.js";
import { appendAuditLog } from "./shared.js";
import { updateRuntimeHealth } from "./shared-governance.js";
import { getProactivityLevelForTask, getProactivityLevelForFindings } from "./proactivity.js";
import { FINDING_SENSITIVITY_CONFIG } from "./cli-config.js";
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
  filterTaskByPriority,
  searchDocuments,
  applyTrustFilter,
  rankResults,
  selectSnippets,
  type SelectedSnippet,
} from "./shared-retrieval.js";

// Output
export {
  buildHookOutput,
} from "./cli-hooks-output.js";

// Session
export {
  handleHookSessionStart,
  handleHookStop,
  handleBackgroundSync,
  handleHookContext,
  handleHookTool,
  trackSessionMetrics,
  filterConversationInsightsForProactivity,
  extractToolFindings,
  filterToolFindingsForProactivity,
  resolveSubprocessArgs,
} from "./cli-hooks-session.js";

// ── Imports for the orchestrator ─────────────────────────────────────────────

import {
  searchDocumentsAsync,
  applyTrustFilter,
  rankResults,
  selectSnippets,
  detectTaskIntent,
  type SelectedSnippet,
} from "./shared-retrieval.js";
import { buildHookOutput } from "./cli-hooks-output.js";
import {
  getGitContext,
  trackSessionMetrics,
} from "./cli-hooks-session.js";
import { approximateTokens } from "./shared-retrieval.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";
import { handleTaskPromptLifecycle } from "./task-lifecycle.js";

function synonymTermKnown(term: string, map: Record<string, string[]>): boolean {
  if (Object.prototype.hasOwnProperty.call(map, term)) return true;
  for (const values of Object.values(map)) {
    if (values.includes(term)) return true;
  }
  return false;
}

function termAppearsInText(term: string, text: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const pattern = new RegExp(`\\b${escaped}\\b`, "i");
  return pattern.test(text);
}

function autoLearnQuerySynonyms(
  cortexPath: string,
  project: string | null,
  keywordEntries: string[],
  rows: Array<{ content: string }>,
): void {
  if (!project) return;

  const synonymMap = loadSynonymMap(project, cortexPath);
  const knownTerms = new Set<string>([
    ...Object.keys(synonymMap),
    ...Object.values(synonymMap).flat(),
  ]);
  const queryTerms = [...new Set(
    keywordEntries
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 2 && !STOP_WORDS.has(item))
  )];
  const unknownTerms = queryTerms.filter((term) => !synonymTermKnown(term, synonymMap));
  if (unknownTerms.length === 0) return;

  const corpus = rows
    .slice(0, 8)
    .map((row) => row.content.slice(0, 6000))
    .join("\n")
    .toLowerCase();
  if (!corpus.trim()) return;

  const learned: Array<{ term: string; related: string[] }> = [];
  for (const unknown of unknownTerms.slice(0, 3)) {
    const related = [...knownTerms]
      .filter((candidate) =>
        candidate.length > 2
        && candidate !== unknown
        && !STOP_WORDS.has(candidate)
        && !queryTerms.includes(candidate)
        && termAppearsInText(candidate, corpus)
      )
      .slice(0, 4);

    if (related.length === 0) continue;
    try {
      learnSynonym(cortexPath, project, unknown, related);
      learned.push({ term: unknown, related });
    } catch (err: unknown) {
      debugLog(`hook-prompt synonym-learn failed for "${unknown}": ${errorMessage(err)}`);
    }
  }

  if (learned.length > 0) {
    const details = learned.map((entry) => `${entry.term}->${entry.related.join(",")}`).join("; ");
    debugLog(`hook-prompt learned synonyms project=${project} ${details}`);
  }
}

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
    debugLog(`parseHookInput: failed to parse hook JSON: ${errorMessage(err)}`);
    return null;
  }
}

// ── handleHookPrompt: orchestrator using extracted stages ────────────────────

export async function handleHookPrompt() {
  const profile = resolveRuntimeProfile(getCortexPath());
  const stage = { indexMs: 0, searchMs: 0, trustMs: 0, rankMs: 0, selectMs: 0 };

  let raw = "";
  try { raw = await readStdin(); } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] hookPrompt stdinRead: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(0);
  }

  const input = parseHookInput(raw);
  if (!input) process.exit(0);

  const { prompt, cwd, sessionId } = input;

  if (!getHooksEnabledPreference(getCortexPath())) {
    appendAuditLog(getCortexPath(), "hook_prompt", "status=disabled");
    process.exit(0);
  }

  // Check per-tool hook preference (CORTEX_HOOK_TOOL is set by session wrappers;
  // Claude hooks always run as "claude" from settings.json)
  const hookTool = process.env.CORTEX_HOOK_TOOL || "claude";
  if (!isToolHookEnabled(getCortexPath(), hookTool)) {
    appendAuditLog(getCortexPath(), "hook_prompt", `status=tool_disabled tool=${hookTool}`);
    process.exit(0);
  }

  updateRuntimeHealth(getCortexPath(), { lastPromptAt: new Date().toISOString() });

  const keywordEntries = extractKeywordEntries(prompt);
  const keywords = keywordEntries.join(" ");
  if (!keywords) process.exit(0);
  debugLog(`hook-prompt keywords: "${keywords}"`);

  const tIndex0 = Date.now();
  const db = await buildIndex(getCortexPath(), profile);
  stage.indexMs = Date.now() - tIndex0;

  const gitCtx = getGitContext(cwd);
  const intent = detectTaskIntent(prompt);
  const detectedProject = cwd ? detectProject(getCortexPath(), cwd, profile) : null;
  if (detectedProject) debugLog(`Detected project: ${detectedProject}`);

  if (!isProjectHookEnabled(getCortexPath(), detectedProject, "UserPromptSubmit")) {
    appendAuditLog(getCortexPath(), "hook_prompt", `status=project_disabled project=${detectedProject}`);
    process.exit(0);
  }

  const safeQuery = buildRobustFtsQuery(keywords, detectedProject, getCortexPath());
  if (!safeQuery) process.exit(0);

  try {
    const tSearch0 = Date.now();
    let rows = await searchDocumentsAsync(db, safeQuery, prompt, keywords, detectedProject, false, getCortexPath());
    stage.searchMs = Date.now() - tSearch0;
    if (!rows || !rows.length) process.exit(0);
    autoLearnQuerySynonyms(getCortexPath(), detectedProject, keywordEntries, rows);

    const tTrust0 = Date.now();
    const policy = getRetentionPolicy(getCortexPath());
    const memoryTtlDays = Number.parseInt(
      process.env.CORTEX_MEMORY_TTL_DAYS || String(policy.ttlDays), 10
    );
    const trustResult = applyTrustFilter(
      rows,
      Number.isNaN(memoryTtlDays) ? policy.ttlDays : memoryTtlDays,
      policy.minInjectConfidence, policy.decay,
      getCortexPath()
    );
    rows = trustResult.rows;
    stage.trustMs = Date.now() - tTrust0;
    if (!rows.length) process.exit(0);

    if (isFeatureEnabled("CORTEX_FEATURE_AUTO_EXTRACT", true) && getProactivityLevelForFindings(getCortexPath()) !== "low" && sessionId && detectedProject && cwd) {
      const marker = sessionMarker(getCortexPath(), `extracted-${sessionId}-${detectedProject}`);
      if (!fs.existsSync(marker)) {
        try {
          await handleExtractMemories(detectedProject, cwd, true, sessionId, "hook");
          fs.writeFileSync(marker, "");
        } catch (err: unknown) {
          debugLog(`auto-extract failed for ${detectedProject}: ${errorMessage(err)}`);
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
        if (runningTokens + est <= maxInjectTokens) {
          kept.push(s);
          runningTokens += est;
        }
      }
      budgetSelected = kept;
      budgetUsedTokens = runningTokens;
      debugLog(`injection-budget: trimmed ${selected.length} -> ${kept.length} snippets to fit ${maxInjectTokens} token budget`);
    }

    const parts = buildHookOutput(budgetSelected, budgetUsedTokens, intent, gitCtx, detectedProject, stage, safeTokenBudget, getCortexPath(), sessionId);
    const taskLevel = getProactivityLevelForTask(getCortexPath());
    const taskLifecycle = handleTaskPromptLifecycle({
      cortexPath: getCortexPath(),
      prompt,
      project: detectedProject,
      sessionId,
      intent,
      taskLevel,
    });
    if (taskLifecycle.noticeLines.length > 0) {
      parts.push("");
      parts.push(...taskLifecycle.noticeLines);
    }

    // Inject finding sensitivity agent instruction
    try {
      const workflowPolicy = getWorkflowPolicy(getCortexPath());
      const sensitivity = workflowPolicy.findingSensitivity ?? "balanced";
      const sensitivityConfig = FINDING_SENSITIVITY_CONFIG[sensitivity];
      if (sensitivityConfig) {
        parts.push("");
        parts.push(`[cortex finding-sensitivity=${sensitivity}] ${sensitivityConfig.agentInstruction}`);
      }
    } catch {
      // ignore — non-fatal
    }

    // Add budget info to trace
    if (parts.length > 0) {
      const traceIdx = parts.findIndex(p => p.includes("trace:"));
      if (traceIdx !== -1) {
        parts[traceIdx] = parts[traceIdx].replace(/tokens/, `budget=${budgetUsedTokens}/${maxInjectTokens};tokens`);
      }
    }

    if (sessionId) {
      trackSessionMetrics(getCortexPath(), sessionId, budgetSelected);
    }

    // Reads stay side-effect free: trust filter output informs ranking/snippets now,
    // while queue/audit mutation is deferred to explicit governance maintenance.
    if (trustResult.queueItems.length > 0 || trustResult.auditEntries.length > 0) {
      debugLog(`hook-prompt deferred trust governance items=${trustResult.queueItems.length} audit=${trustResult.auditEntries.length}`);
    }

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
        // Also clean stale markers from the cortex root
        for (const f of fs.readdirSync(getCortexPath())) {
          if (!f.startsWith(".noticed-") && !f.startsWith(".extracted-")) continue;
          const fp = `${getCortexPath()}/${f}`;
          try { fs.unlinkSync(fp); } catch (err: unknown) {
            if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] hookPrompt staleNoticeUnlink: ${errorMessage(err)}\n`);
          }
        }
      } catch (err: unknown) {
        debugLog(`stale notice cleanup failed: ${errorMessage(err)}`);
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
        parts.push(`Run cortex-consolidate when ready.`);
        parts.push(`<cortex-notice>`);
      }

      if (noticeFile) {
        try { fs.writeFileSync(noticeFile, ""); } catch (err: unknown) {
          if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] hookPrompt noticeFileWrite: ${errorMessage(err)}\n`);
        }
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
    const msg = errorMessage(err);
    process.stdout.write(`\n<cortex-error>cortex hook failed: ${msg}. Check ~/.cortex/.runtime/debug.log for details.<cortex-error>\n`);
    debugLog(`hook-prompt error: ${msg}`);
    process.exit(0);
  }
}
