import { describe, expect, it } from "vitest";
import { assess, collectResources, heavyKind, heavyProcesses, parseMeminfo, parsePmset, parsePs, parseSwap, type ProcessRow, ResourceMonitor } from "./resources.js";

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

  it("counts a Codex launcher, native child and helpers once without absorbing a nested worker or build", () => {
    const pane = { server: "default", pane: "w1:p1", workspace: "Conductor" };
    const rows = [row(10, 1, 0, 20, "/bin/zsh"),
      row(20, 10, 0, 30, "/usr/bin/node", "node /usr/local/bin/codex"),
      row(21, 20, 0, 220, "/vendor/bin/codex"),
      row(22, 21, 0, 40, "/vendor/bin/codex-code-mode-host"),
      row(23, 21, 1, 25, "/bin/node", "node phren mcp"),
      row(30, 21, 12, 100, "/vendor/bin/codex", "codex exec -"),
      row(40, 21, 70, 100, "/usr/bin/xcodebuild"),
      row(41, 40, 30, 50, "/usr/bin/swift-frontend")];
    const jobs = heavyProcesses(rows, new Map([[10, pane]]));
    expect(jobs.map(j => [j.pid, j.processes, j.cpuPercent, j.memoryBytes / 1024 ** 2, j.resourceReason])).toEqual([
      [40, 2, 100, 150, "cpu"], [30, 1, 12, 100, "cpu"], [20, 4, 1, 315, "memory"],
    ]);
    expect(jobs.every(j => j.pane === pane)).toBe(true);
    // Reversing ps order must not change ownership or totals.
    expect(heavyProcesses([...rows].reverse(), new Map([[10, pane]]))).toEqual(jobs);
  });

  it("keeps memory diagnostics without equating idle/helper processes to active sessions", () => {
    const jobs = heavyProcesses([
      row(10, 1, 0, 250, "/bin/codex", "codex app-server --listen unix:///tmp/codex.sock"),
      row(11, 10, 0, 30, "/bin/codex-code-mode-host"),
      row(20, 1, 0, 200, "/bin/codex", "codex mcp-server"),
      row(30, 1, 0, 199, "/bin/codex"),
      row(40, 1, 9.9, 1, "/bin/codex"),
      row(50, 1, 10, 1, "/bin/codex"),
      row(60, 1, 0, 1, "/bin/launchd_sim"),
    ]);
    expect(jobs.map(j => [j.name, j.processes, j.resourceReason])).toEqual([
      ["Codex", 1, "cpu"], ["Codex app server", 2, "memory"], ["Codex MCP server", 1, "memory"],
    ]);
    expect(jobs.filter(j => j.kind === "codex").reduce((sum, j) => sum + j.memoryBytes, 0)).toBe(481 * 1024 ** 2);
  });

  it("classifies executables without matching names in unrelated arguments", () => {
    for (const command of ["/bin/sh", "/usr/bin/python", "/some/tool/2.1.283"]) {
      expect(heavyKind(row(10, 1, 80, 500, command,
        `${command} investigate /sdk/emulator/qemu/bin/qemu-system-aarch64 claude codex`))).toBeUndefined();
    }
    expect(heavyKind(row(10, 1, 10, 200, "/Users/me/.local/share/claude/versions/2.1.283", "worker --prompt")))
      .toEqual({ kind: "claude", name: "Claude Code" });
    expect(heavyKind(row(10, 1, 10, 200, "/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64")))
      .toEqual({ kind: "emulator", name: "Android emulator" });
    expect(heavyKind(row(10, 1, 10, 200, "/usr/bin/node", "node unrelated.js /usr/local/bin/codex"))).toBeUndefined();
    expect(heavyProcesses([row(10, 1, 80, 500, "/bin/sh", "sh -c /sdk/emulator/qemu/bin/codex")])[0])
      .toMatchObject({ kind: "busy", name: "sh" });
  });

  it("requires CPU or memory use for every known job, including simulators and emulators", () => {
    for (const command of ["/bin/launchd_sim", "/sdk/emulator", "/bin/codex", "/bin/claude", "/bin/opencode", "/bin/java", "/bin/xcodebuild"]) {
      expect(heavyProcesses([row(10, 1, 9.9, 199, command)])).toEqual([]);
      expect(heavyProcesses([row(10, 1, 10, 1, command)])[0]).toMatchObject({ resourceReason: "cpu" });
      expect(heavyProcesses([row(10, 1, 0, 200, command)])[0]).toMatchObject({ resourceReason: "memory" });
      expect(heavyProcesses([row(10, 1, 0, 1, command), row(11, 10, 10, 1, "/bin/helper")])[0])
        .toMatchObject({ pid: 10, processes: 2, resourceReason: "cpu" });
    }
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
