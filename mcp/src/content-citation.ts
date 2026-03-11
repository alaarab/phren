import * as fs from "fs";
import * as path from "path";
import { debugLog, EXEC_TIMEOUT_MS, EXEC_TIMEOUT_QUICK_MS } from "./shared.js";
import { errorMessage, runGitOrThrow } from "./utils.js";
import type { RetentionPolicy } from "./shared-governance.js";

export interface FindingCitation {
  created_at: string;
  repo?: string;
  file?: string;
  line?: number;
  commit?: string;
  supersedes?: string;
  task_item?: string;
}

export interface FindingSource {
  machine?: string;
  actor?: string;
  tool?: string;
  model?: string;
  session_id?: string;
}

export interface FindingTrustIssue {
  date: string;
  bullet: string;
  reason: "stale" | "invalid_citation";
}

export interface TrustFilterOptions {
  ttlDays?: number;
  minConfidence?: number;
  decay?: Partial<RetentionPolicy["decay"]>;
}

export function getHeadCommit(cwd: string): string | undefined {
  try {
    const commit = runGitOrThrow(cwd, ["rev-parse", "HEAD"], EXEC_TIMEOUT_QUICK_MS).trim();
    return commit || undefined;
  } catch (err: unknown) {
    debugLog(`getHeadCommit: git rev-parse HEAD failed in ${cwd}: ${errorMessage(err)}`);
    return undefined;
  }
}

export function getRepoRoot(cwd: string): string | undefined {
  try {
    const root = runGitOrThrow(cwd, ["rev-parse", "--show-toplevel"], EXEC_TIMEOUT_QUICK_MS).trim();
    return root || undefined;
  } catch (err: unknown) {
    debugLog(`getRepoRoot: not a git repo or git unavailable in ${cwd}: ${errorMessage(err)}`);
    return undefined;
  }
}

export function inferCitationLocation(repoPath: string, commit: string): { file?: string; line?: number } {
  try {
    const raw = runGitOrThrow(repoPath, ["show", "--pretty=format:", "--unified=0", "--no-color", commit], EXEC_TIMEOUT_MS);
    let currentFile = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("+++ b/")) {
        currentFile = line.slice(6).trim();
        continue;
      }
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk && currentFile) {
        return { file: currentFile, line: Number.parseInt(hunk[1], 10) };
      }
    }
  } catch (err: unknown) {
    debugLog(`citationLocationFromCommit: git show failed: ${errorMessage(err)}`);
  }
  return {};
}

export function buildCitationComment(citation: FindingCitation): string {
  return `<!-- cortex:cite ${JSON.stringify(citation)} -->`;
}

function readSourceToken(match: RegExpMatchArray | null | undefined): string | undefined {
  if (!match?.[1]) return undefined;
  const raw = match[1].trim();
  if (!raw) return undefined;
  if (raw.startsWith("\"") && raw.endsWith("\"") && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  return raw;
}

export function buildSourceComment(source: FindingSource): string {
  const parts: string[] = [];
  if (source.machine) parts.push(`machine:${source.machine}`);
  if (source.actor) parts.push(`actor:${source.actor}`);
  if (source.tool) parts.push(`tool:${source.tool}`);
  if (source.model) parts.push(`model:${source.model}`);
  if (source.session_id) parts.push(`session:${source.session_id}`);
  return parts.length > 0 ? `<!-- source: ${parts.join(" ")} -->` : "";
}

export function parseSourceComment(line: string): FindingSource | null {
  const sourceMatch = line.match(/<!--\s*source:\s*(.*?)\s*-->/);
  if (!sourceMatch) return null;

  const payload = sourceMatch[1];
  const machine =
    readSourceToken(payload.match(/(?:^|\s)machine:(".*?"|\S+)/)) ??
    readSourceToken(payload.match(/(?:^|\s)host:(".*?"|\S+)/));
  const actor =
    readSourceToken(payload.match(/(?:^|\s)actor:(".*?"|\S+)/)) ??
    readSourceToken(payload.match(/(?:^|\s)agent:(".*?"|\S+)/));
  const tool = readSourceToken(payload.match(/(?:^|\s)tool:(".*?"|\S+)/));
  const model = readSourceToken(payload.match(/(?:^|\s)model:(".*?"|\S+)/));
  const session_id =
    readSourceToken(payload.match(/(?:^|\s)session:(".*?"|\S+)/)) ??
    readSourceToken(payload.match(/(?:^|\s)session_id:(".*?"|\S+)/));

  if (!machine && !actor && !tool && !model && !session_id) return null;
  return { machine, actor, tool, model, session_id };
}

export function parseCitationComment(line: string): FindingCitation | null {
  // Find opening marker and closing --> to handle multiline/escaped JSON.
  // Uses marker-based extraction instead of regex to support multiline JSON.
  const markerMatch = line.match(/<!--\s*cortex:cite\s+/);
  if (!markerMatch) return null;
  const jsonStart = markerMatch.index! + markerMatch[0].length;
  const endMarker = line.indexOf("-->", jsonStart);
  if (endMarker === -1) return null;
  const jsonStr = line.slice(jsonStart, endMarker).trim();
  if (!jsonStr.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    // Default created_at to empty string if missing, but still require it to be string-like
    const created_at = typeof parsed.created_at === "string" ? parsed.created_at : "";
    if (!created_at) return null;
    return {
      created_at,
      repo: typeof parsed.repo === "string" ? parsed.repo : undefined,
      file: typeof parsed.file === "string" ? parsed.file : undefined,
      line: typeof parsed.line === "number" ? parsed.line : undefined,
      commit: typeof parsed.commit === "string" ? parsed.commit : undefined,
      supersedes: typeof parsed.supersedes === "string" ? parsed.supersedes : undefined,
      task_item: typeof parsed.task_item === "string" ? parsed.task_item : undefined,
    };
  } catch (err: unknown) {
    debugLog(`parseCitationComment: malformed citation JSON: ${errorMessage(err)}`);
    return null;
  }
}

function resolveCitationFile(citation: FindingCitation): string | null {
  if (!citation.file) return null;
  if (citation.repo) {
    const resolved = path.resolve(citation.repo, citation.file);
    const repoRoot = path.resolve(citation.repo);
    // Require resolved path to stay inside the repo to prevent file probing
    if (resolved !== repoRoot && !resolved.startsWith(repoRoot + path.sep)) return null;
    return resolved;
  }
  if (path.isAbsolute(citation.file)) return citation.file;
  return path.resolve(citation.file);
}

// Session-scoped caches for git I/O during citation validation.
// Keyed by "repo\0commit" and "repo\0file\0line" respectively.
const commitExistsCache = new Map<string, boolean>();
const blameCache = new Map<string, string | false>();

function commitExists(repoPath: string, commit: string): boolean {
  const key = `${repoPath}\0${commit}`;
  const cached = commitExistsCache.get(key);
  if (cached !== undefined) return cached;
  try {
    runGitOrThrow(repoPath, ["cat-file", "-e", `${commit}^{commit}`], EXEC_TIMEOUT_QUICK_MS);
    commitExistsCache.set(key, true);
    return true;
  } catch (err: unknown) {
    debugLog(`commitExists: commit ${commit} not found in ${repoPath}: ${errorMessage(err)}`);
    commitExistsCache.set(key, false);
    return false;
  }
}

function cachedBlame(repoPath: string, relFile: string, line: number): string | false {
  const key = `${repoPath}\0${relFile}\0${line}`;
  const cached = blameCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const out = runGitOrThrow(repoPath, ["blame", "-L", `${line},${line}`, "--porcelain", relFile], 10_000).trim();
    const first = out.split("\n")[0] || "";
    blameCache.set(key, first);
    return first;
  } catch (err: unknown) {
    debugLog(`cachedBlame: git blame failed for ${relFile}:${line}: ${errorMessage(err)}`);
    blameCache.set(key, false);
    return false;
  }
}

export function validateFindingCitation(citation: FindingCitation): boolean {
  if (citation.repo && !fs.existsSync(citation.repo)) return false;
  if (citation.commit && citation.repo && !commitExists(citation.repo, citation.commit)) return false;

  const resolvedFile = resolveCitationFile(citation);
  if (resolvedFile) {
    if (!fs.existsSync(resolvedFile)) return false;
    if (citation.line !== undefined) {
      if (!Number.isInteger(citation.line) || citation.line < 1) return false;
      const lineCount = fs.readFileSync(resolvedFile, "utf8").split("\n").length;
      if (citation.line > lineCount) return false;
      if (citation.commit && citation.repo) {
        const relFile = path.isAbsolute(resolvedFile)
          ? path.relative(citation.repo, resolvedFile)
          : resolvedFile;
        const first = cachedBlame(citation.repo, relFile, citation.line);
        if (first === false || !first.startsWith(citation.commit)) return false;
      }
    }
  }

  return true;
}

function parseLearningDateHeading(line: string): string | null {
  const match = line.match(/^## (\d{4}-\d{2}-\d{2})$/);
  return match ? match[1] : null;
}

function isDateStale(headingDate: string, ttlDays: number): boolean {
  const ts = Date.parse(`${headingDate}T00:00:00Z`);
  if (Number.isNaN(ts)) return false;
  const ageDays = Math.floor((Date.now() - ts) / 86400000);
  return ageDays > ttlDays;
}

function ageDaysForDate(headingDate: string): number | null {
  const ts = Date.parse(`${headingDate}T00:00:00Z`);
  if (Number.isNaN(ts)) return null;
  return Math.floor((Date.now() - ts) / 86400000);
}

const DEFAULT_DECAY = {
  d30: 1.0,
  d60: 0.85,
  d90: 0.65,
  d120: 0.45,
};

const DEFAULT_UNDATED_CONFIDENCE = 0.7;

function confidenceForAge(ageDays: number, decay: RetentionPolicy["decay"]): number {
  const { d30 = 1.0, d60 = 0.85, d90 = 0.65, d120 = 0.45 } = decay;
  if (ageDays <= 0) return 1.0;
  if (ageDays <= 30) return 1.0 - ((1.0 - d30) * (ageDays / 30));
  if (ageDays <= 60) return d30 - ((d30 - d60) * ((ageDays - 30) / 30));
  if (ageDays <= 90) return d60 - ((d60 - d90) * ((ageDays - 60) / 30));
  if (ageDays <= 120) return d90 - ((d90 - d120) * ((ageDays - 90) / 30));
  return d120; // don't decay further past d120; TTL handles final expiry
}

export function filterTrustedFindings(content: string, ttlDays: number): string {
  return filterTrustedFindingsDetailed(content, { ttlDays }).content;
}

export function filterTrustedFindingsDetailed(content: string, opts: number | TrustFilterOptions): {
  content: string;
  issues: FindingTrustIssue[];
} {
  const options: TrustFilterOptions = typeof opts === "number" ? { ttlDays: opts } : opts;
  const ttlDays = options.ttlDays ?? 120;
  const minConfidence = options.minConfidence ?? 0.35;
  const decay: RetentionPolicy["decay"] = {
    ...DEFAULT_DECAY,
    ...(options.decay || {}),
  };

  const lines = content.split("\n");
  const out: string[] = [];
  const issues: FindingTrustIssue[] = [];
  let currentDate: string | null = null;
  let headingBuffer: string[] = [];
  let inDetails = false;

  const flushHeading = (hasEntries: boolean) => {
    if (headingBuffer.length === 0) return;
    if (hasEntries) {
      out.push(...headingBuffer);
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    }
    headingBuffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes("<!-- cortex:archive:start -->") || line.includes("<details>")) {
      inDetails = true;
      continue;
    }
    if (line.includes("<!-- cortex:archive:end -->") || line.includes("</details>")) {
      inDetails = false;
      continue;
    }
    if (inDetails) continue;

    const headingDate = parseLearningDateHeading(line);
    if (headingDate) {
      flushHeading(false);
      currentDate = headingDate;
      headingBuffer = [line];
      continue;
    }

    if (line.startsWith("# ")) {
      if (out.length === 0) out.push(line, "");
      continue;
    }

    if (!line.startsWith("- ")) continue;

    // Determine the effective date for this bullet: heading date, inline created tag, or citation
    const next = lines[i + 1] ?? "";
    const citation = parseCitationComment(next);

    let effectiveDate = currentDate;
    if (!effectiveDate) {
      const inlineCreated = line.match(/<!-- created: (\d{4}-\d{2}-\d{2}) -->/);
      if (inlineCreated) {
        effectiveDate = inlineCreated[1];
      } else if (citation?.created_at) {
        const citationDate = citation.created_at.slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(citationDate)) {
          effectiveDate = citationDate;
        }
      }
    }

    const stale = effectiveDate ? isDateStale(effectiveDate, ttlDays) : false;
    if (stale) {
      issues.push({ date: effectiveDate || "unknown", bullet: line, reason: "stale" });
      if (citation) i++;
      continue;
    }

    let confidence: number;
    if (effectiveDate) {
      const age = ageDaysForDate(effectiveDate);
      confidence = age !== null ? confidenceForAge(age, decay) : DEFAULT_UNDATED_CONFIDENCE;
    } else {
      confidence = DEFAULT_UNDATED_CONFIDENCE;
    }

    if (citation && !validateFindingCitation(citation)) {
      issues.push({ date: effectiveDate || "unknown", bullet: line, reason: "invalid_citation" });
      i++;
      continue;
    }
    if (!citation) confidence *= 0.8;
    if (confidence < minConfidence) {
      issues.push({ date: effectiveDate || "unknown", bullet: line, reason: "stale" });
      if (citation) i++;
      continue;
    }

    flushHeading(true);
    out.push(line);
    if (citation) {
      out.push(next);
      i++;
    }
  }

  return { content: out.join("\n").trim(), issues };
}
