import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountUsageReader,
  claudeOAuthUsage,
  claudeScopedWindows,
  claudeUsage,
  codexUsage,
  fetchClaudeUsage,
  fetchOpenRouterUsage,
  openCodeUsage,
  readClaudeToken,
  readCodexLimits,
  readOpenCodeGoUsage,
  usageStatusLine,
} from "./usage.js";

const now = new Date("2026-09-12T08:00:00Z");
const reset = now.getTime() / 1000 + 3600;
const limits = { primary: { usedPercent: 23.5, windowDurationMins: 300, resetsAt: reset },
  secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: reset + 86400 } };
const openCode = async (date: Date) => openCodeUsage("Total Cost  $0.00", date);
const noOpenRouter = async () => undefined;
const noOpenCodeGo = async () => ({ source: "opencode-go" as const, windows: [] });

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
      async () => undefined, openCode, noOpenRouter, noOpenCodeGo);
    await Promise.all([reader.read(), reader.read()]);
    expect(calls).toBe(1);
    time = 59_999; await reader.read(); expect(calls).toBe(1);
    time = 60_000; await reader.read(); expect(calls).toBe(2);
  });
  it("reports OpenCode's rolling seven-day cost without session content", () => {
    const output = "\u001b[32mTotal Cost\u001b[0m                                        $4.39\nprivate session title";
    const value = openCodeUsage(output, now);
    expect(value).toEqual({ source: "opencode", windows: [], spend: { amountUSD: 4.39, period: "rolling_7_days" }, updatedAt: now.toISOString() });
    expect(JSON.stringify(value)).not.toContain("private session title");
    expect(openCodeUsage("no cost here").message).toContain("opencode stats");
  });
  it("accounts for OpenCode Go fan-outs by model and rolling window", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phren-go-usage-"));
    const jobs = path.join(root, ".runtime", "agent-fanouts");
    const writeJob = async (id: string, model: string, events: unknown[]) => {
      const directory = path.join(jobs, id); await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ provider: "opencode", model, eventLog: "events.jsonl" }));
      await writeFile(path.join(directory, "events.jsonl"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
    };
    try {
      await writeJob("go-kimi", "opencode-go/kimi-k3", [
        { type: "step_finish", timestamp: "2026-09-12T07:00:00Z", part: { cost: 1.2, tokens: { input: 100, output: 20 } } },
        { type: "step_finish", timestamp: "2026-09-06T08:00:00Z", part: { cost: 3.6, tokens: 360 } },
        { type: "step_finish", timestamp: "2026-08-15T08:00:00Z", part: { cost: 4.3, tokens: 430 } },
      ]);
      await writeJob("go-qwen", "opencode-go/qwen3", [
        { type: "step_finish", timestamp: "2026-09-12T07:30:00Z", part: { cost: 0.25, tokens: 25 } },
      ]);
      await writeJob("not-go", "openrouter/example", [
        { type: "step_finish", timestamp: "2026-09-12T07:00:00Z", part: { cost: 99, tokens: 99_999 } },
      ]);
      const calls: { url: string; method?: string; authorization?: string }[] = [];
      const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method, authorization: (init?.headers as Record<string, string>).authorization });
        return { ok: true, headers: { get: () => null }, json: async () => ({ limits: {
        "opencode-go/kimi-k3": { "5h": { limitUSD: 2 }, "7d": { limitUSD: 5 }, "30d": { limitUSD: 10 } },
        } }) };
      }) as unknown as typeof fetch;
      const value = await readOpenCodeGoUsage(now, { root: jobs, readKey: async () => "go-test-key-not-a-secret", fetchImpl });
      expect(calls).toEqual([
        { url: "https://opencode.ai/zen/go/v1/usage", method: "GET", authorization: "Bearer go-test-key-not-a-secret" },
        { url: "https://opencode.ai/zen/go/v1/limits", method: "GET", authorization: "Bearer go-test-key-not-a-secret" },
        { url: "https://opencode.ai/zen/go/v1/credits", method: "GET", authorization: "Bearer go-test-key-not-a-secret" },
        { url: "https://opencode.ai/zen/go/v1/models", method: "HEAD", authorization: "Bearer go-test-key-not-a-secret" },
      ]);
      expect(value.source).toBe("opencode-go");
      expect(JSON.stringify(value)).not.toContain("go-test-key-not-a-secret");
      expect(value.windows).toHaveLength(6);
      expect(value.windows.filter(window => window.name.startsWith("opencode-go/kimi-k3"))).toMatchObject([
        { name: "opencode-go/kimi-k3 · 5h", usedUSD: 1.2, usedTokens: 120, limitUSD: 2, usedPercent: 60 },
        { name: "opencode-go/kimi-k3 · 7d", usedUSD: 4.8, usedTokens: 480, limitUSD: 5, usedPercent: 96 },
        { name: "opencode-go/kimi-k3 · 30d", usedUSD: 9.1, usedTokens: 910, limitUSD: 10, usedPercent: 91 },
      ]);
      expect(value.windows.find(window => window.name == "opencode-go/qwen3 · 30d")).toMatchObject({ usedUSD: 0.25 });
      expect(value.windows.some(window => window.usedUSD === 99)).toBe(false);
      expect(value.spend).toEqual({ amountUSD: 9.35, period: "rolling_30_days" });

      const withoutKey = await readOpenCodeGoUsage(now, { root: jobs, readKey: async () => undefined });
      expect(withoutKey.message).toBe("Connect OpenCode Go on this computer to see its usage.");
      expect(withoutKey.windows).toHaveLength(6);
      expect(withoutKey.windows.every(window => window.limitUSD === undefined && window.usedPercent === undefined)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
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
      async () => { claudeCalls++; return claudeUsage({ rate_limits: { five_hour: { used_percentage: 42 } } }, now); }, openCode, noOpenRouter, noOpenCodeGo);
    const first = await reader.read();
    expect(first.accounts[1].windows[0].usedPercent).toBe(42);
    expect(first.accounts[1].origin).toBe("status-line");
    await reader.read(); expect(claudeCalls).toBe(1);

    const fallback = new AccountUsageReader(async () => codexUsage({ rateLimits: limits }, now), () => 0,
      async () => undefined, openCode, noOpenRouter, noOpenCodeGo);
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
