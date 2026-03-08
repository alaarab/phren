import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { debugLog, EXEC_TIMEOUT_MS, EXEC_TIMEOUT_QUICK_MS } from "./shared.js";
import type { RetentionPolicy } from "./shared-governance.js";

export interface FindingCitation {
  created_at: string;
  repo?: string;
  file?: string;
  line?: number;
  commit?: string;
  supersedes?: string;
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
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: EXEC_TIMEOUT_QUICK_MS }).trim();
    return commit || undefined;
  } catch (err: unknown) {
    debugLog(`getHeadCommit: git rev-parse HEAD failed in ${cwd}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export function getRepoRoot(cwd: string): string | undefined {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: EXEC_TIMEOUT_QUICK_MS }).trim();
    return root || undefined;
  } catch (err: unknown) {
    debugLog(`getRepoRoot: not a git repo or git unavailable in ${cwd}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export function inferCitationLocation(repoPath: string, commit: string): { file?: string; line?: number } {
  try {
    const raw = execFileSync(
      "git",
      ["show", "--pretty=format:", "--unified=0", "--no-color", commit],
      { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: EXEC_TIMEOUT_MS }
    );
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
    debugLog(`citationLocationFromCommit: git show failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {};
}

export function buildCitationComment(citation: FindingCitation): string {
  return `<!-- cortex:cite ${JSON.stringify(citation)} -->`;
}

export function parseCitationComment(line: string): FindingCitation | null {
  const match = line.match(/<!--\s*cortex:cite\s+(\{.*\})\s*-->/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
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
    };
  } catch (err: unknown) {
    debugLog(`parseCitationComment: malformed citation JSON: ${err instanceof Error ? err.message : String(err)}`);
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

export function clearCitationCaches(): void {
  commitExistsCache.clear();
  blameCache.clear();
}

function commitExists(repoPath: string, commit: string): boolean {
  const key = `${repoPath}\0${commit}`;
  const cached = commitExistsCache.get(key);
  if (cached !== undefined) return cached;
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
      cwd: repoPath,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    });
    commitExistsCache.set(key, true);
    return true;
  } catch (err: unknown) {
    debugLog(`commitExists: commit ${commit} not found in ${repoPath}: ${err instanceof Error ? err.message : String(err)}`);
    commitExistsCache.set(key, false);
    return false;
  }
}

function cachedBlame(repoPath: string, relFile: string, line: number): string | false {
  const key = `${repoPath}\0${relFile}\0${line}`;
  const cached = blameCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const out = execFileSync(
      "git",
      ["blame", "-L", `${line},${line}`, "--porcelain", relFile],
      { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }
    ).trim();
    const first = out.split("\n")[0] || "";
    blameCache.set(key, first);
    return first;
  } catch (err: unknown) {
    debugLog(`cachedBlame: git blame failed for ${relFile}:${line}: ${err instanceof Error ? err.message : String(err)}`);
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

    if (line.includes("<details>")) {
      inDetails = true;
      continue;
    }
    if (line.includes("</details>")) {
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

    const stale = currentDate ? isDateStale(currentDate, ttlDays) : false;
    if (stale) {
      issues.push({ date: currentDate || "unknown", bullet: line, reason: "stale" });
      continue;
    }

    let confidence = 1;
    if (currentDate) {
      const age = ageDaysForDate(currentDate);
      if (age !== null) confidence *= confidenceForAge(age, decay);
    }

    const next = lines[i + 1] ?? "";
    const citation = parseCitationComment(next);
    if (citation && !validateFindingCitation(citation)) {
      issues.push({ date: currentDate || "unknown", bullet: line, reason: "invalid_citation" });
      continue;
    }
    if (!citation) confidence *= 0.8;
    if (confidence < minConfidence) {
      issues.push({ date: currentDate || "unknown", bullet: line, reason: "stale" });
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
