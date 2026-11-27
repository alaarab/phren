import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthFinding } from "../machine-health.js";
import { OwnerInbox } from "../owner-inbox.js";
import type { ComputerResources } from "../resources.js";
import { createRouteHandler } from "../server-routes.js";
import { type Check, boundedBadge, Housekeeper, HousekeepingStore, healthCheck } from "./housekeeper.js";
import { approveResultSchema, type Badge, type ItemDraft, viewSchema } from "./report.js";

const GB = 1024 ** 3;
const created: string[] = [];
afterEach(async () => { for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp() { const dir = await realpath(await mkdtemp(path.join(tmpdir(), "phren-hk-report-"))); created.push(dir); return dir; }

function resources(options: { freeGB?: number; level?: ComputerResources["level"]; health?: HealthFinding[] } = {}): ComputerResources {
  const stressed = options.level === "stressed";
  return {
    collectedAt: new Date(0).toISOString(), platform: "darwin", uptimeSeconds: 1,
    cpu: { cores: 10, load1: stressed ? 60 : 2, load5: 2, load15: 2, loadPerCore: stressed ? 6 : 0.2 },
    memory: { totalBytes: 32 * GB, availablePercent: 25, pressure: "normal" },
    disk: { path: "/Users/a", totalBytes: 500 * GB, freeBytes: (options.freeGB ?? 100) * GB },
    heavy: [], pressure: { cpu: 0, memory: 0, disk: 0, overall: 0 }, level: options.level ?? "ok", warnings: [], health: options.health ?? [],
  };
}

/** A check that returns whatever the test sets next. */
function scripted() {
  let next: ItemDraft[] = [];
  const check: Check = { name: "scripted", run: async () => next };
  return { check, set: (drafts: ItemDraft[]) => { next = drafts; } };
}

async function keeper(options: { checks?: Check[]; read?: () => ComputerResources; now?: () => number; dir?: string } = {}) {
  const store = new HousekeepingStore(options.dir ?? await temp());
  const housekeeper = new Housekeeper({ computer: "mini", resources: async () => (options.read ?? (() => resources()))(),
    processes: async () => [], panes: async () => [], checks: options.checks ?? [], store, freeBytes: async () => 0,
    ...(options.now ? { now: options.now } : {}) });
  return { housekeeper, store };
}

const worktree = (title: string, overrides: Partial<ItemDraft> = {}): ItemDraft => ({
  section: "suggestion", area: "worktrees", kind: "worktree", title, reason: "Merged into main, clean and pushed.",
  target: { path: "/Users/a/Projects/app-feature", repo: "/Users/a/Projects/app", branch: "feature" }, fingerprint: "merged-clean",
  action: "remove-worktree", actionLabel: "Remove worktree", sizeBytes: 2 * GB, ...overrides,
});
const finding = (id: string, check: HealthFinding["check"], severity: HealthFinding["severity"], title: string): HealthFinding =>
  ({ id, check, severity, title, detail: `${title} detail`, fix: "do the thing" });

describe("housekeeping reports", () => {
  it("keeps an item's id and since across passes while its state holds, whatever its wording", async () => {
    const { check, set } = scripted();
    let now = Date.parse("2026-11-15T10:00:00Z");
    const dir = await temp();
    const { housekeeper } = await keeper({ checks: [check], now: () => now, dir });
    set([worktree("app-feature, 2.0 GB")]);
    const first = (await housekeeper.view()) ?? (await housekeeper.run(), await housekeeper.view());
    now += 15 * 60_000;
    set([worktree("app-feature, 2.1 GB")]);
    await housekeeper.run();
    const second = await housekeeper.view();
    expect(second!.suggestions[0].id).toBe(first!.suggestions[0].id);
    expect(second!.suggestions[0].since).toBe("2026-11-15T10:00:00.000Z");
    expect(second!.revision).not.toBe(first!.revision);
    // A new state is a new item.
    set([worktree("app-feature, 2.1 GB", { fingerprint: "dirty" })]);
    await housekeeper.run();
    expect((await housekeeper.view())!.suggestions[0].id).not.toBe(first!.suggestions[0].id);
    // A restarted Hook serves the newest stored report.
    const restarted = await keeper({ dir });
    expect((await restarted.housekeeper.view())?.suggestions[0].title).toBe("app-feature, 2.1 GB");
  });

  it("never lets anything but a cache be automatic, and lists kept items apart", async () => {
    const { check, set } = scripted();
    const { housekeeper } = await keeper({ checks: [check] });
    set([
      worktree("tries to be auto", { section: "auto" }),
      worktree("held", { section: "kept", target: { path: "/Users/a/Projects/other" }, reason: "3 unpushed commits",
        blockers: [{ code: "unpushed-commits", detail: "3 commit(s) on no remote branch" }] }),
      { section: "auto", area: "disk", kind: "cache", title: "DerivedData/App-abc", reason: "Older than 14 days.", fingerprint: "old",
        target: { path: "/Users/a/Library/Developer/Xcode/DerivedData/App-abc" }, action: "delete-path", sizeBytes: 5 * GB },
    ]);
    await housekeeper.run();
    const view = (await housekeeper.view())!;
    expect(view.suggestions.map(item => item.title)).toEqual(["tries to be auto"]);
    expect(view.kept).toEqual([expect.objectContaining({ title: "held", reason: "3 unpushed commits" })]);
    // An automatic cache clean shows in `cleaned` once done, not as a suggestion.
    expect(JSON.stringify(view)).not.toContain("DerivedData");
  });

  it("reports a failed check instead of dropping the pass", async () => {
    const broken: Check = { name: "worktrees", run: async () => { throw new Error("git timed out"); } };
    const { housekeeper } = await keeper({ checks: [broken, healthCheck], read: () => resources({ freeGB: 15, health: [finding("disk", "disk", "warn", "15.0 GB free on the home volume")] }) });
    await housekeeper.run();
    const view = (await housekeeper.view())!;
    expect(view.errors).toEqual([{ check: "worktrees", message: "git timed out" }]);
    expect(view.warnings.map(item => item.id)).toEqual(["disk"]);
  });

  it("runs at once on a fresh low-disk or stressed edge, not on every read while it lasts", async () => {
    const { housekeeper } = await keeper();
    expect(housekeeper.observe(resources())).toBeUndefined();
    expect((await housekeeper.observe(resources({ freeGB: 15 })))?.trigger).toBe("low-disk");
    expect(housekeeper.observe(resources({ freeGB: 14 }))).toBeUndefined();
    expect((await housekeeper.observe(resources({ freeGB: 14, level: "stressed" })))?.trigger).toBe("high-load");
    expect(housekeeper.observe(resources())).toBeUndefined();
    expect((await housekeeper.observe(resources({ freeGB: 12 })))?.trigger).toBe("low-disk");
  });

  it("keeps fourteen days of reports and skips a torn newest file", async () => {
    let now = Date.parse("2026-11-01T00:00:00Z");
    const { housekeeper, store } = await keeper({ now: () => now });
    const old = await housekeeper.run();
    now += 15 * 86_400_000;
    const kept = await housekeeper.run();
    const names = await readdir(store.reports);
    expect(names).toEqual([expect.stringContaining(kept.id)]);
    expect(names[0]).not.toContain(old.id);
    await writeFile(path.join(store.reports, `20991231T000000Z-${"a".repeat(12)}.json`), "{\"torn");
    expect((await store.latest())?.id).toBe(kept.id);
  });
});

describe("housekeeping warnings", () => {
  it("are machine-health findings with their ids and wording, notifying for low disk at once and pressure once it lasts", async () => {
    let health = [
      finding("disk", "disk", "high", "8.0 GB free on the home volume"),
      finding("load:cpu", "load", "warn", "Load 60 on 10 cores"),
      finding("backup", "backup", "warn", "No backup in 9 days"),
      finding("simulator-clones", "simulator-clones", "warn", "12 simulator test clones running"),
    ];
    const { housekeeper } = await keeper({ checks: [healthCheck], read: () => resources({ freeGB: 8, health }) });
    await housekeeper.run();
    let view = (await housekeeper.view())!;
    expect(view.warnings.map(w => [w.id, w.area, w.severity, w.title, w.notify ?? false])).toEqual([
      ["disk", "disk", "high", "8.0 GB free on the home volume", true],
      ["simulator-clones", "simulators", "warn", "12 simulator test clones running", false],
      ["load:cpu", "memory", "warn", "Load 60 on 10 cores", false],
    ]);
    await housekeeper.run();
    view = (await housekeeper.view())!;
    expect(view.warnings.find(w => w.id === "load:cpu")?.notify).toBe(true);
    expect(view.warnings.find(w => w.id === "simulator-clones")?.notify).toBeUndefined();
    health = [];
    await housekeeper.run();
    expect((await housekeeper.view())!.warnings).toEqual([]);
  });
});

describe("dismissing", () => {
  it("hides an item until its state changes, lists it on request, and restores it", async () => {
    const { check, set } = scripted();
    const { housekeeper } = await keeper({ checks: [check] });
    set([worktree("app-feature")]);
    await housekeeper.run();
    const before = (await housekeeper.view())!;
    const id = before.suggestions[0].id;
    const { revision } = await housekeeper.dismiss([id, "unknown"]);
    expect(revision).not.toBe(before.revision);
    expect((await housekeeper.view())!.suggestions).toEqual([]);
    expect((await housekeeper.view(true))!.dismissed).toEqual([expect.objectContaining({ id, section: "suggestions", title: "app-feature" })]);
    await housekeeper.run();
    expect((await housekeeper.view())!.suggestions).toEqual([]);
    await housekeeper.restore([id]);
    expect((await housekeeper.view())!.suggestions.map(item => item.id)).toEqual([id]);

    // A fixed-id warning comes back when its severity changes.
    let severity: HealthFinding["severity"] = "warn";
    const health = await keeper({ checks: [healthCheck], read: () => resources({ freeGB: 15, health: [finding("disk", "disk", severity, "low")] }) });
    await health.housekeeper.run();
    await health.housekeeper.dismiss(["disk"]);
    await health.housekeeper.run();
    expect((await health.housekeeper.view())!.warnings).toEqual([]);
    severity = "high";
    await health.housekeeper.run();
    expect((await health.housekeeper.view())!.warnings.map(w => w.severity)).toEqual(["high"]);
  });
});

describe("housekeeping in the owner inbox", () => {
  // The disk-janitor's weekly inbox id collided with its own changed text and
  // failed every day ("This inbox id names another item").
  it("is one row per notifying warning while it lasts, and resolves itself when it goes", async () => {
    let health = [finding("disk", "disk", "warn", "15.0 GB free on the home volume")];
    const { housekeeper } = await keeper({ checks: [healthCheck], read: () => resources({ freeGB: 15, health }) });
    const inbox = new OwnerInbox(async () => housekeeper.inboxSources(), path.join(await temp(), "owner-inbox.json"));
    const open = async () => ((await inbox.run({ action: "list" })) as { items: Array<{ title: string }> }).items.map(item => item.title);

    await housekeeper.run();
    expect(await open()).toEqual(["Housekeeping on mini: 15.0 GB free on the home volume"]);
    health = [finding("disk", "disk", "warn", "14.2 GB free on the home volume")];
    await housekeeper.run();
    expect(await open()).toEqual(["Housekeeping on mini: 14.2 GB free on the home volume"]);
    health = [];
    await housekeeper.run();
    expect(await open()).toEqual([]);
  });
});

describe("approving", () => {
  async function pushedWorktree() {
    const base = await temp();
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: base,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
    const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)("git", ["-C", cwd, ...args], { env })).stdout;
    const remote = path.join(base, "remote.git"), root = path.join(base, "repo"), tree = path.join(base, "repo-feature");
    await mkdir(root);
    await git(base, "init", "-q", "--bare", remote);
    await git(root, "init", "-q", "-b", "main");
    await writeFile(path.join(root, "a.txt"), "one\n");
    await git(root, "add", "."); await git(root, "commit", "-qm", "start");
    await git(root, "remote", "add", "origin", remote); await git(root, "push", "-q", "origin", "main");
    await git(root, "worktree", "add", "-q", "-b", "feature", tree); await git(tree, "push", "-q", "origin", "feature");
    return { tree, git };
  }

  // Windows: git cannot remove a worktree a test process still holds open, and paths differ; housekeeping targets macOS and Linux (phren task).
  it.skipIf(process.platform === "win32")("re-checks safety against the disk, not the report, and records what it did", async () => {
    const { tree, git } = await pushedWorktree();
    const other = (await pushedWorktree()).tree;
    const { check, set } = scripted();
    const { housekeeper } = await keeper({ checks: [check] });
    // The report says both are safe to remove; one gains an unpushed commit after the pass.
    set([worktree("feature", { target: { path: tree } }), worktree("other", { target: { path: other } }),
      worktree("held", { section: "kept", target: { path: "/x" }, blockers: [{ code: "live-process", detail: "pid 7" }] }),
      { section: "warning", area: "disk", kind: "health", id: "disk", severity: "warn", title: "low", reason: "low", target: { name: "disk" }, fingerprint: "warn" }]);
    await housekeeper.run();
    const view = (await housekeeper.view())!;
    const [feature, otherItem] = ["feature", "other"].map(title => view.suggestions.find(item => item.title === title)!.id);
    await writeFile(path.join(other, "b.txt"), "b\n");
    await git(other, "add", "."); await git(other, "commit", "-qm", "local");

    const result = await housekeeper.approve([feature, otherItem, view.kept[0].id, "disk", "0123456789abcdef"], "phone");
    expect(approveResultSchema.parse(result)).toEqual(result);
    expect(result.results).toEqual([
      { id: feature, status: "done", freedBytes: 0 },
      { id: otherItem, status: "refused", reason: "It has commits that aren't on any remote." },
      { id: view.kept[0].id, status: "refused", reason: "A process is using it now." },
      { id: "disk", status: "refused", reason: "This is a warning; there is nothing to apply." },
      { id: "0123456789abcdef", status: "gone" },
    ]);
    await expect(stat(tree)).rejects.toThrow();
    expect((await stat(other)).isDirectory()).toBe(true);
    expect((await housekeeper.view())!.cleaned).toEqual([expect.objectContaining({ id: feature, area: "worktrees", by: "phone", freedBytes: 0, reportedBytes: 2 * GB })]);
  });
});

describe("the /v1/housekeeping contract", () => {
  function handler(housekeeper: Housekeeper) {
    return createRouteHandler({ modules: { has: () => true }, info: { computer: { id: "c1", name: "mini", aliases: [] } }, streams: {},
      agentHooks: { overview: { renew() {} }, pendingPanes: () => new Set() },
      journal: { record: async () => {} }, tabActivity: { observe: async () => ({ generation: 0, stamps: new Map() }), recordStatus: async () => new Map() },
      contextUsage: { read: async () => new Map() }, housekeeper,
    } as never);
  }
  async function call(route: ReturnType<typeof handler>, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    let text = "";
    const response = { statusCode: 200, setHeader() {}, end(value: string) { text = value; } };
    const request = { url, method, headers, [Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(JSON.stringify(body)); } };
    await route(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    return { status: response.statusCode, body: JSON.parse(text) };
  }

  it("serves the view, running a first pass when there is none, and keeps actions to the owner", async () => {
    const { check, set } = scripted();
    const { housekeeper } = await keeper({ checks: [check] });
    set([worktree("app-feature")]);
    const route = handler(housekeeper);
    const got = await call(route, "GET", "/v1/housekeeping");
    expect(got.status).toBe(200);
    const { computer, ...view } = got.body;
    expect(computer).toEqual({ id: "c1", name: "mini", aliases: [] });
    expect(viewSchema.parse(view)).toEqual(view);
    expect(view.suggestions[0].actionLabel).toBe("Remove worktree");

    const id = view.suggestions[0].id;
    expect((await call(route, "POST", "/v1/housekeeping/dismiss", { ids: [id] }, { "x-phren-origin": "agent" })).status).toBe(403);
    expect((await call(route, "POST", "/v1/housekeeping/approve", { ids: [id], origin: "peer" })).status).toBe(403);
    const dismissed = await call(route, "POST", "/v1/housekeeping/dismiss", { ids: [id] });
    expect(dismissed.status).toBe(200);
    expect((await call(route, "GET", "/v1/housekeeping")).body.revision).toBe(dismissed.body.revision);
  });

  it("adds the inventory only with ?inventory=1, starting a scan when there is none", async () => {
    // Empty roots: the test never measures this machine's own folders.
    const housekeeper = new Housekeeper({ computer: "mini", resources: async () => resources(), processes: async () => [], panes: async () => [], checks: [],
      store: new HousekeepingStore(await temp()), freeBytes: async () => 0,
      inventory: { roots: [], tmpRoots: [], rules: [], dispatches: async () => [],
        sessions: async () => [{ pane: { target: { server: "default", pane: "w1:p1" }, label: "worker" }, agent: "codex", status: "done", idleSeconds: 600 }] } });
    const route = handler(housekeeper);
    const first = await call(route, "GET", "/v1/housekeeping?inventory=1");
    expect(first.body.inventory).toBeUndefined();
    await housekeeper.scan(); // the one the request started, shared
    const plain = await call(route, "GET", "/v1/housekeeping");
    expect(plain.body.inventory).toBeUndefined();
    expect(plain.body.revision).not.toBe(first.body.revision);
    const full = await call(route, "GET", "/v1/housekeeping?inventory=1&dismissed=1");
    const { computer: _computer, ...view } = full.body;
    expect(viewSchema.parse(view)).toEqual(view);
    expect(view.inventory.sessions).toEqual([expect.objectContaining({ status: "done", idleSeconds: 600,
      action: expect.objectContaining({ kind: "close-pane", allowed: true, confirm: "Closes the pane and stops its agent." }) })]);
  });

  // The apps decode these fixtures in their own tests; they must match the schema the Hook serves.
  it.each(["housekeeping-report.json", "housekeeping-approve.json"])("fixture %s matches the schema", async name => {
    const fixture = JSON.parse(await readFile(new URL(`../../../fixtures/conformance/${name}`, import.meta.url), "utf8"));
    const schema = name.includes("approve") ? approveResultSchema : viewSchema;
    expect(schema.parse(fixture)).toEqual(fixture);
    if (name === "housekeeping-report.json") {
      // In the documented order: worktrees by path, space largest first, sessions most idle first.
      const { worktrees, space, sessions } = fixture.inventory;
      expect(worktrees.map((row: { path: string }) => row.path)).toEqual(worktrees.map((row: { path: string }) => row.path).sort());
      expect(space.map((row: { sizeBytes: number }) => row.sizeBytes)).toEqual(space.map((row: { sizeBytes: number }) => row.sizeBytes).sort((a: number, b: number) => b - a));
      expect(sessions.map((row: { idleSeconds?: number }) => row.idleSeconds ?? 0)).toEqual(sessions.map((row: { idleSeconds?: number }) => row.idleSeconds ?? 0).sort((a: number, b: number) => b - a));
      // The phone decodes a disabled row in every section.
      for (const rows of [fixture.inventory.worktrees, fixture.inventory.space, fixture.inventory.sessions])
        expect(rows.some((row: { action?: { allowed: boolean; reason?: string } }) => row.action && !row.action.allowed && row.action.reason)).toBe(true);
    }
    if (name.includes("report")) {
      const areas = new Set([...fixture.warnings, ...fixture.suggestions, ...fixture.kept, ...fixture.cleaned].map((item: { area: string }) => item.area));
      expect([...areas].sort()).toEqual(["disk", "docker", "memory", "sessions", "simulators", "worktrees"]);
    }
  });
});

describe("bounded badge", () => {
  it("falls back to the last good badge when a read outlives the wait, with one read in flight", async () => {
    vi.useFakeTimers();
    let reads = 0;
    let release!: (value: Badge | undefined) => void;
    const first = new Promise<Badge | undefined>(resolve => { release = resolve; });
    const badge = boundedBadge(() => { reads++; return reads === 1 ? first : new Promise<Badge | undefined>(() => {}); }, 2_000);
    const timed = badge();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(timed).resolves.toBeUndefined();
    const good: Badge = { revision: "rev", warnings: 1, suggestions: 0, worst: null, freedTodayBytes: 0 };
    release(good);
    await vi.advanceTimersByTimeAsync(0);
    // Both calls share the one read still in flight, and fall back to the last good badge.
    const joined = [badge(), badge()];
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads).toBe(2);
    await expect(joined[0]).resolves.toEqual(good);
    await expect(joined[1]).resolves.toEqual(good);
  });
});
