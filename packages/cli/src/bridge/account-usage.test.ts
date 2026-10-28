import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { accountIdentity, formatAccountUsage, mergeAccountUsage, placeholderTarget, readAccountUsage, settleWindow, usageSummary, type ComputerUsage } from "./account-usage.js";
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
  it("merges one login across computers, takes each window from the newest report, and names the account id per computer", () => {
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

  it("never drops a window the newest report lacks, and takes each window from the newest report that has it", () => {
    const week: AccountUsage = { ...claude("claude:48e1529451f8", "default", at(30), 68), windows: [
      { id: "five_hour", name: "5-hour limit", usedPercent: 40, resetsAt: later(1) }, { id: "seven_day", name: "7-day, all models", usedPercent: 68, resetsAt: later(40) }] };
    const fiveOnly: AccountUsage = { ...claude("claude:48e1529451f8", "default", at(1), 0), windows: [{ id: "five_hour", name: "5-hour limit", usedPercent: 0 }] };
    const [row] = mergeAccountUsage([{ computer: "Laptop", accounts: [fiveOnly] }, { computer: "Desk", accounts: [week] }], now).accounts;
    expect(row.windows.map(w => [w.id, w.usedPercent, w.resetsAt])).toEqual([["five_hour", 0, undefined], ["seven_day", 68, later(40)]]);
    expect(row).toMatchObject({ from: "Laptop", leftPercent: 32 });
    // Equally new: the window with a reset time wins.
    const same = { ...fiveOnly, updatedAt: at(30) };
    expect(mergeAccountUsage([{ computer: "Laptop", accounts: [same] }, { computer: "Desk", accounts: [week] }], now).accounts[0].windows[0].resetsAt).toBe(later(1));
  });

  it("does not say an exhausted API credit comes back at its expiry", () => {
    const credit: AccountUsage = { ...claude("claude:0123456789ab", "api", at(1), 0), windows: [{ id: "credit:abcd1234", name: "API credit, estimate", usedPercent: 100, usedUSD: 50, limitUSD: 50, resetsAt: later(200) }] };
    const [row] = mergeAccountUsage([{ computer: "Desk", accounts: [credit] }], now).accounts;
    expect(row.exhausted).toBe(true);
    expect(row.availableIn).toBeUndefined();
    expect(formatAccountUsage({ accounts: [row], noData: [], computers: ["Desk"], unreachable: [], notLinked: [], enrolled: 0 })).toContain("$50.00 of $50.00, about $0.00 left  expires 2026-10-07");
  });

  it("adds an account's API credits up, drops one that expired since its report, and says what is left", () => {
    const credit = (id: string, usedUSD: number, limitUSD: number, expiresAt?: string) => ({ id: `credit:${id}`, name: `API credit · ${id}, estimate`,
      usedUSD, limitUSD, usedPercent: Math.round(usedUSD / limitUSD * 100), ...(expiresAt ? { resetsAt: expiresAt } : {}) });
    // An older Hook sends no remainingUSD or expiresAt: they come from limit, used and resetsAt.
    const usage: AccountUsage = { ...claude("claude:0123456789ab", "api", at(1), 0), windows: [
      credit("promo", 40, 100, later(48)), credit("paid", 10, 200), credit("old", 1, 50, at(5))] };
    const [row] = mergeAccountUsage([{ computer: "Desk", accounts: [usage] }], now).accounts;
    expect(row.windows.map(w => w.id)).toEqual(["credit:promo", "credit:paid"]);
    expect(row.apiCredit).toEqual({ remainingUSD: 250, limitUSD: 300, usedUSD: 50, expiresAt: later(48), estimate: true });
    const view = { accounts: [row], noData: [], computers: ["Desk"], unreachable: [], notLinked: [], enrolled: 0 };
    expect(formatAccountUsage(view)).toContain("  API credit, all                about $250.00 left of $300.00, the soonest expires 2026-10-01");
    expect(usageSummary(view)).toContain("API credit: Claude · sam@example.com about $250.00 left of $300.00, the soonest expires 2026-10-01.");
    // Credits are one balance: a spent one leaves the account usable while another has money; all spent, it is out.
    const spentPromo = { ...usage, windows: [{ ...credit("promo", 20, 20, later(48)) }, credit("paid", 5, 100)] };
    const [usable] = mergeAccountUsage([{ computer: "Desk", accounts: [spentPromo] }], now).accounts;
    expect(usable.exhausted).toBe(false);
    expect(usageSummary({ ...view, accounts: [usable] })).not.toContain("Out of quota");
    const allSpent = { ...usage, windows: [credit("promo", 20, 20, later(48)), credit("paid", 100, 100)] };
    expect(mergeAccountUsage([{ computer: "Desk", accounts: [allSpent] }], now).accounts[0].exhausted).toBe(true);
    // An account with no credit carries none.
    expect(mergeAccountUsage([{ computer: "Desk", accounts: [claude("claude:1", "work", at(1), 10)] }], now).accounts[0]).not.toHaveProperty("apiCredit");
  });

  it("counts an account's API credits as one balance for its room, as dispatch does, and never names a spent credit's expiry", () => {
    const credit = (id: string, usedUSD: number, limitUSD: number, expiresAt?: string) => ({ id: `credit:${id}`, name: `API credit · ${id}, estimate`,
      usedUSD, limitUSD, usedPercent: Math.round(usedUSD / limitUSD * 100), ...(expiresAt ? { resetsAt: expiresAt } : {}) });
    const api = (windows: AccountUsage["windows"]): AccountUsage => ({ ...claude("claude:0123456789ab", "api", at(1), 0), windows });
    const view = (row: ReturnType<typeof mergeAccountUsage>["accounts"][number]) => ({ accounts: [row], noData: [], computers: ["Desk"], unreachable: [], notLinked: [], enrolled: 0 });
    // A spent $20 promo beside $95 left of a $100 credit: $95 of $120, as dispatch counts it.
    const spentPromo = api([credit("promo", 20, 20, later(48)), credit("paid", 5, 100)]);
    const [usable] = mergeAccountUsage([{ computer: "Desk", accounts: [spentPromo] }], now).accounts;
    expect(usable).toMatchObject({ leftPercent: capacityRoom([spentPromo], now)[0].leftPercent, nearLimit: false, exhausted: false });
    expect(usable.leftPercent).toBe(79);
    expect(usageSummary(view(usable))).not.toContain("Low but usable");
    expect(formatAccountUsage(view(usable))).toContain("Claude · sam@example.com  on Desk (api)  (79% left;");
    // Low on credit: the soonest expiry among credits with money left, never the spent promo's, and not as a reset.
    const low = api([credit("promo", 20, 20, later(48)), credit("paid", 90, 100, later(100))]);
    const [tight] = mergeAccountUsage([{ computer: "Desk", accounts: [low] }], now).accounts;
    expect(tight).toMatchObject({ leftPercent: 8, nearLimit: true, exhausted: false });
    expect(usageSummary(view(tight))).toContain("Low but usable: Claude · sam@example.com (8% left, credit expires in 4d 4h).");
    // A 5-hour window tighter than the credit still names its reset.
    const both = api([{ id: "five_hour", name: "5-hour limit", usedPercent: 95, resetsAt: later(2) }, credit("promo", 20, 20, later(48)), credit("paid", 5, 100)]);
    const [window] = mergeAccountUsage([{ computer: "Desk", accounts: [both] }], now).accounts;
    expect(usageSummary(view(window))).toContain("(5% left, resets in 2h 0m)");
  });

  it("carries Codex credits from the newest report that has them, and prints them", () => {
    const older = { ...codex(30, at(20)), credits: { hasCredits: true, balance: 900 } };
    const newer = { ...codex(100, at(2)), credits: { hasCredits: true, balance: 1250.5, inUse: true as const } };
    const [row] = mergeAccountUsage([{ computer: "Desk", accounts: [older] }, { computer: "Laptop", accounts: [newer] }], now).accounts;
    expect(row.credits).toEqual({ hasCredits: true, balance: 1250.5, inUse: true });
    expect(formatAccountUsage({ accounts: [row], noData: [], computers: ["Desk", "Laptop"], unreachable: [], notLinked: [], enrolled: 0 })).toContain("1,250.5 credits, in use");
    // A report with only a credit balance still makes a card.
    const balanceOnly: AccountUsage = { source: "codex", updatedAt: at(1), windows: [], credits: { hasCredits: true, balance: 40 } };
    expect(mergeAccountUsage([{ computer: "Desk", accounts: [balanceOnly] }], now).accounts[0].credits?.balance).toBe(40);
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

  it("folds a Claude home that only has a label into the account that label names, and keeps one that names none out of the rows", () => {
    const login = (key: string, label: string, email: string, plan: string): AccountUsage => ({ ...claude(key, "work", at(1), 30),
      account: { id: "work", label, key, email }, subscription: { plan, checkedAt: at(1) } });
    const empty = (home: string, label: string): AccountUsage => ({ source: "claude", windows: [], message: "Usage appears after Claude Code replies on this computer.",
      account: { id: home, label, key: `claude:home:${home}` } });
    const reports: ComputerUsage[] = [
      { computer: "Desk", accounts: [login("claude:aaaaaaaaaaaa", "personal Max", "sam@example.com", "Max 20x"), empty("team", "sam Team"), empty("helpdesk", "help Team")] },
      { computer: "Laptop", accounts: [login("claude:bbbbbbbbbbbb", "Claude", "sam@example.com", "Team"), empty("personal", "personal Max"), empty("max", "sam Max 20x")] },
      { computer: "Server", accounts: [{ ...login("claude:cccccccccccc", "Claude", "help@example.com", "Team"), subscription: undefined }, empty("spare", "spare")] },
    ];
    const { accounts, noData } = mergeAccountUsage(reports, now);
    expect(accounts.map(row => [row.id, row.computers])).toEqual([
      ["claude|claude:cccccccccccc", [{ name: "Server", account: "work" }, { name: "Desk", account: "helpdesk" }]],
      ["claude|claude:aaaaaaaaaaaa", [{ name: "Desk", account: "work" }, { name: "Laptop", account: "personal" }, { name: "Laptop", account: "max" }]],
      ["claude|claude:bbbbbbbbbbbb", [{ name: "Laptop", account: "work" }, { name: "Desk", account: "team" }]],
    ]);
    expect(accounts.every(row => !row.message)).toBe(true);
    // "spare" names no account: it is not a row, and Claude has numbers, so it is not listed as missing either.
    expect(noData).toEqual([]);
  });

  it("matches a label to one account only when exactly one fits", () => {
    const accounts = [{ labels: ["Claude"], email: "sam@example.com", plan: "Team" }, { labels: ["Claude"], email: "sam@example.com", plan: "Max 20x" },
      { labels: ["Claude"], email: "sam@other.example" }];
    expect(placeholderTarget("sam Team", accounts)).toBe(0);
    expect(placeholderTarget("SAM  max 20x", accounts)).toBe(1);
    expect(placeholderTarget("sam", accounts)).toBeUndefined();
    expect(placeholderTarget("sam@other.example", accounts)).toBe(2);
    expect(placeholderTarget("Claude", accounts)).toBeUndefined();
    expect(placeholderTarget("sam Pro", accounts.slice(0, 2))).toBeUndefined();
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
      // Claude rows also carry the 5-hour and weekly rooms launch and failover rank accounts by.
      { source: "claude", account: "work", leftPercent: 0, exhausted: true, until: later(72),
        fiveHour: { leftPercent: 90, resetsAt: later(2) }, week: { leftPercent: 0, resetsAt: later(72) } },
      { source: "codex", account: "default" }]);
  });

  it("pools an account's API credits into one balance, and a normal spent window still exhausts on its own", () => {
    const creditRow = (windows: AccountUsage["windows"]): AccountUsage =>
      ({ source: "claude", updatedAt: at(1), account: { id: "api", label: "API", key: "claude:api" }, windows });
    const credit = (id: string, usedUSD: number, limitUSD: number): AccountUsage["windows"][number] =>
      ({ id: `credit:${id}`, name: "API credit, estimate", usedUSD, limitUSD, usedPercent: Math.round(usedUSD / limitUSD * 100), resetsAt: later(200) });
    // A $20 promo fully spent and a $100 paid credit with $5 used still leave $95 of $120.
    const [mixed] = capacityRoom([creditRow([credit("promo", 20, 20), credit("paid", 5, 100)])], now);
    expect(mixed).toMatchObject({ leftPercent: 79 });
    expect(mixed.exhausted).toBeUndefined();
    // Every live credit spent: the pool is exhausted, and a credit's expiry is not a reset to name.
    const [spent] = capacityRoom([creditRow([credit("promo", 20, 20), credit("paid", 100, 100)])], now);
    expect(spent).toMatchObject({ leftPercent: 0, exhausted: true });
    expect(spent.until).toBeUndefined();
    // A normal window at 100% is still exhausted on its own.
    expect(capacityRoom([codex(100)], now)[0]).toMatchObject({ leftPercent: 0, exhausted: true });
  });

  it("rules out only the worker's account when it has no quota, never a low one", () => {
    const usage = [{ source: "codex", account: "default", leftPercent: 3 }, { source: "claude", account: "default", leftPercent: 0, exhausted: true, until: later(5) },
      { source: "claude", account: "work", leftPercent: 60 }];
    expect(outOfQuota({ harness: "codex" }, usage, now)).toBeUndefined();
    expect(outOfQuota({ harness: "claude", account: "default" }, usage, now)).toBe("Its claude account default has no quota left for about 5 more hours.");
    expect(outOfQuota({ harness: "claude", account: "work" }, usage, now)).toBeUndefined();
    // Naming no account lets that computer's launch pick work, so it is out only once every Claude account is.
    expect(outOfQuota({ harness: "claude" }, usage, now)).toBeUndefined();
    const allOut = usage.map(item => item.source === "claude" ? { ...item, leftPercent: 0, exhausted: true, until: item.until ?? later(30) } : item);
    expect(outOfQuota({ harness: "claude" }, allOut, now)).toBe("Its claude accounts all have no quota left for about 5 more hours.");
    expect(outOfQuota({ harness: "opencode" }, usage, now)).toBeUndefined();
    expect(outOfQuota({ harness: "codex" }, undefined, now)).toBeUndefined();
    expect(roomFor({ harness: "claude", account: "work" }, usage)).toEqual({ source: "claude", account: "work", leftPercent: 60 });
  });
});
