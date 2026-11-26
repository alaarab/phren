import * as fs from "fs";
import { createRequire } from "module";
import * as path from "path";
import { parseFindingsContent, readReviewQueue, type FindingItem } from "../data/access.js";
import { readTasks } from "../data/tasks.js";
import { isCitationLine, normalizeFindingText } from "../content/metadata.js";
import { parseCitationComment } from "../content/citation.js";
import { citationStateKey, readCitationStates, type CitationStates } from "../content/citation-states.js";
import { listTopicFiles, NOW_START, NOW_END } from "../content/summarize.js";
import { getMachineName } from "../machine-identity.js";
import { atomicWriteText, debugLog, runtimeDir } from "../phren-paths.js";
import { readRecallTrace, recallTraceFile } from "../recall/trace.js";
import { getStoreProjectDirs, resolveAllStores } from "../store-registry.js";
import { errorMessage, isValidProjectName } from "../utils.js";
import { withFileLock } from "./locks.js";
import { getRetentionPolicy, readRuntimeAgeOutState, RUNTIME_AGE_OUT_STATE, runtimeAgeOutActive, type StoreBudgets } from "./policy.js";

export interface StoreHealthCounts {
  activeFindings: number;
  archivedBullets: number;
  olderBullets: number;
  retiredBullets: number;
  contradictedBullets: number;
  bulletsWithoutFid: number;
  duplicateFids: number;
  duplicateTexts: number;
  citations: { none: number; timestampOnly: number; withFile: number; withCommit: number; withSymbol: number; withRemote: number };
  /**
   * Active findings whose citation this computer last checked to valid, drifted or broken (the daily
   * sweep's `.runtime/citation-states.json`), and of those the ones that name a file.
   */
  checkableCitations: { any: number; withFile: number };
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
  /** Prompts that filed no task because their project was over its open-task budget. */
  taskCapturePaused: number;
  byAbstainReason: Record<string, number>;
}

/** What `.runtime` holds, by kind: the first two are regenerable and the only ones age-out may remove. */
export type RuntimeClass = "codeIndexes" | "fanoutArchive" | "fanouts" | "sessions" | "packages" | "logs" | "other";

export interface OverBudget {
  component: "openTasks" | "reviewEntries" | "runtimeBytes" | "fanoutArchiveBytes";
  store?: string;
  project?: string;
  value: number;
  budget: number;
  /** What the budget stops while the component is over it. */
  effect: string;
}

type AgeOutCounts = Record<"codeIndexes" | "fanoutArchive", { count: number; bytes: number }>;

export interface RuntimeAgeOut {
  enabled: boolean;
  days: number;
  /** Days since this computer first saw age-out on (null while off); it acts from 7. */
  enabledDays: number | null;
  /** Earlier daily lines that reported runtime classes; it acts from 7. */
  reportLines: number;
  acted: boolean;
  /** What age-out removes, or would remove, today. */
  candidates: AgeOutCounts;
}

export interface StoreHealth {
  at: string;
  computer: string;
  stores: Array<{
    name: string;
    path: string;
    projects: Array<StoreHealthCounts & { project: string }>;
    totals: StoreHealthCounts;
    /** Share of the store's active findings whose citation is checkable on this computer, to three places. */
    citationCoverage: number;
  }>;
  runtimeBytes: Record<string, number>;
  runtimeClasses: Record<RuntimeClass, number>;
  budgets: { over: OverBudget[] };
  recall: StoreHealthRecall | null;
  /** Set by the daily record, not by a plain collection. */
  runtimeAgeOut?: RuntimeAgeOut;
}

function emptyCounts(): StoreHealthCounts {
  return {
    activeFindings: 0, archivedBullets: 0, olderBullets: 0,
    retiredBullets: 0, contradictedBullets: 0, bulletsWithoutFid: 0,
    duplicateFids: 0, duplicateTexts: 0,
    citations: { none: 0, timestampOnly: 0, withFile: 0, withCommit: 0, withSymbol: 0, withRemote: 0 },
    checkableCitations: { any: 0, withFile: 0 },
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

// Active bullets whose recorded citation state is decided here; a bare timestamp is never swept, so never counts.
function checkableCitations(findingsPath: string, content: string, states: CitationStates): StoreHealthCounts["checkableCitations"] {
  const counts = { any: 0, withFile: 0 };
  const lines = content.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].startsWith("- ")) continue;
    const citation = parseCitationComment(lines[i + 1]);
    const state = citation ? states[citationStateKey(findingsPath, lines[i])]?.state : undefined;
    if (!state || state === "unverifiable") continue;
    counts.any++;
    if (citation?.file) counts.withFile++;
  }
  return counts;
}

function projectHealth(storePath: string, project: string, states: CitationStates): StoreHealthCounts & { project: string } {
  const counts = { project, ...emptyCounts() };
  const findingsPath = path.join(storePath, project, "FINDINGS.md");
  const activeContent = fs.existsSync(findingsPath) ? fs.readFileSync(findingsPath, "utf8") : "";
  const active = activeContent ? parseBullets(activeContent) : [];
  counts.checkableCitations = checkableCitations(findingsPath, activeContent, states);
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
      if (citation.remote) counts.citations.withRemote++;
      if (!citation.file && !citation.commit && !citation.symbol && !citation.remote) counts.citations.timestampOnly++;
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
  const counts: StoreHealthRecall = { prompts: 0, injected: 0, abstained: 0, skipped: 0, suppressedRepeats: 0, taskCapturePaused: 0, byAbstainReason: {} };
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
    if (entry.taskCapturePaused && typeof entry.taskCapturePaused === "object") counts.taskCapturePaused++;
  }
  counts.byAbstainReason = Object.fromEntries(reasons);
  return counts;
}

function addCounts(into: Record<string, unknown>, from: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(into)) {
    if (typeof value === "number") into[key] = value + (from[key] as number);
    else addCounts(value as Record<string, unknown>, from[key] as Record<string, unknown>);
  }
}

// Read-only: duplicate counts are extra occurrences within a project, across all tiers.
// Citation coverage reads the states this computer's last sweep recorded; it runs no git.
export function collectStoreHealth(
  phrenPath: string,
  now = new Date(),
  computer = getMachineName(),
  citationStates: CitationStates = readCitationStates(phrenPath),
): StoreHealth {
  const stores = resolveAllStores(phrenPath, { migrateAttachments: false }).map(entry => {
    const store = entry.role === "primary" ? { ...entry, path: phrenPath } : entry;
    const projects = getStoreProjectDirs(store).sort().map(dir => projectHealth(store.path, path.basename(dir), citationStates));
    const totals = emptyCounts();
    for (const { project: _name, ...counts } of projects) addCounts(totals as unknown as Record<string, unknown>, counts);
    const citationCoverage = totals.activeFindings ? Math.round((totals.checkableCitations.any / totals.activeFindings) * 1000) / 1000 : 0;
    return { name: store.name, path: path.relative(phrenPath, store.path).split(path.sep).join("/") || ".", projects, totals, citationCoverage };
  });
  const runtime = runtimeDir(phrenPath);
  const runtimeBytes: Record<string, number> = Object.fromEntries(fs.existsSync(runtime)
    ? fs.readdirSync(runtime).sort().map(name => [name, bytes(path.join(runtime, name))])
    : []);
  const runtimeClasses: Record<RuntimeClass, number> = { codeIndexes: 0, fanoutArchive: 0, fanouts: 0, sessions: 0, packages: 0, logs: 0, other: 0 };
  for (const [name, size] of Object.entries(runtimeBytes)) runtimeClasses[runtimeClass(name)] += size;
  const over = stores.flatMap(store => store.projects.flatMap(({ project, openTasks, reviewEntries }) => {
    const budgets = getRetentionPolicy(path.resolve(phrenPath, store.path), project).budgets;
    return [
      overBudget("openTasks", openTasks, budgets.openTasks, { store: store.name, project }),
      overBudget("reviewEntries", reviewEntries, budgets.reviewEntries, { store: store.name, project }),
    ];
  }));
  const global = getRetentionPolicy(phrenPath).budgets;
  const fanoutRow = overBudget("fanoutArchiveBytes", runtimeClasses.fanoutArchive, megabytes(global.fanoutArchiveMB));
  if (fanoutRow && !runtimeAgeOutActive(phrenPath)) fanoutRow.effect = "reported only until runtime age-out is on";
  over.push(overBudget("runtimeBytes", Object.values(runtimeBytes).reduce((sum, size) => sum + size, 0), megabytes(global.runtimeMB)), fanoutRow);
  return {
    at: now.toISOString(), computer, stores, runtimeBytes, runtimeClasses,
    budgets: { over: over.filter((row): row is OverBudget => row !== null) },
    recall: recallHealth(phrenPath, now),
  };
}

// ── Budgets: which components are over, and what that stops ──

const BUDGET_EFFECTS: Record<OverBudget["component"], string> = {
  openTasks: "the prompt hook files no new tasks",
  reviewEntries: "machine-generated entries are not queued",
  runtimeBytes: "reported only",
  fanoutArchiveBytes: "the archive sweep deletes the oldest finished folders",
};

function overBudget(component: OverBudget["component"], value: number, budget: number, where: { store?: string; project?: string } = {}): OverBudget | null {
  return budget > 0 && value > budget ? { component, ...where, value, budget, effect: BUDGET_EFFECTS[component] } : null;
}

function megabytes(mb: number): number {
  return Math.round(mb * 1024 * 1024);
}

function runtimeClass(name: string): RuntimeClass {
  if (name === "code") return "codeIndexes";
  if (name === "agent-fanouts-archive") return "fanoutArchive";
  if (name === "agent-fanouts") return "fanouts";
  if (name === "sessions") return "sessions";
  if (name === "packages") return "packages";
  return /\.(?:log|jsonl)$/.test(name) ? "logs" : "other";
}

// ── Runtime age-out: regenerable files only, off by default, and never before this computer's week ──

const DAY_MS = 86_400_000;
const AGE_OUT_WAIT_DAYS = 7;
const FINISHED_STATUSES = new Set(["completed", "failed", "cancelled"]);
const requireModule = createRequire(import.meta.url);

interface AgeOutCandidate { kind: keyof AgeOutCounts; target: string; bytes: number }

// The checkout a code index was built from, as the indexer recorded it in its meta table; undefined when unreadable.
function indexRepoRoot(file: string): string | undefined {
  let db: import("node:sqlite").DatabaseSync | undefined;
  try {
    const { DatabaseSync } = requireModule("node:sqlite") as typeof import("node:sqlite");
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = 'repo_root'").get() as { value?: unknown } | undefined;
    return typeof row?.value === "string" && row.value ? row.value : undefined;
  } catch { return undefined; } finally { try { db?.close(); } catch { /* already closed */ } }
}

// A folder that is a git checkout here: a repository or a worktree (`.git` file).
function isCheckout(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

// When an archived fanout folder finished, mirroring the archive sweep: its manifest's finishedAt, else exit.txt's mtime.
function archivedFinish(folder: string): number | undefined {
  let manifest: { status?: unknown; finishedAt?: unknown } = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8")); } catch { /* none or torn */ }
  const exit = fs.lstatSync(path.join(folder, "exit.txt"), { throwIfNoEntry: false });
  if (!FINISHED_STATUSES.has(String(manifest.status)) && !exit?.isFile()) return undefined;
  const finished = typeof manifest.finishedAt === "string" ? Date.parse(manifest.finishedAt) : NaN;
  return Number.isFinite(finished) ? finished : exit?.isFile() ? exit.mtimeMs : undefined;
}

/**
 * Code indexes whose recorded checkout is gone from this computer (missing, or no longer a git checkout) and
 * not rebuilt for `days`, and archived fanout folders finished `days` ago. An index without a readable record,
 * a locked one, a symlink, and everything else in `.runtime` or outside it are never candidates.
 */
function ageOutCandidates(phrenPath: string, days: number, now: Date): AgeOutCandidate[] {
  const cutoff = now.getTime() - days * DAY_MS;
  const candidates: AgeOutCandidate[] = [];
  const code = path.join(runtimeDir(phrenPath), "code");
  for (const name of fs.existsSync(code) ? fs.readdirSync(code).sort() : []) {
    const project = name.endsWith(".sqlite") ? name.slice(0, -".sqlite".length) : "";
    const file = path.join(code, name);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!isValidProjectName(project) || !stat?.isFile() || stat.mtimeMs > cutoff || fs.existsSync(`${file}.lock`)) continue;
    const repoRoot = indexRepoRoot(file);
    if (!repoRoot || isCheckout(repoRoot)) continue;
    candidates.push({ kind: "codeIndexes", target: file, bytes: stat.size });
  }
  const archive = path.join(runtimeDir(phrenPath), "agent-fanouts-archive");
  for (const name of fs.existsSync(archive) ? fs.readdirSync(archive).sort() : []) {
    const folder = path.join(archive, name);
    if (!fs.lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) continue;
    const finished = archivedFinish(folder);
    if (finished !== undefined && finished <= cutoff) candidates.push({ kind: "fanoutArchive", target: folder, bytes: bytes(folder) });
  }
  return candidates;
}

function ageOutCounts(candidates: AgeOutCandidate[]): AgeOutCounts {
  const counts: AgeOutCounts = { codeIndexes: { count: 0, bytes: 0 }, fanoutArchive: { count: 0, bytes: 0 } };
  for (const { kind, bytes: size } of candidates) { counts[kind].count++; counts[kind].bytes += size; }
  return counts;
}

// Earlier daily lines that reported runtime classes; a torn line or one whose date cannot be read does not count.
function reportLines(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry?.runtimeClasses && typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at))) count++;
    } catch { /* a torn line */ }
  }
  return count;
}

/**
 * The opt-in this computer saw, kept in `.runtime` (never synced): its week starts the first day age-out is on here,
 * and turning it off forgets it. Ready once that week has passed and seven daily lines have reported runtime classes.
 */
function runtimeAgeOut(phrenPath: string, budgets: StoreBudgets, lines: string[], now: Date): RuntimeAgeOut {
  const stateFile = path.join(runtimeDir(phrenPath), RUNTIME_AGE_OUT_STATE);
  const candidates = ageOutCandidates(phrenPath, budgets.runtimeAgeOutDays, now);
  const reported = reportLines(lines);
  let enabledDays: number | null = null;
  let acted = false;
  if (!budgets.runtimeAgeOut) {
    fs.rmSync(stateFile, { force: true });
  } else {
    const enabledSince = readRuntimeAgeOutState(phrenPath)?.enabledSince ?? now.toISOString();
    enabledDays = Math.max(0, Math.floor((now.getTime() - Date.parse(enabledSince)) / DAY_MS));
    acted = enabledDays >= AGE_OUT_WAIT_DAYS && reported >= AGE_OUT_WAIT_DAYS;
    atomicWriteText(stateFile, `${JSON.stringify({ enabledSince, ready: acted })}\n`);
    if (acted) for (const { target } of candidates) fs.rmSync(target, { recursive: true, force: true });
  }
  return { enabled: budgets.runtimeAgeOut, days: budgets.runtimeAgeOutDays, enabledDays, reportLines: reported, acted, candidates: ageOutCounts(candidates) };
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
    // Age-out runs before the count, so the line's runtime bytes are what is left. A failed age-out never costs the day's line.
    let ageOut: RuntimeAgeOut | undefined;
    try { ageOut = runtimeAgeOut(phrenPath, getRetentionPolicy(phrenPath).budgets, lines, now); }
    catch (err: unknown) { debugLog(`store health: runtime age-out failed: ${errorMessage(err)}`); }
    const entry: StoreHealth = { ...collectStoreHealth(phrenPath, now, computer), ...(ageOut ? { runtimeAgeOut: ageOut } : {}) };
    atomicWriteText(file, [...lines.slice(-399), JSON.stringify(entry)].join("\n") + "\n");
    return true;
  });
}

const COMPONENT_LABELS: Record<OverBudget["component"], string> = {
  openTasks: "open tasks", reviewEntries: "review entries", runtimeBytes: ".runtime", fanoutArchiveBytes: "fanout archive",
};

/** Doctor's warn-only budgets line, from the latest daily health record: it never fails the check. */
export function budgetDoctorCheck(phrenPath: string): { name: string; ok: true; detail: string } {
  const file = path.join(runtimeDir(phrenPath), "store-health.jsonl");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(line => line.trim()) : [];
  let latest: Partial<StoreHealth> | undefined;
  for (const line of lines.reverse()) {
    try { latest = JSON.parse(line); } catch { continue; }
    if (latest?.budgets) break;
    latest = undefined;
  }
  if (!latest?.budgets || typeof latest.at !== "string") return { name: "budgets", ok: true, detail: "no store health recorded yet" };
  const day = latest.at.slice(0, 10);
  if (!latest.budgets.over.length) return { name: "budgets", ok: true, detail: `within budget on ${day}` };
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  const rows = latest.budgets.over.map(row => {
    const where = row.project ? `${row.store}/${row.project} ` : "";
    const amount = row.component.endsWith("Bytes") ? `${mb(row.value)} of ${mb(row.budget)}` : `${row.value} of ${row.budget}`;
    return `${where}${COMPONENT_LABELS[row.component]} ${amount} (${row.effect})`;
  });
  return { name: "budgets", ok: true, detail: `over budget on ${day}: ${rows.join("; ")}` };
}
