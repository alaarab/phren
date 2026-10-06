import { describe, expect, it } from "vitest";
import type { ComputerResources } from "../bridge/resources.js";
import { combineUsage, pickComputer, readComputers, readUsage, resetsIn } from "./read.js";

const GB = 1024 ** 3;
function resources(platform: string, load1: number, freeGB: number, level: ComputerResources["level"] = "ok", overall = load1 / 20): ComputerResources {
  return { collectedAt: "2026-09-26T00:00:00Z", platform, uptimeSeconds: 60, heavy: [],
    cpu: { cores: 10, load1, load5: load1, load15: load1, loadPerCore: load1 / 10 }, memory: { totalBytes: 16 * GB, availablePercent: 60 },
    disk: { path: "~", totalBytes: 500 * GB, freeBytes: freeGB * GB }, pressure: { cpu: 0, memory: 0, disk: 0, overall }, level, warnings: level === "stressed" ? ["load-high"] : [] };
}

describe("computers surface", () => {
  it("reads this computer and its peers from the Hook alone", async () => {
    const routes: string[] = [];
    const report = await readComputers({ request: async route => {
      routes.push(route);
      return { computer: { id: "1", name: "mini" }, resources: resources("darwin", 30, 20) as never,
        peers: [{ name: "macbook", computer: { name: "macbook" }, resources: resources("darwin", 2, 200) as never },
          { name: "linux", error: "The remote Hook is offline", code: "peer-offline" }] };
    } });
    expect(routes).toEqual(["/v1/resources?peers=1"]);
    expect(report.computers.map(c => [c.name, c.local, c.online])).toEqual([["mini", true, true], ["macbook", false, true], ["linux", false, false]]);
  });

  it("falls back to this computer's own reading when no Hook answers", async () => {
    const report = await readComputers({ request: async () => { throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }); },
      localFallback: async () => resources("darwin", 1, 100) });
    expect(report.hookError).toContain("not running");
    expect(report.computers).toHaveLength(1);
    expect(report.computers[0].resources?.cpu.load1).toBe(1);
  });

  it("picks the least-loaded Mac, stressed ones last", () => {
    const computers = [
      { name: "mini", local: true, online: true, resources: resources("darwin", 30, 20, "stressed", 1) },
      { name: "macbook", local: false, online: true, resources: resources("darwin", 8, 200) },
      { name: "linux", local: false, online: true, resources: resources("linux", 0, 400) },
      { name: "old", local: false, online: false, error: "offline" },
    ];
    const mac = pickComputer(computers);
    expect(mac.pick?.name).toBe("macbook");
    expect(mac.ranked.map(item => item.name)).toEqual(["macbook", "mini"]);
    expect(pickComputer(computers, "any").pick?.name).toBe("linux");
    expect(pickComputer(computers, "mac", ["macbook"]).reason).toContain("Every candidate is stressed");
    expect(pickComputer([], "linux").pick).toBeUndefined();
  });

  it("reports every harness, says when one has nothing, and combines limits and spend", async () => {
    const now = Date.parse("2026-09-26T12:00:00Z");
    const report = await readUsage({ now, request: async route => {
      expect(route).toBe("/v1/usage?sources=claude%2Ccodex%2Ccopilot%2Copencode%2Copencode-go%2Copenrouter&goPlan=1&peers=1");
      return { computer: { name: "mini" }, accounts: [
        { source: "claude", windows: [{ id: "five_hour", name: "5-hour limit", usedPercent: 30, resetsAt: "2026-09-26T13:30:00Z" }], updatedAt: "2026-09-26T11:00:00Z", origin: "oauth" },
        { source: "opencode", windows: [], spend: { amountUSD: 1.5, period: "rolling_7_days" } },
        { source: "openrouter", windows: [], spend: { amountUSD: 3, period: "calendar_week" }, accountId: "hash" },
      ] as never, peers: [{ name: "macbook", computer: { name: "macbook" }, accounts: [
        { source: "claude", windows: [{ id: "five_hour", name: "5-hour limit", usedPercent: 45 }], updatedAt: "2026-09-26T11:59:00Z" },
        { source: "opencode", windows: [], spend: { amountUSD: 2.25, period: "rolling_7_days" } },
        { source: "copilot", windows: [], message: "Could not read Copilot usage." },
      ] as never }] };
    } });
    const local = report.computers[0].harnesses!;
    expect(local.map(h => h.source)).toEqual(["claude", "codex", "copilot", "opencode", "opencode-go", "openrouter"]);
    expect(local[0].windows[0]).toEqual({ id: "five_hour", name: "5-hour limit", usedPercent: 30, resetsAt: "2026-09-26T13:30:00Z", resetsIn: "1h 30m" });
    expect(local[1].message).toContain("did not report");
    expect(JSON.stringify(report)).not.toContain("hash");
    expect(JSON.stringify(report)).not.toContain("oauth");
    const combined = Object.fromEntries(report.combined.map(h => [h.source, h]));
    expect(combined.claude.windows[0].usedPercent).toBe(45);
    expect(combined.opencode.spend).toEqual({ amountUSD: 3.75, period: "rolling_7_days" });
    expect(combined.copilot.message).toBe("Could not read Copilot usage.");
    expect(combineUsage([])).toHaveLength(6);
  });

  it("writes reset times people can read", () => {
    const now = Date.parse("2026-09-26T00:00:00Z");
    expect(resetsIn("2026-09-26T00:11:00Z", now)).toBe("11m");
    expect(resetsIn("2026-10-03T19:00:00Z", now)).toBe("7d 19h");
    expect(resetsIn(undefined, now)).toBeUndefined();
  });
});
