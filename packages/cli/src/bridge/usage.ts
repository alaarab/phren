import { spawn } from "node:child_process";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { bridgeRoot, object, type Json } from "./protocol.js";

export interface UsageWindow { id: string; name: string; usedPercent: number; resetsAt?: string }
export interface AccountUsage {
  source: "codex" | "claude";
  windows: UsageWindow[];
  updatedAt?: string;
  message?: string;
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

export function claudeUsage(value: unknown, now = new Date()): AccountUsage {
  const limits = object(object(value).rate_limits);
  const windows = [["five_hour", "5-hour limit"], ["seven_day", "7-day limit"]].flatMap(([key, label]) => {
    const item = object(limits[key]);
    const entry = window(key, label, item.used_percentage, item.resets_at);
    return entry ? [entry] : [];
  });
  return { source: "claude", windows, updatedAt: now.toISOString(),
    ...(!windows.length ? { message: "Usage appears after Claude Code replies with a subscription account on this computer." } : {}) };
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
  constructor(private readCodex = readCodexLimits, private now = Date.now) {}
  async read(): Promise<{ accounts: AccountUsage[] }> {
    if (!this.cached || this.now() - this.cached.at >= 60_000) {
      this.pending ??= this.readCodex().then(value => { this.cached = { at: this.now(), value }; return value; }).finally(() => { this.pending = undefined; });
    }
    const codex = this.pending ? await this.pending : this.cached!.value;
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
    return { accounts: [codex, claude] };
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
