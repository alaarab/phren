import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Housekeeper, HousekeepingStore } from "./housekeeper.js";
import { type InventoryOptions, parseDockerSize, scanInventory, type SessionRow, sessionRowsFromOverview } from "./inventory.js";
import { viewSchema } from "./report.js";
import type { PaneDispatch } from "./safety.js";

const created: string[] = [];
afterEach(async () => { for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp(prefix = "phren-hk-inv-") { const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix))); created.push(dir); return dir; }
const old = async (p: string, days = 30) => { const t = (Date.now() - days * 86_400_000) / 1000; await utimes(p, t, t); };

/** A home with a project (main checkout, a clean pushed worktree, an unpushed one, node_modules),
 * DerivedData, and a scratch root with an old folder, a fresh one, a checkout and a symlink. */
async function computer() {
  const home = await temp();
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: home,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
  const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)("git", ["-C", cwd, ...args], { env })).stdout;
  const projects = path.join(home, "Projects"), app = path.join(projects, "app"), remote = path.join(home, "remote.git");
  await mkdir(app, { recursive: true });
  await git(home, "init", "-q", "--bare", remote);
  await git(app, "init", "-q", "-b", "main");
  await writeFile(path.join(app, "package.json"), "{}\n");
  await writeFile(path.join(app, ".gitignore"), "node_modules\n");
  await git(app, "add", "."); await git(app, "commit", "-qm", "start");
  await git(app, "remote", "add", "origin", remote); await git(app, "push", "-q", "origin", "main");
  const clean = path.join(projects, "app-clean"), ahead = path.join(projects, "app-ahead");
  await git(app, "worktree", "add", "-q", "-b", "clean", clean); await git(clean, "push", "-q", "origin", "clean");
  await git(app, "worktree", "add", "-q", "-b", "ahead", ahead);
  await writeFile(path.join(ahead, "x.txt"), "x\n"); await git(ahead, "add", "."); await git(ahead, "commit", "-qm", "local");
  await mkdir(path.join(app, "node_modules", "dep"), { recursive: true });
  await writeFile(path.join(app, "node_modules", "dep", "index.js"), "x".repeat(50_000));

  const derived = path.join(home, "Library/Developer/Xcode/DerivedData");
  await mkdir(path.join(derived, "App-old"), { recursive: true });
  await writeFile(path.join(derived, "App-old", "build.o"), "x".repeat(200_000));
  await old(path.join(derived, "App-old"));

  const scratch = path.join(home, "tmp");
  await mkdir(path.join(scratch, "train-old"), { recursive: true });
  await writeFile(path.join(scratch, "train-old", "f"), "x".repeat(80_000));
  await old(path.join(scratch, "train-old"));
  await mkdir(path.join(scratch, "train-new"));
  await writeFile(path.join(scratch, "train-new", "f"), "x".repeat(10_000));
  await symlink(projects, path.join(scratch, "link-to-projects"));
  const tmpCheckout = path.join(scratch, "checkout");
  await git(app, "worktree", "add", "-q", "-b", "tmp-work", tmpCheckout); await git(tmpCheckout, "push", "-q", "origin", "tmp-work");
  await old(tmpCheckout);

  const options = {
    home, platform: "darwin" as NodeJS.Platform, roots: [projects, scratch], tmpRoots: [scratch],
    rules: [{ id: "derived-data", root: derived, minAgeDays: 14 }],
    processes: async () => [], panes: async () => [],
  };
  return { home, app, clean, ahead, derived, scratch, tmpCheckout, options, git };
}

describe("inventory", () => {
  it("lists every worktree with what it holds and whether it may go", async () => {
    const { app, clean, ahead, tmpCheckout, options } = await computer();
    const inventory = await scanInventory({ ...options, sessions: async () => [{ pane: { target: { server: "default", pane: "p1" }, label: "ios" }, agent: "claude", cwd: ahead }] });
    const rows = Object.fromEntries(inventory.worktrees.map(row => [row.path, row]));
    expect(Object.keys(rows).sort()).toEqual([app, clean, ahead, tmpCheckout].sort());
    expect(rows[app]).toMatchObject({ main: true, branch: "main", action: { allowed: false, reason: "It is the repository's main checkout." } });
    expect(rows[clean]).toMatchObject({ main: false, repo: app, branch: "clean", dirty: 0, unpushed: 0, stashes: 0, action: { kind: "remove-worktree", allowed: true } });
    expect(rows[ahead]).toMatchObject({ unpushed: 1, sessions: [{ pane: { label: "ios" }, agent: "claude" }],
      action: { allowed: false, reason: "It has commits that aren't on any remote." } });
    expect(rows[clean].sizeBytes).toBeGreaterThan(0);
    expect(Date.parse(rows[clean].lastCommitAt!)).toBeGreaterThan(Date.now() - 3_600_000);
  });

  it("ranks the space users and says which may be cleared", async () => {
    const { app, derived, scratch, options } = await computer();
    const inventory = await scanInventory(options);
    const rows = Object.fromEntries(inventory.space.map(row => [row.path, row]));
    expect(inventory.space.map(row => row.sizeBytes)).toEqual([...inventory.space.map(row => row.sizeBytes)].sort((a, b) => b - a));
    expect(rows[path.join(derived, "App-old")]).toMatchObject({ kind: "derived-data", action: { kind: "delete-path", label: "Clear cache", allowed: true } });
    expect(rows[path.join(scratch, "train-old")]).toMatchObject({ kind: "tmp", action: { allowed: true } });
    expect(rows[path.join(scratch, "train-new")]).toMatchObject({ action: { allowed: false, reason: "It was changed in the last day." } });
    expect(rows[path.join(app, "node_modules")]).toMatchObject({ kind: "node_modules", action: { label: "Delete node_modules", allowed: true } });
    // A symlink is never listed; a checkout in scratch is a worktree row, not a folder to delete.
    expect(rows[path.join(scratch, "link-to-projects")]).toBeUndefined();
    expect(rows[path.join(scratch, "checkout")]).toBeUndefined();
  });

  it("lets a pane be closed only when nothing would be lost", async () => {
    const pane = (id: string, extra: Partial<SessionRow> = {}): SessionRow => ({ pane: { target: { server: "default", pane: id } }, agent: "claude", status: "idle", ...extra });
    const sessions = [pane("p1", { idleSeconds: 7200 }), pane("p2", { status: "working" }), pane("p3"), pane("p4", { role: "conductor" }), pane("p5")];
    const dispatches: PaneDispatch[] = [{ server: "default", pane: "p3", returned: { read: false } }, { server: "default", pane: "p5" }];
    const inventory = await scanInventory({ processes: async () => [], panes: async () => [], roots: [], tmpRoots: [], rules: [], sessions: async () => sessions, dispatches: async () => dispatches });
    expect(inventory.sessions.map(row => [row.pane.target.pane, row.action.allowed, row.action.reason ?? null])).toEqual([
      ["p1", true, null],
      ["p2", false, "Its agent is working."],
      ["p3", false, "Its return hasn't been read yet."],
      ["p4", false, "It is the conductor."],
      ["p5", false, "Its dispatched work hasn't returned yet."],
    ]);
    const blind = await scanInventory({ processes: async () => [], panes: async () => [], roots: [], tmpRoots: [], rules: [], sessions: async () => [pane("p1")],
      dispatches: async () => { throw new Error("receipts unreadable"); } });
    expect(blind.sessions[0].action).toMatchObject({ allowed: false, reason: "Phren couldn't check its dispatches, so it stays open." });
  });

  it("reads agent panes from the Hook's workspace overview", () => {
    const now = Date.parse("2026-11-15T12:00:00Z");
    const overview = { groups: [{ label: "phren", children: [
      { agent: "claude", agentStatus: "idle", title: "housekeeping", cwd: "/Users/a/Projects/phren", lastChangedAt: "2026-11-15T11:00:00Z",
        target: { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude", session: "s" } },
      { label: "shell", target: { server: "default", pane: "w1:p2" } },
    ] }] };
    expect(sessionRowsFromOverview(overview, now)).toEqual([{ pane: { target: { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1" }, label: "phren" },
      agent: "claude", title: "housekeeping", status: "idle", cwd: "/Users/a/Projects/phren", idleSeconds: 3600 }]);
  });

  it.each([["11.2GB", 11_200_000_000], ["512MB", 512_000_000], ["0B", 0], ["1.5GiB", 1_610_612_736]])("reads docker's %s", (text, bytes) => {
    expect(parseDockerSize(text)).toBe(bytes);
  });
});

describe("handling inventory rows", () => {
  async function keeper(options: Awaited<ReturnType<typeof computer>>["options"] & Partial<InventoryOptions>, extra: Record<string, unknown> = {}) {
    return new Housekeeper({ computer: "mini", resources: async () => ({
      collectedAt: new Date().toISOString(), platform: "darwin", uptimeSeconds: 1, cpu: { cores: 8, load1: 1, load5: 1, load15: 1, loadPerCore: 0.1 },
      memory: { totalBytes: 1 }, heavy: [], pressure: { cpu: 0, memory: 0, disk: 0, overall: 0 }, level: "ok", warnings: [] }),
      processes: options.processes, panes: options.panes, checks: [], store: new HousekeepingStore(await temp()), freeBytes: async () => 0,
      inventory: options, ...extra });
  }

  it("approves rows by action id, re-checks each live, and drops what it handled", async () => {
    const machine = await computer();
    let status = "idle";
    const closed: string[] = [];
    const housekeeper = await keeper({ ...machine.options,
      sessions: async () => [{ pane: { target: { server: "default", pane: "p1" } }, agent: "claude", status }], dispatches: async () => [] },
      { closePane: async (_server: string, pane: string) => { closed.push(pane); } });
    await housekeeper.run();
    await housekeeper.scan();
    const view = viewSchema.parse((await housekeeper.view())!);
    const inventory = view.inventory!;
    const id = (rows: Array<{ path?: string; action?: { id: string } }>, p: string) => rows.find(row => row.path === p)!.action!.id;
    const cleanId = id(inventory.worktrees, machine.clean);
    const tmpId = id(inventory.space, path.join(machine.scratch, "train-old"));
    const paneId = inventory.sessions[0].action.id;

    // Between scan and approve the scratch folder gets used and the agent starts working.
    await writeFile(path.join(machine.scratch, "train-old", "g"), "new");
    status = "working";
    const first = await housekeeper.approve([cleanId, tmpId, paneId], "phone");
    expect(first.results).toEqual([
      { id: cleanId, status: "done", freedBytes: 0 },
      { id: tmpId, status: "refused", reason: "It was changed in the last day." },
      { id: paneId, status: "refused", reason: "Its agent is working." },
    ]);
    await expect(stat(machine.clean)).rejects.toThrow();
    expect((await stat(path.join(machine.scratch, "train-old"))).isDirectory()).toBe(true);
    expect(closed).toEqual([]);

    status = "idle";
    expect((await housekeeper.approve([paneId], "phone")).results).toEqual([{ id: paneId, status: "done", freedBytes: 0 }]);
    expect(closed).toEqual(["p1"]);
    const after = (await housekeeper.view())!;
    expect(after.inventory!.worktrees.map(row => row.path)).not.toContain(machine.clean);
    expect(after.inventory!.sessions).toEqual([]);
    expect(after.cleaned.map(entry => [entry.area, entry.by])).toEqual([["worktrees", "phone"], ["sessions", "phone"]]);
  });
});
