import { afterEach, describe, expect, it, vi } from "vitest";
import { quotaBackTransitions, startQuotaBack } from "../ui/shell/quota-back.js";

const hooks = vi.hoisted(() => ({ usage: null as null | ((snapshot: unknown) => void), backOn: true, load: async () => {} }));
vi.mock("../ui/shell/usage-rings.js", async (original) => ({
  ...await original<object>(),
  followUsage: (fn: (snapshot: unknown) => void) => { hooks.usage = fn; fn(null); return () => { hooks.usage = null; }; },
}));
vi.mock("../ui/shell/quota-warn-prefs.js", () => ({
  loadQuotaState: () => hooks.load(), quotaSettings: () => ({ backOn: hooks.backOn }),
}));

const window = (usedPercent: number, id = "five_hour") => ({ id, usedPercent });
const account = (windows = [window(100)], computer = "Desk", id = "claude|work") => ({
  id, harness: "claude", name: "Claude", account: "Work", computers: [{ name: computer, account: "work" }], windows,
});
const snapshot = (...accounts: object[]) => ({ accounts });
const tick = (state: unknown, accounts = [account()], now = 0) => quotaBackTransitions(state, snapshot(...accounts), now);

afterEach(() => { vi.useRealTimers(); hooks.backOn = true; hooks.load = async () => {}; });

describe("account room transitions", () => {
  it("establishes silent baselines for exhausted and available accounts", () => {
    expect(tick(undefined).notices).toEqual([]);
    expect(tick(undefined, [account([window(0)])]).notices).toEqual([]);
    expect(quotaBackTransitions(undefined, null).notices).toEqual([]);
  });

  it("announces recovery once with the account, window and computer", () => {
    const first = tick(undefined);
    const back = tick(first.state, [account([window(20)])], 60_000);
    expect(back.notices).toEqual([{ title: "Claude · Work is available again", body: "5-hour limit reset on Desk" }]);
    expect(tick(back.state, [account([window(30)])], 120_000).notices).toEqual([]);
    expect(first.state.previous.size).toBe(1);
    expect(first.state.notified.size).toBe(0);
  });

  it("waits for the last exhausted window and names that window", () => {
    const first = tick(undefined, [account([window(100), window(100, "seven_day")])]);
    const partial = tick(first.state, [account([window(0), window(100, "seven_day")])]);
    expect(partial.notices).toEqual([]);
    expect(tick(partial.state, [account([window(0), window(40, "seven_day")])]).notices[0].body).toBe("Weekly limit reset on Desk");
  });

  it("recognises service exhaustion and explicit elapsed resets flagged stale by the merger", () => {
    const first = tick(undefined, [{ ...account(), windows: [{ id: "five_hour", exhausted: true }] }]);
    expect(tick(first.state, [{ ...account(), stale: true, windows: [{ id: "five_hour", reset: true }] }]).notices).toHaveLength(1);
  });

  it("suppresses flapping for ten minutes, without delaying a suppressed transition", () => {
    let result = tick(undefined);
    result = tick(result.state, [account([window(0)])], 1_000);
    expect(result.notices).toHaveLength(1);
    result = tick(result.state, [account()], 2_000);
    result = tick(result.state, [account([window(0)])], 600_999);
    expect(result.notices).toEqual([]);
    result = tick(result.state, [account([window(0)])], 601_000);
    expect(result.notices).toEqual([]);
    result = tick(result.state, [account()], 602_000);
    expect(tick(result.state, [account([window(0)])], 603_000).notices).toHaveLength(1);
  });

  it("keeps computers and accounts independent, including cooldowns", () => {
    const rows = [account(), account(undefined, "Laptop"), account(undefined, "Desk", "claude|personal")];
    const first = tick(undefined, rows);
    const next = tick(first.state, [{ ...rows[0], windows: [window(0)] }, rows[1], rows[2]], 1_000);
    expect(next.notices).toHaveLength(1);
    const last = tick(next.state, rows.map((r) => ({ ...r, windows: [window(0)] })), 2_000);
    expect(last.notices.map((n) => n.body)).toEqual(["5-hour limit reset on Laptop", "5-hour limit reset on Desk"]);
  });

  it.each([
    [], [{ ...account(), windows: [] }],
    [{ ...account(), windows: [{ id: "five_hour" }] }],
  ].map((rows) => [rows]))("does not mistake absent or unknown data for recovery: %j", (rows) => {
    const first = tick(undefined);
    const unknown = tick(first.state, rows);
    expect(unknown.notices).toEqual([]);
    expect(tick(unknown.state, [account([window(0)])]).notices).toEqual([]);
  });

  it("does not infer recovery when a blocked window disappears or a computer is unreachable", () => {
    const first = tick(undefined);
    expect(tick(first.state, [account([window(0, "seven_day")])]).notices).toEqual([]);
    expect(quotaBackTransitions(first.state, { ...snapshot(account([window(0)])), unreachable: [{ computer: "Desk" }] }).notices).toEqual([]);
  });

  it("retains exhausted windows and reset times across stale polls until a fresh recovery", () => {
    const windows = [{ ...window(100), resetsAt: "2026-10-15T18:00:00Z" }];
    const first = tick(undefined, [account(windows)]);
    const stale = tick(first.state, [{ ...account(windows), stale: true }], 16 * 60_000);
    expect(stale.notices).toEqual([]);
    expect([...stale.state.previous.values()]).toEqual([windows]);
    const stillStale = tick(stale.state, [{ ...account([window(5)]), stale: true }], 17 * 60_000);
    expect(stillStale.notices).toEqual([]);
    expect([...stillStale.state.previous.values()]).toEqual([windows]);
    const recovered = tick(stillStale.state, [account([window(5)])], 18 * 60_000);
    expect(recovered.notices).toEqual([{ title: "Claude · Work is available again", body: "5-hour limit reset on Desk" }]);
    expect(tick(recovered.state, [account([window(5)])], 19 * 60_000).notices).toEqual([]);
  });

  it("prunes cooldowns for absent computers/accounts and at the ten-minute boundary", () => {
    const rows = [account(), account(undefined, "Laptop"), account(undefined, "Desk", "claude|personal")];
    const first = tick(undefined, rows);
    const available = rows.map((r) => ({ ...r, windows: [window(0)] }));
    const recovered = tick(first.state, available, 1_000);
    expect(recovered.notices).toHaveLength(3);
    expect(recovered.state.notified.size).toBe(3);
    const remaining = tick(recovered.state, [{ ...available[0], stale: true }], 2_000);
    expect(remaining.state.notified.size).toBe(1);
    expect(recovered.state.notified.size).toBe(3);
    const active = tick(remaining.state, [available[0]], 600_999);
    expect(active.state.notified.size).toBe(1);
    const expired = tick(active.state, [available[0]], 601_000);
    expect(expired.state.notified.size).toBe(0);
    expect(expired.notices).toEqual([]);
    expect(tick(recovered.state, [], 2_000).state.notified.size).toBe(0);
  });

  it("follows the shared poll, respects preferences and quiet periods, and unsubscribes", async () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    let enabled = true;
    const stop = startQuotaBack({ notify, enabled: () => enabled });
    hooks.usage!(snapshot(account()));
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    hooks.usage!(snapshot(account([window(0)])));
    expect(notify).toHaveBeenCalledExactlyOnceWith("Claude · Work is available again", "5-hour limit reset on Desk");
    for (const preference of [false, true]) {
      vi.advanceTimersByTime(600_000);
      hooks.backOn = preference;
      enabled = !preference;
      hooks.usage!(snapshot(account()));
      hooks.usage!(snapshot(account([window(0)])));
    }
    hooks.backOn = enabled = true;
    hooks.usage!(snapshot(account([window(0)])));
    expect(notify).toHaveBeenCalledTimes(1);
    stop();
    expect(hooks.usage).toBeNull();
  });

  it("consumes a recovery seen before preferences load instead of replaying it, and retries a failed load", async () => {
    const loads: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    hooks.load = () => new Promise<void>((resolve, reject) => { loads.push({ resolve, reject }); });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const notify = vi.fn();
    const stop = startQuotaBack({ notify, enabled: () => true });
    hooks.usage!(snapshot(account()));
    hooks.usage!(snapshot(account([window(0)])));
    expect(loads).toHaveLength(1);
    // One read in flight at a time.
    hooks.usage!(snapshot(account([window(0)])));
    expect(loads).toHaveLength(1);
    loads[0].reject(new Error("Could not load"));
    await vi.waitFor(() => { hooks.usage!(snapshot(account([window(0)]))); expect(loads).toHaveLength(2); });
    loads[1].resolve();
    await Promise.resolve();
    await Promise.resolve();
    hooks.usage!(snapshot(account([window(0)])));
    expect(notify).not.toHaveBeenCalled();
    // After hydration and the unshown recovery's cooldown, a fresh exhaustion and recovery notifies once.
    vi.setSystemTime(600_000);
    hooks.usage!(snapshot(account()));
    hooks.usage!(snapshot(account([window(0)])));
    expect(notify).toHaveBeenCalledExactlyOnceWith("Claude · Work is available again", "5-hour limit reset on Desk");
    stop();
  });
});
