import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountUsageReader,
  captureClaudeUsage,
  claudeOAuthUsage,
  claudeScopedWindows,
  claudeUsage,
  codexUsage,
  copilotUsage,
  elevenLabsUsage,
  fetchElevenLabsUsage,
  fetchClaudeUsage,
  fetchOpenRouterUsage,
  openCodeFailure,
  openCodeUsage,
  readClaudeToken,
  settleClaudeUsage,
  readCodexLimits,
  readCopilotUsage,
  openCodeGoPlan,
  readGoRefusals,
  readOpenCodeGoUsage,
  usageForCaller,
  readOpenCodeUsage,
  usageStatusLine,
} from "./usage.js";
import { CODEX_ACCOUNT, clearAccountCaches, claudeHomes } from "./claude-accounts.js";

const now = new Date("2026-09-12T08:00:00Z");
const reset = now.getTime() / 1000 + 3600;
const limits = { primary: { usedPercent: 23.5, windowDurationMins: 300, resetsAt: reset },
  secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: reset + 86400 } };
const openCode = async (date: Date) => openCodeUsage("Total Cost  $0.00", date);
const noOpenRouter = async () => undefined;
const noOpenCodeGo = async () => ({ source: "opencode-go" as const, windows: [] });
const noCopilot = async () => ({ source: "copilot" as const, windows: [] });

describe("account usage", () => {
  it("keeps quota percentages and reset times separate from token counts", () => {
    const value = codexUsage({ rateLimits: limits, totalTokens: 999999, token: "private" }, now);
    expect(value.windows).toEqual([
      { id: "codex:primary", name: "5-hour limit", usedPercent: 23.5, resetsAt: "2026-09-12T09:00:00.000Z" },
      { id: "codex:secondary", name: "7-day limit", usedPercent: 0, resetsAt: "2026-09-13T09:00:00.000Z" },
    ]);
    expect(JSON.stringify(value)).not.toContain("private");
    expect(value.updatedAt).toBe(now.toISOString());
  });
  it("uses all named buckets without duplicating the legacy bucket", () => {
    const value = codexUsage({ rateLimits: limits, rateLimitsByLimitId: {
      codex: limits, spark: { limitName: "Spark", primary: limits.primary },
    } });
    // Spark is a separate lane nobody budgets by; it stays out of the report.
    expect(value.windows).toHaveLength(2);
    expect(value.windows.map(w => w.id)).toEqual(["codex:primary", "codex:secondary"]);
  });
  it("rejects malformed values and never converts missing limits into zero usage", () => {
    for (const used of [null, true, "50", -1, 101, Infinity, NaN]) {
      expect(codexUsage({ rateLimits: { primary: { usedPercent: used } } }).windows).toEqual([]);
      expect(claudeUsage({ rate_limits: { five_hour: { used_percentage: used } } }).windows).toEqual([]);
    }
    expect(claudeUsage({}).message).toContain("after Claude Code replies");
    expect(claudeUsage({ rate_limits: { five_hour: { used_percentage: 100, resets_at: "tomorrow" } } }).windows[0].resetsAt).toBeUndefined();
    // Weekly-all and per-model windows are separate allotments. A scoped
    // window can be higher without contradicting the all-models window.
    const perModel = claudeUsage({ rate_limits: {
      seven_day_fable: { used_percentage: 18, resets_at: 1789848000 }, five_hour: { used_percentage: 40, resets_at: 1789514400 },
      seven_day: { used_percentage: 16, resets_at: 1789848000 }, seven_day_opus: { used_percentage: 3, resets_at: 1789848000 } } });
    expect(perModel.windows.map(w => [w.id, w.name, w.usedPercent])).toEqual([
      ["five_hour", "5-hour limit", 40], ["seven_day", "7-day, all models", 16],
      ["seven_day_fable", "7-day, Fable", 18], ["seven_day_opus", "7-day, Opus", 3]]);
  });
  it("normalizes Claude's documented subscription status-line data", () => {
    const value = claudeUsage({ rate_limits: { five_hour: { used_percentage: 41.2, resets_at: reset },
      seven_day: { used_percentage: 0, resets_at: reset + 86400 } }, session_id: "private", cwd: "/private" }, now);
    expect(value.windows.map(w => w.usedPercent)).toEqual([41.2, 0]);
    expect(value.windows[0].resetsAt).toBe("2026-09-12T09:00:00.000Z");
    expect(JSON.stringify(value)).not.toContain("private");
  });
  it("reproduces a 40/16/18 status-line report with one label and its own reset per number", () => {
    const week = 1789848000, fableWeek = week + 1800;
    const report = claudeUsage({ rate_limits: {
      five_hour: { used_percentage: 40, resets_at: 1789514400 },
      seven_day: { used_percentage: 16, resets_at: week },
      seven_day_fable: { used_percentage: 18, resets_at: fableWeek },
    } }, now);
    expect(report.origin).toBe("status-line");
    expect(report.updatedAt).toBe(now.toISOString());
    expect(report.windows.map(w => [w.id, w.name, w.usedPercent])).toEqual([
      ["five_hour", "5-hour limit", 40],
      ["seven_day", "7-day, all models", 16],
      ["seven_day_fable", "7-day, Fable", 18],
    ]);
    // Each window is labelled with its own reset time: the per-model Fable
    // window keeps its own bucket's reset, not the all-models one, and its
    // higher percentage is a separate allowance rather than a subset.
    expect(report.windows.map(w => w.resetsAt)).toEqual([
      new Date(1789514400 * 1000).toISOString(),
      new Date(week * 1000).toISOString(),
      new Date(fableWeek * 1000).toISOString(),
    ]);
    expect(report.windows[2].resetsAt).not.toBe(report.windows[1].resetsAt);
  });
  it("preserves, wraps once, and restores an existing status-line command and options", () => {
    const previous = { type: "command", command: "printf 'custom status'; cat", padding: 2, refreshInterval: 10 };
    const program = "/tmp/phren's helper/bridge-hook.mjs";
    const wrapped = usageStatusLine(previous, program, false) as typeof previous;
    expect(wrapped.padding).toBe(2);
    expect(wrapped.refreshInterval).toBe(10);
    expect(usageStatusLine(wrapped, program, false)).toEqual(wrapped);
    expect(usageStatusLine(wrapped, program, true)).toEqual(previous);
    expect(usageStatusLine(usageStatusLine(undefined, program, false), program, true)).toBeUndefined();
  });
  it("lifts per-model weekly windows out of Claude Code's own usage snapshot, dated", () => {
    const config = { oauthAccount: { emailAddress: "private@example.com" }, cachedUsageUtilization: {
      fetchedAtMs: now.getTime() - 3_600_000, utilization: { five_hour: { utilization: 2 }, limits: [
        { kind: "session", percent: 2, resets_at: "2026-09-12T12:59:59+00:00" },
        { kind: "weekly_all", group: "weekly", percent: 35 },
        { kind: "weekly_scoped", percent: 48, resets_at: "2026-09-19T20:00:00+00:00", scope: { model: { id: null, display_name: "Fable" } } },
        { kind: "weekly_scoped", percent: 7, resets_at: "bad", scope: { model: { display_name: "Opus 5" } } },
        { kind: "weekly_scoped", percent: 200, scope: { model: { display_name: "Broken" } } },
      ] } } };
    expect(claudeScopedWindows(config, now)).toEqual([
      { id: "seven_day_fable", name: "7-day, Fable", usedPercent: 48, resetsAt: "2026-09-19T20:00:00.000Z", asOf: "2026-09-12T07:00:00.000Z" },
      { id: "seven_day_opus_5", name: "7-day, Opus 5", usedPercent: 7, resetsAt: undefined, asOf: "2026-09-12T07:00:00.000Z" },
    ]);
    expect(JSON.stringify(claudeScopedWindows(config, now))).not.toContain("private");
    expect(claudeScopedWindows({ cachedUsageUtilization: { utilization: { limits: [] } } }, now)).toEqual([]);
    expect(claudeScopedWindows({ cachedUsageUtilization: { fetchedAtMs: now.getTime() + 120_000, utilization: { limits: [] } } }, now)).toEqual([]);
  });
  it("shares in-flight Codex requests and caches account reads for a minute", async () => {
    let calls = 0, time = 0;
    const reader = new AccountUsageReader(async () => { calls++; return codexUsage({ rateLimits: limits }, now); }, () => time,
      async () => undefined, openCode, noOpenRouter, noOpenCodeGo, noCopilot);
    await Promise.all([reader.read(), reader.read()]);
    expect(calls).toBe(1);
    time = 59_999; await reader.read(); expect(calls).toBe(1);
    time = 60_000; await reader.read(); expect(calls).toBe(2);
  });
  it("reads Copilot's limited quotas, names unlimited ones and never passes a token on", async () => {
    const report = { copilot_plan: "enterprise", quota_reset_date_utc: "2026-10-01T00:00:00.000Z", token: "ghu_secret",
      quota_snapshots: {
        chat: { quota_id: "chat", unlimited: true, percent_remaining: 100 },
        completions: { quota_id: "completions", unlimited: true, percent_remaining: 100 },
        premium_interactions: { quota_id: "premium_interactions", unlimited: false, percent_remaining: 67.3, quota_remaining: 67305.9 },
      } };
    const value = copilotUsage(report, now);
    expect(value).toEqual({ source: "copilot", updatedAt: now.toISOString(), message: "Plan: enterprise. Unlimited: chat, completions.",
      windows: [{ id: "premium_interactions", name: "Premium requests · monthly", usedPercent: 32.7, resetsAt: "2026-10-01T00:00:00.000Z" }] });
    expect(JSON.stringify(value)).not.toContain("ghu_secret");
    const signedOut = await readCopilotUsage(now, async () => { throw new Error("gh: not logged in"); });
    expect(signedOut.windows).toEqual([]);
    expect(signedOut.message).toContain("gh auth login");
  });
  it("does not ask gh for Copilot usage when the caller excludes Copilot", async () => {
    let ghCalls = 0;
    const reader = new AccountUsageReader(async () => codexUsage({ rateLimits: limits }, now), () => 0,
      async () => undefined, openCode, noOpenRouter, noOpenCodeGo,
      date => readCopilotUsage(date, async () => { ghCalls++; return "{}"; }));
    const usage = await reader.read(new Set(["codex", "claude", "opencode"]));
    expect(ghCalls).toBe(0);
    expect(usage.accounts.some(account => account.source === "copilot")).toBe(false);
    const withCopilot = await reader.read(new Set(["codex", "copilot"]));
    expect(ghCalls).toBe(1);
    expect(withCopilot.accounts.some(account => account.source === "copilot")).toBe(true);
  });
  it("does not spend an ElevenLabs request when the caller excludes ElevenLabs", async () => {
    let elevenCalls = 0;
    const reader = new AccountUsageReader(async () => codexUsage({ rateLimits: limits }, now), () => 0,
      async () => undefined, openCode, noOpenRouter, noOpenCodeGo, async () => ({ source: "copilot", windows: [] }), process.platform,
      async date => { elevenCalls++; return { source: "elevenlabs", windows: [], updatedAt: date.toISOString() }; });
    await reader.read(new Set(["codex", "claude", "opencode", "opencode-go"]));
    expect(elevenCalls).toBe(0);
    const withSpeech = await reader.read(new Set(["codex", "elevenlabs"]));
    expect(elevenCalls).toBe(1);
    expect(withSpeech.accounts.some(account => account.source === "elevenlabs")).toBe(true);
  });
  it("explains a Copilot 404 as a missing subscription", async () => {
    const error = Object.assign(new Error("Command failed"), { stderr: "gh: Not Found (HTTP 404)" });
    const usage = await readCopilotUsage(now, async () => { throw error; });
    expect(usage.message).toBe("No Copilot subscription on this GitHub account");
  });
  it("reports OpenCode's rolling seven-day cost without session content", () => {
    const output = "\u001b[32mTotal Cost\u001b[0m                                        $4.39\nprivate session title";
    const value = openCodeUsage(output, now);
    expect(value).toEqual({ source: "opencode", windows: [], spend: { amountUSD: 4.39, period: "rolling_7_days" }, updatedAt: now.toISOString() });
    expect(JSON.stringify(value)).not.toContain("private session title");
    expect(openCodeUsage("no cost here").message).toContain("opencode stats");
  });
  // The fake opencode is a /bin/sh script, which Windows cannot execute.
  it.skipIf(process.platform === "win32")("says whether OpenCode is missing, signed out or failing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phren-opencode-"));
    try {
      expect((await readOpenCodeUsage(path.join(root, "missing-opencode"), now)).message).toMatch(/not installed/);
      const script = async (name: string, body: string) => {
        const file = path.join(root, name);
        await writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        return file;
      };
      const signedOut = await readOpenCodeUsage(await script("signed-out", "echo 'Error: not logged in to any provider' >&2; exit 1"), now);
      expect(signedOut.message).toBe("OpenCode is not signed in on this computer. Run opencode auth login. (Error: not logged in to any provider)");
      const broken = await readOpenCodeUsage(await script("broken", "echo '' >&2; echo 'database is locked' >&2; exit 3"), now);
      expect(broken.message).toBe("opencode stats --days 7 failed (exit 3): database is locked. Run it on this computer to see why.");
    } finally { await rm(root, { recursive: true, force: true }); }
    expect(openCodeFailure({ killed: true, signal: "SIGTERM" })).toContain("timed out");
  });
  // Owner bug 2026-09-26: the meter showed $0.44 of an invented $100 while
  // Go was refusing requests. Go's own report is what it enforces.
  it("shows OpenCode Go's own plan windows, the limit it is enforcing, and its refusals", async () => {
    const report = { usage: {
      rolling: { status: "ok", percent: 0, resetsAt: "2026-09-27T06:46:25.185Z" },
      weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-09-28T00:00:00.000Z" },
      monthly: { status: "ok", percent: 54, resetsAt: "2026-10-20T19:52:38.000Z" },
    } };
    expect(openCodeGoPlan(report)).toEqual([
      { id: "opencode-go:plan:5h", name: "5-hour limit", usedPercent: 0, resetsAt: "2026-09-27T06:46:25.185Z" },
      { id: "opencode-go:plan:7d", name: "Weekly limit", usedPercent: 100, resetsAt: "2026-09-28T00:00:00.000Z", limited: true },
      { id: "opencode-go:plan:30d", name: "Monthly limit", usedPercent: 54, resetsAt: "2026-10-20T19:52:38.000Z" },
    ]);
    // No dollar caps are invented from percentages.
    expect(JSON.stringify(openCodeGoPlan(report))).not.toMatch(/USD/);

    const logs = await mkdtemp(path.join(tmpdir(), "phren-opencode-log-"));
    try {
      const line = (at: string, model = "deepseek-v4.1-flash") => `timestamp=${at} level=ERROR run=a message="stream error" providerID=opencode-go modelID=${model} error.error="AI_APICallError: Go usage limit exceeded"`;
      await writeFile(path.join(logs, "opencode.log"), [line("2026-09-25T09:00:00.000Z"), line("2026-09-26T20:34:02.000Z"),
        "timestamp=2026-09-26T20:40:00.000Z level=INFO message=ok", line("2026-09-26T21:18:48.946Z")].join("\n") + "\n");
      const now = new Date("2026-09-26T22:00:00Z");
      const refusals = await readGoRefusals(now, 24 * 3_600_000, logs);
      expect(refusals).toEqual({ count: 2, first: "2026-09-26T20:34:02.000Z", last: "2026-09-26T21:18:48.946Z", models: ["opencode-go/deepseek-v4.1-flash"] });
      // A later poll reads only what OpenCode appended.
      await appendFile(path.join(logs, "opencode.log"), `${line("2026-09-26T21:30:00.000Z", "glm-5")}\n`);
      expect(await readGoRefusals(now, 24 * 3_600_000, logs)).toMatchObject({ count: 3, last: "2026-09-26T21:30:00.000Z",
        models: ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5"] });

      let seen: { url?: string; auth?: string } = {};
      const fetchImpl = (async (url: string, init: RequestInit) => {
        seen = { url, auth: (init.headers as Record<string, string>).authorization };
        return new Response(JSON.stringify(report), { status: 200 });
      }) as typeof fetch;
      const value = await readOpenCodeGoUsage(now, { readKey: async () => "go-test-key-not-a-secret", fetchImpl, readRefusals: async () => refusals });
      expect(seen).toEqual({ url: "https://opencode.ai/zen/go/v1/usage", auth: "Bearer go-test-key-not-a-secret" });
      expect(value.windows.find(window => window.id === "opencode-go:plan:7d")).toMatchObject({ usedPercent: 100, limited: true });
      expect(value.message).toBe('Go is refusing requests: the weekly limit is reached. OpenCode refused 2 Go requests with "usage limit exceeded" in the last day (20:34 UTC to 21:18 UTC).');
      expect(JSON.stringify(value)).not.toContain("go-test-key-not-a-secret");
      expect(value.spend).toBeUndefined();

      // A phone built before plan windows rejects them, so it gets the account and message only.
      const accounts = [value, { source: "claude" as const, windows: [] }];
      expect(usageForCaller(accounts, new Set(["opencode-go", "claude"]), false)[0]).toEqual({ ...value, windows: [] });
      expect(usageForCaller(accounts, new Set(["opencode-go", "claude"]), true)[0]).toBe(value);
      expect(usageForCaller(accounts, new Set(["claude"]), true).map(account => account.source)).toEqual(["claude"]);

      // Go's report unreachable: the log still says what happened.
      const down = await readOpenCodeGoUsage(now, { readKey: async () => "go-test-key-not-a-secret", readRefusals: async () => refusals,
        fetchImpl: (async () => new Response("", { status: 502 })) as typeof fetch });
      expect(down.windows).toEqual([]);
      expect(down.message).toContain("Could not read Go's usage report");
      expect(down.message).toContain("refused 2 Go requests");
      const withoutKey = await readOpenCodeGoUsage(now, { readKey: async () => undefined, readRefusals: async () => undefined });
      expect(withoutKey).toMatchObject({ source: "opencode-go", windows: [], message: "Connect OpenCode Go on this computer to see its usage." });
    } finally { await rm(logs, { recursive: true, force: true }); }
  });
  it("reads OpenRouter's current calendar-week spend without returning its key", async () => {
    let authorization = "";
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string>).authorization;
      return { ok: true, status: 200, json: async () => ({ data: { usage_weekly: 5.077798384, byok_usage_weekly: 9 } }) } as Response;
    }) as typeof fetch;
    const value = await fetchOpenRouterUsage("sk-or-private-test-key", fetchImpl, now);
    expect(authorization).toBe("Bearer sk-or-private-test-key");
    expect(value.spend).toEqual({ amountUSD: 5.077798384, period: "calendar_week" });
    expect(value.accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(value)).not.toContain("private-test-key");
  });
  it("maps the OAuth usage endpoint's structured limits without leaking the token", () => {
    const value = claudeOAuthUsage({ limits: [
      { kind: "session", percent: 2, resets_at: "2026-09-19T05:40:00.713784+00:00" },
      { kind: "weekly_all", percent: 99, resets_at: "2026-09-19T20:00:00.713803+00:00" },
      { kind: "weekly_scoped", percent: 100, resets_at: "2026-09-19T19:59:59.713983+00:00", scope: { model: { display_name: "Fable" } } },
      { kind: "weekly_scoped", percent: 7, scope: { model: { display_name: "Opus 5" } } },
      { kind: "extra_usage", percent: 50 },
      { kind: "weekly_scoped", percent: 200, scope: { model: { display_name: "Broken" } } },
    ], access_token: "private" }, now);
    expect(value.windows.map(w => [w.id, w.name, w.usedPercent])).toEqual([
      ["five_hour", "5-hour limit", 2],
      ["seven_day", "7-day, all models", 99],
      ["seven_day_fable", "7-day, Fable", 100],
      ["seven_day_opus_5", "7-day, Opus 5", 7],
    ]);
    expect(value.origin).toBe("oauth");
    expect(JSON.stringify(value)).not.toContain("private");
    expect(value.updatedAt).toBe(now.toISOString());
  });
  it("reads the local sign-in token and rejects an expired one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "phren-cred-"));
    const noKeychain = async () => { throw new Error("no keychain"); };
    try {
      const file = path.join(dir, ".credentials.json");
      const previous = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = dir;
      await writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3_600_000 } }));
      expect(await readClaudeToken(noKeychain)).toBe("tok");
      const keychain = (async () => ({ stdout: JSON.stringify({ claudeAiOauth: { accessToken: "fresh-keychain", expiresAt: Date.now() + 3_600_000 } }), stderr: "" })) as unknown as Parameters<typeof readClaudeToken>[0];
      expect(await readClaudeToken(keychain, "darwin")).toBe("fresh-keychain");
      expect(await readClaudeToken(keychain, "linux")).toBe("tok");
      await writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() - 1 } }));
      expect(await readClaudeToken(noKeychain)).toBeUndefined();
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("fetches live Claude limits with the bearer token, falling back when it fails", async () => {
    let seen: { url: string; auth?: string } | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seen = { url: String(url), auth: (init?.headers as Record<string, string>)?.authorization };
      return { ok: true, status: 200, json: async () => ({ limits: [{ kind: "session", percent: 5, resets_at: null }] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const live = await fetchClaudeUsage("secret-token", fetchImpl, now);
    expect(live.windows.map(w => [w.id, w.usedPercent])).toEqual([["five_hour", 5]]);
    expect(live.origin).toBe("oauth");
    expect(seen?.url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(seen?.auth).toBe("Bearer secret-token");
    expect(JSON.stringify(live)).not.toContain("secret-token");

    let claudeCalls = 0;
    const reader = new AccountUsageReader(async () => codexUsage({ rateLimits: limits }, now), () => 0,
      async () => { claudeCalls++; return claudeUsage({ rate_limits: { five_hour: { used_percentage: 42 } } }, now); }, openCode, noOpenRouter, noOpenCodeGo, noCopilot);
    const first = await reader.read();
    expect(first.accounts[1].windows[0].usedPercent).toBe(42);
    expect(first.accounts[1].origin).toBe("status-line");
    await reader.read(); expect(claudeCalls).toBe(1);

    const fallback = new AccountUsageReader(async () => codexUsage({ rateLimits: limits }, now), () => 0,
      async () => undefined, openCode, noOpenRouter, noOpenCodeGo, noCopilot);
    const empty = await mkdtemp(path.join(tmpdir(), "phren-empty-"));
    const previousBridge = process.env.PHREN_BRIDGE_HOME, previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.PHREN_BRIDGE_HOME = empty; process.env.CLAUDE_CONFIG_DIR = empty;
    try {
      expect((await fallback.read()).accounts[1].message).toContain("after Claude Code replies");
    } finally {
      if (previousBridge === undefined) delete process.env.PHREN_BRIDGE_HOME; else process.env.PHREN_BRIDGE_HOME = previousBridge;
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfig;
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("local usage integration", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-usage-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("initializes Codex and only requests account limits", async () => {
    const executable = path.join(root, "codex"), record = path.join(root, "requests.jsonl");
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const rl = require('node:readline').createInterface({input:process.stdin});
rl.on('line', line => {
  fs.appendFileSync(${JSON.stringify(record)}, line+'\\n');
  const req = JSON.parse(line);
  if(req.id === 0) process.stdout.write(JSON.stringify({id:0,result:{}})+'\\n');
  if(req.id === 1) process.stdout.write(JSON.stringify({id:1,result:{rateLimits:${JSON.stringify(limits)}}})+'\\n');
});
`, { mode: 0o700 });
    const value = await readCodexLimits(executable);
    expect(value.windows).toHaveLength(2);
    const requests = (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.map(r => r.method)).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
  });
  it("reports unavailable when Codex cannot start", async () => {
    const value = await readCodexLimits(path.join(root, "missing-codex"));
    expect(value.windows).toEqual([]);
    expect(value.message).toContain("Could not read");
  });
  it("records only Claude quota data and forwards the original status-line input and output", async () => {
    const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 52, resets_at: reset } }, privateContent: "do-not-persist" });
    const original = Buffer.from(JSON.stringify({ type: "command", command: "cat" })).toString("base64");
    const bundle = path.resolve(process.env.PHREN_TEST_HOOK_BUNDLE || "packages/cli/dist/bridge-hook.mjs");
    const child = spawn(process.execPath, [bundle, "usage-statusline", original], {
      env: { ...process.env, PHREN_BRIDGE_HOME: root }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    const finished = new Promise(resolve => child.once("exit", resolve)); child.stdin.end(input);
    expect(await finished, stderr).toBe(0);
    expect(stdout).toBe(input);
    const stored = await readFile(path.join(root, "usage/claude.json"), "utf8");
    expect(JSON.parse(stored).rate_limits.five_hour.used_percentage).toBe(52);
    expect(stored).not.toContain("do-not-persist");
  });
});

describe("Claude accounts in usage", () => {
  let home: string, bridge: string;
  const saved: Record<string, string | undefined> = {};
  const setEnv = (key: string, value: string | undefined) => { if (!(key in saved)) saved[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  const reader = (platform: NodeJS.Platform, live: (date: Date, home: { id: string }) => Promise<undefined | ReturnType<typeof claudeUsage>>) =>
    new AccountUsageReader(async () => codexUsage({ rateLimits: limits }, now), () => 0, live as never, openCode, noOpenRouter, noOpenCodeGo, noCopilot, platform);
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "phren-acct-home-")); bridge = await mkdtemp(path.join(tmpdir(), "phren-acct-bridge-"));
    setEnv("HOME", home); setEnv("PHREN_BRIDGE_HOME", bridge); setEnv("CLAUDE_CONFIG_DIR", undefined);
    await mkdir(path.join(home, ".claude-work"), { recursive: true });
    await writeFile(path.join(home, ".claude-work", ".claude.json"), "{}");
    clearAccountCaches();
  });
  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    vi.restoreAllMocks(); clearAccountCaches();
    await rm(home, { recursive: true, force: true }); await rm(bridge, { recursive: true, force: true });
  });
  it("returns one Claude row (the default home) unless every account is asked for", async () => {
    const r = reader("linux", async (date, h) => claudeUsage({ rate_limits: { five_hour: { used_percentage: h.id === "work" ? 70 : 10 } } }, date));
    const single = await r.read();
    expect(single.accounts.map(a => [a.source, a.account?.id])).toEqual([["codex", "default"], ["claude", "default"], ["opencode", undefined], ["opencode-go", undefined], ["copilot", undefined]]);
  });
  it("returns one Claude row per home with accounts=all, default first, and tags Codex", async () => {
    const usage = await reader("linux", async (date, h) => claudeUsage({ rate_limits: { five_hour: { used_percentage: h.id === "work" ? 70 : 10 } } }, date)).read(undefined, true);
    expect(usage.accounts.map(a => [a.source, a.account?.id])).toEqual([["codex", "default"], ["claude", "default"], ["claude", "work"], ["opencode", undefined], ["opencode-go", undefined], ["copilot", undefined]]);
    expect(usage.accounts[0].account).toEqual(CODEX_ACCOUNT);
    expect(usage.accounts[1].account).toMatchObject({ id: "default", label: "Claude", key: "claude:home:default" });
    expect(usage.accounts[2].account).toMatchObject({ id: "work", label: "Work", key: "claude:home:work" });
    expect(usage.accounts.filter(a => a.source === "claude").map(a => a.windows[0].usedPercent)).toEqual([10, 70]);
  });
  it("does no live read for a non-default home on macOS and uses its own snapshot", async () => {
    const seen: string[] = [];
    await mkdir(path.join(bridge, "usage"), { recursive: true });
    await writeFile(path.join(bridge, "usage", "claude-work.json"), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 33 } }, updatedAt: new Date(0).toISOString() }));
    const usage = await reader("darwin", async (_date, h) => { seen.push(h.id); return undefined; }).read(undefined, true);
    expect(seen).toEqual(["default"]);
    const work = usage.accounts.find(a => a.account?.id === "work" && a.source === "claude")!;
    expect(work.origin).toBe("status-line");
    expect(work.windows[0].usedPercent).toBe(33);
  });
  it("reads a non-default home's own credentials file off macOS, with a fake fetch", async () => {
    await writeFile(path.join(home, ".claude-work", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "work-token", expiresAt: Date.now() + 3_600_000 } }));
    const noKeychain = (async () => { throw new Error("no keychain"); }) as unknown as Parameters<typeof readClaudeToken>[0];
    const work = claudeHomes().find(h => h.id === "work")!, main = claudeHomes()[0];
    expect(await readClaudeToken(noKeychain, "linux", work)).toBe("work-token");
    expect(await readClaudeToken(noKeychain, "linux", main)).toBeUndefined();
    let keychainCalls = 0;
    const counting = (async () => { keychainCalls++; return { stdout: "{}", stderr: "" }; }) as unknown as Parameters<typeof readClaudeToken>[0];
    expect(await readClaudeToken(counting, "darwin", work)).toBeUndefined();
    expect(keychainCalls).toBe(0);
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => ({ ok: true, status: 200,
      json: async () => ({ limits: [{ kind: "session", percent: (init?.headers as Record<string, string>).authorization === "Bearer work-token" ? 61 : 1, resets_at: null }] }) }) as unknown as Response) as unknown as typeof fetch;
    expect((await fetchClaudeUsage((await readClaudeToken(noKeychain, "linux", work))!, fetchImpl, now)).windows[0].usedPercent).toBe(61);
  });
  it("caches each home separately for a minute", async () => {
    const calls: Record<string, number> = {};
    let time = 0;
    const r = new AccountUsageReader(async () => codexUsage({ rateLimits: limits }, now), () => time,
      async (date, h) => { calls[h.id] = (calls[h.id] ?? 0) + 1; return claudeUsage({ rate_limits: { five_hour: { used_percentage: 5 } } }, date); },
      openCode, noOpenRouter, noOpenCodeGo, noCopilot, "linux");
    await r.read(undefined, true); await r.read(undefined, true);
    expect(calls).toEqual({ default: 1, work: 1 });
    time = 60_000; await r.read(undefined, true);
    expect(calls).toEqual({ default: 2, work: 2 });
  });
  it("captures the status line into the file of the home Claude runs in, and skips unknown homes", async () => {
    const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: 1_900_000_000 } } });
    const feed = () => vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from([input]) as unknown as typeof process.stdin);
    setEnv("CLAUDE_CONFIG_DIR", path.join(home, ".claude-work"));
    feed(); await captureClaudeUsage("bnVsbA==");
    expect(JSON.parse(await readFile(path.join(bridge, "usage", "claude-work.json"), "utf8")).rate_limits.five_hour.used_percentage).toBe(12);
    setEnv("CLAUDE_CONFIG_DIR", undefined);
    feed(); await captureClaudeUsage("bnVsbA==");
    expect(JSON.parse(await readFile(path.join(bridge, "usage", "claude.json"), "utf8")).rate_limits.five_hour.used_percentage).toBe(12);
    await rm(path.join(bridge, "usage"), { recursive: true, force: true });
    setEnv("CLAUDE_CONFIG_DIR", path.join(home, ".claude-nowhere"));
    feed(); await captureClaudeUsage("bnVsbA==");
    await expect(readFile(path.join(bridge, "usage", "claude.json"))).rejects.toThrow();
  });
  it("labels each Claude row with its login's email and key, even from a status-line snapshot", async () => {
    await writeFile(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-1", emailAddress: "me@example.com" } }));
    await mkdir(path.join(bridge, "usage"), { recursive: true });
    await writeFile(path.join(bridge, "usage", "claude.json"), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 20 } }, updatedAt: new Date(0).toISOString() }));
    const usage = await reader("darwin", async () => undefined).read(undefined, true);
    const row = usage.accounts.find(a => a.source === "claude" && a.account?.id === "default")!;
    expect(row.origin).toBe("status-line");
    expect(row.account).toMatchObject({ email: "me@example.com" });
    expect(row.account?.key).toMatch(/^claude:[0-9a-f]{12}$/);
    expect(usage.accounts.find(a => a.account?.id === "work")!.account).not.toHaveProperty("email");
  });
  it("reports a window past its reset as reset without its old percent, and drops reports older than three days", () => {
    const day = 86_400_000, at = Date.parse("2026-09-26T16:18:46.273Z");
    const saved = { source: "claude" as const, origin: "status-line" as const, updatedAt: new Date(at).toISOString(), windows: [
      { id: "five_hour", name: "5-hour limit", usedPercent: 4, resetsAt: "2026-09-26T19:40:00.000Z" },
      { id: "seven_day", name: "7-day, all models", usedPercent: 96, resetsAt: "2026-09-26T20:00:00.000Z" },
      { id: "seven_day_fable", name: "7-day, Fable", usedPercent: 50, resetsAt: "2026-10-01T00:00:00.000Z", asOf: new Date(at + 2 * day).toISOString() },
    ] };
    const beforeReset = settleClaudeUsage(saved, Date.parse("2026-09-26T19:00:00Z"));
    expect(beforeReset.windows.map(w => [w.id, w.usedPercent, w.reset])).toEqual([["five_hour", 4, undefined], ["seven_day", 96, undefined], ["seven_day_fable", 50, undefined]]);
    const afterReset = settleClaudeUsage(saved, Date.parse("2026-09-27T12:00:00Z"));
    expect(afterReset.windows.map(w => [w.id, w.usedPercent, w.reset])).toEqual([["five_hour", undefined, true], ["seven_day", undefined, true], ["seven_day_fable", 50, undefined]]);
    expect(afterReset.windows[1]).not.toHaveProperty("usedPercent");
    // The status-line windows are over three days old; the fresher per-model window stays.
    expect(settleClaudeUsage(saved, at + 3 * day + 1).windows.map(w => w.id)).toEqual(["seven_day_fable"]);
    const gone = settleClaudeUsage(saved, at + 6 * day);
    expect(gone.windows).toEqual([]);
    expect(gone.message).toBe("No usage report from Claude on this computer since 2026-09-26. It updates when Claude Code runs here.");
    expect(gone.message).not.toContain("\u2014");
  });
});

describe("ElevenLabs usage", () => {
  it("reports characters used against the limit with the reset, and sends the key only to ElevenLabs", async () => {
    let seen: { url: string; key?: string } | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seen = { url: String(url), key: (init?.headers as Record<string, string>)["xi-api-key"] };
      return { ok: true, status: 200, json: async () => ({ tier: "creator", character_count: 12_345, character_limit: 100_000, next_character_count_reset_unix: 1_900_000_000 }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const usage = await fetchElevenLabsUsage("xi-secret", fetchImpl, now);
    expect(seen).toEqual({ url: "https://api.elevenlabs.io/v1/user/subscription", key: "xi-secret" });
    expect(usage.source).toBe("elevenlabs");
    expect(usage.windows).toEqual([{ id: "elevenlabs:characters", name: "Characters this period", usedPercent: 12.3,
      usedCharacters: 12_345, limitCharacters: 100_000, resetsAt: new Date(1_900_000_000_000).toISOString() }]);
    expect(JSON.stringify(usage)).not.toContain("xi-secret");
    const failing = (async () => ({ ok: false, status: 401 }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchElevenLabsUsage("xi-secret", failing, now)).rejects.toThrow("401");
  });
  it("caps overage at 100% and explains a missing limit", () => {
    expect(elevenLabsUsage({ character_count: 120, character_limit: 100 }, now).windows[0]).toMatchObject({ usedPercent: 100, usedCharacters: 120 });
    const none = elevenLabsUsage({ character_count: 5 }, now);
    expect(none.windows).toEqual([]);
    expect(none.message).toContain("did not report a character limit");
  });
  it("adds an ElevenLabs row only for callers that name the source", async () => {
    const reader = new AccountUsageReader(async () => codexUsage({ rateLimits: limits }, now), () => 0, async () => undefined,
      openCode, noOpenRouter, noOpenCodeGo, noCopilot, "linux", async date => elevenLabsUsage({ character_count: 10, character_limit: 100 }, date));
    const usage = await reader.read();
    expect(usage.accounts.filter(a => a.source === "elevenlabs").map(a => a.windows[0].usedPercent)).toEqual([10]);
    expect(usageForCaller(usage.accounts, new Set(["codex", "claude", "opencode", "openrouter"]), false).some(a => a.source === "elevenlabs")).toBe(false);
    expect(usageForCaller(usage.accounts, new Set(["elevenlabs"]), false).map(a => a.source)).toEqual(["elevenlabs"]);
  });
});
