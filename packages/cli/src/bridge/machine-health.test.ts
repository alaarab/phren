import { describe, expect, it } from "vitest";
import { assessHealth, MachineHealth, SAMPLE_EVERY_MS } from "./machine-health.js";
import type { ComputerResources, ProcessRow } from "./resources.js";

const GB = 1024 ** 3, HOUR = 3_600_000, NOW = 1_800_000_000_000;
const row = (pid: number, command: string, rssGB = 0.1, cpu = 0, extra: Partial<ProcessRow> = {}): ProcessRow =>
  ({ pid, ppid: 300, pgid: pid, cpu, rssKB: Math.round(rssGB * GB / 1024), command, args: command, ...extra });
const resources = (over: Partial<ComputerResources> = {}): ComputerResources => ({
  collectedAt: "", platform: "darwin", uptimeSeconds: 3_600,
  cpu: { cores: 10, load1: 1, load5: 1, load15: 1, loadPerCore: 0.1 },
  memory: { totalBytes: 32 * GB, swapUsedBytes: 0 }, disk: { path: "~", totalBytes: 1000 * GB, freeBytes: 400 * GB },
  heavy: [], pressure: { cpu: 0, memory: 0, disk: 0, overall: 0 }, level: "ok", warnings: [], ...over });
const ids = (findings: { id: string; severity: string }[]) => findings.map(f => `${f.id}/${f.severity}`);

describe("machine health", () => {
  it("says nothing about a healthy computer", () => {
    expect(assessHealth(resources(), [row(1, "/usr/sbin/syslogd")], [], NOW)).toEqual([]);
  });

  it("flags a daemon holding most of memory, swap and a nearly full disk, worst first", () => {
    const value = resources({ memory: { totalBytes: 32 * GB, swapUsedBytes: 30 * GB }, disk: { path: "~", totalBytes: 500 * GB, freeBytes: 5 * GB }, uptimeSeconds: 38 * 86_400 });
    const findings = assessHealth(value, [row(88, "/usr/sbin/fseventsd", 20)], [], NOW);
    expect(ids(findings)).toEqual(["swap/high", "disk/high", "memory-hog:fseventsd/high", "uptime/info"]);
    expect(findings.every(f => f.fix.length > 0)).toBe(true);
  });

  it("tells a thread or I/O pileup from real CPU load", () => {
    const loaded = resources({ cpu: { cores: 10, load1: 216, load5: 200, load15: 150, loadPerCore: 21.6 } });
    expect(ids(assessHealth(loaded, [row(1, "launchd_sim", 0.5, 40)], [], NOW))).toEqual(["load:pileup/warn"]);
    expect(ids(assessHealth(loaded, [row(1, "xcodebuild", 1, 950)], [], NOW))).toEqual(["load:cpu/high"]);
  });

  it("catches growth against the sample from half an hour ago", () => {
    const health = new MachineHealth();
    health.assess(resources(), [row(88, "fseventsd", 1)], NOW - HOUR);
    const later = resources({ memory: { totalBytes: 32 * GB, swapUsedBytes: 5 * GB }, disk: { path: "~", totalBytes: 1000 * GB, freeBytes: 390 * GB } });
    expect(ids(health.assess(later, [row(88, "fseventsd", 4)], NOW))).toEqual(["swap/warn", "disk/warn", "memory-leak:fseventsd/warn"]);
  });

  it("names orphans by pattern and age, and leaked simulator clones", () => {
    const orphan = (pid: number, args: string, startedAt: number) => row(pid, args.split(" ")[0], 0.1, 0, { ppid: 1, args, startedAt });
    const rows = [
      orphan(10, "/usr/bin/simctl io booted recordVideo out.mov", NOW - 12 * 86_400_000),
      orphan(11, "/usr/bin/simctl io booted recordVideo fresh.mov", NOW - 60_000),
      ...Array.from({ length: 9 }, (_, i) => row(100 + i, "launchd_sim", 0.2, 0, { args: "launchd_sim /Users/me/Library/Developer/XCTestDevices/X/data" })),
    ];
    const findings = assessHealth(resources(), rows, [], NOW);
    expect(ids(findings)).toEqual(["orphan:simctl-record/high", "simulator-clones/warn"]);
    expect(findings[0].title).toBe("1 orphaned simctl-record process");
  });

  it("keeps one sample per interval", () => {
    const health = new MachineHealth();
    health.assess(resources(), [], NOW);
    health.assess(resources({ memory: { totalBytes: 32 * GB, swapUsedBytes: 10 * GB } }), [], NOW + SAMPLE_EVERY_MS / 2);
    // The half-interval read was not sampled, so 40 minutes on there is still only the first sample to compare with.
    expect(health.assess(resources({ memory: { totalBytes: 32 * GB, swapUsedBytes: 5 * GB } }), [], NOW + 40 * 60_000).map(f => f.id)).toEqual(["swap"]);
  });
});
