import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { runtimeDir, PhrenResult, phrenOk, phrenErr, PhrenError, atomicWriteText } from "../shared.js";
import { withFileLock } from "../shared/governance.js";
import { addFindingToFile } from "../shared/content.js";
import { isValidProjectName, errorMessage } from "../utils.js";
import type { FindingProvenanceSource } from "../content/citation.js";
import { FINDINGS_FILENAME } from "../data/access.js";

interface FindingJournalEntry {
  at: string;
  project: string;
  text: string;
  source?: FindingProvenanceSource;
  sessionId?: string;
  repo?: string;
  commit?: string;
  file?: string;
}

interface FindingJournalCompactResult {
  filesProcessed: number;
  entriesProcessed: number;
  added: number;
  skipped: number;
  failed: number;
}

function journalRoot(phrenPath: string): string {
  const dir = path.join(runtimeDir(phrenPath), "finding-journal");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeSessionId(sessionId?: string): string {
  const raw = (sessionId || `session-${new Date().toISOString().slice(0, 10)}`).trim();
  const safe = raw.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "session";
}

function journalFileFor(phrenPath: string, project: string, sessionId?: string): string {
  const projectDir = path.join(journalRoot(phrenPath), project);
  fs.mkdirSync(projectDir, { recursive: true });
  return path.join(projectDir, `${sanitizeSessionId(sessionId)}.jsonl`);
}

function listJournalFiles(phrenPath: string, project?: string): string[] {
  const root = journalRoot(phrenPath);
  const projects = project ? [project] : fs.readdirSync(root).filter((entry) => fs.statSync(path.join(root, entry)).isDirectory());
  const files: string[] = [];
  for (const projectName of projects) {
    const projectDir = path.join(root, projectName);
    if (!fs.existsSync(projectDir)) continue;
    for (const entry of fs.readdirSync(projectDir)) {
      if (!entry.endsWith(".jsonl")) continue;
      files.push(path.join(projectDir, entry));
    }
  }
  return files.sort();
}

export function appendFindingJournal(
  phrenPath: string,
  project: string,
  text: string,
  opts: { sessionId?: string; repo?: string; commit?: string; file?: string; source?: FindingProvenanceSource } = {}
): PhrenResult<string> {
  if (!isValidProjectName(project)) return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
  const filePath = journalFileFor(phrenPath, project, opts.sessionId);
  const entry: FindingJournalEntry = {
    at: new Date().toISOString(),
    project,
    text,
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.repo ? { repo: opts.repo } : {}),
    ...(opts.commit ? { commit: opts.commit } : {}),
    ...(opts.file ? { file: opts.file } : {}),
  };
  try {
    withFileLock(filePath, () => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(entry) + "\n");
    });
    return phrenOk(filePath);
  } catch (err: unknown) {
    return phrenErr(`Failed to append finding journal: ${errorMessage(err)}`, PhrenError.PERMISSION_DENIED);
  }
}

export function compactFindingJournals(phrenPath: string, project?: string): FindingJournalCompactResult {
  const result: FindingJournalCompactResult = {
    filesProcessed: 0,
    entriesProcessed: 0,
    added: 0,
    skipped: 0,
    failed: 0,
  };

  for (const filePath of listJournalFiles(phrenPath, project)) {
    const claimed = `${filePath}.${crypto.randomUUID()}.claim`;
    try {
      fs.renameSync(filePath, claimed);
    } catch {
      continue;
    }

    result.filesProcessed += 1;
    try {
      const entries = fs.readFileSync(claimed, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line) as FindingJournalEntry; } catch { return null; }
        })
        .filter((entry): entry is FindingJournalEntry => Boolean(entry && entry.project && entry.text));

      for (const entry of entries) {
        result.entriesProcessed += 1;
        const write = addFindingToFile(phrenPath, entry.project, entry.text, {
          ...(entry.repo ? { repo: entry.repo } : {}),
          ...(entry.commit ? { commit: entry.commit } : {}),
          ...(entry.file ? { file: entry.file } : {}),
        }, {
          source: entry.source,
          sessionId: entry.sessionId,
        });
        if (!write.ok) {
          result.failed += 1;
          continue;
        }
        if (write.data.status === "skipped") result.skipped += 1;
        else result.added += 1;
      }
    } finally {
      try { fs.unlinkSync(claimed); } catch {}
    }
  }

  return result;
}

// ── Team store journal (append-only markdown, committed to git) ──────────────

const TEAM_JOURNAL_DIR = "journal";

/**
 * Append a finding to a team store's journal.
 * Each actor gets one file per day — no merge conflicts possible.
 * These are markdown files committed to git (not runtime JSONL).
 */
export function appendTeamJournal(
  storePath: string,
  project: string,
  finding: string,
  actor?: string,
): PhrenResult<string> {
  const resolvedActor = actor || process.env.PHREN_ACTOR || process.env.USER || "unknown";
  const date = new Date().toISOString().slice(0, 10);
  const journalDir = path.join(storePath, project, TEAM_JOURNAL_DIR);
  const journalFile = `${date}-${resolvedActor}.md`;
  const journalPath = path.join(journalDir, journalFile);

  try {
    fs.mkdirSync(journalDir, { recursive: true });
    const entry = `- ${finding}\n`;
    if (fs.existsSync(journalPath)) {
      fs.appendFileSync(journalPath, entry);
    } else {
      fs.writeFileSync(journalPath, `## ${date} (${resolvedActor})\n\n${entry}`);
    }
    return phrenOk(journalFile);
  } catch (err: unknown) {
    return phrenErr(`Team journal append failed: ${errorMessage(err)}`, PhrenError.PERMISSION_DENIED);
  }
}

/**
 * Read all team journal entries for a project, newest first.
 */
export function readTeamJournalEntries(
  storePath: string,
  project: string,
): Array<{ file: string; date: string; actor: string; entries: string[] }> {
  const journalDir = path.join(storePath, project, TEAM_JOURNAL_DIR);
  if (!fs.existsSync(journalDir)) return [];

  return fs.readdirSync(journalDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .map((file) => {
      const match = file.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
      const date = match?.[1] ?? "unknown";
      const actor = match?.[2] ?? "unknown";
      const content = fs.readFileSync(path.join(journalDir, file), "utf8");
      const entries = content.split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2).trim());
      return { file, date, actor, entries };
    });
}

/**
 * Materialize FINDINGS.md from team journal entries.
 * Groups by date, includes actor attribution.
 */
export function materializeTeamFindings(
  storePath: string,
  project: string,
): PhrenResult<{ entryCount: number }> {
  const journalEntries = readTeamJournalEntries(storePath, project);
  if (journalEntries.length === 0) {
    return phrenErr("No journal entries found", PhrenError.FILE_NOT_FOUND);
  }

  // Group by date, chronological order
  const byDate = new Map<string, Array<{ actor: string; entries: string[] }>>();
  for (const entry of [...journalEntries].reverse()) {
    if (!byDate.has(entry.date)) byDate.set(entry.date, []);
    byDate.get(entry.date)!.push({ actor: entry.actor, entries: entry.entries });
  }

  const lines: string[] = [`# ${project} findings\n`];
  let count = 0;
  for (const [date, actors] of byDate) {
    lines.push(`## ${date}`);
    for (const { actor, entries } of actors) {
      for (const entry of entries) {
        lines.push(`- ${entry} <!-- author:${actor} -->`);
        count++;
      }
    }
    lines.push("");
  }

  const findingsPath = path.join(storePath, project, FINDINGS_FILENAME);
  try {
    atomicWriteText(findingsPath, lines.join("\n"));
    return phrenOk({ entryCount: count });
  } catch (err: unknown) {
    return phrenErr(`Materialize failed: ${errorMessage(err)}`, PhrenError.PERMISSION_DENIED);
  }
}
