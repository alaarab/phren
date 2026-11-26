import * as fs from "fs";
import * as path from "path";
import { parseFindingsContent, readReviewQueue, type FindingItem } from "../data/access.js";
import { readTasks } from "../data/tasks.js";
import { isCitationLine, normalizeFindingText } from "../content/metadata.js";
import { listTopicFiles, NOW_START, NOW_END } from "../content/summarize.js";
import { getMachineName } from "../machine-identity.js";
import { atomicWriteText, runtimeDir } from "../phren-paths.js";
import { readRecallTrace, recallTraceFile } from "../recall/trace.js";
import { getStoreProjectDirs, resolveAllStores } from "../store-registry.js";
import { withFileLock } from "./locks.js";

export interface StoreHealthCounts {
  activeFindings: number;
  archivedBullets: number;
  olderBullets: number;
  retiredBullets: number;
  contradictedBullets: number;
  bulletsWithoutFid: number;
  duplicateFids: number;
  duplicateTexts: number;
  citations: { none: number; timestampOnly: number; withFile: number; withCommit: number; withSymbol: number };
  openTasks: number;
  doneTasks: number;
  reviewEntries: number;
}

export interface StoreHealthRecall {
  prompts: number;
  injected: number;
  abstained: number;
  skipped: number;
  suppressedRepeats: number;
  byAbstainReason: Record<string, number>;
}

export interface StoreHealth {
  at: string;
  computer: string;
  stores: Array<{
    name: string;
    path: string;
    projects: Array<StoreHealthCounts & { project: string }>;
    totals: StoreHealthCounts;
  }>;
  runtimeBytes: Record<string, number>;
  recall: StoreHealthRecall | null;
}

function emptyCounts(): StoreHealthCounts {
  return {
    activeFindings: 0, archivedBullets: 0, olderBullets: 0,
    retiredBullets: 0, contradictedBullets: 0, bulletsWithoutFid: 0,
    duplicateFids: 0, duplicateTexts: 0,
    citations: { none: 0, timestampOnly: 0, withFile: 0, withCommit: 0, withSymbol: 0 },
    openTasks: 0, doneTasks: 0, reviewEntries: 0,
  };
}

function parseBullets(content: string): FindingItem[] {
  let inNow = false;
  const lines = content.split("\n").map(line => {
    if (line.startsWith(NOW_START)) { inNow = true; return ""; }
    if (line.startsWith(NOW_END)) { inNow = false; return ""; }
    return !inNow && (line.startsWith("- ") || isCitationLine(line)) ? line : "";
  });
  return parseFindingsContent(lines.join("\n"), { includeArchived: true });
}

function projectHealth(storePath: string, project: string): StoreHealthCounts & { project: string } {
  const counts = { project, ...emptyCounts() };
  const findingsPath = path.join(storePath, project, "FINDINGS.md");
  const active = fs.existsSync(findingsPath) ? parseBullets(fs.readFileSync(findingsPath, "utf8")) : [];
  const topics = listTopicFiles(storePath, project);
  const archived = topics.flatMap(topic => parseBullets(fs.readFileSync(topic.file, "utf8")));
  const topicsDir = path.join(storePath, project, "reference", "topics");
  const older = fs.existsSync(topicsDir)
    ? fs.readdirSync(topicsDir).filter(name => name.endsWith(".older.md")).sort()
      .flatMap(name => parseBullets(fs.readFileSync(path.join(topicsDir, name), "utf8")))
    : [];
  counts.activeFindings = active.length;
  counts.archivedBullets = archived.length;
  counts.olderBullets = older.length;
  const fids = new Set<string>();
  const texts = new Set<string>();
  for (const bullet of [...active, ...archived, ...older]) {
    if (bullet.status === "superseded" || bullet.status === "retracted") counts.retiredBullets++;
    if (bullet.status === "contradicted") counts.contradictedBullets++;
    if (!bullet.stableId) counts.bulletsWithoutFid++;
    else if (fids.has(bullet.stableId)) counts.duplicateFids++;
    else fids.add(bullet.stableId);
    const text = normalizeFindingText(bullet.text);
    if (texts.has(text)) counts.duplicateTexts++;
    else texts.add(text);
    const citation = bullet.citationData;
    if (!citation) counts.citations.none++;
    else {
      if (citation.file) counts.citations.withFile++;
      if (citation.commit) counts.citations.withCommit++;
      if (citation.symbol) counts.citations.withSymbol++;
      if (!citation.file && !citation.commit && !citation.symbol) counts.citations.timestampOnly++;
    }
  }
  const tasks = readTasks(storePath, project);
  if (tasks.ok) {
    counts.openTasks = tasks.data.items.Active.length + tasks.data.items.Queue.length;
    counts.doneTasks = tasks.data.items.Done.length;
  }
  const review = readReviewQueue(storePath, project);
  if (review.ok) counts.reviewEntries = review.data.length;
  return counts;
}

function bytes(file: string): number {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile()) return stat.size;
    if (stat.isDirectory()) return fs.readdirSync(file).reduce((sum, name) => sum + bytes(path.join(file, name)), 0);
    return 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

function recallHealth(phrenPath: string, now: Date): StoreHealthRecall | null {
  if (!fs.existsSync(recallTraceFile(phrenPath))) return null;
  const counts: StoreHealthRecall = { prompts: 0, injected: 0, abstained: 0, skipped: 0, suppressedRepeats: 0, byAbstainReason: {} };
  const reasons = new Map<string, number>();
  for (const entry of readRecallTrace(phrenPath)) {
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at) || at < now.getTime() - 86_400_000 || at > now.getTime()) continue;
    counts.prompts++;
    // Injected counts prompts that received memory.
    if (Array.isArray(entry.injected) && entry.injected.length > 0) counts.injected++;
    if (typeof entry.skipped === "string" && entry.skipped) counts.skipped++;
    if (typeof entry.abstained === "string" && entry.abstained) {
      counts.abstained++;
      reasons.set(entry.abstained, (reasons.get(entry.abstained) ?? 0) + 1);
    }
    if (typeof entry.suppressedRepeats === "number" && Number.isFinite(entry.suppressedRepeats) && entry.suppressedRepeats > 0) {
      counts.suppressedRepeats += entry.suppressedRepeats;
    }
  }
  counts.byAbstainReason = Object.fromEntries(reasons);
  return counts;
}

// Read-only: duplicate counts are extra occurrences within a project, across all tiers.
export function collectStoreHealth(phrenPath: string, now = new Date(), computer = getMachineName()): StoreHealth {
  const stores = resolveAllStores(phrenPath, { migrateAttachments: false }).map(entry => {
    const store = entry.role === "primary" ? { ...entry, path: phrenPath } : entry;
    const projects = getStoreProjectDirs(store).sort().map(dir => projectHealth(store.path, path.basename(dir)));
    const totals = emptyCounts();
    for (const project of projects) {
      for (const key of Object.keys(totals) as Array<keyof StoreHealthCounts>) {
        if (key === "citations") {
          for (const kind of Object.keys(totals.citations) as Array<keyof StoreHealthCounts["citations"]>) totals.citations[kind] += project.citations[kind];
        } else totals[key] += project[key];
      }
    }
    return { name: store.name, path: path.relative(phrenPath, store.path).split(path.sep).join("/") || ".", projects, totals };
  });
  const runtime = runtimeDir(phrenPath);
  const runtimeBytes = Object.fromEntries(fs.existsSync(runtime)
    ? fs.readdirSync(runtime).sort().map(name => [name, bytes(path.join(runtime, name))])
    : []);
  return { at: now.toISOString(), computer, stores, runtimeBytes, recall: recallHealth(phrenPath, now) };
}

export function recordStoreHealth(phrenPath: string, now = new Date(), computer = getMachineName()): boolean {
  const file = path.join(runtimeDir(phrenPath), "store-health.jsonl");
  return withFileLock(file, () => {
    const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(line => line.trim()) : [];
    const today = now.toDateString();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.at === "string" && new Date(entry.at).toDateString() === today) return false;
      } catch { /* a torn line does not prevent the next daily sample */ }
    }
    const entry = collectStoreHealth(phrenPath, now, computer);
    atomicWriteText(file, [...lines.slice(-399), JSON.stringify(entry)].join("\n") + "\n");
    return true;
  });
}
