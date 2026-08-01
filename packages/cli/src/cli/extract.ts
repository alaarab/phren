import {
  debugLog,
  appendAuditLog,
  atomicWriteText,
  EXEC_TIMEOUT_MS,
  getPhrenPath,
  runtimeDir,
  runtimeFile,
} from "../shared.js";
import {
  appendReviewQueue,
  getRetentionPolicy,
  recordFeedback,
  flushEntryScores,
  entryScoreKey,
} from "../shared/governance.js";
import { detectProject } from "../shared/index.js";
import { commandExists } from "../hooks.js";
import { runGit as runGitShared, isFeatureEnabled, clampInt, errorMessage, isValidProjectName, resolveExecCommand, safeProjectPath } from "../utils.js";
import { appendFindingJournal, compactFindingJournals } from "../finding/journal.js";
import { findingQualityReason } from "../content/quality.js";
import { FINDINGS_FILENAME } from "../data/access.js";
import { getProactivityLevelForTask, getProactivityLevelForFindings, shouldAutoCaptureFindingsForLevel } from "../proactivity.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { resolveRuntimeProfile } from "../runtime-profile.js";
import type { FindingProvenanceSource } from "../content/citation.js";

function runGit(cwd: string, args: string[]): string | null {
  return runGitShared(cwd, args, EXEC_TIMEOUT_MS, debugLog);
}

function shouldRetryGh(err: unknown): boolean {
  const message = err instanceof Error
    ? err.message
    : (typeof err === "object" && err !== null && "message" in err && typeof (err as { message: unknown }).message === "string")
      ? (err as { message: string }).message
      : String(err ?? "");
  const msg = String(message);
  return /(rate limit|secondary rate limit|timed out|ecconn|network|502|503|504|bad gateway|service unavailable)/i.test(msg);
}

function inferProject(arg?: string): string | null {
  if (arg) return arg;
  return detectProject(getPhrenPath(), process.cwd(), resolveRuntimeProfile(getPhrenPath()));
}

// ── Git log parsing ──────────────────────────────────────────────────────────

export function parseGitLogRecords(cwd: string, days: number): Array<{ hash: string; subject: string; body: string }> {
  const fmt = "%H%x1f%s%x1f%b%x1e";
  const raw = runGit(cwd, ["log", `--since=${days} days ago`, "--first-parent", `--pretty=format:${fmt}`]) || "";
  const records: Array<{ hash: string; subject: string; body: string }> = [];
  for (const rec of raw.split("\x1e")) {
    const trimmed = rec.trim();
    if (!trimmed) continue;
    const [hash, subject, body] = trimmed.split("\x1f");
    if (!hash || !subject) continue;
    records.push({ hash, subject, body: body || "" });
  }
  return records;
}

// ── GitHub mining ────────────────────────────────────────────────────────────

interface GhPr {
  number: number;
  title: string;
  body?: string;
  mergeCommit?: { oid?: string };
  files?: Array<{ path?: string }>;
  comments?: Array<{ body?: string }>;
  reviews?: Array<{ body?: string; state?: string }>;
}

interface GhRun {
  databaseId?: number;
  displayTitle?: string;
  workflowName?: string;
  headSha?: string;
}

interface GhIssue {
  number: number;
  title: string;
  body?: string;
}

interface Candidate {
  text: string;
  score: number;
  commit?: string;
  file?: string;
  sourceText?: string;
}

export async function runGhJson<T>(cwd: string, args: string[]): Promise<T | null> {
  if (!commandExists("gh")) return null;
  const retries = clampInt((process.env.PHREN_GH_RETRIES), 2, 0, 5);
  const timeoutMs = clampInt((process.env.PHREN_GH_TIMEOUT_MS), 10000, 1000, 60000);
  const ghExec = resolveExecCommand("gh");
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const out = execFileSync(ghExec.command, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        shell: ghExec.shell,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      }).trim();
      if (!out) return null;
      return JSON.parse(out) as T;
    } catch (err) {
      if (attempt >= retries || !shouldRetryGh(err)) return null;
      const backoffMs = 750 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  return null;
}

export function ghCachePath(repoRoot: string): string {
  const absPath = path.resolve(repoRoot);
  const repoHash = crypto.createHash("sha1").update(absPath).digest("hex").slice(0, 12);
  const dateKey = new Date().toISOString().slice(0, 10);
  return path.join(os.tmpdir(), `phren-gh-cache-${repoHash}-${dateKey}.json`);
}

const GH_CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export async function mineGithubCandidates(repoRoot: string): Promise<Candidate[]> {
  const cacheFile = ghCachePath(repoRoot);
  try {
    const stat = fs.statSync(cacheFile);
    if (Date.now() - stat.mtimeMs < GH_CACHE_MAX_AGE_MS) {
      return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Candidate[];
    }
  } catch (err: unknown) {
    debugLog(`mineGithubCandidates: cache read failed for ${cacheFile}: ${errorMessage(err)}`);
  }

  const candidates: Candidate[] = [];
  const prLimit = clampInt((process.env.PHREN_GH_PR_LIMIT), 40, 5, 200);
  const runLimit = clampInt((process.env.PHREN_GH_RUN_LIMIT), 25, 5, 200);
  const issueLimit = clampInt((process.env.PHREN_GH_ISSUE_LIMIT), 25, 5, 200);

  const prs = await runGhJson<GhPr[]>(repoRoot, [
    "pr",
    "list",
    "--state",
    "merged",
    "--limit",
    String(prLimit),
    "--json",
    "number,title,body,mergeCommit,files,comments,reviews",
  ]) || [];
  for (const pr of prs) {
    const text = `PR #${pr.number}: ${pr.title}`;
    const body = (pr.body || "").toLowerCase();
    const commentBlob = [
      ...(pr.comments || []).map((c) => c.body || ""),
      ...(pr.reviews || []).map((r) => r.body || ""),
    ].join("\n").toLowerCase();
    let score = 0.65;
    if (/(fix|workaround|must|avoid|regression|incident|root cause|migration)/.test(body)) score += 0.2;
    if (/(review|comment|nit|requested changes)/.test(body + "\n" + commentBlob)) score += 0.1;
    if (/(must|should|avoid|required|don't|do not)/.test(commentBlob)) score += 0.08;
    candidates.push({
      text,
      score: Math.min(0.98, score),
      commit: pr.mergeCommit?.oid,
      file: pr.files?.find((f) => f.path)?.path,
      sourceText: [pr.title, pr.body || "", commentBlob].filter(Boolean).join("\n"),
    });
  }

  const runs = await runGhJson<GhRun[]>(repoRoot, [
    "run",
    "list",
    "--status",
    "failure",
    "--limit",
    String(runLimit),
    "--json",
    "databaseId,displayTitle,workflowName,headSha",
  ]) || [];
  for (const run of runs) {
    const title = run.displayTitle || run.workflowName || "CI failure";
    const text = `CI failure pattern: ${title}`;
    candidates.push({
      text,
      score: 0.62,
      commit: run.headSha,
      sourceText: title,
    });
  }

  const issues = await runGhJson<GhIssue[]>(repoRoot, [
    "issue",
    "list",
    "--state",
    "all",
    "--limit",
    String(issueLimit),
    "--json",
    "number,title,body",
  ]) || [];
  for (const issue of issues) {
    const body = (issue.body || "").toLowerCase();
    if (!/(bug|regression|incident|outage|postmortem|fix)/.test(body) && !/(bug|regression|incident)/.test(issue.title.toLowerCase())) {
      continue;
    }
    const text = `Issue #${issue.number}: ${issue.title}`;
    candidates.push({ text, score: 0.58, sourceText: [issue.title, issue.body || ""].join("\n") });
  }

  try {
    fs.writeFileSync(cacheFile, JSON.stringify(candidates));
  } catch (err: unknown) {
    debugLog(`mineGithubCandidates: cache write failed for ${cacheFile}: ${errorMessage(err)}`);
  }

  return candidates;
}

// ── Memory candidate scoring ─────────────────────────────────────────────────

// Reject commit-message-style subjects that lack real insight.
// Matches patterns like "Fix typo", "Add tests", "Update README", etc.
const COMMIT_MSG_PREFIX = /^(fix|add|update|remove|delete|rename|move|bump|revert|merge|chore|refactor|style|docs|test|ci|build|release|wip)\b/i;

// Insight keywords that indicate the entry has learning value even if short.
const INSIGHT_KEYWORDS = /\b(workaround|must|avoid|regression|root cause|postmortem|incident|retry|timeout|pitfall|caveat|breaking|migration|order matters|race condition|deadlock|flaky)\b/i;

export function scoreFindingCandidate(subject: string, body: string): { score: number; text: string } | null {
  const s = `${subject}\n${body}`.toLowerCase();

  // Reject short commit-message-style entries unless they contain insight keywords
  const combined = `${subject} ${body}`.trim();
  if (combined.length < 50 && !INSIGHT_KEYWORDS.test(combined)) return null;
  if (COMMIT_MSG_PREFIX.test(subject.trim()) && !INSIGHT_KEYWORDS.test(combined)) return null;

  const mergedPr = /merge pull request #\d+/.test(s);
  const ci = /(ci|workflow|pipeline|flake|test fail|build fail)/.test(s);
  const review = /(review|requested changes|address comments|nit|follow-up)/.test(s);
  const learningSignal = INSIGHT_KEYWORDS.test(s);

  let score = 0.35;
  if (mergedPr) score += 0.2;
  if (ci) score += 0.2;
  if (review) score += 0.1;
  if (learningSignal) score += 0.25;
  if (subject.length > 20) score += 0.05;
  if (score < 0.5) return null;

  const cleaned = subject
    .replace(/^merge pull request #\d+\s*from\s+\S+\s*/i, "")
    .replace(/^fix:\s*/i, "")
    .trim();
  const text = cleaned ? cleaned[0].toUpperCase() + cleaned.slice(1) : subject;
  return { score: Math.min(score, 0.99), text };
}

// ── Extraction idempotency ───────────────────────────────────────────────────

// Every extracted candidate is rendered with a `(source commit <hash>)` marker. Without a
// dedup key on that hash, each sync run re-queued the same commits: one real store had 224
// review items from only 84 distinct hashes (twenty of them appended eight times each).
// appendReviewQueue's text dedup does not catch this because the rendered line drifts.
const SOURCE_COMMIT_MARKER = /\(source commit ([0-9a-f]{7,40})\)/i;

/** Cap on remembered commits per project so the state file cannot grow without bound. */
const PROCESSED_MEMORY_LIMIT = 5000;

const EXTRACT_STATE_SCHEMA_VERSION = 1;

interface ProcessedMemory {
  commits: Set<string>;
  subjects: Set<string>;
}

interface ExtractStateFile {
  schemaVersion?: number;
  commits?: unknown;
  subjects?: unknown;
}

function shortHash(hash: string): string {
  return hash.slice(0, 8).toLowerCase();
}

/**
 * Dedup key for the human-readable part of a candidate.
 *
 * Hash dedup alone is necessary but not sufficient: rebased history re-scrapes an identical
 * commit message under a new hash (observed pairs 0a918619/c55f38fa and 6b9a2ab9/9479d2ad),
 * so the same finding still arrives twice.
 */
export function extractSubjectKey(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(new RegExp(SOURCE_COMMIT_MARKER.source, "gi"), " ")
    .replace(/^\s*\[confidence\s+[\d.]+\]\s*/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function extractStateFile(phrenPath: string, project: string): string | null {
  if (!isValidProjectName(project)) return null;
  try {
    return runtimeFile(phrenPath, `extract-state-${project}.json`);
  } catch (err: unknown) {
    debugLog(`extract-memories: no extract state file for ${project}: ${errorMessage(err)}`);
    return null;
  }
}

function addMarkersFromContent(content: string, into: ProcessedMemory): void {
  const pattern = new RegExp(SOURCE_COMMIT_MARKER.source, "gi");
  for (const line of content.split("\n")) {
    const matches = [...line.matchAll(pattern)];
    if (!matches.length) continue;
    for (const match of matches) into.commits.add(shortHash(match[1]));
    // Only lines carrying a marker are extraction output; hand-written findings must not
    // suppress future extraction.
    const key = extractSubjectKey(line.replace(/^\s*-\s*(\[\d{4}-\d{2}-\d{2}\]\s*)?/, ""));
    if (key) into.subjects.add(key);
  }
}

function addMarkersFromFile(file: string, into: ProcessedMemory): void {
  try {
    if (!fs.existsSync(file)) return;
    addMarkersFromContent(fs.readFileSync(file, "utf8"), into);
  } catch (err: unknown) {
    debugLog(`extract-memories: unreadable ${file}: ${errorMessage(err)}`);
  }
}

function addMarkersFromJournal(file: string, into: ProcessedMemory): void {
  try {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: { text?: unknown; commit?: unknown };
      try {
        entry = JSON.parse(line) as { text?: unknown; commit?: unknown };
      } catch {
        continue; // A partially-written journal line is not worth failing extraction over.
      }
      if (typeof entry.commit === "string" && entry.commit) into.commits.add(shortHash(entry.commit));
      if (typeof entry.text !== "string") continue;
      addMarkersFromContent(entry.text, into);
    }
  } catch (err: unknown) {
    debugLog(`extract-memories: unreadable journal ${file}: ${errorMessage(err)}`);
  }
}

/**
 * Everything this project has already extracted: queued in review.md, promoted into
 * FINDINGS.md, still sitting in the finding journal, or recorded in the state file (which
 * also covers items a human has since approved or rejected out of review.md).
 */
function readProcessedMemory(phrenPath: string, project: string): ProcessedMemory {
  const memory: ProcessedMemory = { commits: new Set<string>(), subjects: new Set<string>() };
  const projectDir = safeProjectPath(phrenPath, project);
  if (!projectDir) return memory;
  addMarkersFromFile(path.join(projectDir, "review.md"), memory);
  addMarkersFromFile(path.join(projectDir, FINDINGS_FILENAME), memory);

  // Accepted candidates land in the journal first and only reach FINDINGS.md on the next
  // compaction, so the journal has to be read too or they come back on the very next run.
  const journalDir = path.join(runtimeDir(phrenPath), "finding-journal", project);
  try {
    if (fs.existsSync(journalDir)) {
      for (const entry of fs.readdirSync(journalDir)) {
        if (entry.endsWith(".jsonl")) addMarkersFromJournal(path.join(journalDir, entry), memory);
      }
    }
  } catch (err: unknown) {
    debugLog(`extract-memories: unreadable journal dir ${journalDir}: ${errorMessage(err)}`);
  }

  const stateFile = extractStateFile(phrenPath, project);
  if (stateFile) {
    try {
      if (fs.existsSync(stateFile)) {
        const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as ExtractStateFile;
        if (Array.isArray(parsed.commits)) {
          for (const c of parsed.commits) if (typeof c === "string") memory.commits.add(shortHash(c));
        }
        if (Array.isArray(parsed.subjects)) {
          for (const s of parsed.subjects) if (typeof s === "string" && s) memory.subjects.add(s);
        }
      }
    } catch (err: unknown) {
      debugLog(`extract-memories: unreadable extract state ${stateFile}: ${errorMessage(err)}`);
    }
  }
  return memory;
}

function writeProcessedMemory(phrenPath: string, project: string, memory: ProcessedMemory): void {
  const stateFile = extractStateFile(phrenPath, project);
  if (!stateFile) return;
  // Sets keep insertion order, so the tail holds the most recently seen entries.
  const trim = (values: Set<string>): string[] => [...values].slice(-PROCESSED_MEMORY_LIMIT);
  try {
    atomicWriteText(stateFile, JSON.stringify({
      schemaVersion: EXTRACT_STATE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      commits: trim(memory.commits),
      subjects: trim(memory.subjects),
    }) + "\n");
  } catch (err: unknown) {
    debugLog(`extract-memories: could not persist extract state for ${project}: ${errorMessage(err)}`);
  }
}

// ── handleExtractMemories ────────────────────────────────────────────────────

export async function handleExtractMemories(
  projectArg?: string,
  cwdArg?: string,
  silent: boolean = false,
  sessionId?: string,
  source: FindingProvenanceSource = "extract",
) {
  const project = inferProject(projectArg);
  if (!project) {
    if (!silent) console.error("Usage: phren extract-memories <project>");
    if (!silent) process.exit(1);
    return;
  }

  const repoRoot = runGit(cwdArg || process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (!repoRoot) {
    if (!silent) console.error("extract-memories must run from inside a git repository.");
    if (!silent) process.exit(1);
    return;
  }

  const findingsLevel = getProactivityLevelForFindings(getPhrenPath());
  const taskLevel = getProactivityLevelForTask(getPhrenPath());
  if (taskLevel !== "high") {
    debugLog(`extract-memories task proactivity=${taskLevel}`);
  }
  if (findingsLevel === "low") {
    appendAuditLog(getPhrenPath(), "extract_memories", `project=${project} skipped=proactivity_low`);
    if (!silent) console.log(`Skipped memory extraction for ${project}: findings proactivity is low.`);
    return;
  }

  const rawDays = Number.parseInt((process.env.PHREN_MEMORY_EXTRACT_WINDOW_DAYS) || "30", 10);
  const days = Number.isNaN(rawDays) ? 30 : Math.max(1, rawDays);
  const threshold = Number.parseFloat((process.env.PHREN_MEMORY_AUTO_ACCEPT) || String(getRetentionPolicy(getPhrenPath()).autoAcceptThreshold));
  const records = parseGitLogRecords(repoRoot, days);
  const ghCandidates = isFeatureEnabled("PHREN_FEATURE_GH_MINING", false)
    ? await mineGithubCandidates(repoRoot)
    : [];

  const processed = readProcessedMemory(getPhrenPath(), project);
  let accepted = 0;
  let queued = 0;
  let duplicates = 0;
  let rejected = 0;

  /** True when this commit/subject pair has already been extracted in an earlier run. */
  const alreadyExtracted = (commitKey: string, subjectKey: string): boolean =>
    (commitKey !== "" && processed.commits.has(commitKey)) || (subjectKey !== "" && processed.subjects.has(subjectKey));

  const remember = (commitKey: string, subjectKey: string): void => {
    if (commitKey) processed.commits.add(commitKey);
    if (subjectKey) processed.subjects.add(subjectKey);
  };

  for (const rec of records) {
    if (!shouldAutoCaptureFindingsForLevel(findingsLevel, rec.subject, rec.body)) continue;
    const candidate = scoreFindingCandidate(rec.subject, rec.body);
    if (!candidate) continue;
    const quality = findingQualityReason(candidate.text);
    if (quality) {
      debugLog(`extract-memories: rejected commit ${rec.hash.slice(0, 8)} (${quality}): ${candidate.text.slice(0, 80)}`);
      rejected++;
      continue;
    }
    const commitKey = shortHash(rec.hash);
    const subjectKey = extractSubjectKey(candidate.text);
    if (alreadyExtracted(commitKey, subjectKey)) {
      duplicates++;
      continue;
    }
    remember(commitKey, subjectKey);
    const line = `${candidate.text} (source commit ${commitKey})`;
    if (candidate.score >= threshold) {
      appendFindingJournal(getPhrenPath(), project, line, {
        source,
        sessionId,
        repo: repoRoot,
        commit: rec.hash,
      });
      accepted++;
    } else {
      const qr1 = appendReviewQueue(getPhrenPath(), project, "Review", [`[confidence ${candidate.score.toFixed(2)}] ${line}`]);
      if (qr1.ok) queued += qr1.data;
    }
  }

  for (const c of ghCandidates) {
    if (!shouldAutoCaptureFindingsForLevel(findingsLevel, c.sourceText ?? c.text)) continue;
    const quality = findingQualityReason(c.text);
    if (quality) {
      debugLog(`extract-memories: rejected github candidate (${quality}): ${c.text.slice(0, 80)}`);
      rejected++;
      continue;
    }
    const commitKey = c.commit ? shortHash(c.commit) : "";
    const subjectKey = extractSubjectKey(c.text);
    if (alreadyExtracted(commitKey, subjectKey)) {
      duplicates++;
      continue;
    }
    remember(commitKey, subjectKey);
    const line = `${c.text}${commitKey ? ` (source commit ${commitKey})` : ""}`;
    if (c.text.startsWith("CI failure pattern:")) {
      const key = entryScoreKey(project, FINDINGS_FILENAME, line);
      recordFeedback(getPhrenPath(), key, "regression");
    }
    if (c.score >= threshold) {
      appendFindingJournal(getPhrenPath(), project, line, {
        source,
        sessionId,
        repo: repoRoot,
        commit: c.commit,
        file: c.file,
      });
      accepted++;
    } else {
      const qr2 = appendReviewQueue(getPhrenPath(), project, "Review", [`[confidence ${c.score.toFixed(2)}] ${line}`]);
      if (qr2.ok) queued += qr2.data;
    }
  }

  if (!silent) {
    const compacted = compactFindingJournals(getPhrenPath(), project);
    debugLog(`extract-memories compacted journals for ${project}: added=${compacted.added} skipped=${compacted.skipped} failed=${compacted.failed}`);
  }

  writeProcessedMemory(getPhrenPath(), project, processed);
  flushEntryScores(getPhrenPath());
  appendAuditLog(
    getPhrenPath(),
    "extract_memories",
    `project=${project} accepted=${accepted} queued=${queued} duplicates=${duplicates} rejected=${rejected} window_days=${days}`
  );
  if (!silent) {
    console.log(
      `Extracted memory candidates for ${project}: accepted=${accepted}, queued=${queued}, duplicates=${duplicates}, rejected=${rejected}, window=${days}d`
    );
  }
}
