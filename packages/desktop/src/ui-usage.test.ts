import { describe, expect, it } from "vitest";
import { accountTitles, creditsValue, metaLine, subscriptionSummary, windowText } from "../ui/shell/usage-rings.js";

const now = Date.parse("2026-10-11T12:00:00.000Z");
const later = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

describe("usage popover text", () => {
  it("names each card by email, adds the plan when one email has two plans, and numbers unnamed accounts", () => {
    const titles = accountTitles([
      { id: "claude|a", harness: "claude", name: "Claude", account: "sam@example.com", subscription: { plan: "Max 20x" } },
      { id: "claude|b", harness: "claude", name: "Claude", account: "sam@example.com", subscription: { plan: "Team" } },
      { id: "claude|c", harness: "claude", name: "Claude", account: "kit@example.com", subscription: { plan: "Pro" } },
      { id: "codex", harness: "codex", name: "Codex" },
      { id: "copilot|x", harness: "copilot", name: "GitHub Copilot" },
      { id: "copilot|y", harness: "copilot", name: "GitHub Copilot" },
    ]);
    expect([...titles.values()]).toEqual(["Claude · sam@example.com · Max 20x", "Claude · sam@example.com · Team", "Claude · kit@example.com",
      "Codex", "GitHub Copilot · Account 1", "GitHub Copilot · Account 2"]);
  });

  it("writes the plan line and one meta line like the phone", () => {
    expect(subscriptionSummary({ plan: "Max 20x", startedAt: "2026-07-13T00:00:00Z", renewsAt: "2026-10-13T00:00:00Z", renewsEstimated: true }))
      .toBe("Max 20x · since Jul 13 · renews about Oct 13");
    expect(subscriptionSummary(undefined)).toBe("");
    expect(metaLine({ computers: [{ name: "Mini" }, { name: "Mini", account: "work" }, { name: "Workstation" }], updatedAt: new Date(now - 60_000).toISOString() }, now))
      .toBe("Mini, Workstation · updated 1m ago");
  });

  it("gives every window its reset, a 5-hour window without one 'not started', and an API credit its dollars and expiry", () => {
    expect(windowText({ id: "seven_day", name: "7-day", usedPercent: 40, resetsAt: later(50) }, now)).toMatchObject({ value: "40%", caption: "resets in 2d 2h" });
    expect(windowText({ id: "five_hour", name: "5-hour limit", usedPercent: 0 }, now)).toMatchObject({ value: "0%", caption: "not started" });
    expect(windowText({ id: "five_hour", name: "5-hour limit", reset: true }, now)).toMatchObject({ value: "reset", caption: "" });
    const credit = windowText({ id: "credit:abcd1234", name: "Promo, estimate", usedPercent: 31, usedUSD: 31, limitUSD: 100, resetsAt: "2026-12-31T12:00:00.000Z" }, now);
    expect(credit.value).toBe("$31.00 of $100.00");
    expect(credit.caption).toMatch(/^expires Dec 31$/);
    expect(windowText({ id: "codex:primary", name: "5-hour limit", usedPercent: 100, limited: true, resetsAt: later(1) }, now).caption).toBe("Limit reached · resets in 1h 0m");
  });

  it("shows Codex credits only when the account has them", () => {
    expect(creditsValue({ hasCredits: true, balance: 1250.5, inUse: true })).toBe("1,250.5");
    expect(creditsValue({ hasCredits: true, unlimited: true })).toBe("Unlimited");
    expect(creditsValue({ hasCredits: false, balance: 0 })).toBe("");
    expect(creditsValue(undefined)).toBe("");
  });
});
