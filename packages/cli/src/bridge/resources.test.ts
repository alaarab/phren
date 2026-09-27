import { describe, expect, it } from "vitest";
import { assess, collectResources, heavyProcesses, parseMeminfo, parsePmset, parsePs, parseSwap, type ProcessRow, ResourceMonitor } from "./resources.js";

const GB = 1024 ** 3;
const row = (pid: number, ppid: number, cpu: number, rssMB: number, command: string, args = command): ProcessRow =>
  ({ pid, ppid, cpu, rssKB: rssMB * 1024, command, args });

describe("resources", () => {
  it("parses ps output with spaces in program paths", () => {
    const rows = parsePs(
      "  10     1  12.5  2048 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild\n  11    10   3.0  1024 /Library/Some Dir/launchd_sim\n",
      "  10 xcodebuild test -scheme Phren\n  11 launchd_sim /Users/me/Library/Developer/XCTestDevices/ABC/data\n");
    expect(rows).toEqual([
      { pid: 10, ppid: 1, cpu: 12.5, rssKB: 2048, command: "/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild", args: "xcodebuild test -scheme Phren" },
      { pid: 11, ppid: 10, cpu: 3, rssKB: 1024, command: "/Library/Some Dir/launchd_sim", args: "launchd_sim /Users/me/Library/Developer/XCTestDevices/ABC/data" },
    ]);
  });

  it("attributes each process to its nearest heavy job and names the pane that started it", () => {
    const rows = [
      row(100, 1, 0, 10, "/bin/zsh"),
      row(200, 100, 20, 300, "/Users/me/.local/share/claude/versions/2.1.283", "claude"),
      row(300, 200, 40, 100, "/opt/homebrew/bin/codex", "codex exec"),
      row(400, 300, 90, 200, "/usr/bin/xcodebuild", "xcodebuild test"),
      row(401, 400, 50, 50, "/usr/bin/swift-frontend"),
      row(500, 1, 5, 400, "/Library/Developer/launchd_sim", "launchd_sim /Users/me/Library/Developer/XCTestDevices/X/data"),
      row(501, 500, 60, 800, "/sim/SpringBoard"),
      row(502, 500, 30, 700, "/sim/backboardd"),
      row(600, 1, 45, 100, "/usr/libexec/mdworker_shared"),
      row(601, 1, 30, 100, "/usr/libexec/mdworker_shared"),
      row(700, 1, 0.5, 500, "/usr/bin/java", "java -cp gradle-launcher.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10"),
      row(800, 1, 0, 50, "/sbin/idle"),
    ];
    const pane = { server: "default", pane: "w1:p1", workspace: "phren", agent: "claude" };
    const heavy = heavyProcesses(rows, new Map([[100, pane]]));
    expect(heavy.map(job => [job.kind, job.name, job.pid, job.processes, job.cpuPercent, job.pane?.pane])).toEqual([
      ["xcodebuild", "xcodebuild", 400, 2, 140, "w1:p1"],
      ["simulator", "Simulator test clone", 500, 3, 95, undefined],
      ["busy", "mdworker_shared", 600, 2, 75, undefined],
      ["codex", "Codex", 300, 1, 40, "w1:p1"],
      ["claude", "Claude Code", 200, 1, 20, "w1:p1"],
      ["gradle", "Gradle", 700, 1, 0.5, undefined],
    ]);
  });

  it("reads battery, swap and Linux memory", () => {
    expect(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t12%; discharging; 0:40 remaining present: true"))
      .toEqual({ percent: 12, charging: false, onAC: false });
    expect(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining")).toEqual({ percent: 100, charging: true, onAC: true });
    expect(parsePmset("Now drawing from 'AC Power'")).toBeUndefined();
    expect(parseSwap("total = 2048.00M  used = 798.50M  free = 1249.50M  (encrypted)")).toBe(Math.round(798.5 * 1024 ** 2));
    expect(parseMeminfo("MemTotal:  16000000 kB\nMemAvailable: 1600000 kB\nSwapTotal: 100 kB\nSwapFree: 40 kB\n"))
      .toEqual({ totalBytes: 16000000 * 1024, availablePercent: 10, pressure: "warn", swapUsedBytes: 60 * 1024 });
  });

  it("warns at under 10 GB free or load above twice the cores", () => {
    const base = { collectedAt: "", platform: "darwin", uptimeSeconds: 1, heavy: [],
      cpu: { cores: 10, load1: 5, load5: 5, load15: 5, loadPerCore: 0.5 }, memory: { totalBytes: 16 * GB, availablePercent: 70, pressure: "normal" as const },
      disk: { path: "~", totalBytes: 500 * GB, freeBytes: 300 * GB } };
    expect(assess(base)).toEqual({ pressure: { cpu: 0.25, memory: 0.3, disk: 0.2, overall: 0.3 }, level: "ok", warnings: [] });
    const lowDisk = assess({ ...base, disk: { ...base.disk, freeBytes: 4 * GB } });
    expect(lowDisk.level).toBe("stressed"); expect(lowDisk.warnings).toEqual(["disk-low"]); expect(lowDisk.pressure.disk).toBe(1);
    const loaded = assess({ ...base, cpu: { ...base.cpu, load1: 755, loadPerCore: 75.5 } });
    expect(loaded.warnings).toEqual(["load-high"]); expect(loaded.pressure.cpu).toBe(1);
    expect(assess({ ...base, cpu: { ...base.cpu, loadPerCore: 1.4 } }).level).toBe("busy");
  });

  it("collects once per interval and names panes only when there is a heavy job", async () => {
    let time = 0, owners = 0, processes = 0;
    const monitor = new ResourceMonitor({ now: () => time, home: () => process.cwd(), platform: "freebsd",
      processes: async () => { processes++; return [row(10, 1, 0, 1, "/bin/sh")]; },
      owners: async () => { owners++; return new Map(); } }, 10_000);
    const [a, b] = await Promise.all([monitor.read(), monitor.read()]);
    expect(a).toBe(b); expect(processes).toBe(1); expect(owners).toBe(0);
    expect(a.disk?.freeBytes).toBeGreaterThan(0);
    time = 9_999; await monitor.read(); expect(processes).toBe(1);
    time = 10_000; await monitor.read(); expect(processes).toBe(2);
    const busy = await collectResources({ now: () => 0, home: () => process.cwd(), platform: "freebsd",
      processes: async () => [row(10, 1, 80, 1, "/usr/bin/xcodebuild")], owners: async () => { owners++; return new Map(); } });
    expect(owners).toBe(1); expect(busy.heavy[0].kind).toBe("xcodebuild");
  });
});
