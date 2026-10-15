import { describe, expect, it } from "vitest";
import { runningLow } from "../ui/shell/home-usage.js";

const now = new Date(2026, 9, 14, 8, 0).getTime();
const reset = new Date(now + 80 * 60_000).toISOString();
const chat = (id: string, source = "claude", account: string | null = id) => ({
  id, title: `Chat ${id}`, account: account ? { id: account } : undefined,
  target: { source, session: id },
});
const overview = (children: object[], computer = "Desk", state = "online") => ({
  computers: [{ computer, state, overview: { groups: [{ children }] } }],
});
const account = (id: string, used = 92, harness = "claude", computer = "Desk") => ({
  id, name: harness === "claude" ? "Claude" : "Codex", harness,
  computers: [{ name: computer, account: id }],
  windows: [{ id: "five_hour", usedPercent: used, resetsAt: reset }],
});
const keys = (rows: ReturnType<typeof runningLow>) => rows.map((row: { key: string }) => row.key);

describe("Home running low chats", () => {
  it("uses the configured threshold, including its boundary, independently of notification enablement", () => {
    const merged = overview([chat("work"), chat("personal"), chat("empty")]);
    const usage = { accounts: [account("work", 94.9), account("personal", 95), account("empty", 100)] };
    expect(keys(runningLow(merged, usage, { threshold: 95, on: false }, now))).toEqual(["Desk/empty", "Desk/personal"]);
    expect(runningLow(merged, usage, { threshold: 99 }, now)).toMatchObject([{ child: { id: "empty" } }]);
    expect(runningLow(overview([chat("work")]), { accounts: [account("work", 89.9)] }, {}, now)).toEqual([]);
  });

  it("matches the local Claude account ID and computer, retaining every open chat on the account", () => {
    const merged = overview([chat("first", "claude", "work"), chat("second", "claude", "work"), chat("unbound", "claude", null)]);
    const usage = { accounts: [account("personal", 99), account("work", 92, "claude", "Laptop"), account("work")] };
    expect(keys(runningLow(merged, usage, {}, now))).toEqual(["Desk/first", "Desk/second"]);
    expect(runningLow(merged, { accounts: usage.accounts.slice(0, 2) }, {}, now)).toEqual([]);
    expect(runningLow(merged, { accounts: [account("work"), { ...account("work"), id: "duplicate" }] }, {}, now)).toEqual([]);
  });

  it("requires a unique non-Claude account on the chat's computer", () => {
    const merged = overview([chat("codex", "codex")]);
    const local = account("codex-login", 93, "codex");
    const remote = account("other", 99, "codex", "Laptop");
    expect(keys(runningLow(merged, { accounts: [remote, local] }, {}, now))).toEqual(["Desk/codex"]);
    expect(runningLow(merged, { accounts: [local, { ...local, id: "ambiguous" }] }, {}, now)).toEqual([]);
  });

  it("skips offline, missing, stale, reset, expired and unknown data", () => {
    const merged = overview([chat("work")]);
    const usage = { accounts: [account("work")] };
    expect(runningLow(overview([chat("work")], "Desk", "offline"), usage, {}, now)).toEqual([]);
    expect(runningLow(null, usage, {}, now)).toEqual([]);
    expect(runningLow(merged, null, {}, now)).toEqual([]);
    expect(runningLow(merged, { accounts: [{ ...account("work"), stale: true }] }, {}, now)).toEqual([]);
    for (const window of [
      { usedPercent: 100, reset: true },
      { exhausted: true, resetsAt: new Date(now).toISOString() },
      { usedPercent: 100, resetsAt: new Date(now - 1).toISOString() },
      {},
    ]) {
      expect(runningLow(merged, { accounts: [{ ...account("work"), windows: [{ id: "five_hour", ...window }] }] }, {}, now)).toEqual([]);
    }
  });

  it("orders exhausted first, then tightest active usage, retaining overview order for ties", () => {
    const merged = overview([chat("near"), chat("tie"), chat("tight"), chat("out")]);
    const near = account("near");
    const tight = { ...account("tight"), windows: [
      { id: "five_hour", usedPercent: 98, reset: true },
      { id: "seven_day", leftPercent: 4, resetsAt: reset },
      { id: "five_hour", usedPercent: 99, resetsAt: new Date(now - 1).toISOString() },
    ] };
    const out = { ...account("out"), windows: [{ id: "seven_day", usedPercent: 30, exhausted: true, resetsAt: reset }] };
    const usage = { accounts: [tight, out, account("tie"), near] };
    const rows = runningLow(merged, usage, {}, now);
    expect(keys(rows)).toEqual(["Desk/out", "Desk/tight", "Desk/near", "Desk/tie"]);
    expect(rows.map((row: { text: string }) => row.text)).toEqual([
      "Exhausted · resets in 1h 20m", "96% of weekly · resets in 1h 20m",
      "92% of 5-hour · resets in 1h 20m", "92% of 5-hour · resets in 1h 20m",
    ]);
    expect(usage.accounts[0]).toBe(tight);
    expect(tight.windows[0].reset).toBe(true);
  });

  it("uses the constraining window's reset and clears rows when usage or chats clear", () => {
    const merged = overview([chat("work")]);
    const usage = { accounts: [{ ...account("work"), windows: [
      { id: "five_hour", usedPercent: 100, exhausted: false, resetsAt: reset },
      { id: "seven_day", exhausted: true, resetsAt: new Date(2026, 9, 15, 9, 0).toISOString() },
    ] }] };
    expect(runningLow(merged, usage, {}, now)[0].text).toBe("Exhausted · resets Thu 09:00");
    expect(runningLow(overview([]), usage, {}, now)).toEqual([]);
    expect(runningLow(merged, { accounts: [account("work", 20)] }, {}, now)).toEqual([]);
  });
});
