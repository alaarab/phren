/**
 * Structured fact extraction from findings (PHREN_FEATURE_FACT_EXTRACT=1).
 * Each new finding is passed to an LLM that extracts a preference or fact
 * ("prefers X", "uses Y", "avoids Z"). Stored in project/preferences.json
 * and surfaced in session_start.
 */

import * as fs from "fs";
import * as path from "path";
import { debugLog } from "./shared.js";
import { safeProjectPath, isFeatureEnabled, errorMessage } from "./utils.js";
import { callLlm } from "./content-dedup.js";
import { withFileLock } from "./shared-governance.js";

const FACT_EXTRACT_FLAG = "PHREN_FEATURE_FACT_EXTRACT";
const MAX_FACTS = 50;

export interface ExtractedFact {
  fact: string;
  source: string; // truncated finding text
  at: string;     // ISO timestamp
}

function preferencesPath(phrenPath: string, project: string): string | null {
  const dir = safeProjectPath(phrenPath, project);
  return dir ? path.join(dir, "preferences.json") : null;
}

export function readExtractedFacts(phrenPath: string, project: string): ExtractedFact[] {
  const p = preferencesPath(phrenPath, project);
  if (!p) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (err: unknown) {
    if ((process.env.PHREN_DEBUG)) process.stderr.write(`[phren] readExtractedFacts: ${errorMessage(err)}\n`);
    return [];
  }
}

function writeExtractedFacts(phrenPath: string, project: string, facts: ExtractedFact[]): void {
  const p = preferencesPath(phrenPath, project);
  if (!p) return;
  try {
    const trimmed = facts.slice(-MAX_FACTS);
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
    fs.renameSync(tmp, p);
  } catch (err: unknown) {
    debugLog(`writeExtractedFacts: ${errorMessage(err)}`);
  }
}

/**
 * Fire-and-forget: extract a structured fact from a new finding using an LLM.
 * Skips silently if the feature flag is off or no LLM is configured.
 */
export function extractFactFromFinding(phrenPath: string, project: string, finding: string): void {
  if (!isFeatureEnabled(FACT_EXTRACT_FLAG, false)) return;
  // no LLM configured, skip
  if (!(process.env.PHREN_LLM_ENDPOINT) && !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) return;

  const prompt =
    `Extract a single user preference, technology choice, or architectural fact from this finding. ` +
    `Return ONLY a short statement in the format "prefers X", "uses Y", "avoids Z", ` +
    `or "decided to X because Y". If no clear preference or fact exists, return "none".\n\nFinding: ${finding.slice(0, 500)}`;

  callLlm(prompt, undefined, 60)
    .then(raw => {
      if (!raw || raw.toLowerCase() === "none") return;
      // cap and strip newlines before storing
      const fact = raw.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
      if (!fact) return;
      const p = preferencesPath(phrenPath, project);
      if (!p) return;
      withFileLock(p, () => {
        const existing = readExtractedFacts(phrenPath, project);
        const normalized = fact.toLowerCase();
        if (existing.some(f => f.fact.toLowerCase() === normalized)) return;
        existing.push({ fact, source: finding.slice(0, 120), at: new Date().toISOString() });
        writeExtractedFacts(phrenPath, project, existing);
      });
    })
    .catch((err: unknown) => {
      debugLog(`extractFactFromFinding: ${errorMessage(err)}`);
    });
}
