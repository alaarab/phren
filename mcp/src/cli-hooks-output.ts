import {
  recordInjection,
  recordRetrieval,
} from "./shared-governance.js";
import {
  getDocSourceKey,
} from "./shared-index.js";
import {
  logImpact,
  extractFindingIdsFromSnippet,
} from "./finding-impact.js";
import { isFeatureEnabled } from "./utils.js";
import { annotateStale } from "./cli-hooks-citations.js";
import type { SelectedSnippet, GitContext } from "./shared-retrieval.js";
import { approximateTokens, fileRelevanceBoost, branchMatchBoost } from "./shared-retrieval.js";

// ── Progressive disclosure helpers ────────────────────────────────────────────

function buildOneLiner(snippet: string): string {
  const lines = snippet.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  if (!lines.length) return "";
  const first = lines[0].replace(/^[-*#>\s]+/, "").trim();
  if (first.length <= 80) return first;
  return first.slice(0, 79) + "\u2026";
}

function buildCompactIndex(selected: SelectedSnippet[], cortexPathLocal: string): string[] {
  const lines: string[] = [];
  for (const { doc, snippet } of selected) {
    const id = `mem:${getDocSourceKey(doc, cortexPathLocal)}`;
    const summary = buildOneLiner(snippet);
    lines.push(`[${id}] ${doc.type}: ${summary}`);
  }
  return lines;
}

// ── Hook output formatting ───────────────────────────────────────────────────

export function buildHookOutput(
  selected: SelectedSnippet[],
  usedTokens: number,
  intent: string,
  gitCtx: GitContext | null,
  detectedProject: string | null,
  stage: Record<string, number>,
  tokenBudget: number,
  cortexPathLocal: string,
  sessionId?: string
): string[] {
  const projectLabel = detectedProject ? ` \u00b7 ${detectedProject}` : "";
  const resultLabel = selected.length === 1 ? "1 result" : `${selected.length} results`;
  const statusLine = `\u25c6 cortex${projectLabel} \u00b7 ${resultLabel}`;

  const parts: string[] = [statusLine, "<cortex-context>"];
  const impactEntries: Array<{ findingId: string; project: string; sessionId: string }> = [];
  const impactSessionId = sessionId ?? "none";

  const useCompactIndex = isFeatureEnabled("CORTEX_FEATURE_PROGRESSIVE_DISCLOSURE", false) && selected.length >= 3;

  if (useCompactIndex) {
    const indexEntries = selected.slice(0, 8);
    const indexLines = buildCompactIndex(indexEntries, cortexPathLocal);
    parts.push("Context index (use get_memory_detail to expand any entry):");
    for (const line of indexLines) {
      parts.push(line);
    }
    parts.push("");
    for (const injected of indexEntries) {
      recordInjection(cortexPathLocal, injected.key, sessionId);
      if (injected.doc.type === "findings") {
        for (const findingId of extractFindingIdsFromSnippet(injected.snippet)) {
          impactEntries.push({
            findingId,
            project: injected.doc.project,
            sessionId: impactSessionId,
          });
        }
      }
      try {
        recordRetrieval(cortexPathLocal, `${injected.doc.project}/${injected.doc.filename}`, injected.doc.type);
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] injectContext recordRetrieval: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  } else {
    // Position-aware injection: place most relevant at START and END so the
    // highest-value snippets survive truncation pressure better.
    // Input `selected` is already ranked by relevance (best first).
    // Reorder so: [0] stays first, [1] goes last, middle positions get [2..N-1].
    let ordered = selected;
    if (selected.length >= 3) {
      ordered = [
        selected[0],                    // most relevant → start
        ...selected.slice(2),           // remaining → middle
        selected[1],                    // second most → end
      ];
    }

    // Re-verify token budget after reordering; trim middle items if over budget
    if (ordered.length > 2) {
      let totalTokens = 36; // base overhead
      const keep: boolean[] = ordered.map(() => true);
      for (let i = 0; i < ordered.length; i++) {
        totalTokens += approximateTokens(ordered[i].snippet) + 14;
      }
      // Trim from the middle (indices 1..N-2) if over budget
      if (totalTokens > tokenBudget) {
        for (let i = ordered.length - 2; i >= 1; i--) {
          if (totalTokens <= tokenBudget) break;
          totalTokens -= approximateTokens(ordered[i].snippet) + 14;
          keep[i] = false;
        }
        ordered = ordered.filter((_, i) => keep[i]);
      }
    }

    for (const injected of ordered) {
      const { doc, snippet, key } = injected;
      recordInjection(cortexPathLocal, key, sessionId);
      if (doc.type === "findings") {
        for (const findingId of extractFindingIdsFromSnippet(snippet)) {
          impactEntries.push({
            findingId,
            project: doc.project,
            sessionId: impactSessionId,
          });
        }
      }
      try {
        recordRetrieval(cortexPathLocal, doc.path ?? doc.filename, doc.type);
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] injectContext recordRetrievalOrdered: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      parts.push(`[${getDocSourceKey(doc, cortexPathLocal)}] (${doc.type})`);
      parts.push(annotateStale(snippet));
      parts.push("");
    }
  }

  logImpact(cortexPathLocal, impactEntries);

  parts.push("<cortex-context>");

  const changedCount = gitCtx?.changedFiles.size ?? 0;
  if (gitCtx) {
    const fileHits = selected.filter((r) => fileRelevanceBoost(r.doc.path, gitCtx.changedFiles) > 0).length;
    const branchHits = selected.filter((r) => branchMatchBoost(r.doc.content, gitCtx.branch) > 0).length;
    parts.push(
      `\u25c6 cortex \u00b7 trace: intent=${intent}; reasons=file:${fileHits},branch:${branchHits}; branch=${gitCtx.branch}; changed_files=${changedCount}; tokens\u2248${usedTokens}/${tokenBudget}; stages=index:${stage.indexMs}ms,search:${stage.searchMs}ms,trust:${stage.trustMs}ms,rank:${stage.rankMs}ms,select:${stage.selectMs}ms`
    );
  } else {
    parts.push(`\u25c6 cortex \u00b7 trace: intent=${intent}; reasons=intent-only; tokens\u2248${usedTokens}/${tokenBudget}; stages=index:${stage.indexMs}ms,search:${stage.searchMs}ms,trust:${stage.trustMs}ms,rank:${stage.rankMs}ms,select:${stage.selectMs}ms`);
  }

  return parts;
}
