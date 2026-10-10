import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountWindows, chooseAccount, claudeRooms, limitedBy, noteAccountLimit, readAccountLimits, resolveAccountFailover, UNKNOWN_RESET_MS, type AccountRoom } from "./account-choice.js";
import type { HarnessInventory } from "./harnesses.js";
import type { AccountUsage } from "./usage.js";

const now = Date.parse("2026-10-10T12:00:00Z");
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
const room = (account: string, fiveHour?: number, week?: number, extra: Partial<AccountRoom> = {}): AccountRoom => ({ account, usable: true,
  ...(fiveHour !== undefined ? { fiveHour: { leftPercent: fiveHour, resetsAt: at(2) } } : {}),
  ...(week !== undefined ? { week: { leftPercent: week, resetsAt: at(72) } } : {}), ...extra });

describe("choosing the Claude account with the most headroom", () => {
  it.each([
    ["the most 5-hour room first, whatever the weekly room", [room("default", 20, 90), room("work", 70, 10)], "work"],
    ["the weekly room when the 5-hour rooms tie", [room("default", 50, 30), room("work", 50, 60)], "work"],
    ["default when both windows tie", [room("work", 50, 50), room("default", 50, 50)], "default"],
    ["a reported account over one never reported", [room("default"), room("work", 5, 5)], "work"],
    ["an unreported account over one with both windows exhausted", [room("default", 0, 0, { exhausted: true, until: at(2) }), room("work")], "work"],
  ])("takes %s", (_name, rooms, expected) => {
    expect(chooseAccount(rooms).choice?.account).toBe(expected);
  });

  it("never takes a signed-out account, one out of quota, or one the ledger holds back, and says why", () => {
    const { choice, skipped } = chooseAccount([room("default", 90, 90, { usable: false }), room("work", 0, 40, { exhausted: true, until: at(2) }), room("spare", 30, 30), room("held", 99, 99)],
      candidate => candidate.account === "held" ? "hit its limit" : undefined);
    expect(choice?.account).toBe("spare");
    expect(skipped).toEqual(["default: not signed in", `work: out of quota until ${at(2)}`, "held: hit its limit"]);
    expect(choice?.reason).toContain("most headroom: spare (30% 5-hour left, 30% weekly left)");
  });

  it("chooses nothing when every account is out", () => {
    expect(chooseAccount([room("default", 0, 50, { exhausted: true }), room("work", 50, 0, { exhausted: true })]).choice).toBeUndefined();
    expect(chooseAccount([]).choice).toBeUndefined();
  });

  it("reads a window whose reset has passed as full, and a refused one as empty", () => {
    const usage = { windows: [{ id: "five_hour", name: "5-hour", usedPercent: 100, resetsAt: at(-1) }, { id: "seven_day", name: "7-day", usedPercent: 40, limited: true, resetsAt: at(30) }] };
    expect(accountWindows(usage, now)).toEqual({ fiveHour: { leftPercent: 100 }, week: { leftPercent: 0, resetsAt: at(30) } });
  });

  it("joins the signed-in homes with their usage rows, marking an exhausted window", () => {
    const inventory: HarnessInventory = { harnesses: [{ source: "claude", installed: true, usable: true, accounts: [
      { id: "default", label: "Claude", key: "claude:a", signedIn: true, usable: true }, { id: "work", label: "Work", key: "claude:b", signedIn: true, usable: true }] }] };
    const usage: AccountUsage[] = [{ source: "claude", account: { id: "work", label: "Work", key: "claude:b" }, windows: [{ id: "five_hour", name: "5-hour", usedPercent: 100, resetsAt: at(3) }] }];
    expect(claudeRooms(inventory, usage, now)).toEqual([
      { account: "default", key: "claude:a", usable: true },
      { account: "work", key: "claude:b", usable: true, fiveHour: { leftPercent: 0, resetsAt: at(3) }, exhausted: true, until: at(3) }]);
  });
});

describe("the ledger of accounts that hit their limit", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "phren-account-limits-")); vi.stubEnv("PHREN_BRIDGE_HOME", root); });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  it("holds a login back until its reset, or one 5-hour window when the reset is unknown, by key on every computer", async () => {
    await noteAccountLimit({ key: "claude:a", account: "default", until: at(3) }, now);
    await noteAccountLimit({ key: "Mini/work", account: "work" }, now);
    expect((await readAccountLimits(now)).map(entry => [entry.key, entry.until])).toEqual([["claude:a", at(3)], ["Mini/work", new Date(now + UNKNOWN_RESET_MS).toISOString()]]);
    const held = limitedBy(await readAccountLimits(now), "MacBook");
    expect(held({ account: "personal", key: "claude:a" })).toContain("held until");
    expect(held({ account: "work" })).toBeUndefined();
    expect(await readAccountLimits(now + 4 * 3_600_000)).toEqual([{ key: "Mini/work", account: "work", until: new Date(now + UNKNOWN_RESET_MS).toISOString(), at: new Date(now).toISOString() }]);
  });
});

describe("the account-failover switch", () => {
  it("is on by default and follows PHREN_ACCOUNT_FAILOVER", () => {
    expect(resolveAccountFailover({}, null)).toEqual({ on: true, source: "default" });
    expect(resolveAccountFailover({ PHREN_ACCOUNT_FAILOVER: "off" }, null)).toEqual({ on: false, source: "PHREN_ACCOUNT_FAILOVER" });
  });
});
