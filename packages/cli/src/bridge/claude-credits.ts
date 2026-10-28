// API credits for Claude homes signed in with a Console login: the owner
// enters each credit once (amount, optional expiry and label) and the Hook
// estimates what is left from Claude Code's own per-session cost under that
// home. Opt-in: with no credit entered nothing is recorded or shown.
// The estimate never reads billing; it can drift from the Console's balance.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { dump, load } from "js-yaml";
import { atomic, atomicInPrivateDir, bridgeRoot, object } from "./protocol.js";
import { accountsFile, isAccountSlug, type ClaudeHome } from "./claude-accounts.js";
import type { ApiCredit, UsageWindow } from "./usage.js";

export interface ClaudeCredit {
  /** Short id derived from the entry, for `--remove`. */
  id: string;
  amountUSD: number;
  /** Spend counts from this day (UTC midnight). */
  since: string;
  expiresAt?: string;
  label?: string;
}

/** One session's cost as Claude Code reported it, and when the session began. */
export interface SessionCost { costUSD: number; startedAt: string }

const MAX_CREDITS = 16;
const MAX_SESSIONS = 4000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const day = (value: string, what: string): string => {
  if (!DAY.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) throw new Error(`${what} is a date like 2026-12-31.`);
  return new Date(`${value}T00:00:00Z`).toISOString();
};

function readYaml(text: string | undefined): Record<string, unknown> {
  try { const parsed = text === undefined ? undefined : load(text); return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}

function creditsOf(parsed: Record<string, unknown>, home: string): ClaudeCredit[] {
  const list = object(parsed.credits)[home];
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_CREDITS).flatMap((raw): ClaudeCredit[] => {
    const item = object(raw);
    const amountUSD = item.amountUSD, since = item.since;
    if (typeof item.id !== "string" || typeof amountUSD !== "number" || !Number.isFinite(amountUSD) || amountUSD <= 0
      || typeof since !== "string" || !Number.isFinite(Date.parse(since))) return [];
    const expires = typeof item.expiresAt === "string" && Number.isFinite(Date.parse(item.expiresAt)) ? item.expiresAt : undefined;
    const label = typeof item.label === "string" && item.label.trim() ? item.label.trim().slice(0, 40) : undefined;
    return [{ id: item.id.slice(0, 16), amountUSD, since, ...(expires ? { expiresAt: expires } : {}), ...(label ? { label } : {}) }];
  });
}

/** The credits entered for one Claude home, in `<bridge>/accounts.yaml` under `credits`. */
export function claudeCredits(home: string): ClaudeCredit[] {
  let text: string | undefined;
  try { text = readFileSync(accountsFile(), "utf8"); } catch { return []; }
  return creditsOf(readYaml(text), home);
}

async function updateCredits(home: string, change: (list: ClaudeCredit[]) => ClaudeCredit[]): Promise<ClaudeCredit[]> {
  if (!isAccountSlug(home)) throw new Error(`"${home}" is not an account name: use lowercase letters, digits and dashes.`);
  let text: string | undefined;
  try { text = await readFile(accountsFile(), "utf8"); } catch { /* First entry. */ }
  const parsed = readYaml(text);
  const next = change(creditsOf(parsed, home));
  const credits = { ...object(parsed.credits) } as Record<string, unknown>;
  if (next.length) credits[home] = next; else delete credits[home];
  parsed.credits = credits;
  if (!Object.keys(credits).length) delete parsed.credits;
  await mkdir(bridgeRoot(), { recursive: true, mode: 0o700 });
  await atomic(accountsFile(), dump(parsed), 0o600);
  return next;
}

/** `phren bridge accounts credit <id> --amount <usd> [--expires <date>] [--since <date>] [--label <name>]`. */
export async function addClaudeCredit(home: string, entry: { amount: string; expires?: string; since?: string; label?: string }, now = new Date()): Promise<ClaudeCredit> {
  const amountUSD = Number(entry.amount.replace(/^\$/, ""));
  if (!Number.isFinite(amountUSD) || amountUSD <= 0 || amountUSD > 1_000_000) throw new Error("--amount is the credit in US dollars, like 200.");
  const label = entry.label?.trim();
  if (label !== undefined && (!label || label.length > 40 || /[\u0000-\u001f]/.test(label))) throw new Error("A label is 1 to 40 printable characters.");
  const since = entry.since ? day(entry.since, "--since") : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  // A credit lasts through its expiry day.
  const expiresAt = entry.expires ? new Date(Date.parse(day(entry.expires, "--expires")) + 86_400_000 - 1000).toISOString() : undefined;
  if (expiresAt && expiresAt <= since) throw new Error("--expires is after --since.");
  const id = createHash("sha256").update(`${home}|${amountUSD}|${since}|${expiresAt ?? ""}|${label ?? ""}`).digest("hex").slice(0, 8);
  const credit: ClaudeCredit = { id, amountUSD, since, ...(expiresAt ? { expiresAt } : {}), ...(label ? { label } : {}) };
  await updateCredits(home, list => {
    if (list.some(item => item.id === id)) return list;
    if (list.length >= MAX_CREDITS) throw new Error(`An account holds at most ${MAX_CREDITS} credits; remove one first.`);
    return [...list, credit];
  });
  return credit;
}

export async function removeClaudeCredit(home: string, id: string): Promise<boolean> {
  let removed = false;
  await updateCredits(home, list => list.filter(item => item.id === id ? (removed = true, false) : true));
  return removed;
}

// ── spend (Claude Code's own per-session cost) ──────────────────────────────

/** Per-session costs from the status line, kept only for homes with a credit. */
export const costLedgerFile = (home: ClaudeHome) => path.join(bridgeRoot(), "usage", home.isDefault ? "claude-cost.json" : `claude-cost-${home.id}.json`);

function readLedger(file: string): Record<string, SessionCost> {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 1_048_576) return {};
    const sessions = object(object(JSON.parse(readFileSync(file, "utf8"))).sessions);
    return Object.fromEntries(Object.entries(sessions).flatMap(([id, raw]) => {
      const item = object(raw);
      return typeof item.costUSD === "number" && Number.isFinite(item.costUSD) && item.costUSD >= 0 && typeof item.startedAt === "string"
        ? [[id, { costUSD: item.costUSD, startedAt: item.startedAt }]] : [];
    }));
  } catch { return {}; }
}

/** Record one status-line render: the session's running total only grows, so the largest seen stands. */
export async function recordSessionCost(home: ClaudeHome, payload: unknown, now = new Date()): Promise<void> {
  if (!claudeCredits(home.id).length) return;
  const value = object(payload);
  const session = typeof value.session_id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(value.session_id) ? value.session_id : undefined;
  const cost = object(value.cost).total_cost_usd;
  if (!session || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || cost > 100_000) return;
  const file = costLedgerFile(home);
  const sessions = readLedger(file);
  const seen = sessions[session];
  if (seen && seen.costUSD >= cost) return;
  sessions[session] = { costUSD: cost, startedAt: seen?.startedAt ?? now.toISOString() };
  const kept = Object.entries(sessions).sort(([, a], [, b]) => b.startedAt.localeCompare(a.startedAt)).slice(0, MAX_SESSIONS);
  await atomicInPrivateDir(file, JSON.stringify({ sessions: Object.fromEntries(kept) }));
}

/**
 * Every session cost known for a home: the status-line ledger, plus the
 * `lastCost` Claude Code keeps per project in the home's `.claude.json`
 * (which also covers sessions with no status line), dated by the session's
 * transcript. The larger figure for one session stands.
 */
export function homeSessionCosts(home: ClaudeHome): Record<string, SessionCost> {
  const sessions = readLedger(costLedgerFile(home));
  let projects: Record<string, unknown> = {};
  try {
    const stat = statSync(home.configFile);
    if (stat.isFile() && stat.size <= 16_777_216) projects = object(object(JSON.parse(readFileSync(home.configFile, "utf8"))).projects);
  } catch { /* No config: the ledger stands alone. */ }
  const wanted = new Map<string, number>();
  for (const raw of Object.values(projects)) {
    const project = object(raw);
    const id = project.lastSessionId, cost = project.lastCost;
    if (typeof id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(id) && typeof cost === "number" && Number.isFinite(cost) && cost > 0) wanted.set(id, cost);
  }
  if (wanted.size) {
    const started = transcriptTimes(path.join(home.dir, "projects"), new Set(wanted.keys()));
    for (const [id, cost] of wanted) {
      const startedAt = sessions[id]?.startedAt ?? started.get(id);
      if (!startedAt) continue;
      if (!sessions[id] || sessions[id].costUSD < cost) sessions[id] = { costUSD: cost, startedAt };
    }
  }
  return sessions;
}

/** When each wanted session's transcript was created, from `<home>/projects/<folder>/<session>.jsonl`. */
function transcriptTimes(root: string, wanted: Set<string>): Map<string, string> {
  const found = new Map<string, string>();
  let folders: string[] = [];
  try { folders = readdirSync(root); } catch { return found; }
  for (const folder of folders.slice(0, 2000)) {
    for (const id of wanted) {
      if (found.has(id)) continue;
      try {
        const stat = statSync(path.join(root, folder, `${id}.jsonl`));
        const time = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
        found.set(id, new Date(time).toISOString());
      } catch { /* Not in this folder. */ }
    }
    if (found.size === wanted.size) break;
  }
  return found;
}

/**
 * One window per live credit: spend is drawn from the credit that expires
 * first among those active when the session began, overflowing to the next.
 * Expired credits are left out. The window's `resetsAt` is the expiry.
 */
export function creditWindows(credits: readonly ClaudeCredit[], sessions: Record<string, SessionCost>, now = new Date()): UsageWindow[] {
  const ordered = [...credits].sort((a, b) => (a.expiresAt ?? "9999").localeCompare(b.expiresAt ?? "9999") || a.since.localeCompare(b.since));
  const used = new Map(ordered.map(credit => [credit.id, 0]));
  const spend = Object.values(sessions).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const session of spend) {
    let cost = session.costUSD;
    for (const credit of ordered) {
      if (cost <= 0) break;
      if (session.startedAt < credit.since || credit.expiresAt && session.startedAt > credit.expiresAt) continue;
      const take = Math.min(cost, credit.amountUSD - used.get(credit.id)!);
      if (take <= 0) continue;
      used.set(credit.id, used.get(credit.id)! + take);
      cost -= take;
    }
  }
  const round = (value: number) => Math.round(value * 100) / 100;
  return ordered.filter(credit => !credit.expiresAt || Date.parse(credit.expiresAt) > now.getTime()).map(credit => {
    const usedUSD = round(used.get(credit.id)!);
    return {
      id: `credit:${credit.id}`, name: `API credit${credit.label ? ` · ${credit.label}` : ""}, estimate`,
      usedUSD, limitUSD: credit.amountUSD, remainingUSD: round(Math.max(0, credit.amountUSD - usedUSD)),
      usedPercent: Math.min(100, Math.round(usedUSD / credit.amountUSD * 100)),
      ...(credit.expiresAt ? { resetsAt: credit.expiresAt, expiresAt: credit.expiresAt } : {}), asOf: now.toISOString(),
    };
  });
}

/** The credit windows added up: dollars left and the soonest expiry among those with money left. None: undefined. */
export function creditSummary(windows: ReadonlyArray<Pick<UsageWindow, "id" | "usedUSD" | "limitUSD" | "remainingUSD" | "expiresAt">>): ApiCredit | undefined {
  const credit = windows.filter(window => window.id.startsWith("credit:") && typeof window.limitUSD === "number" && typeof window.usedUSD === "number");
  if (!credit.length) return undefined;
  const round = (value: number) => Math.round(value * 100) / 100;
  const sum = (pick: (window: typeof credit[number]) => number) => round(credit.reduce((total, window) => total + pick(window), 0));
  const expiresAt = credit.filter(window => window.expiresAt && (window.remainingUSD ?? window.limitUSD! - window.usedUSD!) > 0)
    .map(window => window.expiresAt!).sort()[0];
  return { remainingUSD: sum(window => Math.max(0, window.remainingUSD ?? window.limitUSD! - window.usedUSD!)), limitUSD: sum(window => window.limitUSD!),
    usedUSD: sum(window => window.usedUSD!), ...(expiresAt ? { expiresAt } : {}), estimate: true };
}
