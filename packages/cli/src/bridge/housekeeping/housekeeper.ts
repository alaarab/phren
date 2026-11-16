import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, statfs, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { HealthCheck } from "../machine-health.js";
import type { InboxSource } from "../owner-inbox.js";
import { atomicInPrivateDir, bridgeRoot } from "../protocol.js";
import type { ComputerResources } from "../resources.js";
import {
  type ActionKind, type ApproveResult, type Area, type Badge, badgeOf, type InventoryView, buildReport, type Cleaned, healthOf, type HousekeepingView,
  type ItemDraft, type StoredItem, type StoredReport, type Trigger, viewOf,
} from "./report.js";
import { type Inventory, type InventoryOptions, type InventorySession, type InventorySpace, type InventoryWorktree, scanInventory } from "./inventory.js";

import { type DeletionContext, type InUseSources, type PaneDispatch, paneCloseBlock, plainReason, removeApprovedPath, removeWorktreeSafely } from "./safety.js";


/**
 * The Hook's housekeeping pass: every TICK_MS, and at once when free disk
 * drops below the floor or the computer becomes stressed, run each check,
 * store the report for RETAIN_DAYS, and serve the phone's view of it. Checks
 * only observe and propose. Acting happens in `approve` (the owner) or, in a
 * later slice, for allow-listed caches; both go through safety.ts against
 * fresh state, never the stored report.
 */

export const TICK_MS = 15 * 60_000;
export const RETAIN_DAYS = 14;
/** Below this the RC suites fail; the audit's floor for warning and cleaning. */
export const DISK_FLOOR_BYTES = 20 * 1024 ** 3;
/** Approve answers within this; later work comes back `started` and lands in `cleaned`. */
export const APPROVE_BUDGET_MS = 45_000;
/** The inventory scan (sizes are slow) runs hourly and on request. */
export const SCAN_MS = 60 * 60_000;
/** An inventory older than this is marked stale. */
const STALE_MS = 2 * SCAN_MS;
const MAX_REPORTS = 2000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const DAY = 86_400_000;

export interface CheckContext extends InUseSources {
  resources: ComputerResources;
  now: number;
}

export interface Check {
  name: string;
  run: (context: CheckContext) => Promise<ItemDraft[]>;
}

/** Machine-health findings that are housekeeping's business, and their area. */
const HEALTH_AREAS: Partial<Record<HealthCheck, Area>> = {
  swap: "memory", load: "memory", "memory-hog": "memory", "memory-leak": "memory", oom: "memory",
  disk: "disk", orphan: "sessions", "stale-lock": "sessions", "simulator-clones": "simulators",
};
const SUSTAINED: ReadonlySet<HealthCheck> = new Set(["swap", "load", "memory-hog", "memory-leak"]);

/** Warnings are machine-health findings, with their ids and wording, so the
 * phone and the conductor's `machine_health` name the same thing the same way. */
export const healthCheck: Check = {
  name: "health",
  run: async ({ resources }) => (resources.health ?? []).flatMap(finding => {
    const area = HEALTH_AREAS[finding.check];
    if (!area) return [];
    // Disk under the RC floor wakes the owner at once; pressure only once it lasts (see `pass`).
    const notify = finding.check === "disk" && (resources.disk?.freeBytes ?? Infinity) < DISK_FLOOR_BYTES;
    return [{ id: finding.id, section: "warning" as const, area, kind: "health" as const, severity: finding.severity, title: finding.title,
      reason: finding.detail, fix: finding.fix, target: { name: finding.check }, fingerprint: finding.severity, ...(notify ? { notify } : {}) }];
  }),
};

export const DEFAULT_CHECKS: Check[] = [healthCheck];

async function readJson<T>(file: string, fallback: T): Promise<T> {
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_FILE_BYTES) return fallback;
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return fallback; }
}

/** `<bridge>/housekeeping/`: reports/ (one file per pass), cleaned.json, dismissed.json. */
export class HousekeepingStore {
  readonly reports: string;
  constructor(readonly dir = path.join(bridgeRoot(), "housekeeping")) { this.reports = path.join(dir, "reports"); }

  private async names(): Promise<string[]> {
    const entries = await readdir(this.reports).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return [] as string[]; throw error; });
    return entries.filter(name => /^\d{8}T\d{6}Z-[a-f0-9]{12}\.json$/.test(name)).sort();
  }

  async save(report: StoredReport, now: number): Promise<void> {
    await mkdir(this.reports, { recursive: true, mode: 0o700 });
    const stamp = report.generatedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    await atomicInPrivateDir(path.join(this.reports, `${stamp}-${report.id}.json`), report);
    const names = await this.names();
    for (const [index, name] of names.entries()) {
      const at = Date.parse(name.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z.*/, "$1-$2-$3T$4:$5:$6Z"));
      if (at < now - RETAIN_DAYS * DAY || index < names.length - MAX_REPORTS) await unlink(path.join(this.reports, name)).catch(() => {});
    }
  }

  async latest(): Promise<StoredReport | undefined> {
    for (const name of (await this.names()).reverse()) {
      const report = await readJson<StoredReport | undefined>(path.join(this.reports, name), undefined);
      if (report?.version === 1) return report; // a torn or foreign file: try the one before
    }
    return undefined;
  }

  async cleaned(now: number): Promise<Cleaned[]> {
    return (await readJson<Cleaned[]>(path.join(this.dir, "cleaned.json"), [])).filter(entry => Date.parse(entry.at) >= now - RETAIN_DAYS * DAY);
  }

  async addCleaned(entry: Cleaned, now: number): Promise<void> {
    const kept = [...await this.cleaned(now), entry].slice(-5000);
    await atomicInPrivateDir(path.join(this.dir, "cleaned.json"), kept);
  }

  async inventory(): Promise<Inventory | undefined> {
    return readJson<Inventory | undefined>(path.join(this.dir, "inventory.json"), undefined);
  }

  async setInventory(inventory: Inventory): Promise<void> {
    await atomicInPrivateDir(path.join(this.dir, "inventory.json"), inventory);
  }

  async dismissed(): Promise<Map<string, { fingerprint: string; at: string }>> {
    return new Map(Object.entries(await readJson<Record<string, { fingerprint: string; at: string }>>(path.join(this.dir, "dismissed.json"), {})));
  }

  async setDismissed(marks: Map<string, { fingerprint: string; at: string }>, now: number): Promise<void> {
    // A mark for a state that has not come back in a month is dropped.
    const live = [...marks].filter(([, mark]) => Date.parse(mark.at) >= now - 30 * DAY);
    await atomicInPrivateDir(path.join(this.dir, "dismissed.json"), Object.fromEntries(live));
  }
}

export interface HousekeeperOptions extends InUseSources {
  computer: string;
  resources: () => Promise<ComputerResources>;
  checks?: Check[];
  store?: HousekeepingStore;
  now?: () => number;
  /** Free bytes on the volume actions free space on; statfs of the home folder by default. */
  freeBytes?: () => Promise<number>;
  /** Inventory sources beyond processes and panes (sessions, dispatches, simulators, docker, roots). */
  inventory?: Omit<InventoryOptions, "processes" | "panes">;
  /** Close a pane through the terminal provider. */
  closePane?: (server: string, pane: string) => Promise<void>;
  /** Runs simctl and docker for approved actions; execFile by default. */
  command?: (file: string, args: string[]) => Promise<void>;
}

type Outcome = { status: "done"; freedBytes: number } | { status: "refused" | "failed"; reason: string };

export class Housekeeper {
  private current: StoredReport | undefined;
  private loaded = false;
  private running: Promise<StoredReport> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private cachedView: HousekeepingView | undefined;
  private lastEdge = { lowDisk: false, stressed: false };
  private inventory: Inventory | undefined;
  private inventoryLoaded = false;
  private scanning: Promise<Inventory> | undefined;
  private readonly store: HousekeepingStore;
  private readonly now: () => number;

  constructor(private readonly options: HousekeeperOptions) {
    this.store = options.store ?? new HousekeepingStore();
    this.now = options.now ?? Date.now;
  }

  private async latest(): Promise<StoredReport | undefined> {
    if (!this.loaded) { this.current ??= await this.store.latest(); this.loaded = true; }
    return this.current;
  }

  /** One pass. Concurrent callers share the pass in flight. */
  run(trigger: Trigger = "tick", persist = true): Promise<StoredReport> {
    if (this.running) return this.running;
    const pass = this.pass(trigger, persist).finally(() => { this.running = undefined; });
    this.running = pass;
    return pass;
  }

  private async pass(trigger: Trigger, persist: boolean): Promise<StoredReport> {
    const startedAt = this.now();
    const resources = await this.options.resources();
    const context: CheckContext = { resources, now: startedAt, processes: this.options.processes, panes: this.options.panes };
    const drafts: ItemDraft[] = [], errors: Array<{ check: string; message: string }> = [];
    for (const check of this.options.checks ?? DEFAULT_CHECKS) {
      try { drafts.push(...await check.run(context)); }
      catch (error) { errors.push({ check: check.name, message: error instanceof Error ? error.message.slice(0, 300) : String(error) }); }
    }
    const previous = await this.latest();
    // Pressure notifies once it was already there on the previous pass.
    const before = new Set(previous?.items.map(item => item.id));
    for (const draft of drafts) if (draft.id && SUSTAINED.has(draft.target.name as HealthCheck) && before.has(draft.id)) draft.notify = true;
    const report = buildReport({ computer: this.options.computer, trigger, startedAt, finishedAt: this.now(), drafts, previous, health: healthOf(resources), errors });
    if (persist) {
      await this.store.save(report, this.now());
      this.current = report; this.loaded = true; this.cachedView = undefined;
      // Warm the view: the inbox and the overview badge read it synchronously.
      await this.view();
    }
    return report;
  }

  private async latestInventory(): Promise<Inventory | undefined> {
    if (!this.inventoryLoaded) { this.inventory ??= await this.store.inventory(); this.inventoryLoaded = true; }
    return this.inventory;
  }

  /** Scan the inventory in the background; concurrent callers share the scan. */
  scan(): Promise<Inventory> {
    if (this.scanning) return this.scanning;
    const run = (async () => {
      const inventory = await scanInventory({ ...this.options.inventory, processes: this.options.processes, panes: this.options.panes, now: this.now() });
      await this.store.setInventory(inventory);
      this.inventory = inventory; this.inventoryLoaded = true;
      return inventory;
    })().finally(() => { this.scanning = undefined; this.cachedView = undefined; });
    this.scanning = run;
    this.cachedView = undefined;
    return run;
  }

  /** The phone's view of the newest report; undefined before the first pass. */
  async view(includeDismissed = false, includeInventory = false): Promise<HousekeepingView | undefined> {
    const plain = !includeDismissed && !includeInventory;
    if (plain && this.cachedView) return this.cachedView;
    const report = await this.latest();
    if (!report) return undefined;
    const scanned = await this.latestInventory();
    const inventory = scanned ? { collectedAt: scanned.collectedAt, scanning: Boolean(this.scanning),
      ids: [...scanned.worktrees, ...scanned.space, ...scanned.sessions].map(row => row.action?.id ?? row.id) } : undefined;
    const view = viewOf(report, { cleaned: await this.store.cleaned(this.now()), dismissed: await this.store.dismissed(), includeDismissed,
      nextCheckAt: new Date(Date.parse(report.generatedAt) + TICK_MS).toISOString(), ...(inventory ? { inventory } : {}),
      ...(includeInventory && scanned ? { include: inventoryOf(scanned, Boolean(this.scanning), this.now() - Date.parse(scanned.collectedAt) > STALE_MS) } : {}) });
    if (plain) this.cachedView = view;
    return view;
  }

  /** The overview badge, from the cached view: no pass, no git. */
  async badge(): Promise<Badge | undefined> {
    const view = await this.view();
    return view ? badgeOf(view, this.now()) : undefined;
  }

  /** Called with each resource read: a fresh drop below the disk floor or a
   * fresh stressed state runs a pass now rather than at the next tick. */
  observe(resources: ComputerResources): Promise<StoredReport> | undefined {
    const lowDisk = !!resources.disk && resources.disk.freeBytes < DISK_FLOOR_BYTES;
    const stressed = resources.level === "stressed";
    const edge = lowDisk && !this.lastEdge.lowDisk ? "low-disk" : stressed && !this.lastEdge.stressed ? "high-load" : undefined;
    this.lastEdge = { lowDisk, stressed };
    return edge ? this.run(edge) : undefined;
  }

  /** Warnings worth waking the owner for, as owner-inbox sources keyed by item
   * id: a reworded finding stays one row, which resolves itself when it goes. */
  inboxSources(): InboxSource[] {
    const view = this.cachedView;
    if (!view || !this.current) return [];
    return view.warnings.filter(item => item.notify).map(item => ({
      source: `housekeeping:${item.id}`, kind: "needs-you" as const, title: `Housekeeping on ${this.current!.computer}: ${item.title}`.slice(0, 500),
    }));
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Hide items until their state changes. Unknown ids are ignored. */
  dismiss(ids: string[]): Promise<{ revision: string }> {
    return this.serial(async () => {
      const report = await this.latest();
      const marks = await this.store.dismissed();
      const at = new Date(this.now()).toISOString();
      for (const item of report?.items ?? []) if (ids.includes(item.id)) marks.set(item.id, { fingerprint: item.fingerprint, at });
      await this.store.setDismissed(marks, this.now());
      this.cachedView = undefined;
      return { revision: (await this.view())?.revision ?? "" };
    });
  }

  restore(ids: string[]): Promise<{ revision: string }> {
    return this.serial(async () => {
      const marks = await this.store.dismissed();
      for (const id of ids) marks.delete(id);
      await this.store.setDismissed(marks, this.now());
      this.cachedView = undefined;
      return { revision: (await this.view())?.revision ?? "" };
    });
  }

  /**
   * Apply the owner's approval. A fresh pass runs first and each id is judged
   * against it: an id that is no longer there (its state changed) is `gone`,
   * a kept item or a warning is `refused`, and an action re-checks safety
   * against the disk itself as it runs. Work past APPROVE_BUDGET_MS comes back
   * `started` and finishes in the background, landing in `cleaned`.
   */
  approve(ids: string[], by: Cleaned["by"]): Promise<ApproveResult> {
    return this.serial(async () => {
      const started = this.now();
      const fresh = await this.run("approve");
      const items = new Map(fresh.items.map(item => [item.id, item]));
      const results: ApproveResult["results"] = [];
      const later: StoredItem[] = [];
      let acted = false;
      for (const id of ids) {
        const item = items.get(id) ?? await this.inventoryItem(id);
        if (!item) { results.push({ id, status: "gone" }); continue; }
        if (item.section === "kept") { results.push({ id, status: "refused", reason: plainReason(item.blockers ?? []) || item.reason }); continue; }
        if (item.section === "warning") { results.push({ id, status: "refused", reason: "This is a warning; there is nothing to apply." }); continue; }
        if (!item.action || !EXECUTORS[item.action]) { results.push({ id, status: "refused", reason: "This computer's Hook can't do that yet." }); continue; }
        if (this.now() - started > APPROVE_BUDGET_MS) { later.push(item); results.push({ id, status: "started" }); continue; }
        const outcome = await this.apply(item, by);
        acted ||= outcome.status === "done";
        results.push(outcome.status === "done" ? { id, status: "done", freedBytes: outcome.freedBytes } : { id, status: outcome.status, reason: outcome.reason });
      }
      if (later.length) void (async () => { for (const item of later) await this.apply(item, by); await this.run("approve"); })().catch(() => {});
      if (acted) await this.run("approve");
      return { results, revision: (await this.view())?.revision ?? "" };
    });
  }

  private async freeBytes(): Promise<number> {
    if (this.options.freeBytes) return this.options.freeBytes();
    const stats = await statfs(homedir());
    return Number(stats.bavail) * Number(stats.bsize);
  }

  private async apply(item: StoredItem, by: Cleaned["by"]): Promise<Outcome> {
    const before = await this.freeBytes();
    let outcome: Outcome;
    // The same roots the scan used, so a row is judged at approval by the rules that listed it.
    const inv = this.options.inventory;
    const context = { processes: this.options.processes, panes: this.options.panes, ...(inv?.rules ? { rules: inv.rules } : {}), ...(inv?.tmpRoots ? { tmpRoots: inv.tmpRoots } : {}) };
    try { outcome = await EXECUTORS[item.action!]!(item, context, this.fresh()); }
    catch (error) { outcome = { status: "failed", reason: error instanceof Error ? error.message.slice(0, 300) : String(error) }; }
    if (outcome.status !== "done") return outcome;
    // What the volume really gained, not what the item estimated.
    const freedBytes = Math.max(0, (await this.freeBytes()) - before);
    await this.store.addCleaned({ id: item.id, at: new Date(this.now()).toISOString(), area: item.area, kind: item.kind, title: item.title, target: item.target,
      freedBytes, ...(item.sizeBytes !== undefined ? { reportedBytes: item.sizeBytes } : {}), by }, this.now());
    // The row is gone from what the phone sees until the next scan confirms it.
    if (this.inventory) {
      const keep = <T extends { action?: { id: string } }>(rows: T[]) => rows.filter(row => row.action?.id !== item.fingerprint);
      this.inventory = { ...this.inventory, worktrees: keep(this.inventory.worktrees), space: keep(this.inventory.space), sessions: keep(this.inventory.sessions) };
      await this.store.setInventory(this.inventory);
    }
    this.cachedView = undefined;
    return { status: "done", freedBytes };
  }

  /** An inventory row (prefixed id) as an approvable item; it is re-checked live by its executor. */
  private async inventoryItem(id: string): Promise<StoredItem | undefined> {
    const inventory = await this.latestInventory();
    if (!inventory) return undefined;
    const tree = inventory.worktrees.find(row => row.action.id === id);
    const room = inventory.space.find(row => row.action?.id === id);
    const pane = inventory.sessions.find(row => row.action.id === id);
    const found = tree ? { section: "worktrees", row: tree } : room ? { section: "space", row: room } : pane ? { section: "sessions", row: pane } : undefined;
    if (!found) return undefined;
    // The fingerprint holds the row's own action id, which is how a handled row leaves the inventory.
    const base = { section: "suggestion" as const, since: inventory.collectedAt, id, reason: "" };
    if (found.section === "worktrees") {
      const tree = found.row as InventoryWorktree;
      return { ...base, fingerprint: tree.action.id, area: "worktrees", kind: "worktree", title: path.basename(tree.path),
        target: { path: tree.path, repo: tree.repo, ...(tree.branch ? { branch: tree.branch } : {}) }, action: "remove-worktree",
        ...(tree.sizeBytes !== undefined ? { sizeBytes: tree.sizeBytes } : {}) };
    }
    if (found.section === "space") {
      const room = found.row as InventorySpace;
      if (!room.action) return undefined;
      return { ...base, fingerprint: room.action.id, area: room.area, kind: room.kind === "simulator" ? "simulator" : room.kind === "docker" ? "docker" : room.kind === "tmp" ? "tmp" : "cache",
        title: room.title, target: { ...(room.path ? { path: room.path } : {}), ...(room.udid ? { udid: room.udid } : {}), ...(room.kind === "docker" ? { name: "builder" } : {}) },
        action: room.action.kind as ActionKind, sizeBytes: room.sizeBytes };
    }
    const session = found.row as InventorySession;
    return { ...base, fingerprint: session.action.id, area: "sessions", kind: "pane", title: session.pane.label ?? session.title ?? session.pane.target.pane,
      target: { name: `${session.pane.target.server}/${session.pane.target.pane}` }, action: "close-pane", pane: session.pane };
  }

  /** Live state for executors: fresh sessions and dispatches, never the scan's copy. */
  private fresh(): ExecutorDeps {
    const inv = this.options.inventory;
    return {
      sessions: async () => (await inv?.sessions?.()) ?? [],
      dispatches: async () => { if (!inv?.dispatches) throw new Error("dispatches unavailable"); return inv.dispatches(); },
      closePane: this.options.closePane,
      command: this.options.command ?? (async (file, args) => { await promisify(execFile)(file, args, { timeout: 120_000 }); }),
      xcodebuildRunning: inv?.xcodebuildRunning ?? (async () => false),
      simulators: inv?.simulators,
    };
  }
}

interface ExecutorDeps {
  sessions: () => Promise<Array<Pick<InventorySession, "pane" | "status"> & { role?: string }>>;
  dispatches: () => Promise<PaneDispatch[]>;
  closePane?: (server: string, pane: string) => Promise<void>;
  command: (file: string, args: string[]) => Promise<void>;
  xcodebuildRunning: () => Promise<boolean>;
  simulators?: InventoryOptions["simulators"];
}

type Executor = (item: StoredItem, sources: DeletionContext, deps: ExecutorDeps) => Promise<Outcome>;

async function simulatorAction(item: StoredItem, deps: ExecutorDeps, verb: "shutdown" | "delete"): Promise<Outcome> {
  const udid = item.target.udid;
  if (!udid || !/^[A-F0-9-]{36}$/i.test(udid)) return { status: "refused", reason: "The item names no simulator." };
  if (await deps.xcodebuildRunning()) return { status: "refused", reason: "An Xcode build or test is running." };
  const sim = (await deps.simulators?.() ?? []).find(row => row.udid === udid.toUpperCase());
  if (!sim) return { status: "refused", reason: "The simulator is already gone." };
  if (verb === "delete" && sim.state !== "Shutdown") return { status: "refused", reason: "It is running; shut it down first." };
  if (verb === "shutdown" && sim.state !== "Booted") return { status: "refused", reason: "It isn't running." };
  await deps.command("/usr/bin/xcrun", ["simctl", verb, udid]);
  return { status: "done", freedBytes: 0 };
}

/** What each action does once approved; every one goes through safety.ts. */
const EXECUTORS: Partial<Record<ActionKind, Executor>> = {
  "remove-worktree": async (item, sources) => {
    if (!item.target.path) return { status: "refused", reason: "The item names no worktree." };
    const result = await removeWorktreeSafely(item.target.path, sources);
    return result.removed ? { status: "done", freedBytes: 0 } : { status: "refused", reason: plainReason(result.blockers) };
  },
  "delete-path": async (item, sources) => {
    if (!item.target.path) return { status: "refused", reason: "The item names no path." };
    const result = await removeApprovedPath(item.target.path, sources);
    return result.removed ? { status: "done", freedBytes: 0 } : { status: "refused", reason: result.decision.allowed ? "" : result.decision.reason };
  },
  "close-pane": async (item, _sources, deps) => {
    const pane = item.pane?.target;
    if (!pane || !deps.closePane) return { status: "refused", reason: "This computer's Hook can't close panes." };
    const live = (await deps.sessions()).find(row => row.pane.target.server === pane.server && row.pane.target.pane === pane.pane);
    if (!live) return { status: "refused", reason: "The pane is already closed." };
    const dispatches = await deps.dispatches().catch(() => undefined);
    if (!dispatches) return { status: "refused", reason: "Phren couldn't check its dispatches, so it stays open." };
    const block = paneCloseBlock({ server: pane.server, pane: pane.pane, status: live.status, role: live.role }, dispatches);
    if (block) return { status: "refused", reason: block };
    await deps.closePane(pane.server, pane.pane);
    return { status: "done", freedBytes: 0 };
  },
  "shutdown-simulator": async (item, _sources, deps) => simulatorAction(item, deps, "shutdown"),
  "delete-simulator": async (item, _sources, deps) => simulatorAction(item, deps, "delete"),
  "prune-docker-builder": async (_item, _sources, deps) => {
    // Build cache only, older than a week; never images, containers or volumes.
    await deps.command("docker", ["builder", "prune", "--force", "--filter", "until=168h"]);
    return { status: "done", freedBytes: 0 };
  },
};

/** The inventory as the view carries it: the scan, its state, and nothing internal. */
function inventoryOf(scan: Inventory, scanning: boolean, stale: boolean): InventoryView {
  return { collectedAt: scan.collectedAt, durationMs: scan.durationMs, ...(scanning ? { scanning: true } : {}), ...(stale ? { stale: true } : {}),
    worktrees: scan.worktrees, space: scan.space, sessions: scan.sessions, ...(scan.errors?.length ? { errors: scan.errors } : {}) };
}
