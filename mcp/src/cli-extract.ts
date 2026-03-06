import {
  ensureCortexPath,
  detectProject,
  addLearningToFile,
  appendMemoryQueue,
  appendAuditLog,
  getMemoryPolicy,
  recordMemoryFeedback,
  flushMemoryScores,
  memoryScoreKey,
  EXEC_TIMEOUT_MS,
} from "./shared.js";
import { commandExists } from "./hooks.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

const cortexPath = ensureCortexPath();
const profile = process.env.CORTEX_PROFILE || "";

function isFeatureEnabled(envName: string, defaultValue: boolean = true): boolean {
  const raw = process.env[envName];
  if (!raw) return defaultValue;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: EXEC_TIMEOUT_MS }).trim();
  } catch {
    return null;
  }
}

function shouldRetryGh(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? "");
  return /(rate limit|secondary rate limit|timed out|ecconn|network|502|503|504|bad gateway|service unavailable)/i.test(msg);
}

function inferProject(arg?: string): string | null {
  if (arg) return arg;
  return detectProject(cortexPath, process.cwd(), profile);
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
}

export async function runGhJson<T>(cwd: string, args: string[]): Promise<T | null> {
  if (!commandExists("gh")) return null;
  const retries = clampInt(process.env.CORTEX_GH_RETRIES, 2, 0, 5);
  const timeoutMs = clampInt(process.env.CORTEX_GH_TIMEOUT_MS, 10000, 1000, 60000);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const out = execFileSync("gh", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
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
  const repoKey = path.basename(repoRoot).replace(/[^a-zA-Z0-9_-]/g, "_");
  const dateKey = new Date().toISOString().slice(0, 10);
  return path.join(os.tmpdir(), `cortex-gh-cache-${repoKey}-${dateKey}.json`);
}

const GH_CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export async function mineGithubCandidates(repoRoot: string): Promise<Candidate[]> {
  const cacheFile = ghCachePath(repoRoot);
  try {
    const stat = fs.statSync(cacheFile);
    if (Date.now() - stat.mtimeMs < GH_CACHE_MAX_AGE_MS) {
      return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Candidate[];
    }
  } catch {}

  const candidates: Candidate[] = [];
  const prLimit = clampInt(process.env.CORTEX_GH_PR_LIMIT, 40, 5, 200);
  const runLimit = clampInt(process.env.CORTEX_GH_RUN_LIMIT, 25, 5, 200);
  const issueLimit = clampInt(process.env.CORTEX_GH_ISSUE_LIMIT, 25, 5, 200);

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
    candidates.push({ text, score: 0.58 });
  }

  try {
    fs.writeFileSync(cacheFile, JSON.stringify(candidates));
  } catch {}

  return candidates;
}

// ── Memory candidate scoring ─────────────────────────────────────────────────

export function scoreMemoryCandidate(subject: string, body: string): { score: number; text: string } | null {
  const s = `${subject}\n${body}`.toLowerCase();
  const mergedPr = /merge pull request #\d+/.test(s);
  const ci = /(ci|workflow|pipeline|flake|test fail|build fail)/.test(s);
  const review = /(review|requested changes|address comments|nit|follow-up)/.test(s);
  const learningSignal = /(fix|workaround|must|avoid|regression|root cause|postmortem|incident|retry|timeout)/.test(s);

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

// ── handleExtractMemories ────────────────────────────────────────────────────

export async function handleExtractMemories(projectArg?: string, cwdArg?: string, silent: boolean = false) {
  const project = inferProject(projectArg);
  if (!project) {
    if (!silent) console.error("Usage: cortex extract-memories <project>");
    if (!silent) process.exit(1);
    return;
  }

  const repoRoot = runGit(cwdArg || process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (!repoRoot) {
    if (!silent) console.error("extract-memories must run from inside a git repository.");
    if (!silent) process.exit(1);
    return;
  }

  const days = Number.parseInt(process.env.CORTEX_MEMORY_EXTRACT_WINDOW_DAYS || "30", 10);
  const threshold = Number.parseFloat(process.env.CORTEX_MEMORY_AUTO_ACCEPT || String(getMemoryPolicy(cortexPath).autoAcceptThreshold));
  const records = parseGitLogRecords(repoRoot, Number.isNaN(days) ? 30 : days);
  const ghCandidates = isFeatureEnabled("CORTEX_FEATURE_GH_MINING", false)
    ? await mineGithubCandidates(repoRoot)
    : [];

  let accepted = 0;
  let queued = 0;
  for (const rec of records) {
    const candidate = scoreMemoryCandidate(rec.subject, rec.body);
    if (!candidate) continue;
    const line = `${candidate.text} (source commit ${rec.hash.slice(0, 8)})`;
    if (candidate.score >= threshold) {
      addLearningToFile(cortexPath, project, line, {
        repo: repoRoot,
        commit: rec.hash,
      });
      accepted++;
    } else {
      queued += appendMemoryQueue(cortexPath, project, "Review", [`[confidence ${candidate.score.toFixed(2)}] ${line}`]);
    }
  }

  for (const c of ghCandidates) {
    const line = `${c.text}${c.commit ? ` (source commit ${c.commit.slice(0, 8)})` : ""}`;
    if (c.text.startsWith("CI failure pattern:")) {
      const key = memoryScoreKey(project, "LEARNINGS.md", line);
      recordMemoryFeedback(cortexPath, key, "regression");
    }
    if (c.score >= threshold) {
      addLearningToFile(cortexPath, project, line, {
        repo: repoRoot,
        commit: c.commit,
        file: c.file,
      });
      accepted++;
    } else {
      queued += appendMemoryQueue(cortexPath, project, "Review", [`[confidence ${c.score.toFixed(2)}] ${line}`]);
    }
  }

  flushMemoryScores(cortexPath);
  appendAuditLog(cortexPath, "extract_memories", `project=${project} accepted=${accepted} queued=${queued} window_days=${days}`);
  if (!silent) console.log(`Extracted memory candidates for ${project}: accepted=${accepted}, queued=${queued}, window=${days}d`);
}
