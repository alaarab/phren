import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeAccountSubscription, claudeHomes, clearAccountCaches } from "./claude-accounts.js";
import { codexSubscription, readCodexSubscription, elevenLabsUsage, fetchElevenLabsUsage, copilotUsage, openCodeGoUsage, AccountUsageReader } from "./usage.js";
import { monthlyAnniversary } from "./subscription.js";
import { mergeAccountUsage, readAccountUsage, formatAccountUsage } from "./account-usage.js";

const now = new Date("2026-09-29T20:00:00Z");
const token = (claims: unknown) => `invalid-header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.private-signature`;
const idToken = token({ "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_subscription_active_start: "2026-07-13T00:00:00Z", chatgpt_subscription_active_until: "2026-10-06T00:00:00Z" }, email: "private@example.com" });
const roots: string[] = [];
afterEach(async () => { clearAccountCaches(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => { const root = await mkdtemp(path.join(tmpdir(), "phren-subscription-")); roots.push(root); return root; };

describe("subscription metadata", () => {
  it("decodes only the Codex claims payload and exposes only plan and dates", async () => {
    const value = codexSubscription(idToken, now);
    expect(value).toEqual({ plan: "Pro", startedAt: "2026-07-13T00:00:00.000Z", renewsAt: "2026-10-06T00:00:00.000Z", checkedAt: now.toISOString() });
    expect(JSON.stringify(value)).not.toMatch(/private|invalid-header|signature/);
    const file = path.join(await fixture(), "auth.json");
    await writeFile(file, JSON.stringify({ tokens: { id_token: idToken, access_token: "private-access", refresh_token: "private-refresh" } }));
    expect(await readCodexSubscription(file, now)).toEqual(value);
    await writeFile(file, "not json");
    expect(await readCodexSubscription(file, now)).toBeUndefined();
    expect(await readCodexSubscription(file + ".missing", now)).toBeUndefined();
  });
  it("ignores absent or malformed tokens, plans and dates", () => {
    for (const raw of [undefined, "", "a.b", "a.%.c", "a.b.c", "x".repeat(70_000), token([]), token({})]) expect(codexSubscription(raw, now)).toBeUndefined();
    expect(codexSubscription(token({ "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_subscription_active_start: null, chatgpt_subscription_active_until: "bad" } }), now))
      .toEqual({ plan: "Plus", checkedAt: now.toISOString() });
  });
  it("reads each Claude home independently and does not expose other oauth fields", async () => {
    const home = await fixture();
    await mkdir(path.join(home, ".claude-work"));
    await writeFile(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationRateLimitTier: "default_claude_max_20x", billingType: "stripe_subscription", subscriptionCreatedAt: "2026-07-13T09:00:00Z", accessToken: "private" } }));
    await writeFile(path.join(home, ".claude-work/.claude.json"), JSON.stringify({ oauthAccount: { billingType: "claude_pro", subscriptionCreatedAt: "2026-08-31T09:00:00Z" } }));
    const homes = claudeHomes({ HOME: home });
    expect(homes.map(h => claudeAccountSubscription(h, now))).toEqual([
      { plan: "Max 20x", startedAt: "2026-07-13T09:00:00.000Z", renewsAt: "2026-10-13T09:00:00.000Z", renewsEstimated: true, checkedAt: now.toISOString() },
      { plan: "Pro", startedAt: "2026-08-31T09:00:00.000Z", renewsAt: "2026-09-30T09:00:00.000Z", renewsEstimated: true, checkedAt: now.toISOString() },
    ]);
    await writeFile(homes[1].configFile, "{}"); clearAccountCaches();
    expect(claudeAccountSubscription(homes[1], now)).toBeUndefined();
  });
  it("attaches file metadata to both live and cached reader reports without re-reading quota", async () => {
    const home = await fixture();
    await mkdir(path.join(home, ".codex"));
    await writeFile(path.join(home, ".codex/auth.json"), JSON.stringify({ tokens: { id_token: idToken } }));
    await writeFile(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationRateLimitTier: "default_claude_pro", subscriptionCreatedAt: "2026-07-13T00:00:00Z" } }));
    vi.stubEnv("HOME", home); vi.stubEnv("CODEX_HOME", path.join(home, ".codex")); vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    let quotaCalls = 0;
    const reader = new AccountUsageReader(async () => { quotaCalls++; return { source: "codex", windows: [], updatedAt: "2026-09-28T00:00:00Z" }; },
      () => now.getTime(), async () => ({ source: "claude", windows: [{ id: "five_hour", name: "5-hour", usedPercent: 5 }], updatedAt: now.toISOString() }));
    const first = await reader.limits();
    expect(first[0].subscription?.plan).toBe("Pro");
    expect(first[0].updatedAt).toBe("2026-09-28T00:00:00Z");
    expect(first[1].subscription).toMatchObject({ plan: "Pro", renewsEstimated: true });
    expect((await reader.limits())[0].subscription).toEqual(first[0].subscription);
    expect(quotaCalls).toBe(1);
  });
  it("clamps month ends without drifting, handles leap years and advances at the anniversary", () => {
    expect(monthlyAnniversary("2024-01-31T10:00:00Z", new Date("2024-02-01"))).toBe("2024-02-29T10:00:00.000Z");
    expect(monthlyAnniversary("2024-01-31T10:00:00Z", new Date("2024-02-29T10:00:00Z"))).toBe("2024-03-31T10:00:00.000Z");
    expect(monthlyAnniversary("2025-01-31T10:00:00Z", new Date("2025-02-01"))).toBe("2025-02-28T10:00:00.000Z");
    expect(monthlyAnniversary("2025-01-31T10:00:00Z", new Date("2025-12-31T10:00:00Z"))).toBe("2026-01-31T10:00:00.000Z");
    expect(monthlyAnniversary("2027-01-01", now)).toBeUndefined();
  });
  it("reuses ElevenLabs' subscription response and keeps invoice and character reset distinct", async () => {
    let calls = 0;
    const value = await fetchElevenLabsUsage("fixture-key", async () => { calls++; return new Response(JSON.stringify({ tier: "creator", character_count: 50, character_limit: 100, next_invoice: { next_payment_attempt_unix: 1791244800 }, next_character_count_reset_unix: 1791331200 })); }, now);
    expect(calls).toBe(1);
    expect(value.subscription).toEqual({ plan: "Creator", renewsAt: "2026-10-06T00:00:00.000Z", checkedAt: now.toISOString() });
    expect(value.windows[0].resetsAt).toBe("2026-10-07T00:00:00.000Z");
    expect(elevenLabsUsage({ tier: "free" }, now).subscription?.plan).toBe("Free");
    expect(elevenLabsUsage({ tier: "starter", next_invoice: null }, now).subscription?.renewsAt).toBeUndefined();
  });
  it("carries known Copilot and Go plans and monthly resets", () => {
    expect(copilotUsage({ copilot_plan: "individual_pro", quota_reset_date_utc: "2026-10-01" }, now).subscription)
      .toEqual({ plan: "Individual Pro", renewsAt: "2026-10-01T00:00:00.000Z", checkedAt: now.toISOString() });
    const windows = [{ id: "opencode-go:plan:30d", name: "Monthly", usedPercent: 20, resetsAt: "2026-10-06T00:00:00Z" }];
    expect(openCodeGoUsage(windows, undefined, now, true).subscription?.renewsAt).toBe(windows[0].resetsAt);
    expect(openCodeGoUsage([], undefined, now, false).subscription).toBeUndefined();
  });
  it("merges subscription freshness by account separately from quota freshness and carries it through account_usage", async () => {
    const reports = [{ computer: "Mini", accounts: [{ source: "codex" as const, windows: [], subscription: codexSubscription(idToken, now) }] },
      { computer: "MacBook", accounts: [{ source: "codex" as const, windows: [{ id: "week", name: "Week", usedPercent: 20 }], updatedAt: now.toISOString(), subscription: { plan: "Plus", checkedAt: "2026-09-28T00:00:00Z" } }] }];
    const merged = mergeAccountUsage(reports, now.getTime());
    expect(merged.accounts).toHaveLength(1);
    expect(merged.accounts[0].subscription?.plan).toBe("Pro");
    expect(merged.accounts[0].windows[0].usedPercent).toBe(20);
    const view = await readAccountUsage({ hook: async route => route === "/v1/health" ? { computer: { name: "Mini" } } : { accounts: reports[0].accounts }, peers: async () => ({ peers: [] }), store: null, now: now.getTime() });
    expect(view.accounts[0].subscription).toEqual(reports[0].accounts[0].subscription);
    expect(formatAccountUsage(view)).toContain("Pro · since 2026-07-13 · renews 2026-10-06");
  });
});
