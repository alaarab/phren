import {
  recordInjection,
  recordRetrieval,
} from "./shared-governance.js";
import {
  getDocSourceKey,
} from "./shared-index.js";
import { isFeatureEnabled } from "./utils.js";
import { annotateStale } from "./cli-hooks-citations.js";
import type { SelectedSnippet, GitContext } from "./cli-hooks-retrieval.js";

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
      try {
        recordRetrieval(cortexPathLocal, injected.doc.path ?? injected.doc.filename, injected.doc.type);
      } catch {
        // best-effort
      }
    }
  } else {
    // Position-aware injection: place most relevant at START and END (LaRA benchmark).
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

    for (const injected of ordered) {
      const { doc, snippet, key } = injected;
      recordInjection(cortexPathLocal, key, sessionId);
      try {
        recordRetrieval(cortexPathLocal, doc.path ?? doc.filename, doc.type);
      } catch {
        // best-effort
      }
      parts.push(`[${getDocSourceKey(doc, cortexPathLocal)}] (${doc.type})`);
      parts.push(annotateStale(snippet));
      parts.push("");
    }
  }

  parts.push("</cortex-context>");

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

// Internal helpers used for trace output — duplicated here to avoid circular deps
function fileRelevanceBoost(filePath: string, changedFiles: Set<string>): number {
  if (changedFiles.size === 0) return 0;
  const normalized = filePath.replace(/\\/g, "/");
  for (const cf of changedFiles) {
    const n = cf.replace(/\\/g, "/");
    if (normalized.endsWith(n) || normalized.includes(`/${n}`)) return 3;
  }
  return 0;
}

function branchMatchBoost(content: string, branch: string | undefined): number {
  if (!branch) return 0;
  const text = content.toLowerCase();
  const tokens = branch
    .split(/[\/._-]/g)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 2 && !["main", "master", "feature", "fix", "bugfix", "hotfix"].includes(s));
  let score = 0;
  for (const t of tokens) {
    if (text.includes(t)) score += 1;
  }
  return Math.min(3, score);
}
