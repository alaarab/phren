import { browserHint } from "./browser-hint.js";
import { moduleEnabled } from "../modules/runtime.js";
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
  getPhrenPath,
} from "../shared.js";
import {
  mergeConfig, recordLookupEvents } from "../shared/governance.js";
import {
  loadIndexForHook,
  detectProject,
} from "../shared/index.js";
import { isProjectHookEnabled } from "../project-config.js";
import {
  checkConsolidationNeeded,
} from "../shared/content.js";
import {
  extractKeywordEntries,
  isFeatureEnabled,
  clampInt,
  errorMessage,
} from "../utils.js";
import { getHooksEnabledPreference } from "../init/preferences.js";
import { logger } from "../logger.js";
import { isToolHookEnabled, runPrePromptHooks } from "../hooks.js";
import { handleExtractMemories } from "./extract.js";
import { appendAuditLog } from "../shared.js";
import { updateRuntimeHealth } from "../shared/governance.js";
import { getProactivityLevel, getProactivityLevelForTask, getProactivityLevelForFindings } from "../proactivity.js";
import { FINDING_SENSITIVITY_CONFIG } from "./config-policy.js";
import * as fs from "fs";

// ── Re-exports from focused modules ─────────────────────────────────────────

// Citations
export {
  parseCitations,
  validateCitation,
  annotateStale,
  clearCitationValidCache,
  type ParsedCitation,
} from "./hooks-citations.js";

// Globs
export {
  getProjectGlobBoost,
  clearProjectGlobCache,
} from "./hooks-globs.js";

// Retrieval
export {
  detectTaskIntent,
  filterTaskByPriority,
  searchDocuments,
  applyTrustFilter,
  rankResults,
  applyRelevanceFloor,
  promptRarity,
  DEFAULT_MIN_QUERY_RELEVANCE,
  selectSnippets,
  type SelectedSnippet,
} from "../shared/retrieval.js";

// Output
export {
  buildHookOutput,
} from "./hooks-output.js";

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
} from "./hooks-session.js";

// ── Imports for the orchestrator ─────────────────────────────────────────────

import type { SelectedSnippet } from "../shared/retrieval.js";
import { runPromptPipeline } from "../recall/pipeline.js";
import { isMachinePrompt } from "../recall/prompt-source.js";
import { recordRecallTrace, skippedTraceEntry, traceEntryFromResult } from "../recall/trace.js";
import { readRecallSeen, recentlyInjected, writeRecallSeen } from "../recall/repeat.js";
import { buildHookOutput } from "./hooks-output.js";
import {
  getGitContext,
  trackSessionMetrics,
} from "./hooks-session.js";
import { approximateTokens, SNIPPET_OVERHEAD_TOKENS } from "../shared/retrieval.js";
import { resolveRuntimeProfile } from "../runtime-profile.js";
import { handleTaskPromptLifecycle } from "../task/lifecycle.js";
import { bestFindingNodeId } from "../finding-graph-id.js";
import { readKnowsBlock } from "../content/summarize.js";

// Auto-learn from prompts was removed — it learned conversational noise ("bro", "idk", typos)
// as synonyms for high-frequency terms. Manual `phren config synonyms add` still works.
// Future: finding-based co-occurrence mining (phren maintain command, not live hook).

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
  const profile = resolveRuntimeProfile(getPhrenPath());

  let raw = "";
  try { raw = await readStdin(); } catch (err: unknown) {
    if (process.env.PHREN_DEBUG) logger.debug("cli-hooks", `hookPrompt stdinRead: ${errorMessage(err)}`);
    process.exit(0);
  }

  const input = parseHookInput(raw);
  if (!input) process.exit(0);

  const { prompt, cwd, sessionId } = input;

  // Another agent's result, report or message is not the owner asking anything:
  // the context pass (about a second on a busy store) has nothing to answer.
  if (isMachinePrompt(prompt)) {
    recordRecallTrace(getPhrenPath(), skippedTraceEntry(prompt, "machine-prompt", null, sessionId));
    process.exit(0);
  }

  if (!getHooksEnabledPreference(getPhrenPath())) {
    appendAuditLog(getPhrenPath(), "hook_prompt", "status=disabled");
    process.exit(0);
  }

  // Check per-tool hook preference (PHREN_HOOK_TOOL is set by session wrappers;
  // Claude hooks always run as "claude" from settings.json)
  const hookTool = process.env.PHREN_HOOK_TOOL || "claude";
  if (!isToolHookEnabled(getPhrenPath(), hookTool)) {
    appendAuditLog(getPhrenPath(), "hook_prompt", `status=tool_disabled tool=${hookTool}`);
    process.exit(0);
  }

  updateRuntimeHealth(getPhrenPath(), { lastPromptAt: new Date().toISOString() });

  const detectedProject = cwd ? detectProject(getPhrenPath(), cwd, profile) : null;
  if (detectedProject) debugLog(`Detected project: ${detectedProject}`);

  if (!isProjectHookEnabled(getPhrenPath(), detectedProject, "UserPromptSubmit")) {
    appendAuditLog(getPhrenPath(), "hook_prompt", `status=project_disabled project=${detectedProject}`);
    process.exit(0);
  }

  const resolvedConfig = mergeConfig(getPhrenPath(), detectedProject ?? undefined);
  const watchHint = browserHint(getPhrenPath(), prompt, sessionId,
    resolvedConfig.proactivity.base ?? getProactivityLevel(getPhrenPath()));
  if (watchHint) console.log(watchHint);

  // The pipeline extracts keywords too; the hook needs them first for session momentum,
  // and a prompt with none ends here before the index loads.
  const keywordEntries = extractKeywordEntries(prompt);
  if (!keywordEntries.length) {
    recordRecallTrace(getPhrenPath(), skippedTraceEntry(prompt, "no-keywords", detectedProject, sessionId));
    process.exit(0);
  }
  debugLog(`hook-prompt keywords: "${keywordEntries.join(" ")}"`);

  // Session momentum: track topic frequencies within the session
  let hotTopics: string[] = [];
  if (sessionId) {
    const topicFile = sessionMarker(getPhrenPath(), `topics-${sessionId}.json`);
    let sessionTopics: Record<string, number> = {};
    try {
      if (fs.existsSync(topicFile)) {
        sessionTopics = JSON.parse(fs.readFileSync(topicFile, 'utf8'));
      }
    } catch { /* ignore parse errors */ }

    for (const kw of keywordEntries) {
      sessionTopics[kw] = (sessionTopics[kw] ?? 0) + 1;
    }
    const topicTmp = `${topicFile}.tmp-${process.pid}`;
    fs.writeFileSync(topicTmp, JSON.stringify(sessionTopics));
    fs.renameSync(topicTmp, topicFile);

    // Find hot topics (3+ mentions this session)
    hotTopics = Object.entries(sessionTopics)
      .filter(([, count]) => count >= 3)
      .map(([topic]) => topic);
  }

  // Repeat suppression: this prompt's number in the session, and the bullets injected in the window before it.
  const seen = sessionId ? readRecallSeen(getPhrenPath(), sessionId) : null;
  if (seen) seen.prompt += 1;

  const tIndex0 = Date.now();
  // Never block the prompt on a rebuild: serve the current/stale snapshot and
  // refresh in a detached process (see loadIndexForHook).
  const db = await loadIndexForHook(getPhrenPath(), profile);
  const indexMs = Date.now() - tIndex0;

  // Resolve git context AFTER the enabled check — it spawns 3 git processes and is
  // wasted work when the project has hooks disabled.
  const gitCtx = moduleEnabled(getPhrenPath(), "git") ? getGitContext(cwd) : null;

  try {
    const result = await runPromptPipeline({ prompt, phrenPath: getPhrenPath(), db, detectedProject, cwd, gitCtx, hotTopics,
      recentlyInjected: seen ? recentlyInjected(seen) : undefined });

    // Auto-extract once rows survive the trust filter, even if a later stage abstained.
    if (result.trustSurvivors > 0) {
      const findingsProactivity = resolvedConfig.proactivity.findings
        ?? resolvedConfig.proactivity.base
        ?? getProactivityLevelForFindings(getPhrenPath());
      if (moduleEnabled(getPhrenPath(), "git") && isFeatureEnabled("PHREN_FEATURE_AUTO_EXTRACT", true) && findingsProactivity !== "low" && sessionId && detectedProject && cwd) {
        const marker = sessionMarker(getPhrenPath(), `extracted-${sessionId}-${detectedProject}`);
        if (!fs.existsSync(marker)) {
          try {
            await handleExtractMemories(detectedProject, cwd, true, sessionId, "hook");
            fs.writeFileSync(marker, "");
          } catch (err: unknown) {
            debugLog(`auto-extract failed for ${detectedProject}: ${errorMessage(err)}`);
          }
        }
      }
    }
    if (result.abstained) {
      if (seen && sessionId) writeRecallSeen(getPhrenPath(), sessionId, seen);
      recordRecallTrace(getPhrenPath(), traceEntryFromResult(getPhrenPath(), prompt, result, [], { session: sessionId, indexMs }));
      process.exit(0);
    }

    const { intent } = result;
    const keywords = result.keywords.join(" ");
    const stage = { indexMs, ...result.stageMs };
    let selected: SelectedSnippet[] = result.selectedRows;
    let usedTokens = result.usedTokens;

    // Once per session per project: the "What phren knows" paragraph from
    // summary.md, so the agent gets the shape of a project's archive before
    // individual bullets. Written by `phren maintain summarize`; absent until then.
    if (detectedProject && sessionId) {
      const knowsMarker = sessionMarker(getPhrenPath(), `knows-${sessionId}-${detectedProject}`);
      if (!fs.existsSync(knowsMarker)) {
        const knows = readKnowsBlock(getPhrenPath(), detectedProject);
        if (knows) {
          const text = knows.text.length > 520 ? `${knows.text.slice(0, 519)}…` : knows.text;
          selected = [{ doc: { project: detectedProject, filename: "summary.md", type: "summary", content: knows.text, path: knows.path }, snippet: text, key: `knows:${detectedProject}` }, ...selected.filter((s) => s.key !== `knows:${detectedProject}`)];
          usedTokens += approximateTokens(text) + SNIPPET_OVERHEAD_TOKENS;
          try { fs.writeFileSync(knowsMarker, ""); } catch (err: unknown) { debugLog(`knows marker: ${errorMessage(err)}`); }
        }
      }
    }

    // Injection budget: cap total injected tokens across all content
    const maxInjectTokens = clampInt(process.env.PHREN_MAX_INJECT_TOKENS, 2000, 200, 20000);
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
        const est = approximateTokens(s.snippet) + SNIPPET_OVERHEAD_TOKENS;
        if (runningTokens + est <= maxInjectTokens) {
          kept.push(s);
          runningTokens += est;
        }
      }
      budgetSelected = kept;
      budgetUsedTokens = runningTokens;
      debugLog(`injection-budget: trimmed ${selected.length} -> ${kept.length} snippets to fit ${maxInjectTokens} token budget`);
    }

    // Task capture runs before the trace line, which records a capture the open-task budget paused.
    const taskLevel = resolvedConfig.proactivity.tasks
      ?? resolvedConfig.proactivity.base
      ?? getProactivityLevelForTask(getPhrenPath());
    const taskLifecycle = moduleEnabled(getPhrenPath(), "tasks") ? handleTaskPromptLifecycle({
      phrenPath: getPhrenPath(),
      prompt,
      project: detectedProject,
      sessionId,
      intent,
      taskLevel,
      // The primary store's merged budgets, reused only for a project that lives there.
      resolvedBudgets: { store: getPhrenPath(), budgets: resolvedConfig.retentionPolicy.budgets },
    }) : { noticeLines: [] };
    const paused = "budgetPaused" in taskLifecycle ? taskLifecycle.budgetPaused : undefined;
    recordRecallTrace(getPhrenPath(), traceEntryFromResult(getPhrenPath(), prompt, result,
      budgetSelected.map((s) => ({ project: s.doc.project, filename: s.doc.filename, type: s.doc.type, path: s.doc.path, key: s.key })),
      { session: sessionId, indexMs, taskCapturePaused: paused }));

    // Live activity: what a prompt pulled in is a recall as much as a search
    // hit is, and it is by far the most common kind. Recording it here is what
    // lets the terminal graph's watch mode, and anything else tailing the log,
    // light up while an agent works. Best-effort: logging must never break
    // the hook.
    try {
      const at = new Date().toISOString();
      // The prompt, not the expanded keyword string: the feed shows this to a
      // person, and "retry retry backoff backoff jitter" is not what they asked.
      const asked = prompt.replace(/\s+/g, " ").trim().slice(0, 160);
      recordLookupEvents(getPhrenPath(), budgetSelected.map((s) => {
        const nodeId = s.doc.type === "findings" ? bestFindingNodeId(s.doc.project, s.doc.content, keywords) : null;
        return {
          at,
          query: asked,
          project: s.doc.project,
          filename: s.doc.filename,
          type: s.doc.type,
          path: s.doc.path,
          snippet: s.snippet,
          source: "hook",
          ...(nodeId ? { nodeId } : {}),
          ...(sessionId ? { session: sessionId } : {}),
        };
      }));
    } catch (err: unknown) {
      debugLog(`hook-prompt lookup-events: ${errorMessage(err)}`);
    }

    const parts = buildHookOutput(budgetSelected, budgetUsedTokens, intent, gitCtx, detectedProject, stage, result.tokenBudget, getPhrenPath(), sessionId, keywords);
    if (taskLifecycle.noticeLines.length > 0) {
      parts.push("");
      parts.push(...taskLifecycle.noticeLines);
    }

    // Inject finding sensitivity agent instruction
    try {
      const sensitivity = resolvedConfig.findingSensitivity ?? "balanced";
      const sensitivityConfig = FINDING_SENSITIVITY_CONFIG[sensitivity];
      if (sensitivityConfig) {
        parts.push("");
        parts.push(`[phren finding-sensitivity=${sensitivity}] ${sensitivityConfig.agentInstruction}`);
      }
    } catch {
      // ignore — non-fatal
    }

    // Add budget info to trace, and say when the open-task budget kept this prompt from filing a task
    if (parts.length > 0) {
      const traceIdx = parts.findIndex(p => p.includes("trace:"));
      if (traceIdx !== -1) {
        parts[traceIdx] = parts[traceIdx].replace(/tokens/, `budget=${budgetUsedTokens}/${maxInjectTokens};tokens`);
        if (paused) parts[traceIdx] += `; tasks=paused open ${paused.open}/${paused.budget}`;
      }
    }

    if (sessionId) {
      trackSessionMetrics(getPhrenPath(), sessionId, budgetSelected);
    }

    const noticeFile = sessionId ? sessionMarker(getPhrenPath(), `noticed-${sessionId}`) : null;
    const alreadyNoticed = noticeFile ? fs.existsSync(noticeFile) : false;

    if (!alreadyNoticed) {
      // Defer stale session marker cleanup to after output — it's I/O-heavy and not needed for results
      setImmediate(() => {
        try {
          const cutoff = Date.now() - 86400000;
          const sessDir = sessionsDir(getPhrenPath());
          if (fs.existsSync(sessDir)) {
            for (const f of fs.readdirSync(sessDir)) {
              if (!f.startsWith("noticed-") && !f.startsWith("extracted-") && !f.startsWith("recall-seen-")) continue;
              const fp = `${sessDir}/${f}`;
              try {
                if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
              } catch { /* ignore per-file errors */ }
            }
          }
          // Also clean stale markers from the phren root
          for (const f of fs.readdirSync(getPhrenPath())) {
            if (!f.startsWith(".noticed-") && !f.startsWith(".extracted-")) continue;
            const fp = `${getPhrenPath()}/${f}`;
            try { fs.unlinkSync(fp); } catch { /* ignore */ }
          }
        } catch (err: unknown) {
          debugLog(`stale notice cleanup failed: ${errorMessage(err)}`);
        }
      });

      const needed = checkConsolidationNeeded(getPhrenPath(), profile);
      if (needed.length > 0) {
        const notices = needed.map((n) => {
          const since = n.lastConsolidated ? ` since ${n.lastConsolidated}` : "";
          return `  ${n.project}: ${n.entriesSince} new findings${since}`;
        });
        parts.push(`\u25c8 phren \u00b7 consolidation ready`);
        parts.push(`<phren-notice>`);
        parts.push(`Findings ready for consolidation:`);
        parts.push(notices.join("\n"));
        parts.push(`Run phren-consolidate when ready.`);
        parts.push(`</phren-notice>`);
      }

      if (noticeFile) {
        try { fs.writeFileSync(noticeFile, ""); } catch (err: unknown) {
          if (process.env.PHREN_DEBUG) logger.debug("cli-hooks", `hookPrompt noticeFileWrite: ${errorMessage(err)}`);
        }
      }
    }

    const totalMs = stage.indexMs + stage.searchMs + stage.trustMs + stage.rankMs + stage.selectMs;
    const slowThreshold = Number.parseInt(process.env.PHREN_SLOW_FS_WARN_MS || "3000", 10) || 3000;
    if (totalMs > slowThreshold) {
      debugLog(`slow-fs: hook-prompt took ${totalMs}ms (index=${stage.indexMs} search=${stage.searchMs} trust=${stage.trustMs} rank=${stage.rankMs} select=${stage.selectMs})`);
      process.stderr.write(`phren: hook-prompt took ${totalMs}ms, check if ~/.phren is on a slow or network filesystem\n`);
    }

    // Run pre-prompt custom hooks and prepend their output
    const prePromptOutput = runPrePromptHooks(getPhrenPath(), raw);
    if (prePromptOutput) parts.unshift(prePromptOutput);

    if (seen && sessionId) {
      for (const s of budgetSelected) if (s.bulletHash) seen.seen[s.bulletHash] = seen.prompt;
      writeRecallSeen(getPhrenPath(), sessionId, seen);
    }
    console.log(parts.join("\n"));
  } catch (err: unknown) {
    const msg = errorMessage(err);
    process.stdout.write(`\n<phren-error>phren hook failed: ${msg}. Check ~/.phren/.runtime/debug.log for details.</phren-error>\n`);
    debugLog(`hook-prompt error: ${msg}`);
    process.exit(0);
  }
}
