import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { accountIdentity, formatAccountUsage, mergeAccountUsage, readAccountUsage, settleWindow, usageSummary, type ComputerUsage } from "./account-usage.js";
import { BridgeError } from "./protocol.js";
import { capacityRoom, type AccountUsage } from "./usage.js";
import { outOfQuota, roomFor } from "./dispatch.js";

const now = Date.parse("2026-09-29T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const later = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
const claude = (key: string, id: string, updatedAt: string, used: number, extra: Partial<AccountUsage> = {}): AccountUsage => ({
  source: "claude", updatedAt, account: { id, label: id === "default" ? "Claude" : "Work", key, email: key.includes("home") ? undefined : "sam@example.com" },
  windows: [{ id: "five_hour", name: "5-hour limit", usedPercent: 10, resetsAt: later(2) }, { id: "seven_day", name: "7-day, all models", usedPercent: used, resetsAt: later(72) }],
  ...extra,
});
const codex = (used: number, updatedAt = at(1)): AccountUsage => ({ source: "codex", updatedAt, account: { id: "default", label: "Codex", key: "codex" },
  windows: [{ id: "codex:secondary", name: "7-day limit", usedPercent: used, resetsAt: later(90) }] });

describe("account usage merged by account", () => {
  it("merges one login across computers, keeps the freshest whole report, and names the account id per computer", () => {
    const reports: ComputerUsage[] = [
      { computer: "Desk", accounts: [claude("claude:48e1529451f8", "default", at(10), 40)] },
      { computer: "Devbox", accounts: [claude("claude:48e1529451f8", "work", at(2), 55)] },
    ];
    const { accounts } = mergeAccountUsage(reports, now);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: "claude|claude:48e1529451f8", harness: "claude", account: "sam@example.com", from: "Devbox", age: "2m", stale: false,
      leftPercent: 45, nearLimit: false, computers: [{ name: "Desk", account: "default" }, { name: "Devbox", account: "work" }] });
    expect(accounts[0].windows.map(w => [w.id, w.usedPercent, w.leftPercent])).toEqual([["five_hour", 10, 90], ["seven_day", 55, 45]]);
  });

  it("keeps two Claude logins with no identity apart, one per computer", () => {
    const reports: ComputerUsage[] = [
      { computer: "Desk", accounts: [claude("claude:home:default", "default", at(1), 20)] },
      { computer: "Devbox", accounts: [claude("claude:home:default", "default", at(1), 70)] },
    ];
    const { accounts } = mergeAccountUsage(reports, now);
    expect(accounts.map(row => [row.id, row.from, row.leftPercent])).toEqual([
      ["claude|claude:home:default@Desk", "Desk", 80], ["claude|claude:home:default@Devbox", "Devbox", 30]]);
    expect(accountIdentity(codex(5), "Desk")).toBe("codex");
  });

  it("says reset instead of an old percent once a window's reset passed, and flags the report stale", () => {
    const old = codex(97, at(3 * 60));
    old.windows = [{ id: "codex:primary", name: "5-hour limit", usedPercent: 97, resetsAt: at(30) }, { id: "codex:secondary", name: "7-day limit", usedPercent: 40, resetsAt: later(50) }];
    const [row] = mergeAccountUsage([{ computer: "Desk", accounts: [old] }], now).accounts;
    expect(row.windows[0]).toEqual({ id: "codex:primary", name: "5-hour limit", reset: true });
    expect(row).toMatchObject({ leftPercent: 60, nearLimit: false, stale: true, age: "3h 0m" });
    // A Claude window the Hook already settled keeps its reset and has no percent.
    expect(settleWindow({ id: "seven_day", name: "7-day", reset: true }, now)).toEqual({ id: "seven_day", name: "7-day", reset: true });
  });

  it("flags a report older than fifteen minutes stale, and one with no time at all", () => {
    const [aged] = mergeAccountUsage([{ computer: "Desk", accounts: [codex(10, at(16))] }], now).accounts;
    expect(aged).toMatchObject({ stale: true, age: "16m" });
    const [fresh] = mergeAccountUsage([{ computer: "Desk", accounts: [codex(10, at(14))] }], now).accounts;
    expect(fresh.stale).toBe(false);
    const [untimed] = mergeAccountUsage([{ computer: "Desk", accounts: [{ ...codex(10), updatedAt: undefined }] }], now).accounts;
    expect(untimed).toMatchObject({ stale: true });
    expect(untimed).not.toHaveProperty("age");
  });

  it("marks under 20% left as near a limit but usable, and only 100% or refusing requests as exhausted", () => {
    const [tight] = mergeAccountUsage([{ computer: "Desk", accounts: [codex(83)] }], now).accounts;
    expect(tight).toMatchObject({ leftPercent: 17, nearLimit: true, exhausted: false });
    // 99.6% used rounds to 0% left but still has quota.
    const [almost] = mergeAccountUsage([{ computer: "Desk", accounts: [codex(99.6)] }], now).accounts;
    expect(almost).toMatchObject({ leftPercent: 0, exhausted: false });
    const [spent] = mergeAccountUsage([{ computer: "Desk", accounts: [codex(100)] }], now).accounts;
    expect(spent).toMatchObject({ leftPercent: 0, exhausted: true, availableIn: "3d 18h", windows: [{ exhausted: true }] });
    const go: AccountUsage = { source: "opencode-go", updatedAt: at(1), windows: [{ id: "opencode-go:plan:5h", name: "5-hour limit", usedPercent: 30, resetsAt: later(1), limited: true }] };
    const [limited] = mergeAccountUsage([{ computer: "Desk", accounts: [go] }], now).accounts;
    expect(limited).toMatchObject({ leftPercent: 0, nearLimit: true, exhausted: true, availableIn: "1h 0m", windows: [{ limited: true, exhausted: true, leftPercent: 0, usedPercent: 30 }] });
  });

  it("adds OpenCode's local spend across computers and counts one OpenRouter key once", () => {
    const spend = (amountUSD: number) => ({ amountUSD, period: "rolling_7_days" as const });
    const router = (accountId: string, amountUSD: number, updatedAt: string): AccountUsage => ({ source: "openrouter", windows: [], accountId, updatedAt, spend: { amountUSD, period: "calendar_week" } });
    const { accounts } = mergeAccountUsage([
      { computer: "Desk", accounts: [{ source: "opencode", windows: [], updatedAt: at(1), spend: spend(1.25) }, router("a".repeat(64), 3, at(5))] },
      { computer: "Devbox", accounts: [{ source: "opencode", windows: [], updatedAt: at(2), spend: spend(2.5) }, router("a".repeat(64), 4, at(1))] },
    ], now);
    expect(accounts.find(row => row.harness === "opencode")?.spend).toEqual({ amountUSD: 3.75, period: "rolling_7_days" });
    expect(accounts.find(row => row.harness === "openrouter")?.spend).toEqual({ amountUSD: 4, period: "calendar_week" });
    expect(accounts.find(row => row.harness === "opencode")?.computers).toEqual([{ name: "Desk" }, { name: "Devbox" }]);
  });

  it("lists harnesses no computer reported numbers for apart, with what the Hook said", () => {
    const empty: AccountUsage = { source: "copilot", windows: [], message: "GitHub CLI is not signed in." };
    const { accounts, noData } = mergeAccountUsage([
      { computer: "Desk", accounts: [codex(10), empty] }, { computer: "Devbox", accounts: [{ ...codex(0), windows: [] }, empty] }], now);
    expect(accounts.map(row => row.harness)).toEqual(["codex"]);
    // Codex is signed in only where it reported numbers.
    expect(accounts[0].computers).toEqual([{ name: "Desk" }]);
    expect(noData).toEqual([{ harness: "copilot", name: "GitHub Copilot", computers: ["Desk", "Devbox"], message: "GitHub CLI is not signed in." }]);
  });

  it("reports low accounts as usable, names exhausted ones, and warns only when every account is out of quota", () => {
    const extra = { computers: ["Desk"], unreachable: [{ computer: "Studio", error: "ssh: connect timed out" }], notLinked: [{ name: "Laptop" }], enrolled: 1 };
    const view = { ...mergeAccountUsage([{ computer: "Desk", accounts: [codex(90), claude("claude:48e1529451f8", "default", at(30), 100)] }], now), ...extra };
    const summary = usageSummary(view);
    expect(summary).toContain("2 accounts across 1 computer.");
    expect(summary).toContain("Out of quota, do not dispatch to: Claude · sam@example.com (back in 3d 0h).");
    expect(summary).toContain("Low but usable: Codex (10% left, resets in 3d 18h).");
    expect(summary).not.toContain("Every account");
    expect(summary).toContain("Stale: Claude · sam@example.com (reported 30m ago).");
    expect(summary).toContain("Unreachable: Studio.");
    expect(summary).toContain("Not linked, so not checked: Laptop.");
    const allOut = { ...mergeAccountUsage([{ computer: "Desk", accounts: [codex(100), claude("claude:48e1529451f8", "default", at(1), 100)] }], now), ...extra };
    expect(usageSummary(allOut)).toContain("Every account with limits is out of quota: tell the owner before dispatching.");
    const text = formatAccountUsage(view);
    expect(text).toContain("Codex  on Desk  (low, 10% left; 1m ago)");
    expect(text).toContain("Claude · sam@example.com  on Desk  (out of quota, back in 3d 0h; stale, reported 30m ago)");
    expect(text).toMatch(/Unreachable\n {2}Studio: ssh: connect timed out/);
    expect(text).not.toContain("—");
  });
});

describe("reading every Hook's usage", () => {
  it("asks this Hook and each linked Hook, and lists unreachable and unlinked computers apart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phren-account-usage-")), store = path.join(root, "store");
    try {
      await mkdir(store);
      await writeFile(path.join(store, "machines.yaml"), "Desk: home\nDevbox.local: home\nStudio: home\nLaptop: work\n");
      const peer = (name: string) => ({ name, address: `${name.toLowerCase()}.example`, username: "sam", port: 22, hostKey: "unused", server: "default" });
      const asked: string[] = [];
      const view = await readAccountUsage({ store, now,
        hook: async route => { asked.push(route); return route === "/v1/health" ? { computer: { name: "Desk" } } : { accounts: [codex(30), claude("claude:48e1529451f8", "default", at(5), 20)] }; },
        peers: async () => ({ peers: [peer("Devbox"), peer("Studio")] }),
        peer: async (target, route) => {
          if (target.name === "Studio") throw new BridgeError(503, "ssh: connect to host studio.example port 22: Connection timed out", { code: "peer-offline" });
          return route === "/v1/health" ? { computer: { name: "Devbox.local", aliases: ["devbox"] } }
            : { accounts: [codex(35, at(3)), claude("claude:48e1529451f8", "default", at(1), 25), { source: "opencode", windows: [], message: "OpenCode is not installed on this computer." }] };
        } });
      expect(asked).toEqual(["/v1/health", "/v1/usage?sources=claude%2Ccodex%2Ccopilot%2Copencode%2Copencode-go%2Copenrouter&goPlan=1&accounts=all"]);
      expect(view.computers).toEqual(["Desk", "Devbox"]);
      expect(view.accounts.map(row => [row.id, row.from, row.computers.map(c => c.name)])).toEqual([
        ["claude|claude:48e1529451f8", "Devbox", ["Desk", "Devbox"]], ["codex", "Desk", ["Desk", "Devbox"]]]);
      expect(view.noData).toEqual([{ harness: "opencode", name: expect.stringContaining("OpenCode"), computers: ["Devbox"], message: "OpenCode is not installed on this computer." }]);
      expect(view.unreachable).toEqual([{ computer: "Studio", error: expect.stringContaining("Connection timed out"), code: "peer-offline" }]);
      // Devbox.local answers as Devbox's Hook, so only Laptop is unlinked.
      expect(view.notLinked).toEqual([{ name: "Laptop" }]);
      expect(view.enrolled).toBe(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("usage as a dispatch tie-break", () => {
  it("reports each Codex and Claude account's least room, whether it has none, and none for a reset window", () => {
    const reset = { ...codex(0), windows: [{ id: "codex:primary", name: "5-hour", usedPercent: 100, resetsAt: at(1) }] };
    expect(capacityRoom([codex(83), claude("claude:1", "work", at(1), 100), reset], now)).toEqual([
      { source: "codex", account: "default", leftPercent: 17 },
      { source: "claude", account: "work", leftPercent: 0, exhausted: true, until: later(72) },
      { source: "codex", account: "default" }]);
  });

  it("rules out only the worker's account when it has no quota, never a low one", () => {
    const usage = [{ source: "codex", account: "default", leftPercent: 3 }, { source: "claude", account: "default", leftPercent: 0, exhausted: true, until: later(5) },
      { source: "claude", account: "work", leftPercent: 60 }];
    expect(outOfQuota({ harness: "codex" }, usage, now)).toBeUndefined();
    expect(outOfQuota({ harness: "claude" }, usage, now)).toBe("Its claude account default has no quota left for about 5 more hours.");
    expect(outOfQuota({ harness: "claude", account: "work" }, usage, now)).toBeUndefined();
    expect(outOfQuota({ harness: "opencode" }, usage, now)).toBeUndefined();
    expect(outOfQuota({ harness: "codex" }, undefined, now)).toBeUndefined();
    expect(roomFor({ harness: "claude", account: "work" }, usage)).toEqual({ source: "claude", account: "work", leftPercent: 60 });
  });
});
