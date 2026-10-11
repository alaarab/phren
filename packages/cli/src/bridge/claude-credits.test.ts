import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeHome, clearAccountCaches } from "./claude-accounts.js";
import { addClaudeCredit, claudeCredits, creditWindows, homeSessionCosts, recordSessionCost, removeClaudeCredit } from "./claude-credits.js";
import { AccountUsageReader } from "./usage.js";

let home = "";
const now = new Date("2026-10-11T12:00:00Z");
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "phren-credits-"));
  vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", ""); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
  clearAccountCaches();
  mkdirSync(path.join(home, ".claude-api"));
  writeFileSync(path.join(home, ".claude-api/.claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "u", organizationUuid: "o" } }));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it("enters, lists and removes credits per account, keeping labels and other accounts", async () => {
  const first = await addClaudeCredit("api", { amount: "$50", expires: "2026-12-31", label: "Promo" }, now);
  expect(first).toMatchObject({ amountUSD: 50, since: "2026-10-11T00:00:00.000Z", expiresAt: "2026-12-31T23:59:59.000Z", label: "Promo" });
  await addClaudeCredit("api", { amount: "50", expires: "2026-12-31", label: "Promo" }, now);
  const second = await addClaudeCredit("api", { amount: "10", since: "2026-10-01" }, now);
  expect(claudeCredits("api").map(c => c.id)).toEqual([first.id, second.id]);
  expect(claudeCredits("default")).toEqual([]);
  await expect(addClaudeCredit("api", { amount: "-1" })).rejects.toThrow(/amount/);
  await expect(addClaudeCredit("api", { amount: "5", expires: "soon" })).rejects.toThrow(/date/);
  await expect(addClaudeCredit("Bad Slug", { amount: "5" })).rejects.toThrow();
  expect(await removeClaudeCredit("api", first.id)).toBe(true);
  expect(await removeClaudeCredit("api", first.id)).toBe(false);
  expect(claudeCredits("api").map(c => c.id)).toEqual([second.id]);
  await removeClaudeCredit("api", second.id);
  expect(readFileSync(path.join(home, "bridge/accounts.yaml"), "utf8")).not.toContain("credits");
});

it("draws spend from the credit that expires first, overflows, and leaves expired and earlier spend out", () => {
  const credits = [
    { id: "late", amountUSD: 100, since: "2026-10-01T00:00:00.000Z" },
    { id: "soon", amountUSD: 20, since: "2026-10-01T00:00:00.000Z", expiresAt: "2026-11-01T00:00:00.000Z", label: "Promo" },
    { id: "gone", amountUSD: 20, since: "2026-09-01T00:00:00.000Z", expiresAt: "2026-10-05T00:00:00.000Z" },
  ];
  const sessions = {
    before: { costUSD: 7, startedAt: "2026-09-02T00:00:00.000Z" },
    a: { costUSD: 15, startedAt: "2026-10-06T00:00:00.000Z" },
    b: { costUSD: 10.005, startedAt: "2026-10-07T00:00:00.000Z" },
  };
  expect(creditWindows(credits, sessions, now)).toEqual([
    { id: "credit:soon", name: "API credit · Promo, estimate", usedUSD: 20, limitUSD: 20, usedPercent: 100, resetsAt: "2026-11-01T00:00:00.000Z", asOf: now.toISOString() },
    { id: "credit:late", name: "API credit, estimate", usedUSD: 5.01, limitUSD: 100, usedPercent: 5, asOf: now.toISOString() },
  ]);
});

it("records status-line costs only for a home with a credit and adds Claude Code's lastCost per project", async () => {
  const api = claudeHome("api")!;
  const line = (cost: number) => ({ session_id: "s-1", cost: { total_cost_usd: cost } });
  await recordSessionCost(api, line(1), now);
  expect(homeSessionCosts(api)).toEqual({});
  await addClaudeCredit("api", { amount: "50" }, now);
  await recordSessionCost(api, line(2), now);
  await recordSessionCost(api, line(1.5), new Date("2026-10-11T13:00:00Z"));
  await recordSessionCost(api, { session_id: "../x", cost: { total_cost_usd: 3 } }, now);
  mkdirSync(path.join(api.dir, "projects/-work"), { recursive: true });
  writeFileSync(path.join(api.dir, "projects/-work/s-2.jsonl"), "");
  utimesSync(path.join(api.dir, "projects/-work/s-2.jsonl"), now, now);
  writeFileSync(api.configFile, JSON.stringify({ oauthAccount: { accountUuid: "u" }, projects: { "/work": { lastSessionId: "s-2", lastCost: 4 }, "/other": { lastSessionId: "s-1", lastCost: 3 }, "/lost": { lastSessionId: "s-9", lastCost: 9 } } }));
  const costs = homeSessionCosts(api);
  expect(Object.keys(costs).sort()).toEqual(["s-1", "s-2"]);
  expect(costs["s-1"]).toEqual({ costUSD: 3, startedAt: now.toISOString() });
  expect(costs["s-2"].costUSD).toBe(4);
});

it("puts the estimate on the home's usage row and names a Console login's plan from Claude Code", async () => {
  await addClaudeCredit("api", { amount: "50", label: "Promo" }, now);
  let asked = 0;
  const reader = new AccountUsageReader(async () => ({ source: "codex", windows: [] }), () => now.getTime(), async () => undefined,
    undefined, undefined, undefined, undefined, "linux", undefined, async () => { asked++; return { signedIn: true, console: true }; });
  const rows = await reader.limits();
  const api = rows.find(row => row.account?.id === "api")!;
  expect(api.subscription?.plan).toBe("Console");
  expect(api.windows).toEqual([expect.objectContaining({ id: expect.stringMatching(/^credit:/), name: "API credit · Promo, estimate", usedUSD: 0, limitUSD: 50 })]);
  expect(api.message).toBeUndefined();
  expect(rows.find(row => row.account?.id === "default")?.windows).toEqual([]);
  expect(asked).toBe(1);
});
