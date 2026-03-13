import * as crypto from "crypto";
import * as fs from "fs";
import { impactLogFile } from "./shared.js";
import { withFileLock } from "./shared-governance.js";

export interface FindingImpactEntry {
  findingId: string;
  project: string;
  timestamp: string;
  sessionId: string;
  taskCompleted: boolean;
}

interface ParsedImpactSummary {
  surfaceCountByFinding: Map<string, number>;
  completedByFinding: Set<string>;
}

interface ImpactLogInput {
  findingId: string;
  project: string;
  sessionId: string;
}

let highImpactCache:
  | {
    file: string;
    mtimeMs: number;
    size: number;
    minSurfaceCount: number;
    ids: Set<string>;
  }
  | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeFindingText(raw: string): string {
  return raw
    .replace(/^-\s+/, "")
    .replace(/<!--.*?-->/g, " ")
    .replace(/\[confidence\s+[01](?:\.\d+)?\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function findingIdFromLine(line: string): string {
  const fid = line.match(/<!--\s*fid:([a-z0-9]{8})\s*-->/i);
  if (fid?.[1]) return `fid:${fid[1].toLowerCase()}`;
  const normalized = normalizeFindingText(line);
  if (!normalized) return "hash:empty";
  const hash = crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 12);
  return `hash:${hash}`;
}

export function extractFindingIdsFromSnippet(snippet: string): string[] {
  const lines = snippet
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const bulletLines = lines.filter((line) => line.startsWith("- "));
  const candidates = bulletLines.length > 0 ? bulletLines : (lines[0] ? [lines[0]] : []);
  const ids = new Set<string>();
  for (const line of candidates) {
    ids.add(findingIdFromLine(line));
  }
  return [...ids];
}

function parseImpactLine(line: string): FindingImpactEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<FindingImpactEntry>;
    if (
      !parsed
      || typeof parsed.findingId !== "string"
      || typeof parsed.project !== "string"
      || typeof parsed.timestamp !== "string"
      || typeof parsed.sessionId !== "string"
      || typeof parsed.taskCompleted !== "boolean"
    ) {
      return null;
    }
    return {
      findingId: parsed.findingId,
      project: parsed.project,
      timestamp: parsed.timestamp,
      sessionId: parsed.sessionId,
      taskCompleted: parsed.taskCompleted,
    };
  } catch {
    return null;
  }
}

function readImpactSummary(cortexPath: string): ParsedImpactSummary {
  const file = impactLogFile(cortexPath);
  const surfaceCountByFinding = new Map<string, number>();
  const completedByFinding = new Set<string>();

  if (!fs.existsSync(file)) {
    return {
      surfaceCountByFinding,
      completedByFinding,
    };
  }

  const content = fs.readFileSync(file, "utf8");
  for (const line of content.split("\n")) {
    const entry = parseImpactLine(line);
    if (!entry) continue;

    surfaceCountByFinding.set(entry.findingId, (surfaceCountByFinding.get(entry.findingId) ?? 0) + 1);
    if (entry.taskCompleted) {
      completedByFinding.add(entry.findingId);
    }
  }

  return {
    surfaceCountByFinding,
    completedByFinding,
  };
}

function appendImpact(cortexPath: string, entries: FindingImpactEntry[]): void {
  if (entries.length === 0) return;
  const file = impactLogFile(cortexPath);
  withFileLock(file, () => {
    const lines = entries.map((entry) => JSON.stringify(entry));
    fs.appendFileSync(file, lines.join("\n") + "\n");
  });
}

export function logImpact(cortexPath: string, entries: ImpactLogInput[]): void {
  if (entries.length === 0) return;
  const timestamp = nowIso();
  appendImpact(cortexPath, entries.map((entry) => ({
    findingId: entry.findingId,
    project: entry.project,
    sessionId: entry.sessionId,
    timestamp,
    taskCompleted: false,
  })));
}

export function getHighImpactFindings(cortexPath: string, minSurfaceCount = 3): Set<string> {
  const file = impactLogFile(cortexPath);
  let stat: fs.Stats | null = null;
  try {
    stat = fs.existsSync(file) ? fs.statSync(file) : null;
  } catch {
    stat = null;
  }

  if (!stat) return new Set<string>();
  if (
    highImpactCache
    && highImpactCache.file === file
    && highImpactCache.mtimeMs === stat.mtimeMs
    && highImpactCache.size === stat.size
    && highImpactCache.minSurfaceCount === minSurfaceCount
  ) {
    return new Set(highImpactCache.ids);
  }

  const summary = readImpactSummary(cortexPath);
  const ids = new Set<string>();
  for (const [findingId, surfaceCount] of summary.surfaceCountByFinding.entries()) {
    if (surfaceCount >= minSurfaceCount && summary.completedByFinding.has(findingId)) {
      ids.add(findingId);
    }
  }

  highImpactCache = {
    file,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    minSurfaceCount,
    ids,
  };
  return new Set(ids);
}

export function markImpactEntriesCompletedForSession(cortexPath: string, sessionId: string, project?: string): number {
  if (!sessionId) return 0;
  const file = impactLogFile(cortexPath);
  if (!fs.existsSync(file)) return 0;

  const updated = withFileLock(file, () => {
    if (!fs.existsSync(file)) return 0;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let updatedCount = 0;

    const rewritten = lines
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const entry = parseImpactLine(line);
        if (!entry) return line;
        if (entry.taskCompleted) return line;
        if (entry.sessionId !== sessionId) return line;
        if (project && entry.project !== project) return line;
        updatedCount += 1;
        return JSON.stringify({ ...entry, taskCompleted: true });
      });

    if (updatedCount > 0) {
      fs.writeFileSync(file, rewritten.join("\n") + "\n");
    }
    return updatedCount;
  });

  if (updated > 0) highImpactCache = null;
  return updated;
}
