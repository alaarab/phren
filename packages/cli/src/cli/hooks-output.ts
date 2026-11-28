import * as path from "node:path";
import { cachedCitationFreshness, citationFreshnessAnnotation, type CitationFreshnessOptions } from "../content/citation-freshness.js";
import { parseCitationComment } from "../content/citation.js";
import { getProjectRemote, readProjectConfig } from "../project-config.js";
import {
  recordInjection,
  recordRetrieval,
} from "../shared/governance.js";
import {
  getDocSourceKey,
} from "../shared/index.js";
import {
  logImpact,
  extractFindingIdsFromSnippet,
} from "../finding/impact.js";
import { errorMessage } from "../utils.js";
import { HOOK_TITLE_CHARS, clankerEnabled, docEntries, queryTerms, rowKeywords, rowTitle, termScore, type DocEntry } from "../clanker.js";
import { annotateStale } from "./hooks-citations.js";
import type { SelectedSnippet, GitContext } from "../shared/retrieval.js";
import { approximateTokens, fileRelevanceBoost, branchMatchBoost, SNIPPET_OVERHEAD_TOKENS } from "../shared/retrieval.js";
import { logger } from "../logger.js";

// ── Clanker mode: compact index ──────────────────────────────────────────────

// The finding a one-bullet snippet is, matched by its start since the budget often cuts the id comment.
function compactEntry({ doc, snippet }: SelectedSnippet): DocEntry | undefined {
  const bullets = snippet.split("\n").filter((l) => /^-\s/.test(l));
  const prefix = bullets.length === 1 ? bullets[0].replace(/ \[may be out of date:[\s\S]*$/, "").replace(/…$/, "").slice(0, 120) : "";
  return prefix ? docEntries(doc.content).find((e) => e.line.startsWith(prefix)) : undefined;
}

/** Rows the clanker index prints at most. */
export const COMPACT_INDEX_ROWS = 8;

/** The id a compact index row prints: the entry's `fid:`, else the doc's `mem:` key. */
export function compactRowId(selected: SelectedSnippet, phrenPathLocal: string, entry = compactEntry(selected)): string {
  return entry ? entry.id : `mem:${getDocSourceKey(selected.doc, phrenPathLocal)}`;
}

function buildCompactIndex(selected: SelectedSnippet[], phrenPathLocal: string, terms: string[]): string[] {
  const lines: string[] = [];
  const options = new Map<string, CitationFreshnessOptions>();
  for (const row of selected) {
    const { doc, snippet, key } = row;
    const textLines = snippet.split("\n").filter((l) => l.trim() && !l.trim().startsWith("<!--"));
    // The line that matched most of the prompt, skipping headings and table rules.
    const candidates = textLines.filter((l) => !/^\s*(#|\|?[\s:|-]+\|?\s*$)/.test(l));
    const firstLine = candidates.reduce<string | undefined>((best, l) => (best === undefined || termScore(l, terms) > termScore(best, terms) ? l : best), undefined) ?? textLines[0] ?? "";
    const entry = compactEntry(row);
    const id = compactRowId(row, phrenPathLocal, entry);
    const text = (entry ? entry.line : firstLine).replace(/ \[may be out of date:[\s\S]*$/, "");
    const citation = entry ? entry.text.split("\n").map(parseCitationComment).find(cite => cite !== null)
      : parseCitationComment(snippet.split("\n")[snippet.split("\n").indexOf(firstLine) + 1] ?? "");
    let annotation = "";
    if (citation) {
      const root = doc.path ? path.dirname(path.dirname(doc.path)) : phrenPathLocal;
      const optionsKey = JSON.stringify([root, doc.project]);
      let opts = options.get(optionsKey);
      if (!opts) {
        opts = { phrenPath: root, projectRemote: getProjectRemote(root, doc.project, readProjectConfig(root, doc.project)) };
        options.set(optionsKey, opts);
      }
      annotation = citationFreshnessAnnotation(citation, cachedCitationFreshness(citation, opts));
    }
    const keywords = rowKeywords(text, terms);
    // The fb: key rides here too. memory_feedback's description promises it
    // appears in injected headers without qualification, and this path renders
    // instead of the full one whenever clanker mode is on.
    lines.push(`${id} fb:${key} ${rowTitle(text, HOOK_TITLE_CHARS)}${annotation}${keywords.length ? ` [${keywords.join(", ")}]` : ""}`);
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
  phrenPathLocal: string,
  sessionId?: string,
  keywords?: string,
): string[] {
  const projectLabel = detectedProject ? ` \u00b7 ${detectedProject}` : "";
  const resultLabel = selected.length === 1 ? "1 result" : `${selected.length} results`;
  const statusLine = `\u25c6 phren${projectLabel} \u00b7 ${resultLabel}`;

  const parts: string[] = [statusLine, "<phren-context>"];
  const impactEntries: Array<{ findingId: string; project: string; sessionId: string }> = [];
  const impactSessionId = sessionId ?? "none";
  const matchedWords = new Set<string>();

  const clanker = clankerEnabled(phrenPathLocal);
  if (clanker) {
    const indexEntries = selected.slice(0, COMPACT_INDEX_ROWS);
    const indexLines = buildCompactIndex(indexEntries, phrenPathLocal, queryTerms(keywords ?? ""));
    parts.push("Index (get_memory_detail id=<id> for full text):");
    for (const line of indexLines) {
      parts.push(line);
    }
    parts.push("");
    for (const injected of indexEntries) {
      for (const word of injected.matched ?? []) matchedWords.add(word);
      recordInjection(phrenPathLocal, injected.key, sessionId);
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
        recordRetrieval(phrenPathLocal, `${injected.doc.project}/${injected.doc.filename}`, injected.doc.type);
      } catch (err: unknown) {
        logger.debug("hooks-output", `injectContext recordRetrieval: ${errorMessage(err)}`);
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
        // 24 ≈ header line ([source key] (type) fb:key) + blank separator.
        totalTokens += approximateTokens(ordered[i].snippet) + SNIPPET_OVERHEAD_TOKENS;
      }
      // Trim from the middle (indices 1..N-2) if over budget
      if (totalTokens > tokenBudget) {
        for (let i = ordered.length - 2; i >= 1; i--) {
          if (totalTokens <= tokenBudget) break;
          totalTokens -= approximateTokens(ordered[i].snippet) + SNIPPET_OVERHEAD_TOKENS;
          keep[i] = false;
        }
        ordered = ordered.filter((_, i) => keep[i]);
      }
    }

    for (const injected of ordered) {
      for (const word of injected.matched ?? []) matchedWords.add(word);
      const { doc, snippet, key } = injected;
      recordInjection(phrenPathLocal, key, sessionId);
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
        recordRetrieval(phrenPathLocal, doc.path ?? doc.filename, doc.type);
      } catch (err: unknown) {
        logger.debug("hooks-output", `injectContext recordRetrievalOrdered: ${errorMessage(err)}`);
      }
      // `fb:` is the memory_feedback handle. The tool scores entryScoreKey
      // (project/filename:digest) — NOT the mem: source key and NOT an fid —
      // and this header was the only place the injection pipeline had the
      // key in hand; before it was printed here, the feedback loop was
      // built, wired into ranking, and unreachable.
      parts.push(`[${getDocSourceKey(doc, phrenPathLocal)}] (${doc.type}) fb:${key}`);
      parts.push(annotateStale(snippet));
      parts.push("");
    }
  }

  logImpact(phrenPathLocal, impactEntries);

  parts.push("</phren-context>");
  // Up to eight matched prompt words, then a count; nothing at all when no snippet matched any.
  const matched = matchedWords.size ? [...matchedWords].slice(0, 8).join(",") + (matchedWords.size > 8 ? `,+${matchedWords.size - 8}` : "") : "";
  const matchedField = matched ? ` matched=${matched};` : "";
  if (clanker) {
    if (matched) parts.push(`\u25c6 phren \u00b7 matched=${matched}`);
    return parts;
  }

  const changedCount = gitCtx?.changedFiles.size ?? 0;
  if (gitCtx) {
    const fileHits = selected.filter((r) => fileRelevanceBoost(r.doc.path, gitCtx.changedFiles) > 0).length;
    const branchHits = selected.filter((r) => branchMatchBoost(r.doc.content, gitCtx.branch) > 0).length;
    parts.push(
      `\u25c6 phren \u00b7 trace: intent=${intent};${matchedField} reasons=file:${fileHits},branch:${branchHits}; branch=${gitCtx.branch}; changed_files=${changedCount}; tokens\u2248${usedTokens}/${tokenBudget}; stages=index:${stage.indexMs}ms,search:${stage.searchMs}ms,trust:${stage.trustMs}ms,rank:${stage.rankMs}ms,select:${stage.selectMs}ms`
    );
  } else {
    parts.push(`\u25c6 phren \u00b7 trace: intent=${intent};${matchedField} tokens\u2248${usedTokens}/${tokenBudget}; stages=index:${stage.indexMs}ms,search:${stage.searchMs}ms,trust:${stage.trustMs}ms,rank:${stage.rankMs}ms,select:${stage.selectMs}ms`);
  }

  return parts;
}
