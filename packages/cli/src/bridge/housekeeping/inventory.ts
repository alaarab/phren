import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ActionKind, Area, PaneLink } from "./report.js";
import {
  type BoundPane, cacheRules, deletionDecision, housekeepingGit, inspectCheckout, type InUseSources, type LiveProcess, paneCloseBlock,
  type PaneDispatch, parseWorktreeList, plainReason, tmpRoots,
} from "./safety.js";

/**
 * The inventory: everything on this computer the owner may want to see and
 * handle, not just what crossed a threshold. Every worktree, the largest space
 * users, and every agent pane, each with an action that says whether it is
 * allowed now and, if not, why in a plain sentence. Scanning sizes is slow, so
 * the Hook runs it in the background (hourly and on request) and serves the
 * last scan; every action re-checks against the disk when approved.
 */

const exec = promisify(execFile);

export interface InventoryAction { id: string; kind: ActionKind; label: string; allowed: boolean; reason?: string }

export interface InventoryWorktree {
  id: string; repo: string; branch?: string; path: string; main: boolean; sizeBytes?: number; lastCommitAt?: string;
  dirty: number; untracked: number; unpushed: number; stashes: number; inProgress?: string; locked?: true;
  sessions: Array<{ pane: PaneLink; agent?: string; title?: string }>;
  processes: Array<{ pid: number; command?: string }>;
  action: InventoryAction;
}

export type SpaceKind = "cache" | "derived-data" | "xctest-devices" | "device-support" | "simulator" | "docker" | "tmp" | "node_modules";
export interface InventorySpace {
  id: string; area: Area; kind: SpaceKind; title: string; path?: string; udid?: string; sizeBytes: number; lastUsedAt?: string; action?: InventoryAction;
  /** Who is using it now, when that is why it stays. */
  inUse?: string;
  /** Why a row with no action is never handled here. */
  never?: string;
}

export interface InventorySession {
  id: string; pane: PaneLink; agent?: string; title?: string; project?: string; status?: string; idleSeconds?: number; cwd?: string;
  dispatch?: string; role?: string; receipt?: { id: string; returnRead: boolean }; action: InventoryAction;
}

export interface Inventory {
  collectedAt: string; durationMs: number;
  worktrees: InventoryWorktree[]; space: InventorySpace[]; sessions: InventorySession[];
  errors?: Array<{ check: string; message: string }>;
}

/** An agent pane as the Hook's overview shows it. */
export interface SessionRow {
  pane: PaneLink; agent?: string; title?: string; project?: string; status?: string; role?: string; idleSeconds?: number; cwd?: string; dispatch?: string;
}

export interface InventoryOptions {
  home?: string;
  platform?: NodeJS.Platform;
  /** Folders whose direct children are checked for checkouts. */
  roots?: string[];
  tmpRoots?: string[];
  rules?: ReturnType<typeof cacheRules>;
  processes: () => Promise<LiveProcess[]>;
  panes: () => Promise<BoundPane[]>;
  sessions?: () => Promise<SessionRow[]>;
  dispatches?: () => Promise<PaneDispatch[]>;
  /** Bytes under a path; `du` by default. Undefined when it could not be measured. */
  sizeOf?: (target: string) => Promise<number | undefined>;
  simulators?: () => Promise<Array<{ udid: string; name: string; state: string; dataPath: string }>>;
  docker?: () => Promise<Array<{ type: string; sizeBytes: number; reclaimableBytes: number }>>;
  xcodebuildRunning?: () => Promise<boolean>;
  now?: number;
  /** How many space rows to keep. */
  spaceLimit?: number;
}

export const LABELS: Record<ActionKind, string> = {
  "remove-worktree": "Remove worktree", "delete-path": "Delete", "close-pane": "Close pane", "end-job": "End job",
  "shutdown-simulator": "Shut down simulator", "delete-simulator": "Delete simulator", "prune-docker-builder": "Prune build cache",
};

/** An action id: the row's kind, target and state, so a changed row gets a new id. */
export function actionId(kind: ActionKind, target: string, state: unknown): string {
  return createHash("sha256").update(JSON.stringify([kind, target, state])).digest("hex").slice(0, 16);
}

function action(kind: ActionKind, target: string, state: unknown, block?: string, label = LABELS[kind]): InventoryAction {
  return { id: actionId(kind, target, state), kind, label, allowed: !block, ...(block ? { reason: block } : {}) };
}

export async function duBytes(target: string): Promise<number | undefined> {
  try {
    // -x: one file system; nice: a background scan never competes with builds.
    const { stdout } = await exec("nice", ["-n", "15", "du", "-sk", "-x", target], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    const kb = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : undefined;
  } catch (error) {
    // du exits 1 when some entries were unreadable; its total still counts the rest.
    const stdout = (error as { stdout?: string }).stdout;
    const kb = Number(String(stdout ?? "").trim().split(/\s+/)[0]);
    return stdout && Number.isFinite(kb) ? kb * 1024 : undefined;
  }
}

async function children(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).filter(name => name !== ".DS_Store").map(name => path.join(dir, name));
}
const isDir = async (p: string) => (await lstat(p).catch(() => undefined))?.isDirectory() ?? false;
const has = async (p: string) => Boolean(await lstat(p).catch(() => undefined));

/** Checkouts under the roots (their direct children, plus each repo's linked worktrees and .claude/worktrees). */
export async function findCheckouts(roots: string[], limit = 400): Promise<string[]> {
  const found = new Set<string>();
  const add = async (dir: string) => { if (found.size < limit) found.add(await realpath(dir).catch(() => dir)); };
  for (const root of roots) {
    const scanned = path.basename(root) === ".cache" ? (await children(root)).filter(p => path.basename(p).startsWith("fanout-")) : [root];
    for (const base of scanned) for (const dir of await children(base)) {
      if (!await isDir(dir) || !await has(path.join(dir, ".git"))) continue;
      await add(dir);
      for (const inner of await children(path.join(dir, ".claude", "worktrees"))) if (await has(path.join(inner, ".git"))) await add(inner);
      if (!await isDir(path.join(dir, ".git"))) continue; // a linked worktree: its main lists the rest
      const listed = await housekeepingGit(dir, "worktree", "list", "--porcelain").catch(() => "");
      for (const entry of parseWorktreeList(listed)) if (!entry.bare && !entry.prunable && await isDir(entry.path)) await add(entry.path);
    }
  }
  return [...found].sort();
}

export function defaultRoots(home = homedir(), platform: NodeJS.Platform = process.platform): string[] {
  return [path.join(home, "Projects"), path.join(home, "Sites"), path.join(home, ".cache"), ...tmpRoots(platform)];
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

export async function scanInventory(options: InventoryOptions): Promise<Inventory> {
  const started = Date.now();
  const now = options.now ?? started;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const errors: Inventory["errors"] = [];
  const sizeOf = options.sizeOf ?? duBytes;
  // One process and pane listing for the whole scan.
  const [processes, panes] = await Promise.all([options.processes(), options.panes()]);
  const sources: InUseSources = { processes: async () => processes, panes: async () => panes };
  const sessionRows = await (options.sessions?.() ?? Promise.resolve([] as SessionRow[])).catch(error => { errors.push({ check: "sessions", message: String(error) }); return [] as SessionRow[]; });
  const context = { ...sources, ...(options.rules ? { rules: options.rules } : {}), tmpRoots: options.tmpRoots ?? tmpRoots(platform), now,
    protected: undefined };

  // Worktrees.
  const worktrees: InventoryWorktree[] = [];
  const checkouts = await findCheckouts(options.roots ?? defaultRoots(home, platform)).catch(error => { errors.push({ check: "worktrees", message: String(error) }); return [] as string[]; });
  for (const dir of checkouts) {
    const linked = !await isDir(path.join(dir, ".git"));
    const { facts, blockers } = await inspectCheckout(dir, linked ? "worktree" : "repository", sources);
    const inPanes = sessionRows.filter(row => row.cwd && inside(row.cwd, dir));
    const procs = processes.filter(proc => inside(proc.cwd, dir) && proc.pid !== process.pid).slice(0, 10);
    const main = facts?.main ?? !linked;
    const state = { facts, blockers: blockers.map(b => b.code) };
    const block = main ? "It is the repository's main checkout." : blockers.length ? plainReason(blockers) : undefined;
    worktrees.push({
      id: actionId("remove-worktree", dir, "row"), repo: facts?.repo ?? dir, ...(facts?.branch ? { branch: facts.branch } : {}), path: dir, main,
      ...(facts?.lastCommitAt ? { lastCommitAt: facts.lastCommitAt } : {}),
      dirty: facts?.dirty ?? 0, untracked: facts?.untracked ?? 0, unpushed: facts?.unpushed ?? 0, stashes: facts?.stashes ?? 0,
      ...(facts?.inProgress.length ? { inProgress: facts.inProgress[0] } : {}), ...(facts?.locked ? { locked: true as const } : {}),
      sessions: inPanes.map(row => ({ pane: row.pane, ...(row.agent ? { agent: row.agent } : {}), ...(row.title ? { title: row.title } : {}) })),
      processes: procs.map(proc => ({ pid: proc.pid, ...(proc.command ? { command: proc.command } : {}) })),
      action: action("remove-worktree", dir, state, block),
    });
  }
  // Sizes last: the slow part, and a checkout nested in another is counted in both.
  for (const row of worktrees) { const size = await sizeOf(row.path); if (size !== undefined) row.sizeBytes = size; }

  // Space.
  const space: InventorySpace[] = [];
  const pathRow = async (kind: SpaceKind, area: Area, target: string, title: string, withAction = true) => {
    const info = await lstat(target).catch(() => undefined);
    if (!info || info.isSymbolicLink()) return;
    const size = await sizeOf(target);
    if (size === undefined || size === 0) return;
    const decision = withAction ? await deletionDecision(target, context) : undefined;
    const user = decision && !decision.allowed ? decision.blockers?.find(b => b.code === "live-process" || b.code === "bound-pane") : undefined;
    space.push({ id: actionId("delete-path", target, "row"), area, kind, title, path: target, sizeBytes: size, lastUsedAt: new Date(info.mtimeMs).toISOString(),
      ...(user ? { inUse: user.detail } : {}), ...(!withAction ? { never: "Phren clears this cache by age on its own." } : {}),
      ...(decision ? { action: action("delete-path", target, [size, info.mtimeMs], decision.allowed ? undefined : decision.reason, kind === "node_modules" ? "Delete node_modules" : kind === "tmp" ? "Delete folder" : "Clear cache") } : {}) });
  };
  const KINDS: Record<string, SpaceKind> = { "derived-data": "derived-data", "xctest-devices": "xctest-devices", "ios-device-support": "device-support" };
  for (const rule of options.rules ?? cacheRules(home, platform)) {
    try {
      if (["npm-cacache", "swiftpm-cache"].includes(rule.id)) { await pathRow("cache", "disk", rule.root, `${rule.id === "npm-cacache" ? "npm" : "SwiftPM"} cache`, false); continue; }
      for (const entry of await children(rule.root)) await pathRow(KINDS[rule.id] ?? "cache", rule.id === "xctest-devices" ? "simulators" : "disk", entry, `${path.basename(rule.root)}/${path.basename(entry)}`);
    } catch (error) { errors.push({ check: `space:${rule.id}`, message: String(error) }); }
  }
  for (const root of options.tmpRoots ?? tmpRoots(platform)) {
    for (const entry of await children(root)) {
      if (checkouts.includes(await realpath(entry).catch(() => entry))) continue; // listed as a worktree
      const info = await lstat(entry).catch(() => undefined);
      if (!info?.isDirectory() || info.uid !== process.getuid?.()) continue;
      await pathRow("tmp", "disk", entry, entry);
    }
  }
  for (const dir of checkouts) {
    const modules = path.join(dir, "node_modules");
    if (await isDir(modules)) await pathRow("node_modules", "disk", modules, `${path.basename(dir)}/node_modules`);
  }
  if (platform === "darwin" && options.simulators) {
    try {
      const building = await (options.xcodebuildRunning?.() ?? Promise.resolve(false));
      for (const sim of await options.simulators()) {
        const size = await sizeOf(sim.dataPath);
        if (!size) continue;
        const booted = sim.state === "Booted";
        const kind: ActionKind = booted ? "shutdown-simulator" : "delete-simulator";
        const block = building ? "An Xcode build or test is running." : undefined;
        space.push({ id: actionId(kind, sim.udid, "row"), area: "simulators", kind: "simulator", title: `${sim.name} (${sim.state.toLowerCase()})`, udid: sim.udid,
          sizeBytes: size, action: action(kind, sim.udid, [sim.state, building], block) });
      }
    } catch (error) { errors.push({ check: "space:simulators", message: String(error) }); }
  }
  if (options.docker) {
    try {
      for (const row of await options.docker()) {
        if (!row.sizeBytes) continue;
        const build = /build cache/i.test(row.type);
        const never = /volume/i.test(row.type) ? "Phren never deletes docker volumes: they hold data."
          : /image/i.test(row.type) ? "Phren doesn't remove docker images." : "Phren doesn't remove docker containers.";
        space.push({ id: actionId("prune-docker-builder", row.type, "row"), area: "docker", kind: "docker", title: `Docker ${row.type.toLowerCase()}`, sizeBytes: row.sizeBytes,
          ...(build ? { action: action("prune-docker-builder", "builder", [row.sizeBytes], row.reclaimableBytes ? undefined : "Nothing in it can be pruned.") } : { never }) });
      }
    } catch (error) { errors.push({ check: "space:docker", message: String(error) }); }
  }
  space.sort((a, b) => b.sizeBytes - a.sizeBytes);
  space.splice(options.spaceLimit ?? 500);

  // Sessions.
  const dispatches = await (options.dispatches?.() ?? Promise.resolve([] as PaneDispatch[])).catch(() => undefined);
  const sessions: InventorySession[] = sessionRows.map(row => {
    const block = dispatches ? paneCloseBlock({ server: row.pane.target.server, pane: row.pane.target.pane, status: row.status, role: row.role }, dispatches)
      : "Phren couldn't check its dispatches, so it stays open.";
    const target = `${row.pane.target.server}/${row.pane.target.pane}`;
    return { id: actionId("close-pane", target, "row"), pane: row.pane, ...(row.agent ? { agent: row.agent } : {}), ...(row.title ? { title: row.title } : {}),
      ...(row.project ? { project: row.project } : {}), ...(row.status ? { status: row.status } : {}), ...(row.idleSeconds !== undefined ? { idleSeconds: row.idleSeconds } : {}),
      ...(row.cwd ? { cwd: row.cwd } : {}), ...(row.dispatch ? { dispatch: row.dispatch } : {}), ...(row.role ? { role: row.role } : {}),
      ...receiptOf(row, dispatches),
      action: action("close-pane", target, [row.status, block], block) };
  }).sort((a, b) => (b.idleSeconds ?? 0) - (a.idleSeconds ?? 0));

  return { collectedAt: new Date(now).toISOString(), durationMs: Date.now() - started, worktrees, space, sessions, ...(errors.length ? { errors } : {}) };
}

/** The pane's open dispatch, newest first, as the phone shows it. */
function receiptOf(row: SessionRow, dispatches: PaneDispatch[] | undefined): { receipt?: { id: string; returnRead: boolean } } {
  const receipt = [...dispatches ?? []].reverse().find(d => d.id && !d.closedAt && d.server === row.pane.target.server && d.pane === row.pane.target.pane);
  return receipt?.id ? { receipt: { id: receipt.id, returnRead: receipt.returned?.read ?? false } } : {};
}

/** Simulators with their data folders (macOS). */
export async function listSimulators(home = homedir()): Promise<Array<{ udid: string; name: string; state: string; dataPath: string }>> {
  const { stdout } = await exec("/usr/bin/xcrun", ["simctl", "list", "devices", "-j"], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  const devices = (JSON.parse(stdout) as { devices?: Record<string, Array<{ udid?: string; name?: string; state?: string; dataPath?: string }>> }).devices ?? {};
  const out: Array<{ udid: string; name: string; state: string; dataPath: string }> = [];
  for (const list of Object.values(devices)) for (const device of list) {
    if (!device.udid || !/^[A-F0-9-]{36}$/i.test(device.udid)) continue;
    const dataPath = path.join(home, "Library/Developer/CoreSimulator/Devices", device.udid);
    out.push({ udid: device.udid.toUpperCase(), name: String(device.name ?? "Simulator").slice(0, 120), state: String(device.state ?? "Unknown"), dataPath });
  }
  return out;
}

const UNITS: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3 };
export function parseDockerSize(text: string): number {
  const match = /^([\d.]+)\s*([KMGT]?i?B)/i.exec(text.trim());
  return match ? Math.round(Number(match[1]) * (UNITS[match[2].toUpperCase()] ?? 1)) : 0;
}

/** `docker system df`, when docker answers. */
export async function dockerUsage(): Promise<Array<{ type: string; sizeBytes: number; reclaimableBytes: number }>> {
  const { stdout } = await exec("docker", ["system", "df", "--format", "{{json .}}"], { timeout: 20_000 }).catch(() => ({ stdout: "" }));
  return stdout.split("\n").filter(Boolean).map(line => {
    const row = JSON.parse(line) as { Type?: string; Size?: string; Reclaimable?: string };
    return { type: String(row.Type ?? "Unknown"), sizeBytes: parseDockerSize(String(row.Size ?? "0B")), reclaimableBytes: parseDockerSize(String(row.Reclaimable ?? "0B")) };
  });
}

export async function xcodebuildRunning(): Promise<boolean> {
  return exec("pgrep", ["-x", "xcodebuild"], { timeout: 5_000 }).then(() => true, () => false);
}

/** Agent panes from one server's workspace overview (the Hook's `/v1/workspaces` shape). */
export function sessionRowsFromOverview(overview: Record<string, unknown>, now = Date.now()): SessionRow[] {
  const rows: SessionRow[] = [];
  const list = (value: unknown) => Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object") : [];
  const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
  for (const group of list(overview.groups)) for (const tab of list(group.children)) {
    const target = tab.target as PaneLink["target"] | undefined;
    if (typeof tab.agent !== "string" || !target || typeof target.server !== "string" || typeof target.pane !== "string") continue;
    const changedAt = typeof tab.lastChangedAt === "string" ? Date.parse(tab.lastChangedAt) : NaN;
    const label = text(tab.label) && !/^\d+$/.test(String(tab.label)) ? text(tab.label) : text(group.label);
    rows.push({
      pane: { target: { server: target.server, ...(target.workspace ? { workspace: target.workspace } : {}), ...(target.tab ? { tab: target.tab } : {}), pane: target.pane },
        ...(label ? { label } : {}) },
      agent: tab.agent, ...(text(tab.title) ? { title: text(tab.title) } : {}), ...(text(tab.agentStatus) ? { status: text(tab.agentStatus) } : {}),
      ...(text(tab.role) ? { role: text(tab.role) } : {}), ...(text(tab.cwd) ? { cwd: text(tab.cwd) } : {}),
      ...(Number.isFinite(changedAt) ? { idleSeconds: Math.max(0, Math.floor((now - changedAt) / 1000)) } : {}),
      ...(text(tab.dispatch) ? { dispatch: text(tab.dispatch) } : {}),
    });
  }
  return rows;
}
