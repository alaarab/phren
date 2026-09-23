import { describe, expect, it } from "vitest";
import { HookMetrics } from "./metrics.js";

describe("Hook metrics", () => {
  it("counts by kind and name with totals, the last minute and the average rate", () => {
    let now = Date.UTC(2026, 8, 22, 12, 0, 10);
    const metrics = new HookMetrics(() => now);
    metrics.count("herdr", "session.snapshot"); metrics.count("herdr", "session.snapshot"); metrics.count("herdr", "pane.read");
    metrics.count("git", "branch"); metrics.count("timer", "activity"); metrics.count("identity", "lsof");
    now += 60_000;
    metrics.count("herdr", "session.snapshot");
    const snapshot = metrics.snapshot() as Record<string, Record<string, Record<string, number>>>;
    expect(snapshot.herdr["session.snapshot"]).toEqual({ total: 3, lastMinute: 2, currentMinute: 1, perMinute: 3 });
    expect(snapshot.herdr["pane.read"]).toEqual({ total: 1, lastMinute: 1, currentMinute: 0, perMinute: 1 });
    expect(snapshot.git.branch.total).toBe(1);
    expect(snapshot.timers.activity.total).toBe(1);
    expect(snapshot.identity.lsof.total).toBe(1);
    expect(snapshot.uptimeSeconds).toBe(60);
  });

  it("forgets a minute that passed with no counts", () => {
    let now = Date.UTC(2026, 8, 22, 12, 0, 0);
    const metrics = new HookMetrics(() => now);
    metrics.count("git", "changes");
    now += 3 * 60_000;
    const git = (metrics.snapshot() as Record<string, Record<string, Record<string, number>>>).git.changes;
    expect(git).toEqual({ total: 1, lastMinute: 0, currentMinute: 0, perMinute: 0.33 });
  });

  it("stays bounded: unexpected names and names past the limit count as other", () => {
    const metrics = new HookMetrics(() => 0);
    metrics.count("herdr", "/Users/someone/secret path");
    for (let i = 0; i < 100; i++) metrics.count("timer", `t${i}`);
    const snapshot = metrics.snapshot() as Record<string, Record<string, Record<string, number>>>;
    expect(Object.keys(snapshot.herdr)).toEqual(["other"]);
    expect(Object.keys(snapshot.timers)).toHaveLength(65);
    expect(snapshot.timers.other.total).toBe(36);
    expect(JSON.stringify(snapshot)).not.toContain("someone");
  });
});
