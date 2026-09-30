import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { heavyProcesses } from "./resources.js";
import { JobRegistry, CLEANUP_LEASE_MS, paneKey, planCleanup, resolveJobGroups, type JobPane, type ProcessLike, type TrackedJob } from "./job-registry.js";

const proc = (pid: number, ppid: number, pgid: number, command: string, args = command, startedAt?: number): ProcessLike =>
  ({ pid, ppid, pgid, command, args, ...(startedAt !== undefined ? { startedAt } : {}) });
const servers = new Set(["default"]);
const pane = (over: Partial<JobPane> = {}): JobPane => ({ server: "default", pane: "w1:p1", ...over });
const job = (over: Partial<TrackedJob> = {}): TrackedJob => ({ pgid: 500, pane: pane(), command: "xcodebuild", startedAt: 0, ...over });

const dirs: string[] = [];
const tempFile = (): string => { const dir = mkdtempSync(path.join(tmpdir(), "phren-jobs-")); dirs.push(dir); return path.join(dir, "jobs.json"); };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("job registry", () => {
  it("fills a job's process group from the pane it owns", () => {
    const owners = new Map<number, JobPane>([[700, pane({ pane: "w1:p1" })]]);
    const rows = [proc(700, 1, 1234, "/bin/zsh"), proc(701, 700, 1234, "/bin/claude")];
    expect(resolveJobGroups([job({ pgid: undefined })], rows, owners)).toEqual([job({ pgid: 1234 })]);
    // A job with no pane, or an unresolved pane, keeps no group.
    expect(resolveJobGroups([job({ pgid: undefined, pane: undefined })], rows, owners)[0].pgid).toBeUndefined();
    expect(resolveJobGroups([job({ pgid: undefined, pane: pane({ pane: "w9:p9" }) })], rows, owners)[0].pgid).toBeUndefined();
    // A recorded group is never overwritten.
    expect(resolveJobGroups([job({ pgid: 42 })], rows, owners)[0].pgid).toBe(42);
  });

  it("ends only an owned group whose pane is gone, after the lease, matching the command", () => {
    const now = 10 * CLEANUP_LEASE_MS;
    const live = new Set([paneKey(pane({ pane: "alive" }))]);
    const stale = { ...job({ pgid: 500, leaderStartedAt: 1_000, startedAt: now - CLEANUP_LEASE_MS - 1 }) };
    const rows = [
      proc(1, 0, 1, "/sbin/init"),
      proc(500, 1, 500, "/usr/bin/xcodebuild", "xcodebuild test", 1_000),
      proc(600, 1, 600, "/usr/bin/claude"),
      proc(700, 1, 700, "/usr/bin/claude"),
      proc(800, 1, 800, "/bin/sh"),
      proc(900, 1, 900, "/usr/bin/node", "node server.js"),
      proc(999, 1, 999, "/usr/bin/phren-hook"),
    ];
    const jobs = [
      stale,
      job({ pgid: 600, pane: pane({ pane: "alive" }) }),
      job({ pgid: 700, startedAt: now }),
      job({ pgid: 900, command: "claude", startedAt: now - CLEANUP_LEASE_MS - 1 }),
      { ...job({ pgid: undefined, pane: pane({ pane: "gone" }) }), startedAt: now - CLEANUP_LEASE_MS - 1 },
      { ...job({ pgid: undefined, pane: pane({ pane: "alive" }) }), startedAt: now },
      { pgid: 999, command: "phren-hook", startedAt: now - CLEANUP_LEASE_MS - 1 } as TrackedJob,
    ];
    const plan = planCleanup(jobs, rows, live, { now, selfPid: 999, servers });
    expect(plan.kill.map(item => item.pgid)).toEqual([500]);
    expect(plan.forget.map(item => item.pgid)).toEqual([undefined]);
    expect(Object.fromEntries(plan.keep.map(({ job: kept, reason }) => [kept.pgid, reason]))).toEqual({
      600: "pane-alive", 700: "lease", 900: "reused", 999: "reserved", undefined: "unresolved",
    });
  });

  it("never signals the Hook's own group, and nothing when the pane set is unknown", () => {
    const now = 10 * CLEANUP_LEASE_MS;
    const own = { pid: 999, ppid: 1, pgid: 999, command: "/usr/bin/phren-hook", args: "phren-hook" };
    const rows = [own, proc(1000, 999, 999, "/bin/sh")];
    const selfGroup = job({ pgid: 999, pane: pane({ pane: "gone" }), startedAt: now - CLEANUP_LEASE_MS - 1 });
    const descendant = job({ pgid: 999, pane: pane({ pane: "gone" }), startedAt: now - CLEANUP_LEASE_MS - 1 });
    expect(planCleanup([selfGroup, descendant], rows, new Set(), { now, selfPid: 999 }).kill).toEqual([]);
    expect(planCleanup([selfGroup, descendant], rows, new Set(), { now, selfPid: 999 }).keep.map(item => item.reason)).toEqual(["reserved", "reserved"]);
    // A failed pane read is "unknown": nothing ends, nothing is forgotten.
    const unknown = planCleanup([selfGroup], rows, new Set(), { now, selfPid: 1, panesKnown: false });
    expect(unknown.kill).toEqual([]); expect(unknown.forget).toEqual([]); expect(unknown.keep[0].reason).toBe("unknown");
  });

  it("forgets a reused group id once its record is old, and a group that is gone", () => {
    const now = 10 * CLEANUP_LEASE_MS;
    const reused = job({ pgid: 900, command: "claude", startedAt: now - CLEANUP_LEASE_MS - 1 });
    const gone = job({ pgid: 800, startedAt: now - CLEANUP_LEASE_MS - 1 });
    const plan = planCleanup([reused, gone], [proc(900, 1, 900, "/usr/bin/node", "node server.js")], new Set(), { now, retainMs: CLEANUP_LEASE_MS, servers });
    expect(plan.kill).toEqual([]);
    expect(plan.forget.map(item => item.pgid).sort()).toEqual([800, 900]);
  });

  it("persists registrations, resolves groups and only cleans what it owns", async () => {
    const file = tempFile();
    const registry = new JobRegistry(file, () => 0);
    await registry.register({ pane: pane({ pane: "w1:p1" }), agent: "claude", command: "claude", label: "Worker" });
    expect(await registry.list()).toEqual([job({ pgid: undefined, agent: "claude", command: "claude", label: "Worker", startedAt: 0 })]);

    const owners = new Map<number, JobPane>([[700, pane({ pane: "w1:p1" })]]);
    const rows = [proc(700, 1, 4242, "/bin/claude")];
    const resolved = await registry.reconcile(rows, owners);
    expect(resolved[0].pgid).toBe(4242);
    expect((await registry.list())[0].pgid).toBe(4242);

    const signals: Array<[number, string]> = [];
    const report = await registry.cleanup([proc(700, 1, 4242, "/bin/claude")], new Set(), {
      owners, servers, now: CLEANUP_LEASE_MS + 1, leaseMs: CLEANUP_LEASE_MS, kill: (pgid, signal) => signals.push([pgid, signal]),
    });
    expect(report.killed).toEqual([4242]);
    expect(signals).toEqual([[4242, "SIGTERM"]]);
    expect(await registry.list()).toEqual([]);
  });

  it("never ends a job whose server did not list its panes", () => {
    const now = 10 * CLEANUP_LEASE_MS;
    const stale = job({ pgid: 500, leaderStartedAt: 1_000, startedAt: 0, pane: pane({ server: "hung" }) });
    const rows = [proc(500, 1, 500, "/usr/bin/xcodebuild", "xcodebuild test", 1_000)];
    // "hung" answered no snapshot, so its panes are unknown, not gone.
    const plan = planCleanup([stale], rows, new Set(), { now, selfPid: 999, servers });
    expect(plan.kill).toEqual([]);
    expect(plan.keep.map(item => item.reason)).toEqual(["server-unknown"]);
    // No server list at all: nothing is ended.
    expect(planCleanup([job({ pgid: 500, leaderStartedAt: 1_000, startedAt: 0 })], rows, new Set(), { now, selfPid: 999 }).kill).toEqual([]);
  });

  it("ends a group only while its leader is the one recorded with it", () => {
    const now = 10 * CLEANUP_LEASE_MS;
    const recorded = job({ pgid: 500, command: "claude", leaderStartedAt: 1_000, startedAt: 0 });
    const plan = (leaderStart?: number, withLeader = true) => planCleanup([recorded],
      [...(withLeader ? [proc(500, 1, 500, "/usr/bin/claude", "claude", leaderStart)] : []), proc(501, 500, 500, "/usr/bin/claude", "claude")],
      new Set(), { now, selfPid: 999, servers });
    // Same leader, to within ps's second: ended.
    expect(plan(2_500).kill.map(item => item.pgid)).toEqual([500]);
    // A newer program leads a reused group id: left alone, even running claude.
    expect(plan(now - 1_000).kill).toEqual([]);
    expect(plan(now - 1_000).keep.map(item => item.reason)).toEqual(["leader-unverified"]);
    // A leader whose start can't be read can't be verified either.
    expect(plan(undefined).kill).toEqual([]);
    // Leader gone, members left: the group still holds its id, so it is the original.
    expect(plan(undefined, false).kill.map(item => item.pgid)).toEqual([500]);
    // A job recorded without a leader start is never ended while a leader lives.
    expect(planCleanup([job({ pgid: 500, command: "claude", startedAt: 0 })], [proc(500, 1, 500, "/usr/bin/claude", "claude", 1_000)],
      new Set(), { now, selfPid: 999, servers }).kill).toEqual([]);
  });

  it("records the leader's start with the group it resolves", () => {
    const owners = new Map<number, JobPane>([[700, pane({ pane: "w1:p1" })]]);
    const rows = [proc(700, 1, 700, "/bin/zsh", "-zsh", 5_000), proc(701, 700, 700, "/bin/claude", "claude", 6_000)];
    expect(resolveJobGroups([job({ pgid: undefined })], rows, owners)[0]).toMatchObject({ pgid: 700, leaderStartedAt: 5_000 });
  });

  it("attributes a detached worker and its helpers to the owning agent by process group", () => {
    const tracked: TrackedJob[] = [job({ pgid: 500, command: "claude", pane: pane({ agent: "claude" }), startedAt: 0 })];
    const rows = [
      proc(500, 1, 500, "/Users/me/.local/share/claude/versions/2.1.283", "claude"),
      proc(501, 500, 500, "/bin/node", "node helper.js"),
    ];
    const heavy = heavyProcesses(rows, new Map(), tracked);
    expect(heavy).toHaveLength(1);
    expect(heavy[0]).toMatchObject({ kind: "claude", processes: 2, tracked: true, agent: "claude", resourceReason: "tracked" });
    expect(heavy[0].pane?.pane).toBe("w1:p1");
  });

  it("keeps two registered workers' helper processes apart", () => {
    const jobs: TrackedJob[] = [
      job({ pgid: 500, command: "node", pane: pane({ pane: "w1:p1", agent: "claude" }) }),
      job({ pgid: 600, command: "node", pane: pane({ pane: "w2:p2", agent: "codex" }) }),
    ];
    const rows = [proc(500, 1, 500, "/bin/node", "node a.js"), proc(600, 1, 600, "/bin/node", "node b.js")];
    const heavy = heavyProcesses(rows, new Map(), jobs);
    expect(heavy.map(item => [item.pane?.pane, item.agent, item.tracked, item.resourceReason]))
      .toEqual([["w1:p1", "claude", true, "tracked"], ["w2:p2", "codex", true, "tracked"]]);
  });
});
