import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { accountIdentity, formatAccountUsage, mergeAccountUsage, readAccountUsage, settleWindow, usageSummary, type ComputerUsage } from "./account-usage.js";
import { BridgeError } from "./protocol.js";
import { capacityRoom, type AccountUsage } from "./usage.js";
import { roomFor, roomRank } from "./dispatch.js";

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
      { computer: "Linuxbox", accounts: [claude("claude:48e1529451f8", "work", at(2), 55)] },
    ];
    const { accounts } = mergeAccountUsage(reports, now);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: "claude|claude:48e1529451f8", harness: "claude", account: "sam@example.com", from: "Linuxbox", age: "2m", stale: false,
      leftPercent: 45, nearLimit: false, computers: [{ name: "Desk", account: "default" }, { name: "Linuxbox", account: "work" }] });
    expect(accounts[0].windows.map(w => [w.id, w.usedPercent, w.leftPercent])).toEqual([["five_hour", 10, 90], ["seven_day", 55, 45]]);
  });

  it("keeps two Claude logins with no identity apart, one per computer", () => {
    const reports: ComputerUsage[] = [
      { computer: "Desk", accounts: [claude("claude:home:default", "default", at(1), 20)] },
      { computer: "Linuxbox", accounts: [claude("claude:home:default", "default", at(1), 70)] },
    ];
    const { accounts } = mergeAccountUsage(reports, now);
    expect(accounts.map(row => [row.id, row.from, row.leftPercent])).toEqual([
      ["claude|claude:home:default@Desk", "Desk", 80], ["claude|claude:home:default@Linuxbox", "Linuxbox", 30]]);
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

  it("puts an account under 20% left, or refusing requests, near its limit", () => {
    const [tight] = mergeAccountUsage([{ computer: "Desk", accounts: [codex(83)] }], now).accounts;
    expect(tight).toMatchObject({ leftPercent: 17, nearLimit: true });
    const go: AccountUsage = { source: "opencode-go", updatedAt: at(1), windows: [{ id: "opencode-go:plan:5h", name: "5-hour limit", usedPercent: 30, resetsAt: later(1), limited: true }] };
    const [limited] = mergeAccountUsage([{ computer: "Desk", accounts: [go] }], now).accounts;
    expect(limited).toMatchObject({ leftPercent: 0, nearLimit: true, windows: [{ limited: true, leftPercent: 0, usedPercent: 30 }] });
  });

  it("adds OpenCode's local spend across computers and counts one OpenRouter key once", () => {
    const spend = (amountUSD: number) => ({ amountUSD, period: "rolling_7_days" as const });
    const router = (accountId: string, amountUSD: number, updatedAt: string): AccountUsage => ({ source: "openrouter", windows: [], accountId, updatedAt, spend: { amountUSD, period: "calendar_week" } });
    const { accounts } = mergeAccountUsage([
      { computer: "Desk", accounts: [{ source: "opencode", windows: [], updatedAt: at(1), spend: spend(1.25) }, router("a".repeat(64), 3, at(5))] },
      { computer: "Linuxbox", accounts: [{ source: "opencode", windows: [], updatedAt: at(2), spend: spend(2.5) }, router("a".repeat(64), 4, at(1))] },
    ], now);
    expect(accounts.find(row => row.harness === "opencode")?.spend).toEqual({ amountUSD: 3.75, period: "rolling_7_days" });
    expect(accounts.find(row => row.harness === "openrouter")?.spend).toEqual({ amountUSD: 4, period: "calendar_week" });
    expect(accounts.find(row => row.harness === "opencode")?.computers).toEqual([{ name: "Desk" }, { name: "Linuxbox" }]);
  });

  it("lists harnesses no computer reported numbers for apart, with what the Hook said", () => {
    const empty: AccountUsage = { source: "copilot", windows: [], message: "GitHub CLI is not signed in." };
    const { accounts, noData } = mergeAccountUsage([
      { computer: "Desk", accounts: [codex(10), empty] }, { computer: "Linuxbox", accounts: [{ ...codex(0), windows: [] }, empty] }], now);
    expect(accounts.map(row => row.harness)).toEqual(["codex"]);
    // Codex is signed in only where it reported numbers.
    expect(accounts[0].computers).toEqual([{ name: "Desk" }]);
    expect(noData).toEqual([{ harness: "copilot", name: "GitHub Copilot", computers: ["Desk", "Linuxbox"], message: "GitHub CLI is not signed in." }]);
  });

  it("summarizes tight and stale accounts and warns when every account is near a limit", () => {
    const view = { ...mergeAccountUsage([{ computer: "Desk", accounts: [codex(90), claude("claude:48e1529451f8", "default", at(30), 85)] }], now),
      computers: ["Desk"], unreachable: [{ computer: "Studio", error: "ssh: connect timed out" }], notLinked: [{ name: "Laptop" }], enrolled: 1 };
    const summary = usageSummary(view);
    expect(summary).toContain("2 accounts across 1 computer.");
    expect(summary).toContain("Near a limit: Claude · sam@example.com (15% left, resets in 3d 0h); Codex (10% left, resets in 3d 18h).");
    expect(summary).toContain("Every account with limits is near one: tell the owner before dispatching.");
    expect(summary).toContain("Stale: Claude · sam@example.com (reported 30m ago).");
    expect(summary).toContain("Unreachable: Studio.");
    expect(summary).toContain("Not linked, so not checked: Laptop.");
    const text = formatAccountUsage(view);
    expect(text).toContain("Codex  on Desk  (near limit, 10% left; 1m ago)");
    expect(text).toMatch(/Unreachable\n {2}Studio: ssh: connect timed out/);
    expect(text).not.toContain("—");
  });
});

describe("reading every Hook's usage", () => {
  it("asks this Hook and each linked Hook, and lists unreachable and unlinked computers apart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phren-account-usage-")), store = path.join(root, "store");
    try {
      await mkdir(store);
      await writeFile(path.join(store, "machines.yaml"), "Desk: home\nLinuxbox.local: home\nStudio: home\nLaptop: work\n");
      const peer = (name: string) => ({ name, address: `${name.toLowerCase()}.example`, username: "sam", port: 22, hostKey: "unused", server: "default" });
      const asked: string[] = [];
      const view = await readAccountUsage({ store, now,
        hook: async route => { asked.push(route); return route === "/v1/health" ? { computer: { name: "Desk" } } : { accounts: [codex(30), claude("claude:48e1529451f8", "default", at(5), 20)] }; },
        peers: async () => ({ peers: [peer("Linuxbox"), peer("Studio")] }),
        peer: async (target, route) => {
          if (target.name === "Studio") throw new BridgeError(503, "ssh: connect to host studio.example port 22: Connection timed out", { code: "peer-offline" });
          return route === "/v1/health" ? { computer: { name: "Linuxbox.local", aliases: ["linuxbox"] } }
            : { accounts: [codex(35, at(3)), claude("claude:48e1529451f8", "default", at(1), 25), { source: "opencode", windows: [], message: "OpenCode is not installed on this computer." }] };
        } });
      expect(asked).toEqual(["/v1/health", "/v1/usage?sources=claude%2Ccodex%2Ccopilot%2Copencode%2Copencode-go%2Copenrouter&goPlan=1&accounts=all"]);
      expect(view.computers).toEqual(["Desk", "Linuxbox"]);
      expect(view.accounts.map(row => [row.id, row.from, row.computers.map(c => c.name)])).toEqual([
        ["claude|claude:48e1529451f8", "Linuxbox", ["Desk", "Linuxbox"]], ["codex", "Desk", ["Desk", "Linuxbox"]]]);
      expect(view.noData).toEqual([{ harness: "opencode", name: expect.stringContaining("OpenCode"), computers: ["Linuxbox"], message: "OpenCode is not installed on this computer." }]);
      expect(view.unreachable).toEqual([{ computer: "Studio", error: expect.stringContaining("Connection timed out"), code: "peer-offline" }]);
      // Linuxbox.local answers as Linuxbox's Hook, so only Laptop is unlinked.
      expect(view.notLinked).toEqual([{ name: "Laptop" }]);
      expect(view.enrolled).toBe(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("usage as a dispatch tie-break", () => {
  it("reports each Codex and Claude account's least room, and none for a reset window", () => {
    const reset = { ...codex(0), windows: [{ id: "codex:primary", name: "5-hour", usedPercent: 99, resetsAt: at(1) }] };
    expect(capacityRoom([codex(83), claude("claude:1", "work", at(1), 40), reset], now)).toEqual([
      { source: "codex", account: "default", leftPercent: 17 }, { source: "claude", account: "work", leftPercent: 60 }, { source: "codex", account: "default" }]);
  });

  it("reads room for the account the worker would run under, and ranks room first, unknown next, near a limit last", () => {
    const usage = [{ source: "codex", account: "default", leftPercent: 12 }, { source: "claude", account: "default", leftPercent: 90 }, { source: "claude", account: "work", leftPercent: 5 }];
    expect(roomFor({ harness: "codex" }, usage)).toBe(12);
    expect(roomFor({ harness: "claude" }, usage)).toBe(90);
    expect(roomFor({ harness: "claude", account: "work" }, usage)).toBe(5);
    expect(roomFor({ harness: "opencode" }, usage)).toBeUndefined();
    expect(roomFor({ harness: "codex" }, undefined)).toBeUndefined();
    expect([roomRank(50), roomRank(undefined), roomRank(19)]).toEqual([0, 1, 2]);
  });
});
