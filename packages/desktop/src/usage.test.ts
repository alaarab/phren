import { describe, expect, it } from "vitest";
import type { Computer, HookRequest, HookResponse } from "./contract.js";
import { collectUsage, fetchUsage } from "./usage.js";

const A: Computer = { name: "A", local: true, server: "default" };
const B: Computer = { name: "B", local: false, address: "b", username: "me", port: 22, hostKey: "k", server: "default", keyFile: "/k" };
const C: Computer = { name: "C", local: false, address: "c", username: "me", port: 22, hostKey: "k", server: "default", keyFile: "/k" };

const report = (accounts: unknown[]): HookResponse => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ accounts })) });
const claude = (usedPercent: number, updatedAt: string) => ({ source: "claude", updatedAt, windows: [{ id: "seven_day", name: "7-day", usedPercent }] });
const codex = (usedPercent: number, updatedAt: string) => ({ source: "codex", updatedAt, windows: [{ id: "codex:primary", name: "Primary limit", usedPercent }] });

/** A fake whose answer per computer is named; a computer in `down` rejects. */
function fakeHook(byComputer: Record<string, HookResponse>, down: string[] = []): { request: HookRequest; calls: () => number } {
  let calls = 0;
  const request: HookRequest = async (c) => {
    calls += 1;
    if (down.includes(c.name)) throw new Error(`${c.name} is down.`);
    const answer = byComputer[c.name];
    if (!answer) throw new Error(`no answer for ${c.name}`);
    return answer;
  };
  return { request, calls: () => calls };
}

describe("fetchUsage", () => {
  it("merges every computer's report by account and skips the unreachable", async () => {
    const hook = fakeHook({
      A: report([claude(30, "2026-01-01T00:00:00.000Z"), codex(80, "2026-01-01T00:00:00.000Z")]),
      B: report([claude(55, "2026-01-01T00:05:00.000Z")]),
    }, ["C"]);
    const now = Date.parse("2026-01-01T00:06:00.000Z");

    const snapshot = await fetchUsage([A, B, C], hook.request, now);

    expect(snapshot.computers).toEqual(["A", "B"]);
    expect(snapshot.unreachable).toEqual([{ computer: "C", error: expect.stringContaining("down") }]);
    expect(snapshot.accounts.map(row => row.id).sort()).toEqual(["claude", "codex"]);
    const merged = snapshot.accounts.find(row => row.id === "claude")!;
    expect(merged.windows[0].usedPercent).toBe(55);
    expect(merged.from).toBe("B");
    expect(merged.computers.map(c => c.name)).toEqual(["A", "B"]);
  });

  it("counts nothing for a computer that answers with no accounts", async () => {
    const hook = fakeHook({ A: report([]) });
    const snapshot = await fetchUsage([A], hook.request, Date.now());
    expect(snapshot.accounts).toEqual([]);
    expect(snapshot.computers).toEqual(["A"]);
  });
});

describe("collectUsage", () => {
  it("serves a second poll within a minute from cache", async () => {
    const hook = fakeHook({ A: report([claude(10, "2026-02-01T00:00:00.000Z")]) });
    const base = 1_700_000_000_000;

    const first = await collectUsage([A], hook.request, base);
    const second = await collectUsage([A], hook.request, base + 1_000);
    expect(hook.calls()).toBe(1);
    expect(second).toEqual(first);

    await collectUsage([A], hook.request, base + 61_000);
    expect(hook.calls()).toBe(2);
  });
});
