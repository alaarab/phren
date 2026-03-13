import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { runtimeDir, CortexResult, cortexOk, cortexErr, CortexError } from "./shared.js";
import { withFileLock } from "./shared-governance.js";
import { addFindingToFile } from "./shared-content.js";
import { isValidProjectName, errorMessage } from "./utils.js";
import type { FindingProvenanceSource } from "./content-citation.js";

export interface FindingJournalEntry {
  at: string;
  project: string;
  text: string;
  source?: FindingProvenanceSource;
  sessionId?: string;
  repo?: string;
  commit?: string;
  file?: string;
}

export interface FindingJournalCompactResult {
  filesProcessed: number;
  entriesProcessed: number;
  added: number;
  skipped: number;
  failed: number;
}

function journalRoot(cortexPath: string): string {
  const dir = path.join(runtimeDir(cortexPath), "finding-journal");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeSessionId(sessionId?: string): string {
  const raw = (sessionId || `session-${new Date().toISOString().slice(0, 10)}`).trim();
  const safe = raw.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "session";
}

function journalFileFor(cortexPath: string, project: string, sessionId?: string): string {
  const projectDir = path.join(journalRoot(cortexPath), project);
  fs.mkdirSync(projectDir, { recursive: true });
  return path.join(projectDir, `${sanitizeSessionId(sessionId)}.jsonl`);
}

function listJournalFiles(cortexPath: string, project?: string): string[] {
  const root = journalRoot(cortexPath);
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
  cortexPath: string,
  project: string,
  text: string,
  opts: { sessionId?: string; repo?: string; commit?: string; file?: string; source?: FindingProvenanceSource } = {}
): CortexResult<string> {
  if (!isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const filePath = journalFileFor(cortexPath, project, opts.sessionId);
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
    return cortexOk(filePath);
  } catch (err: unknown) {
    return cortexErr(`Failed to append finding journal: ${errorMessage(err)}`, CortexError.PERMISSION_DENIED);
  }
}

export function compactFindingJournals(cortexPath: string, project?: string): FindingJournalCompactResult {
  const result: FindingJournalCompactResult = {
    filesProcessed: 0,
    entriesProcessed: 0,
    added: 0,
    skipped: 0,
    failed: 0,
  };

  for (const filePath of listJournalFiles(cortexPath, project)) {
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
        const write = addFindingToFile(cortexPath, entry.project, entry.text, {
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
        if (typeof write.data === "string" && write.data.includes("Skipped duplicate")) result.skipped += 1;
        else result.added += 1;
      }
    } finally {
      try { fs.unlinkSync(claimed); } catch {}
    }
  }

  return result;
}
