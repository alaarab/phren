import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { claudeConfigDir, codexHome } from "../home-paths.js";
import path from "node:path";
import { promisify } from "node:util";
import { atomicInPrivateDir, bridgeRoot, type Json, object } from "./protocol.js";
import { stripTerminal } from "../terminal-text.js";
import { codexExecutable } from "./codex-binary.js";
import { readSpeechKey } from "./speech-key.js";
import { resolveSpeechRegion, SPEECH_REGIONS } from "./speech-voice.js";
import { CODEX_ACCOUNT, claudeAccountSubscription, claudeAccountEmail, claudeAccountRef, claudeHomeOfEnv, claudeHomes, type AccountRef, type ClaudeHome } from "./claude-accounts.js";

import { planName, subscriptionDate, type Subscription } from "./subscription.js";
export type { Subscription } from "./subscription.js";

const exec = promisify(execFile);

export interface UsageWindow {
  id: string;
  name: string;
  /** A percentage is omitted rather than invented when a service has no limit. */
  usedPercent?: number;
  /** Local Go-ledger values; quota readers deliberately do not use these. */
  usedUSD?: number;
  limitUSD?: number;
  usedTokens?: number;
  /** ElevenLabs' character quota, next to its percentage. */
  usedCharacters?: number;
  limitCharacters?: number;
  resetsAt?: string;
  /** The service says this window is refusing requests now (OpenCode Go's `rate-limited`). */
  limited?: boolean;
  asOf?: string;
  /** The window's reset time passed after its report: no percent is known, so none is sent. */
  reset?: boolean;
}
export interface UsageSpend { amountUSD: number; period: "rolling_7_days" | "rolling_30_days" | "calendar_week" }
export interface AccountUsage {
  source: "codex" | "claude" | "opencode" | "opencode-go" | "openrouter" | "copilot" | "elevenlabs";
  windows: UsageWindow[];
  updatedAt?: string;
  message?: string;
  spend?: UsageSpend;
  subscription?: Subscription;
  /** Opaque key identity used only to avoid counting one OpenRouter key twice. */
  accountId?: string;
  /** Which Claude report fed this account: the status-line rate_limits payload
   *  or the OAuth usage endpoint. Per-model windows the status line never
   *  carries document their own age through each window's asOf instead. */
  origin?: "status-line" | "oauth";
  /** Which account this row is: a Claude home, or Codex's single one. Older phones ignore it. */
  account?: AccountRef;
}
/** The status-line snapshot: `usage/claude.json` for the default home, `usage/claude-<id>.json` for others. */
const claudeFile = (home?: ClaudeHome) => path.join(bridgeRoot(), "usage", home && !home.isDefault ? `claude-${home.id}.json` : "claude.json");
const safeText = (v: unknown) => typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100) : undefined;
function window(id: string, name: string, percent: unknown, reset: unknown): UsageWindow | undefined {
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return;
  const resetsAt = typeof reset === "number" && Number.isSafeInteger(reset) && reset > 0 && reset < 32_503_680_000
    ? new Date(reset * 1000).toISOString() : undefined;
  return { id, name, usedPercent: percent, resetsAt };
}
function duration(value: unknown, fallback: string): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 525600) return fallback;
  return value % 1440 === 0 ? `${value / 1440}-day limit` : value % 60 === 0 ? `${value / 60}-hour limit` : `${value}-minute limit`;
}

export function codexUsage(value: unknown, now = new Date()): AccountUsage {
  const result = object(value), multiple = object(result.rateLimitsByLimitId);
  const buckets = Object.keys(multiple).length
    ? Object.entries(multiple).sort(([a], [b]) => a === "codex" ? -1 : b === "codex" ? 1 : a.localeCompare(b)).slice(0, 16)
    : [["codex", result.rateLimits]];
  const windows: UsageWindow[] = [];
  for (const [key, raw] of buckets) {
    const bucket = object(raw), name = safeText(bucket.limitName);
    // Spark is a separate, lightweight lane nobody budgets by; leave it out.
    if (/spark/i.test(String(key)) || /spark/i.test(name ?? "")) continue;
    for (const field of ["primary", "secondary"]) {
      const item = object(bucket[field]);
      const label = duration(item.windowDurationMins, field === "primary" ? "Primary limit" : "Secondary limit");
      const entry = window(`${safeText(key)}:${field}`, name ? `${name} · ${label}` : label, item.usedPercent, item.resetsAt);
      if (entry) windows.push(entry);
    }
  }
  return { source: "codex", windows, updatedAt: now.toISOString(),
    ...(!windows.length ? { message: "Codex has not reported account limits. Sign in with your ChatGPT account in Codex on this computer." } : {}) };
}

/** Display metadata from the ID token's claims only, never an authentication decision. */
export function codexSubscription(idToken: unknown, now = new Date()): Subscription | undefined {
  if (typeof idToken !== "string" || idToken.length > 65_536) return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return undefined;
  try {
    const claims = object(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
    const auth = object(claims["https://api.openai.com/auth"]);
    const plan = planName(auth.chatgpt_plan_type);
    if (!plan) return undefined;
    const startedAt = subscriptionDate(auth.chatgpt_subscription_active_start);
    const renewsAt = subscriptionDate(auth.chatgpt_subscription_active_until);
    return { plan, ...(startedAt ? { startedAt } : {}), ...(renewsAt ? { renewsAt } : {}), checkedAt: now.toISOString() };
  } catch { return undefined; }
}

export async function readCodexSubscription(file = path.join(codexHome(), "auth.json"), now = new Date()): Promise<Subscription | undefined> {
  try {
    const handle = await open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 131_072) return undefined;
      return codexSubscription(object(object(JSON.parse(await handle.readFile("utf8"))).tokens).id_token, now);
    } finally { await handle.close(); }
  } catch { return undefined; }
}

/** Parse OpenCode's own cost ledger. `stats --days 7` is a rolling local view. */
export function openCodeUsage(output: string, now = new Date()): AccountUsage {
  const plain = stripTerminal(output);
  const match = /Total Cost\s+\$([0-9][0-9,]*(?:\.[0-9]+)?)/i.exec(plain);
  const amountUSD = match ? Number(match[1].replace(/,/g, "")) : Number.NaN;
  if (!Number.isFinite(amountUSD) || amountUSD < 0 || amountUSD > 1_000_000_000) {
    return { source: "opencode", windows: [], message: "Could not read OpenCode's seven-day cost. Run opencode stats --days 7 on this computer." };
  }
  return { source: "opencode", windows: [], spend: { amountUSD, period: "rolling_7_days" }, updatedAt: now.toISOString() };
}

/** Read the authoritative cost that OpenCode records for its local sessions. */
export async function readOpenCodeUsage(executable = "opencode", now = new Date()): Promise<AccountUsage> {
  try {
    const { stdout } = await exec(executable, ["stats", "--days", "7", "--pure"], { timeout: 12_000, maxBuffer: 1_048_576 });
    return openCodeUsage(stdout, now);
  } catch (error) {
    return { source: "opencode", windows: [], message: openCodeFailure(error) };
  }
}

/** Not installed, not signed in and a failing command each say so, with the command's own first line. */
export function openCodeFailure(error: unknown): string {
  const failure = error as { code?: string | number; stderr?: string; killed?: boolean; signal?: string } | undefined;
  if (failure?.code === "ENOENT") return "OpenCode is not installed on this computer (opencode was not found on PATH).";
  const said = stripTerminal(String(failure?.stderr ?? "")).split(/\r?\n/)
    .map(line => line.replace(/[\x00-\x1f\x7f]/g, " ").trim()).find(Boolean)?.slice(0, 200);
  if (/not (logged|signed) in|no (credentials|providers?)|unauthori[sz]ed|opencode auth login/i.test(said ?? ""))
    return `OpenCode is not signed in on this computer. Run opencode auth login. (${said})`;
  if (failure?.killed || failure?.signal) return "opencode stats --days 7 timed out on this computer.";
  const exit = typeof failure?.code === "number" ? ` (exit ${failure.code})` : "";
  return `opencode stats --days 7 failed${exit}${said ? `: ${said}` : ""}. Run it on this computer to see why.`;
}

const openCodeAuthFile = () => path.join(
  process.env.OPENCODE_DATA_DIR || path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "opencode"),
  "auth.json",
);

/** OpenCode's OpenRouter key stays local and is used only with OpenRouter. */
export async function readOpenRouterKey(): Promise<string | undefined> {
  try {
    const handle = await open(openCodeAuthFile(), "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65_536) return undefined;
      const key = object(object(JSON.parse(await handle.readFile("utf8"))).openrouter).key;
      return typeof key === "string" && key.length >= 16 && key.length <= 4_096 && !/[\x00-\x1f\x7f]/.test(key) ? key : undefined;
    } finally { await handle.close(); }
  } catch { return undefined; }
}

/** OpenCode Go's key stays local and is sent only to the Go gateway. */
export async function readOpenCodeGoKey(): Promise<string | undefined> {
  try {
    const handle = await open(openCodeAuthFile(), "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > 65_536) return undefined;
      const key = object(object(JSON.parse(await handle.readFile("utf8")))["opencode-go"]).key;
      return typeof key === "string" && key.length >= 16 && key.length <= 4_096 && !/[\x00-\x1f\x7f]/.test(key) ? key : undefined;
    } finally { await handle.close(); }
  } catch { return undefined; }
}

const GO_GATEWAY = "https://opencode.ai/zen/go/v1";
const GO_KEY_MESSAGE = "Connect OpenCode Go on this computer to see its usage.";
const GO_WINDOWS = [
  { key: "rolling", id: "opencode-go:plan:5h", name: "5-hour limit" },
  { key: "weekly", id: "opencode-go:plan:7d", name: "Weekly limit" },
  { key: "monthly", id: "opencode-go:plan:30d", name: "Monthly limit" },
] as const;

/**
 * Go's own report of the plan, `GET /zen/go/v1/usage`:
 * `{usage: {rolling|weekly|monthly: {status, percent, resetsAt}}}`. It is
 * account-wide, so it already counts every computer's use, and it is what
 * Go enforces: `status: "rate-limited"` is the window that refuses requests.
 * It carries no dollar amounts, so none are shown.
 */
export function openCodeGoPlan(value: unknown): UsageWindow[] {
  const usage = object(object(value).usage);
  return GO_WINDOWS.flatMap(({ key, id, name }) => {
    const item = object(usage[key]);
    const percent = item.percent;
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return [];
    const resetsAt = typeof item.resetsAt === "string" && Number.isFinite(Date.parse(item.resetsAt)) ? new Date(item.resetsAt).toISOString() : undefined;
    const limited = typeof item.status === "string" && item.status !== "ok";
    return [{ id, name, usedPercent: Math.round(percent * 10) / 10, ...(resetsAt ? { resetsAt } : {}), ...(limited ? { limited: true } : {}) }];
  });
}

export async function fetchOpenCodeGoPlan(key: string, fetchImpl: typeof fetch = fetch): Promise<UsageWindow[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl(`${GO_GATEWAY}/usage`, { headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(`OpenCode Go usage returned ${response.status}.`);
    return openCodeGoPlan(await response.json());
  } finally { clearTimeout(timer); }
}

export interface GoRefusals { count: number; first: string; last: string; models: string[] }
const openCodeLogDir = () => path.join(process.env.OPENCODE_DATA_DIR || path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local/share"), "opencode"), "log");

/** Refusals already read from each log, so a poll reads only what OpenCode
 * appended since (this log grows by tens of MB a day). */
const refusalScans = new Map<string, { ino: number; offset: number; events: { at: number; model?: string }[] }>();
const FIRST_SCAN_BYTES = 64 * 1_048_576;

/** "Go usage limit exceeded" refusals in OpenCode's own log over the last
 * `withinMs`. The first read of a log covers at most its last 64 MB. */
export async function readGoRefusals(now = new Date(), withinMs = 24 * 3_600_000, root = openCodeLogDir()): Promise<GoRefusals | undefined> {
  const since = now.getTime() - withinMs;
  const events: { at: number; model?: string }[] = [];
  for (const name of (await readdir(root).catch(() => [] as string[])).filter(name => name.endsWith(".log")).slice(0, 32)) {
    const file = path.join(root, name);
    const info = await lstat(file).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.mtimeMs < since) continue;
    let scan = refusalScans.get(file);
    // A rotated or truncated log starts over.
    if (!scan || scan.ino !== info.ino || scan.offset > info.size) scan = { ino: info.ino, offset: Math.max(0, info.size - FIRST_SCAN_BYTES), events: [] };
    if (info.size > scan.offset) {
      const handle = await open(file, "r");
      try {
        const length = Math.min(info.size - scan.offset, FIRST_SCAN_BYTES), bytes = Buffer.alloc(length);
        await handle.read(bytes, 0, length, info.size - length);
        const text = bytes.toString("utf8");
        // Only whole lines: a line still being written is read next time.
        const complete = text.lastIndexOf("\n") + 1;
        for (const line of text.slice(0, complete).split("\n")) {
          if (!line.includes("Go usage limit exceeded")) continue;
          const stamp = /timestamp=(\S+)/.exec(line)?.[1] ?? /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.exec(line)?.[0];
          const at = stamp ? Date.parse(stamp) : NaN;
          if (Number.isFinite(at)) scan.events.push({ at, model: /modelID=([A-Za-z0-9._\/-]{1,120})/.exec(line)?.[1] });
        }
        scan.offset = info.size - length + complete;
      } finally { await handle.close(); }
    }
    scan.events = scan.events.filter(event => event.at >= now.getTime() - 7 * 24 * 3_600_000).slice(-10_000);
    refusalScans.set(file, scan);
    events.push(...scan.events.filter(event => event.at >= since && event.at <= now.getTime() + 60_000));
  }
  if (!events.length) return undefined;
  events.sort((a, b) => a.at - b.at);
  const models = [...new Set(events.flatMap(event => event.model ? [`opencode-go/${event.model}`] : []))].sort().slice(0, 8);
  return { count: events.length, first: new Date(events[0].at).toISOString(), last: new Date(events.at(-1)!.at).toISOString(), models };
}

const clock = (iso: string) => `${iso.slice(11, 16)} UTC`;
export function openCodeGoUsage(windows: UsageWindow[], refusals: GoRefusals | undefined, now: Date, hasKey: boolean, planError?: boolean): AccountUsage {
  const refused = refusals
    ? `OpenCode refused ${refusals.count} Go request${refusals.count === 1 ? "" : "s"} with "usage limit exceeded" in the last day (${refusals.first.slice(0, 10) === refusals.last.slice(0, 10) ? `${clock(refusals.first)} to ${clock(refusals.last)}` : `${refusals.first.slice(0, 16).replace("T", " ")} to ${refusals.last.slice(0, 16).replace("T", " ")} UTC`}).`
    : undefined;
  const reached = windows.filter(window => window.limited).map(window => window.name.replace(" limit", "").toLowerCase());
  const message = [
    !hasKey ? GO_KEY_MESSAGE : planError ? "Could not read Go's usage report; showing what OpenCode's log says." : undefined,
    reached.length ? `Go is refusing requests: the ${reached.join(" and ")} limit is reached.` : undefined,
    refused,
  ].filter(Boolean).join(" ");
  const renewsAt = windows.find(w => w.id === "opencode-go:plan:30d")?.resetsAt;
  const subscription: Subscription | undefined = hasKey ? { plan: "Go", ...(renewsAt ? { renewsAt } : {}), checkedAt: now.toISOString() } : undefined;
  return { source: "opencode-go", windows, ...(subscription ? { subscription } : {}), updatedAt: now.toISOString(), ...(message ? { message } : {}) };
}

/** The accounts one caller can read: the sources it names, and Go's plan
 * windows only for a caller that asked for them (`goPlan=1`). */
export function usageForCaller(accounts: AccountUsage[], sources: Set<string>, goPlan: boolean): AccountUsage[] {
  return accounts.filter(account => sources.has(account.source)).map(account => goPlan || account.source !== "opencode-go" ? account
    : { ...account, windows: account.windows.filter(window => !window.id.startsWith("opencode-go:plan:")) });
}

let goPlanCached: { at: number; windows: UsageWindow[] } | undefined;
let goPlanPending: Promise<UsageWindow[]> | undefined;
async function cachedOpenCodeGoPlan(key: string, now: Date): Promise<UsageWindow[]> {
  if (!goPlanCached || now.getTime() - goPlanCached.at >= 60_000) {
    goPlanPending ??= fetchOpenCodeGoPlan(key)
      .then(windows => { goPlanCached = { at: now.getTime(), windows }; return windows; })
      .finally(() => { goPlanPending = undefined; });
  }
  return goPlanPending ? await goPlanPending : goPlanCached!.windows;
}

export async function readOpenCodeGoUsage(now = new Date(), options: {
  readKey?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  readRefusals?: (now: Date) => Promise<GoRefusals | undefined>;
} = {}): Promise<AccountUsage> {
  const [key, refusals] = await Promise.all([(options.readKey ?? readOpenCodeGoKey)(), (options.readRefusals ?? readGoRefusals)(now).catch(() => undefined)]);
  if (!key) return openCodeGoUsage([], refusals, now, false);
  try {
    const windows = options.fetchImpl ? await fetchOpenCodeGoPlan(key, options.fetchImpl) : await cachedOpenCodeGoPlan(key, now);
    return openCodeGoUsage(windows, refusals, now, true);
  } catch { return openCodeGoUsage([], refusals, now, true, true); }
}

/** OpenRouter reports the current UTC calendar week's charged usage per key. */
export async function fetchOpenRouterUsage(key: string, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<AccountUsage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl("https://openrouter.ai/api/v1/key", {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenRouter usage endpoint returned ${response.status}.`);
    const amountUSD = object(object(await response.json()).data).usage_weekly;
    if (typeof amountUSD !== "number" || !Number.isFinite(amountUSD) || amountUSD < 0 || amountUSD > 1_000_000_000) {
      throw new Error("OpenRouter returned invalid usage.");
    }
    return {
      source: "openrouter",
      accountId: createHash("sha256").update(key).digest("hex"),
      windows: [],
      spend: { amountUSD, period: "calendar_week" },
      updatedAt: now.toISOString(),
    };
  } finally { clearTimeout(timer); }
}

async function liveOpenRouterUsage(now: Date): Promise<AccountUsage | undefined> {
  if (typeof fetch !== "function") return undefined;
  const key = await readOpenRouterKey();
  if (!key) return undefined;
  try { return await fetchOpenRouterUsage(key, fetch, now); } catch {
    return { source: "openrouter", windows: [], message: "Could not read OpenRouter spend. Check its key in OpenCode." };
  }
}

/** ElevenLabs' subscription: characters used this billing period against the plan's limit. */
export function elevenLabsUsage(value: unknown, now = new Date()): AccountUsage {
  const sub = object(value);
  const used = sub.character_count, limit = sub.character_limit;
  const plan = planName(sub.tier);
  const renewsAt = subscriptionDate(object(sub.next_invoice).next_payment_attempt_unix);
  const subscription: Subscription | undefined = plan ? { plan, ...(renewsAt ? { renewsAt } : {}), checkedAt: now.toISOString() } : undefined;
  const metadata = subscription ? { subscription } : {};
  const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!count(used) || !count(limit) || limit === 0) {
    return { source: "elevenlabs", ...metadata, windows: [], updatedAt: now.toISOString(), message: "ElevenLabs did not report a character limit for this key." };
  }
  const entry = window("elevenlabs:characters", "Characters this period", Math.min(100, Math.round(used / limit * 1000) / 10), sub.next_character_count_reset_unix);
  return { source: "elevenlabs", ...metadata, windows: entry ? [{ ...entry, usedCharacters: used, limitCharacters: limit }] : [], updatedAt: now.toISOString() };
}

/** The key the Hook already uses for /v1/speech, sent only to ElevenLabs; the answer carries counts, never the key. */
export async function fetchElevenLabsUsage(key: string, fetchImpl: typeof fetch = fetch, now = new Date(), origin: string = SPEECH_REGIONS.global): Promise<AccountUsage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl(`${origin}/v1/user/subscription`, {
      headers: { "xi-api-key": key, accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`ElevenLabs subscription endpoint returned ${response.status}.`);
    return elevenLabsUsage(await response.json(), now);
  } finally { clearTimeout(timer); }
}

/** No row without a key: most computers have no spoken replies set up. `PHREN_ELEVENLABS_USAGE=off` skips it (the test suite does). */
async function liveElevenLabsUsage(now: Date): Promise<AccountUsage | undefined> {
  if (typeof fetch !== "function" || process.env.PHREN_ELEVENLABS_USAGE === "off") return undefined;
  const key = await readSpeechKey().catch(() => undefined);
  if (!key) return undefined;
  try { return await fetchElevenLabsUsage(key, fetch, now, (await resolveSpeechRegion()).origin); } catch {
    return { source: "elevenlabs", windows: [], updatedAt: now.toISOString(), message: "Could not read ElevenLabs usage. Check this computer's ElevenLabs key." };
  }
}

/** "seven_day_fable" → "7-day, Fable"; weekly-all stays explicit. */
function claudeWindowName(key: string): string {
  const spans: [string, string][] = [["five_hour", "5-hour"], ["seven_day", "7-day"], ["one_hour", "1-hour"], ["one_day", "1-day"]];
  for (const [prefix, label] of spans) {
    if (key === prefix) return key === "seven_day" ? "7-day, all models" : `${label} limit`;
    if (key.startsWith(prefix + "_")) {
      const model = key.slice(prefix.length + 1).split("_").filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
      return `${label}, ${model}`;
    }
  }
  return key.split("_").filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

/** Claude Code's documented status-line payload: rate_limits carries the
 *  five_hour and seven_day windows (the 5h/7d unified limits) and, when the
 *  build emits them, per-model keys such as seven_day_fable. Every window
 *  keeps its own reset time; a per-model window is its own weekly allowance
 *  with its own denominator, not a subset of seven_day, so it can show a
 *  higher percentage without contradicting the all-models window. */
export function claudeUsage(value: unknown, now = new Date()): AccountUsage {
  const limits = object(object(value).rate_limits);
  // Every window Claude Code reports, each on its own line: the overall
  // ones first, then per-model windows (Fable, Opus...) in a stable order.
  const order = (key: string) => key === "five_hour" ? 0 : key === "seven_day" ? 1 : 2;
  const windows = Object.keys(limits).sort((a, b) => order(a) - order(b) || a.localeCompare(b)).slice(0, 16).flatMap(key => {
    const item = object(limits[key]);
    const entry = window(key, claudeWindowName(key), item.used_percentage, item.resets_at);
    return entry ? [entry] : [];
  });
  return { source: "claude", windows, updatedAt: now.toISOString(), origin: "status-line",
    ...(!windows.length ? { message: "Usage appears after Claude Code replies with a subscription account on this computer." } : {}) };
}

/**
 * Claude's per-model weekly windows (Fable today) never reach the status
 * line, so they come from the snapshot Claude Code itself keeps of its usage
 * endpoint in ~/.claude.json — refreshed whenever Claude opens /usage or
 * checks a limit. Each window carries the snapshot's own time so the phone
 * can say how old it is. No sign-in token is read or sent.
 */
export function claudeScopedWindows(config: unknown, now = new Date()): UsageWindow[] {
  const cached = object(object(config).cachedUsageUtilization);
  const fetched = typeof cached.fetchedAtMs === "number" && Number.isFinite(cached.fetchedAtMs) && cached.fetchedAtMs > 0
    && cached.fetchedAtMs <= now.getTime() + 60_000 ? new Date(cached.fetchedAtMs).toISOString() : undefined;
  if (!fetched) return [];
  const limits = object(cached.utilization).limits;
  if (!Array.isArray(limits)) return [];
  const windows: UsageWindow[] = [];
  for (const raw of limits.slice(0, 16)) {
    const limit = object(raw);
    if (limit.kind !== "weekly_scoped") continue;
    const model = safeText(object(object(object(limit.scope).model)).display_name);
    if (!model) continue;
    const reset = Date.parse(String(limit.resets_at ?? ""));
    const entry = window(`seven_day_${model.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, `7-day, ${model}`, limit.percent,
      Number.isFinite(reset) ? Math.round(reset / 1000) : undefined);
    if (entry) windows.push({ ...entry, asOf: fetched });
  }
  return windows;
}
const claudeCredentialsFile = (home?: ClaudeHome) => path.join(home?.dir ?? claudeConfigDir(), ".credentials.json");

/**
 * The OAuth usage endpoint Claude Code itself reads, mapped to the same
 * windows the status-line snapshot produces. `limits` is the structured
 * list (session, weekly_all, weekly_scoped with the model name); the older
 * per-key fields are ignored because `limits` already carries them.
 */
export function claudeOAuthUsage(value: unknown, now = new Date()): AccountUsage {
  const limits = object(value).limits;
  const windows: UsageWindow[] = [];
  if (Array.isArray(limits)) {
    for (const raw of limits.slice(0, 16)) {
      const limit = object(raw);
      const percent = limit.percent;
      const reset = typeof limit.resets_at === "string" && Number.isFinite(Date.parse(limit.resets_at))
        ? Math.round(Date.parse(limit.resets_at) / 1000) : undefined;
      if (limit.kind === "session") {
        const entry = window("five_hour", "5-hour limit", percent, reset);
        if (entry) windows.push(entry);
      } else if (limit.kind === "weekly_all") {
        const entry = window("seven_day", "7-day, all models", percent, reset);
        if (entry) windows.push(entry);
      } else if (limit.kind === "weekly_scoped") {
        const model = safeText(object(object(object(limit.scope).model)).display_name);
        if (!model) continue;
        const entry = window(`seven_day_${model.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, `7-day, ${model}`, percent, reset);
        if (entry) windows.push(entry);
      }
    }
  }
  return { source: "claude", windows, updatedAt: now.toISOString(), origin: "oauth",
    ...(!windows.length ? { message: "Claude has not reported account limits on this computer." } : {}) };
}

/**
 * Claude Code's own sign-in token, read locally and used only against
 * Anthropic's usage endpoint — never persisted, logged, or sent elsewhere.
 * The file is authoritative off macOS; macOS keeps it in the login keychain,
 * with the file left stale after a refresh. A non-default `home` reads only its
 * own file, and nothing on macOS (its keychain item name is unverified).
 */
export async function readClaudeToken(execSecurity = exec, platform = process.platform, home?: ClaudeHome): Promise<string | undefined> {
  const parse = (raw: string): string | undefined => {
    if (raw.length > 16_384) return undefined;
    const oauth = object(object(JSON.parse(raw)).claudeAiOauth);
    const token = typeof oauth.accessToken === "string" && oauth.accessToken.length > 0 ? oauth.accessToken : undefined;
    const expires = typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined;
    if (!token || (expires !== undefined && expires <= Date.now() + 60_000)) return undefined;
    return token;
  };
  const other = home !== undefined && !home.isDefault;
  if (other && platform === "darwin") return undefined;
  if (platform === "darwin") {
    try {
      const { stdout } = await execSecurity("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 5_000, maxBuffer: 16_384 });
      const token = parse(stdout.trim());
      if (token) return token;
    } catch { /* Headless installs can keep credentials in the file instead. */ }
  }
  try { return parse(await readFile(claudeCredentialsFile(home), "utf8")); } catch { return undefined; }
}

/** Fetch live limits; any failure falls back to the local snapshot. */
export async function fetchClaudeUsage(token: string, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<AccountUsage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl("https://api.anthropic.com/api/oauth/usage", {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Claude usage endpoint returned ${response.status}.`);
    return claudeOAuthUsage(await response.json(), now);
  } finally { clearTimeout(timer); }
}

async function liveClaudeUsage(now: Date, home?: ClaudeHome): Promise<AccountUsage | undefined> {
  if (typeof fetch !== "function") return undefined;
  const token = await readClaudeToken(exec, process.platform, home);
  if (!token) return undefined;
  try { return await fetchClaudeUsage(token, fetch, now); } catch { return undefined; }
}


/** Only initialize and read limits. Never create a thread, prompt, or login. */
export function readCodexLimits(executable = codexExecutable()): Promise<AccountUsage> {
  return new Promise(resolve => {
    const child = spawn(executable, ["app-server"], { cwd: homedir(), stdio: ["pipe", "pipe", "ignore"] });
    let pending = "", bytes = 0, initialized = false, done = false;
    const finish = (result?: AccountUsage) => {
      if (done) return; done = true;
      clearTimeout(timer); child.stdin.destroy(); child.stdout.destroy();
      child.kill("SIGTERM");
      const kill = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1000);
      kill.unref(); child.once("exit", () => clearTimeout(kill));
      resolve(result || { source: "codex", windows: [], message: "Could not read Codex limits. Open Codex on this computer, check its sign-in, then refresh." });
    };
    const timer = setTimeout(() => finish(), 12_000);
    const send = (value: Json) => { if (!done) child.stdin.write(JSON.stringify(value) + "\n"); };
    child.on("error", () => finish()); child.on("exit", () => finish()); child.stdin.on("error", () => finish());
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1_048_576) { finish(); return; }
      pending += chunk;
      let newline: number;
      while (!done && (newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const response = object(JSON.parse(line));
          if (response.id === 0 && !initialized) {
            if (response.error || !response.result) { finish(); return; }
            initialized = true;
            send({ method: "initialized", params: {} });
            send({ id: 1, method: "account/rateLimits/read" });
          } else if (response.id === 1 && initialized) {
            finish(response.error ? undefined : codexUsage(response.result));
          } else if (response.method && response.id !== undefined) {
            // Reject server-initiated requests, including auth refresh. No
            // provider credential or capability token is handled by Phren.
            send({ id: response.id, error: { code: -32601, message: "Unsupported request" } });
          }
        } catch { finish(); }
      }
    });
    send({ id: 0, method: "initialize", params: { clientInfo: { name: "phren_usage", title: "Phren Usage", version: "1" } } });
  });
}

/**
 * GitHub Copilot's own quota report (`gh api /copilot_internal/user`): one
 * window per limited quota (premium requests, usually) with the monthly
 * reset. Unlimited quotas are named in the message, not drawn as 0%.
 */
export function copilotUsage(value: unknown, now = new Date()): AccountUsage {
  const result = object(value), snapshots = object(result.quota_snapshots);
  const reset = typeof result.quota_reset_date_utc === "string" && Number.isFinite(Date.parse(result.quota_reset_date_utc))
    ? new Date(Date.parse(result.quota_reset_date_utc)).toISOString() : undefined;
  const names: Record<string, string> = { premium_interactions: "Premium requests · monthly", chat: "Chat · monthly", completions: "Completions · monthly" };
  const windows: UsageWindow[] = [], unlimited: string[] = [];
  for (const [id, raw] of Object.entries(snapshots).slice(0, 8)) {
    const quota = object(raw), key = safeText(id) ?? "quota";
    if (quota.unlimited === true) { unlimited.push((names[key] ?? key).replace(" · monthly", "").toLowerCase()); continue; }
    const remaining = quota.percent_remaining;
    if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0 || remaining > 100) continue;
    windows.push({ id: key, name: names[key] ?? key, usedPercent: Math.round((100 - remaining) * 10) / 10, ...(reset ? { resetsAt: reset } : {}) });
  }
  const plan = planName(result.copilot_plan);
  const notes = [safeText(result.copilot_plan) ? `Plan: ${safeText(result.copilot_plan)}.` : "", unlimited.length ? `Unlimited: ${unlimited.join(", ")}.` : ""].filter(Boolean).join(" ");
  return { source: "copilot", windows, updatedAt: now.toISOString(),
    ...(plan ? { subscription: { plan, ...(reset ? { renewsAt: reset } : {}), checkedAt: now.toISOString() } } : {}),
    ...(notes || !windows.length ? { message: notes || "GitHub reported no Copilot quotas for this account." } : {}) };
}

/** The first GitHub CLI found; the Hook's service PATH may not include Homebrew. */
function ghExecutable(): string {
  for (const candidate of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]) {
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return "gh";
}

/** Reads through the GitHub CLI's own sign-in; the token never reaches Phren. */
export async function readCopilotUsage(now = new Date(), run: (file: string, args: string[]) => Promise<string> =
  async (file, args) => (await exec(file, args, { timeout: 10_000, maxBuffer: 1_048_576, cwd: homedir() })).stdout): Promise<AccountUsage> {
  try { return copilotUsage(JSON.parse(await run(ghExecutable(), ["api", "/copilot_internal/user"])), now); }
  catch (error) {
    const failure = object(error);
    const detail = [failure.stderr, failure.message].filter((part): part is string => typeof part === "string").join(" ");
    return { source: "copilot", windows: [], message: /\bHTTP 404\b/i.test(detail)
      ? "No Copilot subscription on this GitHub account"
      : "Could not read Copilot usage. Sign in with gh auth login on this computer (Copilot reports its quotas through GitHub)." };
  }
}

/** Under this much left on any window, an account is near its limit: information for the owner, never a reason to avoid it. */
export const NEAR_LIMIT_LEFT = 20;

/** No quota on this window now: at 100% or refused by the service, and its reset not yet passed. */
export function windowExhausted(window: UsageWindow, now: number): boolean {
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  if (window.reset || Number.isFinite(reset) && reset <= now) return false;
  return window.limited === true || typeof window.usedPercent === "number" && window.usedPercent >= 100;
}

/** Percent left on a window at `now`: none once its reset passed or with no percent, 0 while the service refuses requests. */
export function windowLeft(window: UsageWindow, now: number): number | undefined {
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  if (window.reset || Number.isFinite(reset) && reset <= now) return undefined;
  if (window.limited) return 0;
  return typeof window.usedPercent === "number" ? Math.max(0, Math.min(100, Math.round(100 - window.usedPercent))) : undefined;
}

/** What a capacity probe says about room: each Codex and Claude account's least room left, and whether it has none
 *  (`exhausted`, with `until` the last reset that frees it). */
export function capacityRoom(accounts: readonly AccountUsage[], now: number): Array<{ source: string; account?: string; leftPercent?: number; exhausted?: true; until?: string }> {
  return accounts.map(usage => {
    const left = usage.windows.map(window => windowLeft(window, now)).filter((value): value is number => value !== undefined);
    const out = usage.windows.filter(window => windowExhausted(window, now));
    const until = out.map(window => window.resetsAt).filter((value): value is string => Boolean(value)).sort().at(-1);
    return { source: usage.source, ...(usage.account?.id ? { account: usage.account.id } : {}), ...(left.length ? { leftPercent: Math.min(...left) } : {}),
      ...(out.length ? { exhausted: true as const, ...(until ? { until } : {}) } : {}) };
  });
}

/** A Claude report older than this says nothing about the account now. */
export const CLAUDE_REPORT_MAX_AGE_MS = 3 * 86_400_000;

/**
 * What a saved Claude report still says at `now`: a window whose reset time
 * has passed is reported as reset without its old percent, and a report
 * older than three days is dropped, so a stale number never reaches the
 * phone's cards, rings or widgets.
 */
export function settleClaudeUsage(usage: AccountUsage, now: number): AccountUsage {
  if (!usage.windows.length) return usage;
  const reported = (w: UsageWindow) => Date.parse(w.asOf ?? usage.updatedAt ?? "");
  const windows = usage.windows
    .filter(w => { const at = reported(w); return !Number.isFinite(at) || now - at < CLAUDE_REPORT_MAX_AGE_MS; })
    .map(w => {
      const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
      if (!Number.isFinite(reset) || reset > now) return w;
      const { usedPercent: _old, ...rest } = w;
      return { ...rest, reset: true };
    });
  if (windows.length) return { ...usage, windows };
  const since = usage.updatedAt?.slice(0, 10);
  return { ...usage, windows, message: `No usage report from Claude on this computer${since ? ` since ${since}` : ""}. It updates when Claude Code runs here.` };
}

/** `opencode stats` scans OpenCode's whole database, several CPU-seconds on a
 *  busy machine, for a rolling seven-day cost that barely moves in a minute. */
export const OPENCODE_STATS_REUSE_MS = 10 * 60_000;

export class AccountUsageReader {
  private cached?: { at: number; value: AccountUsage };
  private pending?: Promise<AccountUsage>;
  private claudeCached = new Map<string, { at: number; value?: AccountUsage }>();
  private claudePending = new Map<string, Promise<AccountUsage | undefined>>();
  private spendingCached = new Map<string, { at: number; value: AccountUsage[] }>();
  private spendingPending = new Map<string, Promise<AccountUsage[]>>();
  private openCodeCached?: { at: number; value: AccountUsage };
  private openCodePending?: Promise<AccountUsage>;
  constructor(private readCodex = readCodexLimits, private now = Date.now,
              private readClaudeLive: (now: Date, home: ClaudeHome) => Promise<AccountUsage | undefined> = liveClaudeUsage,
              private readOpenCode: (now: Date) => Promise<AccountUsage> = now => readOpenCodeUsage("opencode", now),
              private readOpenRouter: (now: Date) => Promise<AccountUsage | undefined> = liveOpenRouterUsage,
              private readOpenCodeGo: (now: Date) => Promise<AccountUsage> = readOpenCodeGoUsage,
              private readCopilot: (now: Date) => Promise<AccountUsage> = readCopilotUsage,
              private platform: NodeJS.Platform = process.platform,
              private readElevenLabs: (now: Date) => Promise<AccountUsage | undefined> = liveElevenLabsUsage) {}
  /** `allAccounts`: one Claude row per home. Otherwise only the default home's, as
   *  before accounts existed, since older phones refuse two rows of one source. */
  async read(sources?: Set<string>, allAccounts = false): Promise<{ accounts: AccountUsage[] }> {
    const [limits, spending] = await Promise.all([this.limits(allAccounts),
      this.spending(sources?.has("copilot") ?? true, sources?.has("elevenlabs") ?? true)]);
    return { accounts: [...limits, ...spending] };
  }
  /** Codex and every Claude home, without the spend readers: what a dispatch capacity probe asks. */
  async limits(allAccounts = true): Promise<AccountUsage[]> {
    if (!this.cached || this.now() - this.cached.at >= 60_000) {
      this.pending ??= this.readCodex().then(value => { this.cached = { at: this.now(), value }; return value; }).finally(() => { this.pending = undefined; });
    }
    const codex = this.pending ?? Promise.resolve(this.cached!.value);
    // Every home, default first; the labels and keys are read once per poll.
    const homes = allAccounts ? claudeHomes() : claudeHomes().slice(0, 1);
    const claudeRow = async (home: ClaudeHome): Promise<AccountUsage> => {
      const email = claudeAccountEmail(home);
      const subscription = claudeAccountSubscription(home, new Date(this.now()));
      return { ...settleClaudeUsage(await this.claude(home), this.now()), ...(subscription ? { subscription } : {}), account: { ...claudeAccountRef(home), ...(email ? { email } : {}) } };
    };
    const [codexValue, claude, subscription] = await Promise.all([codex, Promise.all(homes.map(claudeRow)), readCodexSubscription(undefined, new Date(this.now()))]);
    return [{ ...codexValue, ...(subscription ? { subscription } : {}), account: CODEX_ACCOUNT }, ...claude];
  }
  /** ElevenLabs is read only when the caller shows it: every read spends a request against the key's quota. */
  private async spending(includeCopilot: boolean, includeElevenLabs: boolean): Promise<AccountUsage[]> {
    const key = `${includeCopilot}:${includeElevenLabs}`;
    const cached = this.spendingCached.get(key);
    if (!cached || this.now() - cached.at >= 60_000) {
      const at = this.now();
      if (!this.spendingPending.has(key)) {
        const pending = Promise.all([this.openCode(at), this.readOpenCodeGo(new Date(at)), this.readOpenRouter(new Date(at)),
          includeCopilot ? this.readCopilot(new Date(at)) : Promise.resolve(undefined),
          includeElevenLabs ? this.readElevenLabs(new Date(at)).catch(() => undefined) : Promise.resolve(undefined)])
          .then(([openCode, openCodeGo, openRouter, copilot, elevenLabs]) => [openCode, openCodeGo, ...(openRouter ? [openRouter] : []), ...(copilot ? [copilot] : []), ...(elevenLabs ? [elevenLabs] : [])])
          .then(value => { this.spendingCached.set(key, { at, value }); return value; })
          .finally(() => { this.spendingPending.delete(key); });
        this.spendingPending.set(key, pending);
      }
    }
    return this.spendingPending.get(key) ?? cached!.value;
  }
  /** One `opencode stats` run serves every spending key for `OPENCODE_STATS_REUSE_MS`. */
  private openCode(at: number): Promise<AccountUsage> {
    if (this.openCodeCached && at - this.openCodeCached.at < OPENCODE_STATS_REUSE_MS) return Promise.resolve(this.openCodeCached.value);
    this.openCodePending ??= this.readOpenCode(new Date(at))
      .then(value => { this.openCodeCached = { at, value }; return value; })
      .finally(() => { this.openCodePending = undefined; });
    return this.openCodePending;
  }
  /** Live first, so the phone's minute-by-minute poll keeps Claude current
   *  even when Claude Code is not running; the local snapshot is the backup.
   *  Off macOS a non-default home reads its own credentials file; on macOS it
   *  has no live read (the keychain item name for custom homes is unverified). */
  private async claude(home: ClaudeHome): Promise<AccountUsage> {
    if (home.isDefault || this.platform !== "darwin") {
      const cached = this.claudeCached.get(home.dir);
      if (!cached || this.now() - cached.at >= 60_000) {
        const at = this.now();
        if (!this.claudePending.has(home.dir)) this.claudePending.set(home.dir, this.readClaudeLive(new Date(at), home)
          .then(value => { this.claudeCached.set(home.dir, { at, value }); return value; })
          .catch(() => { this.claudeCached.set(home.dir, { at, value: undefined }); return undefined; })
          .finally(() => { this.claudePending.delete(home.dir); }));
      }
      const pending = this.claudePending.get(home.dir);
      const live = pending ? await pending : this.claudeCached.get(home.dir)?.value;
      if (live?.windows.length) return live;
    }
    return this.snapshotClaude(home);
  }
  private async snapshotClaude(home: ClaudeHome): Promise<AccountUsage> {
    let claude: AccountUsage = { source: "claude", windows: [], message: "Usage appears after Claude Code replies on this computer. Run phren bridge install if usage reporting is not set up yet." };
    try {
      const handle = await open(claudeFile(home), "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 16_384) throw new Error("Invalid usage snapshot");
        const saved = object(JSON.parse(await handle.readFile("utf8")));
        const date = new Date(String(saved.updatedAt));
        if (!Number.isFinite(date.getTime()) || date.getTime() > this.now() + 60_000) throw new Error("Invalid usage timestamp");
        claude = claudeUsage(saved, date);
      } finally { await handle.close(); }
    } catch { /* No status-line report yet. Keep unavailable explicit. */ }
    try {
      const handle = await open(home.configFile, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 16_777_216) throw new Error("Invalid Claude config");
        const scoped = claudeScopedWindows(JSON.parse(await handle.readFile("utf8")), new Date(this.now()))
          .filter(entry => !claude.windows.some(existing => existing.id === entry.id));
        if (scoped.length) claude = { ...claude, windows: [...claude.windows, ...scoped], message: undefined };
      } finally { await handle.close(); }
    } catch { /* No snapshot from Claude Code; the status-line windows stand alone. */ }
    return claude;
  }
}

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
/** Wrap an existing status line, preserving its input, output and options. */
export function usageStatusLine(current: unknown, program: string, remove: boolean): unknown {
  const prefix = `${quote(process.execPath)} ${quote(program)} usage-statusline `;
  const command = object(current).command;
  if (typeof command === "string" && command.startsWith(prefix)) {
    if (!remove) return current;
    const encoded = command.slice(prefix.length);
    if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) throw new Error("Invalid Phren status line");
    return JSON.parse(Buffer.from(encoded, "base64").toString()) ?? undefined;
  }
  if (remove) return current;
  if (current !== undefined && (object(current).type !== "command" || typeof command !== "string")) return current;
  const original = Buffer.from(JSON.stringify(current ?? null)).toString("base64");
  if (original.length > 32_768) return current;
  return { ...object(current), type: "command", command: prefix + original };
}

export async function captureClaudeUsage(original: string): Promise<void> {
  if (!/^[A-Za-z0-9+/=]{1,32768}$/.test(original)) return;
  let input = "";
  for await (const chunk of process.stdin) { input += chunk.toString(); if (Buffer.byteLength(input) > 1_048_576) return; }
  try {
    // The home Claude runs in names the file; an unknown CLAUDE_CONFIG_DIR records nothing.
    // Homes are resolved without this process's CLAUDE_CONFIG_DIR: that is the account's own dir here, not the default.
    const home = claudeHomeOfEnv(process.env.CLAUDE_CONFIG_DIR, { ...process.env, CLAUDE_CONFIG_DIR: undefined });
    if (!home) throw new Error("Unknown Claude home");
    const snapshot = claudeUsage(JSON.parse(input));
    // Persist only normalized percentages/reset times; never session content.
    const rate_limits = Object.fromEntries(snapshot.windows.map(w => [w.id, {
      used_percentage: w.usedPercent, resets_at: w.resetsAt ? Date.parse(w.resetsAt) / 1000 : undefined,
    }]));
    await atomicInPrivateDir(claudeFile(home), JSON.stringify({ rate_limits, updatedAt: snapshot.updatedAt }));
  } catch { /* Status line rendering must survive unavailable usage storage. */ }
  const previous = object(JSON.parse(Buffer.from(original, "base64").toString()));
  if (typeof previous.command === "string") {
    await new Promise<void>(resolve => {
      // This is the user's original status-line command, invoked just as
      // Claude did before installing the observer. The phone cannot set it.
      const child = spawn("/bin/sh", ["-c", previous.command as string], { stdio: ["pipe", "inherit", "inherit"] });
      child.on("error", () => resolve()); child.on("exit", () => resolve());
      child.stdin.on("error", () => {}); child.stdin.end(input);
    });
  }
}
