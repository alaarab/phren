import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  launchdLabels, parseDiagnosticReports, parseFailedUnits, parseJournalSize, parseLaunchdService, parseNvidia, parseOomKills,
  parseSystemdRestarts, parseTimeMachine, parseUpdates, PlatformProbes, PROBE_EVERY_MS, staleLocks,
} from "./machine-probes.js";
import { MachineHealth } from "./machine-health.js";

const DAY = 86_400_000;
const ids = (fs: Array<{ id: string; severity: string } | undefined>) => fs.filter(Boolean).map(f => `${f!.id}/${f!.severity}`);

describe("machine probes", () => {
  it("finds a launchd agent in a restart loop and leaves interval jobs alone", () => {
    expect(launchdLabels("PID\tStatus\tLabel\n-\t78\tdev.herdr.server\n412\t0\tcom.apple.Finder\n")).toEqual(["dev.herdr.server"]);
    const loop = parseLaunchdService("dev.herdr.server", "\tstate = waiting\n\truns = 66012\n\tlast exit code = 78: EX_CONFIG\n");
    expect(ids([loop])).toEqual(["restart-loop:dev.herdr.server/high"]);
    expect(loop!.detail).toContain("EX_CONFIG");
    expect(parseLaunchdService("sync", "\truns = 9000\n\trun interval = 300 seconds\n")).toBeUndefined();
    expect(parseLaunchdService("ok", "\truns = 3\n")).toBeUndefined();
  });

  it("reads systemd restarts and failed units", () => {
    const show = "Id=herdr.service\nNRestarts=450\n\nId=sshd.service\nNRestarts=0\n";
    expect(ids(parseSystemdRestarts(show, "user"))).toEqual(["restart-loop:herdr.service/high"]);
    expect(parseSystemdRestarts(show, "user")[0].fix).toContain("--user");
    expect(ids(parseFailedUnits("● nginx.service loaded failed failed nginx\n", "system"))).toEqual(["failed-units:system/warn"]);
    expect(parseFailedUnits("", "system")).toEqual([]);
  });

  it("ages the latest Time Machine backup", () => {
    const now = new Date(2026, 9, 31, 12).getTime();
    expect(parseTimeMachine("/Volumes/TM/Backups.backupdb/mini/2026-10-30-101112", now)).toBeUndefined();
    expect(ids([parseTimeMachine("2026-10-25-101112.backup", now)])).toEqual(["backup:time-machine/warn"]);
    expect(ids([parseTimeMachine("2026-10-01-000000.backup", now)])).toEqual(["backup:time-machine/high"]);
    expect(parseTimeMachine("No machine directory found", now)).toBeUndefined();
  });

  it("counts pending updates", () => {
    const mac = "Software Update found the following:\n* Label: macOS 27.1-27B5\n\tTitle: macOS 27.1, Version: 27.1, Size: 9G, Recommended: YES, Action: restart,\n";
    expect(ids([parseUpdates(mac, "softwareupdate")])).toEqual(["os-updates/warn"]);
    expect(parseUpdates("linux-firmware 1 -> 2\nmesa 3 -> 4\n", "checkupdates")!.title).toBe("2 pending updates");
    expect(parseUpdates("Listing...\nvim/noble 2:9.1 amd64 [upgradable from: 2:9.0]\n", "apt")!.detail).toContain("vim");
    expect(parseUpdates("No new software available.\n", "softwareupdate")).toBeUndefined();
  });

  it("groups crash reports, jetsam and panics", () => {
    const names = [...Array.from({ length: 4 }, (_, i) => `herdr-2026-10-31-10000${i}.ips`), "Safari-2026-10-31-100000.ips",
      "JetsamEvent-2026-10-31-100000.ips", "panic-full-2026-10-31-100000.panic"];
    expect(ids(parseDiagnosticReports(names))).toEqual(["crashes:kernel/high", "oom/warn", "crashes:herdr/warn"]);
  });

  it("reads Linux OOM kills, journal size and NVIDIA errors", () => {
    expect(parseOomKills("Out of memory: Killed process 4242 (postgres) total-vm:1kB\n")!.detail).toContain("postgres");
    expect(ids([parseJournalSize("Archived and active journals take up 6.2G in the file system.")])).toEqual(["journal/warn"]);
    expect(parseJournalSize("take up 300.0M in the file system.")).toBeUndefined();
    expect(ids(parseNvidia("0, NVIDIA RTX 6000, 2, 71\n1, NVIDIA RTX 6000, [N/A], 92\n", "NVRM: Xid (PCI:0000:01:00): 79, pid=1\n")))
      .toEqual(["gpu:ecc-0/high", "gpu:temp-1/warn", "gpu:xid/high"]);
  });

  it("names locks whose owner exited", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "locks-"));
    const old = (Date.now() - 2 * 3_600_000) / 1000;
    for (const [file, pid] of [["dead.json.lock", 999_001], ["live.json.lock", 999_002], ["fresh.json.lock", 999_001]] as const) {
      writeFileSync(path.join(dir, file), `${pid}\n0`);
      if (file !== "fresh.json.lock") utimesSync(path.join(dir, file), old, old);
    }
    const found = await staleLocks({ lockDirs: [dir], alive: pid => pid === 999_002, now: Date.now });
    expect(found!.detail).toContain("dead.json.lock");
    expect(found!.detail).not.toContain("live");
    expect(found!.detail).not.toContain("fresh");
  });

  it("runs due probes in the background and merges their findings into each read", async () => {
    let now = 0, runs = 0;
    const probe = { name: "p", everyMs: PROBE_EVERY_MS, platforms: ["darwin"], run: async () => {
      runs++; return [{ id: "backup", check: "backup" as const, severity: "high" as const, title: "t", detail: "", fix: "" }];
    } };
    const probes = new PlatformProbes({ platform: "darwin", now: () => now, lockDirs: [] }, [probe]);
    expect(probes.current()).toEqual([]);
    await probes.refresh();
    now = PROBE_EVERY_MS - 1;
    expect(probes.current().map(f => f.id)).toEqual(["backup"]);
    expect(runs).toBe(1);
    now = PROBE_EVERY_MS;
    await probes.refresh();
    expect(runs).toBe(2);
    expect(new PlatformProbes({ platform: "linux", now: () => now }, [probe]).current()).toEqual([]);

    const health = new MachineHealth(probes);
    const value = { collectedAt: "", platform: "darwin", uptimeSeconds: 40 * DAY / 1000, cpu: { cores: 8, load1: 0, load5: 0, load15: 0, loadPerCore: 0 },
      memory: { totalBytes: 1 }, heavy: [], pressure: { cpu: 0, memory: 0, disk: 0, overall: 0 }, level: "ok" as const, warnings: [] };
    expect(health.assess(value, [], now).map(f => f.id)).toEqual(["backup", "uptime"]);
  });
});
