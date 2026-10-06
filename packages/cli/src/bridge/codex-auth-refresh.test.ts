import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexAuthKeeper, codexAuthRefreshEnabled, lastCodexRefresh, REFRESH_AFTER_MS } from "./codex-auth-refresh.js";

let directory = "", file = "";
const now = Date.parse("2026-09-28T10:00:00Z");
const signIn = (lastRefresh: number) => writeFile(file, JSON.stringify({ auth_mode: "chatgpt",
  tokens: { access_token: "a", refresh_token: "r", id_token: "i" }, last_refresh: new Date(lastRefresh).toISOString() }));
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), "phren-codex-auth-")); file = path.join(directory, "auth.json"); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("refreshing the shared Codex sign-in ahead of its workers", () => {
  it("leaves a recent sign-in, an API key and a missing file alone", async () => {
    const refreshAuth = vi.fn(async () => {});
    const keeper = new CodexAuthKeeper({ refreshAuth }, file, () => now);
    expect(await keeper.tick()).toBe(false);
    await signIn(now - REFRESH_AFTER_MS + 60_000);
    expect(await keeper.tick()).toBe(false);
    await writeFile(file, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "k" }));
    expect(await lastCodexRefresh(file)).toBeUndefined();
    expect(await keeper.tick()).toBe(false);
    expect(refreshAuth).not.toHaveBeenCalled();
  });

  it("refreshes a sign-in six days old exactly once, even when ticks overlap", async () => {
    await signIn(now - REFRESH_AFTER_MS - 60_000);
    const refreshAuth = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 20)); await signIn(now); });
    const keeper = new CodexAuthKeeper({ refreshAuth }, file, () => now);
    expect(await Promise.all([keeper.tick(), keeper.tick()])).toEqual([true, true]);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(await keeper.tick()).toBe(false);
  });

  it("reports a failed or ineffective refresh and tries again on the next tick", async () => {
    await signIn(now - 7 * 86_400_000);
    const refreshAuth = vi.fn(async () => { throw new Error("offline"); });
    const keeper = new CodexAuthKeeper({ refreshAuth }, file, () => now);
    expect(await keeper.tick()).toBe(false);
    expect(await new CodexAuthKeeper({ refreshAuth: async () => {} }, file, () => now).tick()).toBe(false);
    expect(await keeper.tick()).toBe(false);
    expect(refreshAuth).toHaveBeenCalledTimes(2);
    expect(codexAuthRefreshEnabled({ PHREN_CODEX_AUTH_REFRESH: "off" })).toBe(false);
    expect(codexAuthRefreshEnabled({})).toBe(true);
  });
});
