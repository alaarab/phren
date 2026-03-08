import {
  type FindingCitation,
  parseCitationComment,
  validateFindingCitation,
} from "./content-citation.js";
import * as fs from "fs";
import { capCache } from "./shared.js";

// ── Citation validation ──────────────────────────────────────────────────────

const citationValidCache = new Map<string, boolean>();

export function clearCitationValidCache(): void {
  citationValidCache.clear();
}

/** @deprecated Legacy citation formats. Use `<!-- cortex:cite {...} -->` instead. */
const CITATION_PATTERN = /<!-- source: ((?:[a-zA-Z]:[\\\/])?[^:]+):(\d+) -->|\[file:((?:[a-zA-Z]:[\\\/])?[^:]+):(\d+)\]/g;

export interface ParsedCitation {
  file?: string;
  line?: number;
  citation?: FindingCitation;
  /** True when the citation was parsed from a legacy format (not `<!-- cortex:cite ... -->`). */
  legacy?: boolean;
}

export function parseCitations(text: string): ParsedCitation[] {
  const results: ParsedCitation[] = [];
  let m: RegExpExecArray | null;
  /** @deprecated Parses legacy `<!-- source: ... -->` and `[file:...:line]` formats. */
  const re = new RegExp(CITATION_PATTERN.source, "g");
  while ((m = re.exec(text)) !== null) {
    const file = m[1] || m[3];
    const line = parseInt(m[2] || m[4], 10);
    if (file && !isNaN(line)) results.push({ file, line, legacy: true });
  }
  const citeRe = /<!--\s*cortex:cite\s+(\{[\s\S]*?\})\s*-->/g;
  while ((m = citeRe.exec(text)) !== null) {
    const parsed = parseCitationComment(m[0]);
    if (parsed) results.push({ citation: parsed });
  }
  return results;
}

export function validateCitation(citation: ParsedCitation): boolean {
  const key = citation.citation
    ? JSON.stringify(citation.citation)
    : `${citation.file}:${citation.line}`;
  if (citationValidCache.has(key)) return citationValidCache.get(key)!;

  let valid = false;
  if (citation.citation) {
    valid = validateFindingCitation(citation.citation);
  } else if (citation.file && typeof citation.line === "number") {
    try {
      if (fs.existsSync(citation.file)) {
        if (citation.line > 0) {
          const content = fs.readFileSync(citation.file, "utf8");
          const lines = content.split("\n");
          if (citation.line <= lines.length) {
            valid = true;
          }
        } else {
          valid = true;
        }
      }
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] isCitationValid: ${err instanceof Error ? err.message : String(err)}\n`);
      valid = false;
    }
  }

  citationValidCache.set(key, valid);
  capCache(citationValidCache);
  return valid;
}

export function annotateStale(snippet: string): string {
  const citations = parseCitations(snippet);
  if (citations.length === 0) return snippet;

  const annotations: string[] = [];
  for (const c of citations) {
    if (!validateCitation(c)) {
      annotations.push("[citation stale]");
    } else if (c.legacy) {
      annotations.push("[legacy format]");
    }
  }
  if (annotations.length === 0) return snippet;
  return snippet + " " + annotations.join(" ");
}
