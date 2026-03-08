/**
 * Structured fact extraction from findings (CORTEX_FEATURE_FACT_EXTRACT=1).
 * Each new finding is passed to an LLM that extracts a preference or fact
 * ("prefers X", "uses Y", "avoids Z"). Stored in project/preferences.json
 * and surfaced in session_start.
 */

import * as fs from "fs";
import * as path from "path";
import { debugLog } from "./shared.js";
import { safeProjectPath, isFeatureEnabled } from "./utils.js";
import { callLlm } from "./content-dedup.js";

const FACT_EXTRACT_FLAG = "CORTEX_FEATURE_FACT_EXTRACT";
const MAX_FACTS = 50;

export interface ExtractedFact {
  fact: string;
  source: string; // truncated finding text
  at: string;     // ISO timestamp
}

function preferencesPath(cortexPath: string, project: string): string | null {
  const dir = safeProjectPath(cortexPath, project);
  return dir ? path.join(dir, "preferences.json") : null;
}

export function readExtractedFacts(cortexPath: string, project: string): ExtractedFact[] {
  const p = preferencesPath(cortexPath, project);
  if (!p) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function writeExtractedFacts(cortexPath: string, project: string, facts: ExtractedFact[]): void {
  const p = preferencesPath(cortexPath, project);
  if (!p) return;
  try {
    const trimmed = facts.slice(-MAX_FACTS);
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
    fs.renameSync(tmp, p);
  } catch (err: unknown) {
    debugLog(`writeExtractedFacts: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Fire-and-forget: extract a structured fact from a new finding using an LLM.
 * Skips silently if the feature flag is off or no LLM is configured.
 */
export function extractFactFromFinding(cortexPath: string, project: string, finding: string): void {
  if (!isFeatureEnabled(FACT_EXTRACT_FLAG, false)) return;
  // no LLM configured, skip
  if (!process.env.CORTEX_LLM_ENDPOINT && !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) return;

  const prompt =
    `Extract a single user preference, technology choice, or architectural fact from this finding. ` +
    `Return ONLY a short statement in the format "prefers X", "uses Y", "avoids Z", ` +
    `or "decided to X because Y". If no clear preference or fact exists, return "none".\n\nFinding: ${finding.slice(0, 500)}`;

  callLlm(prompt, undefined, 60)
    .then(raw => {
      if (!raw || raw.toLowerCase() === "none") return;
      // Truncate and sanitize to prevent unbounded or injected content from being stored
      const fact = raw.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
      if (!fact) return;
      // Re-read inside the callback to minimize race window (best-effort; not locked)
      const existing = readExtractedFacts(cortexPath, project);
      const normalized = fact.toLowerCase();
      if (existing.some(f => f.fact.toLowerCase() === normalized)) return;
      existing.push({ fact, source: finding.slice(0, 120), at: new Date().toISOString() });
      writeExtractedFacts(cortexPath, project, existing);
    })
    .catch((err: unknown) => {
      debugLog(`extractFactFromFinding: ${err instanceof Error ? err.message : String(err)}`);
    });
}
