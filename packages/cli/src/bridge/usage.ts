import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { claudeConfigDir, homeDir } from "../home-paths.js";
import path from "node:path";
import { promisify } from "node:util";
import { fanoutRoot } from "./fanouts.js";
import { bridgeRoot, type Json, object } from "./protocol.js";
import { stripTerminal } from "../terminal-text.js";

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
  resetsAt?: string;
  asOf?: string;
}
export interface UsageSpend { amountUSD: number; period: "rolling_7_days" | "rolling_30_days" | "calendar_week" }
export interface AccountUsage {
  source: "codex" | "claude" | "opencode" | "opencode-go" | "openrouter";
  windows: UsageWindow[];
  updatedAt?: string;
  message?: string;
  spend?: UsageSpend;
  /** Opaque key identity used only to avoid counting one OpenRouter key twice. */
  accountId?: string;
  /** Which Claude report fed this account: the status-line rate_limits payload
   *  or the OAuth usage endpoint. Per-model windows the status line never
   *  carries document their own age through each window's asOf instead. */
  origin?: "status-line" | "oauth";
}
const claudeFile = () => path.join(bridgeRoot(), "usage", "claude.json");
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

type GoPeriod = "5h" | "7d" | "30d";
type GoLimit = { limitUSD: number; resetsAt?: string };
type GoLimits = Map<string, Partial<Record<GoPeriod, GoLimit>>>;
type GoTotals = Map<string, Record<GoPeriod, { usedUSD: number; usedTokens: number }>>;
const goPeriods: { id: GoPeriod; label: string; milliseconds: number }[] = [
  { id: "5h", label: "5h", milliseconds: 5 * 60 * 60 * 1_000 },
  { id: "7d", label: "7d", milliseconds: 7 * 24 * 60 * 60 * 1_000 },
  { id: "30d", label: "30d", milliseconds: 30 * 24 * 60 * 60 * 1_000 },
];
const GO_GATEWAY = "https://opencode.ai/zen/go/v1";
const MAX_GO_JOBS = 128;
const MAX_GO_MANIFEST_BYTES = 64 * 1_024;
const MAX_GO_EVENTS_BYTES = 64 * 1_024 * 1_024;
const GO_KEY_MESSAGE = "Connect OpenCode Go on this computer to see its usage.";

function goPeriod(value: unknown): GoPeriod | undefined {
  const text = String(value ?? "").toLowerCase().replace(/[\s_-]/g, "");
  if (text === "5h" || text === "5hour" || text === "fivehour" || text === "300m" || text === "300minute") return "5h";
  if (text === "7d" || text === "7day" || text === "week" || text === "weekly") return "7d";
  if (text === "30d" || text === "30day" || text === "month" || text === "monthly") return "30d";
  return undefined;
}
function goModel(value: unknown, allowBare = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const model = value.trim();
  if (/^opencode-go\/[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/.test(model)) return model;
  const reserved = new Set(["data", "limits", "usage", "models", "credits", "window", "period", "monthly", "weekly",
    "5h", "7d", "30d", "fivehour", "seven_day", "month", "limit", "quota", "max", "plan", "account", "rate", "ratelimit",
    "ratelimits", "remaining", "reset"]);
  return allowBare && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/.test(model) && !reserved.has(model.toLowerCase())
    ? `opencode-go/${model}` : undefined;
}
function amount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000 ? value : undefined;
}
function resetAt(value: unknown): string | undefined {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) return resetAt(Number(value));
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && value < 32_503_680_000) {
    return new Date(value * 1_000).toISOString();
  }
  return undefined;
}
function recordGoLimit(limits: GoLimits, model: string, period: GoPeriod, limitUSD: number | undefined, resetsAt?: string): void {
  if (limitUSD === undefined || limitUSD <= 0) return;
  const current = limits.get(model) ?? {};
  const existing = current[period];
  // A response can repeat a limit at several levels. Keep the first numeric
  // value, but retain a reset time wherever the service supplied one.
  current[period] = existing ? { ...existing, ...(existing.resetsAt ? {} : { resetsAt }) } : { limitUSD, resetsAt };
  limits.set(model, current);
}
function numberFrom(value: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const found = amount(value[name]);
    if (found !== undefined) return found;
  }
  return undefined;
}
function parseGoLimits(value: unknown, limits: GoLimits, model?: string, period?: GoPeriod, depth = 0): void {
  if (depth > 8) return;
  if (typeof value === "number") {
    if (period) recordGoLimit(limits, model ?? "*", period, amount(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 64)) parseGoLimits(item, limits, model, period, depth + 1);
    return;
  }
  const item = object(value);
  if (!Object.keys(item).length) return;
  const nestedModel = goModel(item.model, true) ?? goModel(item.modelId, true) ?? goModel(item.model_id, true) ?? model;
  const nestedPeriod = goPeriod(item.window) ?? goPeriod(item.period) ?? goPeriod(item.interval) ?? goPeriod(item.windowName) ?? period;
  const limitUSD = numberFrom(item, ["limitUSD", "limit_usd", "dollarLimit", "dollar_limit", "creditLimit", "credit_limit", "limit", "quota", "max"]);
  const reset = resetAt(item.resetsAt) ?? resetAt(item.resets_at) ?? resetAt(item.resetAt) ?? resetAt(item.reset_at);
  if (nestedPeriod) recordGoLimit(limits, nestedModel ?? "*", nestedPeriod, limitUSD, reset);
  for (const [key, nested] of Object.entries(item).slice(0, 64)) {
    const keyPeriod = goPeriod(key) ?? nestedPeriod;
    const keyModel = goModel(key) ?? nestedModel ?? (typeof nested === "object" && !keyPeriod ? goModel(key, true) : undefined);
    // Scalar metadata such as a plan name cannot carry a usable limit.
    if (typeof nested !== "object" && typeof nested !== "number") continue;
    parseGoLimits(nested, limits, keyModel, keyPeriod, depth + 1);
  }
}
function completeGoLimits(limits: GoLimits): void {
  for (const [model, windows] of limits) {
    const monthly = windows["30d"]?.limitUSD ?? (windows["7d"] ? windows["7d"].limitUSD * 2 : windows["5h"] ? windows["5h"].limitUSD * 5 : undefined);
    if (!monthly || !Number.isFinite(monthly) || monthly <= 0) continue;
    recordGoLimit(limits, model, "5h", monthly * 0.2);
    recordGoLimit(limits, model, "7d", monthly * 0.5);
    recordGoLimit(limits, model, "30d", monthly);
  }
}
function header(response: Response, name: string): string | undefined {
  try { return response.headers.get(name) ?? undefined; } catch { return undefined; }
}
function parseGoHeaders(response: Response, limits: GoLimits): void {
  const limit = amount(Number(header(response, "x-ratelimit-limit")));
  const remaining = amount(Number(header(response, "x-ratelimit-remaining")));
  if (limit === undefined || remaining === undefined || remaining > limit) return;
  const period = goPeriod(header(response, "x-ratelimit-window"));
  const reset = resetAt(header(response, "x-ratelimit-reset"));
  // Gateway headers do not identify a model. Their plan-wide limit is the
  // monthly amount unless the response explicitly names its window.
  recordGoLimit(limits, "*", period ?? "30d", limit, reset);
}

/** Best-effort gateway discovery. All four requests are independent because
 * undocumented routes vary by OpenCode release and account. */
export async function fetchOpenCodeGoLimits(key: string, fetchImpl: typeof fetch = fetch): Promise<GoLimits> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  const limits: GoLimits = new Map();
  try {
    const responses = await Promise.allSettled([
      ["GET", `${GO_GATEWAY}/usage`],
      ["GET", `${GO_GATEWAY}/limits`],
      ["GET", `${GO_GATEWAY}/credits`],
      ["HEAD", `${GO_GATEWAY}/models`],
    ].map(async ([method, url]) => {
      const response = await fetchImpl(url, { method, headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        redirect: "error", signal: controller.signal });
      if (!response.ok) return;
      parseGoHeaders(response, limits);
      if (method === "GET") {
        try { parseGoLimits(await response.json(), limits); } catch { /* An HTML or empty gateway response has no limits. */ }
      }
    }));
    // Keep every request observed: one undocumented endpoint failing must not
    // prevent headers or a second endpoint from describing the account.
    void responses;
  } finally {
    clearTimeout(timer);
  }
  completeGoLimits(limits);
  return limits;
}

async function containedRegularFile(root: string, candidate: string, maximum: number): Promise<string | undefined> {
  try {
    const link = await lstat(candidate);
    if (!link.isFile() || link.isSymbolicLink() || link.size > maximum) return undefined;
    const resolved = await realpath(candidate);
    if (!resolved.startsWith(root + path.sep)) return undefined;
    const metadata = await stat(resolved);
    return metadata.isFile() && metadata.size <= maximum ? resolved : undefined;
  } catch { return undefined; }
}
function goEventTime(value: Record<string, unknown>): number | undefined {
  const raw = value.timestamp ?? value.time ?? value.createdAt ?? value.created_at;
  if (typeof raw === "string" && Number.isFinite(Date.parse(raw))) return Date.parse(raw);
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  return raw < 32_503_680_000 ? raw * 1_000 : raw;
}
function goTokenCount(value: unknown, depth = 0): number {
  if (depth > 5) return 0;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= 10_000_000_000 ? value : 0;
  const item = object(value);
  const total = amount(item.total) ?? amount(item.totalTokens) ?? amount(item.total_tokens);
  if (total !== undefined) return total;
  return Object.values(item).reduce<number>((sum, part) => sum + goTokenCount(part, depth + 1), 0);
}
function goStepCost(event: Record<string, unknown>, part: Record<string, unknown>): number | undefined {
  const raw = part.cost ?? event.cost;
  if (typeof raw === "number") return amount(raw);
  const cost = object(raw);
  return numberFrom(cost, ["total", "amount", "usd", "cost"]);
}

/** Sum only completed OpenCode Go fan-outs. Their ledger stays on the
 * computer and malformed jobs are ignored rather than becoming usage. */
export async function readOpenCodeGoLedger(root = fanoutRoot(), now = new Date()): Promise<GoTotals> {
  const totals: GoTotals = new Map();
  let directory: string;
  try { directory = await realpath(root); } catch { return totals; }
  const names = (await readdir(directory).catch(() => [])).slice(0, MAX_GO_JOBS);
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) continue;
    const manifestFile = await containedRegularFile(directory, path.join(directory, name, "manifest.json"), MAX_GO_MANIFEST_BYTES);
    if (!manifestFile) continue;
    let manifest: Record<string, unknown>;
    try { manifest = object(JSON.parse(await readFile(manifestFile, "utf8"))); } catch { continue; }
    const model = goModel(manifest.model);
    const eventLog = typeof manifest.eventLog === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.jsonl$/.test(manifest.eventLog)
      ? manifest.eventLog : undefined;
    if (manifest.provider !== "opencode" || !model || !eventLog) continue;
    const jobRoot = await realpath(path.join(directory, name)).catch(() => undefined);
    if (!jobRoot || !jobRoot.startsWith(directory + path.sep)) continue;
    const eventsFile = await containedRegularFile(jobRoot, path.join(jobRoot, eventLog), MAX_GO_EVENTS_BYTES);
    if (!eventsFile) continue;
    let events: string;
    try { events = await readFile(eventsFile, "utf8"); } catch { continue; }
    for (const line of events.split("\n")) {
      if (!line || Buffer.byteLength(line) > 1_048_576) continue;
      let event: Record<string, unknown>;
      try { event = object(JSON.parse(line)); } catch { continue; }
      if (event.type !== "step_finish") continue;
      const at = goEventTime(event), part = object(event.part);
      const cost = goStepCost(event, part), tokens = goTokenCount(part.tokens ?? event.tokens);
      if (at === undefined || (cost === undefined && tokens === 0) || at > now.getTime()) continue;
      for (const period of goPeriods) {
        if (at < now.getTime() - period.milliseconds) continue;
        const modelTotals = totals.get(model) ?? {
          "5h": { usedUSD: 0, usedTokens: 0 }, "7d": { usedUSD: 0, usedTokens: 0 }, "30d": { usedUSD: 0, usedTokens: 0 },
        };
        const usedUSD = modelTotals[period.id].usedUSD + (cost ?? 0);
        if (usedUSD > 1_000_000_000) continue;
        modelTotals[period.id].usedUSD = usedUSD;
        modelTotals[period.id].usedTokens += tokens;
        totals.set(model, modelTotals);
      }
    }
  }
  return totals;
}

function goLimitFor(limits: GoLimits, model: string, period: GoPeriod): GoLimit | undefined {
  return limits.get(model)?.[period] ?? limits.get("*")?.[period];
}
function goWindowID(model: string, period: GoPeriod): string {
  return `opencode-go:${model.slice("opencode-go/".length).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}:${period}`;
}
function openCodeGoUsage(totals: GoTotals, limits: GoLimits, now: Date, hasKey: boolean): AccountUsage {
  const windows: UsageWindow[] = [];
  let total30Days = 0;
  for (const model of [...totals.keys()].sort((a, b) => a.localeCompare(b))) {
    const modelTotals = totals.get(model)!;
    for (const period of goPeriods) {
      const local = modelTotals[period.id], limit = goLimitFor(limits, model, period.id);
      const usedPercent = limit ? Math.min(100, Math.round(local.usedUSD / limit.limitUSD * 10_000) / 100) : undefined;
      windows.push({ id: goWindowID(model, period.id), name: `${model} · ${period.label}`, usedUSD: local.usedUSD,
        usedTokens: local.usedTokens, ...(limit ? { limitUSD: limit.limitUSD, usedPercent, resetsAt: limit.resetsAt } : {}) });
    }
    total30Days += modelTotals["30d"].usedUSD;
  }
  return { source: "opencode-go", windows, updatedAt: now.toISOString(),
    ...(windows.length ? { spend: { amountUSD: total30Days, period: "rolling_30_days" as const } } : {}),
    ...(!hasKey ? { message: GO_KEY_MESSAGE } : {}) };
}

let goDiscoveryCached: { at: number; limits: GoLimits } | undefined;
let goDiscoveryPending: Promise<GoLimits> | undefined;
async function cachedOpenCodeGoLimits(key: string, now: Date): Promise<GoLimits> {
  if (!goDiscoveryCached || now.getTime() - goDiscoveryCached.at >= 10 * 60_000) {
    goDiscoveryPending ??= fetchOpenCodeGoLimits(key).catch(() => new Map<string, Partial<Record<GoPeriod, GoLimit>>>())
      .then(limits => { goDiscoveryCached = { at: now.getTime(), limits }; return limits; })
      .finally(() => { goDiscoveryPending = undefined; });
  }
  return goDiscoveryPending ? await goDiscoveryPending : goDiscoveryCached?.limits ?? new Map();
}

export async function readOpenCodeGoUsage(now = new Date(), options: {
  root?: string;
  readKey?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
} = {}): Promise<AccountUsage> {
  const [totals, key] = await Promise.all([readOpenCodeGoLedger(options.root, now), (options.readKey ?? readOpenCodeGoKey)()]);
  if (!key) return openCodeGoUsage(totals, new Map(), now, false);
  let limits: GoLimits = new Map();
  try {
    limits = options.fetchImpl ? await fetchOpenCodeGoLimits(key, options.fetchImpl) : await cachedOpenCodeGoLimits(key, now);
  } catch { /* Gateway discovery is optional; local accounting is still useful. */ }
  return openCodeGoUsage(totals, limits, now, true);
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
// Claude keeps .claude.json inside CLAUDE_CONFIG_DIR when set, else beside ~/.claude.
const claudeConfigFile = () => path.join(process.env.CLAUDE_CONFIG_DIR?.trim() ? claudeConfigDir() : homeDir(), ".claude.json");
const claudeCredentialsFile = () => path.join(claudeConfigDir(), ".credentials.json");

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
 * with the file left stale after a refresh.
 */
export async function readClaudeToken(execSecurity = exec, platform = process.platform): Promise<string | undefined> {
  const parse = (raw: string): string | undefined => {
    if (raw.length > 16_384) return undefined;
    const oauth = object(object(JSON.parse(raw)).claudeAiOauth);
    const token = typeof oauth.accessToken === "string" && oauth.accessToken.length > 0 ? oauth.accessToken : undefined;
    const expires = typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined;
    if (!token || (expires !== undefined && expires <= Date.now() + 60_000)) return undefined;
    return token;
  };
  if (platform === "darwin") {
    try {
      const { stdout } = await execSecurity("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 5_000, maxBuffer: 16_384 });
      const token = parse(stdout.trim());
      if (token) return token;
    } catch { /* Headless installs can keep credentials in the file instead. */ }
  }
  try { return parse(await readFile(claudeCredentialsFile(), "utf8")); } catch { return undefined; }
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

async function liveClaudeUsage(now: Date): Promise<AccountUsage | undefined> {
  if (typeof fetch !== "function") return undefined;
  const token = await readClaudeToken();
  if (!token) return undefined;
  try { return await fetchClaudeUsage(token, fetch, now); } catch { return undefined; }
}


/** Only initialize and read limits. Never create a thread, prompt, or login. */
export function readCodexLimits(executable = "codex"): Promise<AccountUsage> {
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

export class AccountUsageReader {
  private cached?: { at: number; value: AccountUsage };
  private pending?: Promise<AccountUsage>;
  private claudeCached?: { at: number; value?: AccountUsage };
  private claudePending?: Promise<AccountUsage | undefined>;
  private spendingCached?: { at: number; value: AccountUsage[] };
  private spendingPending?: Promise<AccountUsage[]>;
  constructor(private readCodex = readCodexLimits, private now = Date.now,
              private readClaudeLive: (now: Date) => Promise<AccountUsage | undefined> = liveClaudeUsage,
              private readOpenCode: (now: Date) => Promise<AccountUsage> = now => readOpenCodeUsage("opencode", now),
              private readOpenRouter: (now: Date) => Promise<AccountUsage | undefined> = liveOpenRouterUsage,
              private readOpenCodeGo: (now: Date) => Promise<AccountUsage> = readOpenCodeGoUsage) {}
  async read(): Promise<{ accounts: AccountUsage[] }> {
    if (!this.cached || this.now() - this.cached.at >= 60_000) {
      this.pending ??= this.readCodex().then(value => { this.cached = { at: this.now(), value }; return value; }).finally(() => { this.pending = undefined; });
    }
    const codex = this.pending ?? Promise.resolve(this.cached!.value);
    const [codexValue, claude, spending] = await Promise.all([codex, this.claude(), this.spending()]);
    return { accounts: [codexValue, claude, ...spending] };
  }
  private async spending(): Promise<AccountUsage[]> {
    if (!this.spendingCached || this.now() - this.spendingCached.at >= 60_000) {
      const at = this.now();
      this.spendingPending ??= Promise.all([this.readOpenCode(new Date(at)), this.readOpenCodeGo(new Date(at)), this.readOpenRouter(new Date(at))])
        .then(([openCode, openCodeGo, openRouter]) => [openCode, openCodeGo, ...(openRouter ? [openRouter] : [])])
        .then(value => { this.spendingCached = { at, value }; return value; })
        .finally(() => { this.spendingPending = undefined; });
    }
    return this.spendingPending ? await this.spendingPending : this.spendingCached!.value;
  }
  /** Live first, so the phone's minute-by-minute poll keeps Claude current
   *  even when Claude Code is not running; the local snapshot is the backup. */
  private async claude(): Promise<AccountUsage> {
    if (!this.claudeCached || this.now() - this.claudeCached.at >= 60_000) {
      const at = this.now();
      this.claudePending ??= this.readClaudeLive(new Date(at))
        .then(value => { this.claudeCached = { at, value }; return value; })
        .catch(() => { this.claudeCached = { at, value: undefined }; return undefined; })
        .finally(() => { this.claudePending = undefined; });
    }
    const live = this.claudePending ? await this.claudePending : this.claudeCached?.value;
    if (live?.windows.length) return live;
    return this.snapshotClaude();
  }
  private async snapshotClaude(): Promise<AccountUsage> {
    let claude: AccountUsage = { source: "claude", windows: [], message: "Usage appears after Claude Code replies on this computer. Run phren bridge install if usage reporting is not set up yet." };
    try {
      const handle = await open(claudeFile(), "r");
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
      const handle = await open(claudeConfigFile(), "r");
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
    const snapshot = claudeUsage(JSON.parse(input));
    // Persist only normalized percentages/reset times; never session content.
    const rate_limits = Object.fromEntries(snapshot.windows.map(w => [w.id, {
      used_percentage: w.usedPercent, resets_at: w.resetsAt ? Date.parse(w.resetsAt) / 1000 : undefined,
    }]));
    const file = claudeFile(), temporary = file + "." + randomUUID();
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ rate_limits, updatedAt: snapshot.updatedAt }), { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
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
