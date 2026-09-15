import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { AccountUsageReader, claudeScopedWindows, claudeUsage, codexUsage, readCodexLimits, usageStatusLine } from "./usage.js";

const now = new Date("2026-09-12T08:00:00Z");
const reset = now.getTime() / 1000 + 3600;
const limits = { primary: { usedPercent: 23.5, windowDurationMins: 300, resetsAt: reset },
  secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: reset + 86400 } };

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
    // Per-model windows each get their own line, after the two overall ones.
    const perModel = claudeUsage({ rate_limits: {
      seven_day_fable: { used_percentage: 12, resets_at: 1789848000 }, five_hour: { used_percentage: 10, resets_at: 1789514400 },
      seven_day: { used_percentage: 70, resets_at: 1789848000 }, seven_day_opus: { used_percentage: 3, resets_at: 1789848000 } } });
    expect(perModel.windows.map(w => [w.id, w.name])).toEqual([
      ["five_hour", "5-hour limit"], ["seven_day", "7-day limit"], ["seven_day_fable", "7-day · Fable"], ["seven_day_opus", "7-day · Opus"]]);
  });
  it("normalizes Claude's documented subscription status-line data", () => {
    const value = claudeUsage({ rate_limits: { five_hour: { used_percentage: 41.2, resets_at: reset },
      seven_day: { used_percentage: 0, resets_at: reset + 86400 } }, session_id: "private", cwd: "/private" }, now);
    expect(value.windows.map(w => w.usedPercent)).toEqual([41.2, 0]);
    expect(value.windows[0].resetsAt).toBe("2026-09-12T09:00:00.000Z");
    expect(JSON.stringify(value)).not.toContain("private");
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
      { id: "seven_day_fable", name: "7-day · Fable", usedPercent: 48, resetsAt: "2026-09-19T20:00:00.000Z", asOf: "2026-09-12T07:00:00.000Z" },
      { id: "seven_day_opus_5", name: "7-day · Opus 5", usedPercent: 7, resetsAt: undefined, asOf: "2026-09-12T07:00:00.000Z" },
    ]);
    expect(JSON.stringify(claudeScopedWindows(config, now))).not.toContain("private");
    expect(claudeScopedWindows({ cachedUsageUtilization: { utilization: { limits: [] } } }, now)).toEqual([]);
    expect(claudeScopedWindows({ cachedUsageUtilization: { fetchedAtMs: now.getTime() + 120_000, utilization: { limits: [] } } }, now)).toEqual([]);
  });
  it("shares in-flight Codex requests and caches account reads for a minute", async () => {
    let calls = 0, time = 0;
    const reader = new AccountUsageReader(async () => { calls++; return codexUsage({ rateLimits: limits }, now); }, () => time);
    await Promise.all([reader.read(), reader.read()]);
    expect(calls).toBe(1);
    time = 59_999; await reader.read(); expect(calls).toBe(1);
    time = 60_000; await reader.read(); expect(calls).toBe(2);
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
