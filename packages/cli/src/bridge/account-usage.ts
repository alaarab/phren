import { findPhrenPath } from "../phren-paths.js";
import { HARNESS_NAMES, resetsIn, USAGE_SOURCES } from "../computers/read.js";
import { hookRequest } from "./client.js";
import { notLinkedFrom, type NotLinkedComputer } from "./hand-off.js";
import { optionalHookPeers, peerRequest, type HookPeer } from "./peers.js";
import { errorCode, object, type Json } from "./protocol.js";
import { NEAR_LIMIT_LEFT, windowLeft, type AccountUsage, type UsageWindow } from "./usage.js";

export { NEAR_LIMIT_LEFT };

/**
 * Every computer's agent usage merged by account, for a conductor choosing
 * where to send work: `account_usage` and `phren dispatch usage`. Read like
 * `live_sessions`: this Hook, then each linked Hook over its pinned pipe, with
 * unreachable and unlinked computers listed apart.
 *
 * The merge follows the phone's cards: one account is one allowance whichever
 * computers report it, so the freshest whole report stands. Claude and Codex
 * rows merge by their account key; a Claude login with no identity
 * (`claude:home:<id>`) stays per computer, since two unknown logins are not
 * one account. A window whose reset time has passed says `reset` and has no
 * percent, and a report older than STALE_AFTER_MS is flagged stale.
 */

/** A report older than this is flagged: the Hook reads each account at most once a minute. */
export const STALE_AFTER_MS = 15 * 60_000;
/** ElevenLabs is left out: every read of it spends a request against its key's quota. */
const SOURCES = USAGE_SOURCES.join(",");
const USAGE_ROUTE = `/v1/usage?${new URLSearchParams({ sources: SOURCES, goPlan: "1", accounts: "all" })}`;

export interface AccountWindow {
  id: string;
  name: string;
  usedPercent?: number;
  leftPercent?: number;
  resetsAt?: string;
  resetsIn?: string;
  /** Reset since its report: the allowance is back, but no new percent is known. */
  reset?: true;
  /** The service is refusing requests on this window now. */
  limited?: true;
  usedUSD?: number;
  limitUSD?: number;
}

export interface AccountUsageRow {
  /** `source` or `source|key`, as the phone keys its cards. */
  id: string;
  harness: string;
  name: string;
  /** The login's email, else the account's label, when the Hook names one. */
  account?: string;
  windows: AccountWindow[];
  /** Least room on any window with a percent; `limited` counts as 0. */
  leftPercent?: number;
  nearLimit: boolean;
  spend?: { amountUSD: number; period: string };
  updatedAt?: string;
  /** How old the standing report is, as "4m" or "2d 3h". */
  age?: string;
  stale: boolean;
  /** The computer whose report stands. */
  from?: string;
  /** Where it is signed in, with the Claude account id dispatch takes there. */
  computers: Array<{ name: string; account?: string }>;
  message?: string;
}

export interface AccountUsageView {
  accounts: AccountUsageRow[];
  /** Harnesses no computer reported numbers for, with what each Hook said. */
  noData: Array<{ harness: string; name: string; computers: string[]; message?: string }>;
  /** The computers that answered, this one first. */
  computers: string[];
  unreachable: Array<{ computer: string; error: string; code?: string }>;
  /** Registered in the store but not linked in hooks.yaml: their usage is unknown, not zero. */
  notLinked: NotLinkedComputer[];
  enrolled: number;
  peerError?: string;
}

export interface ComputerUsage { computer: string; accounts: AccountUsage[] }

const date = (value: string | undefined) => value ? Date.parse(value) : NaN;
const hasData = (usage: AccountUsage) => usage.windows.length > 0 || Boolean(usage.spend);
const newer = <T extends { usage: AccountUsage }>(a: T, b: T): T => (date(b.usage.updatedAt) || 0) > (date(a.usage.updatedAt) || 0) ? b : a;

export function ageText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** The phone's card key, except that a Claude login with no identity stays on its own computer. */
export function accountIdentity(usage: AccountUsage, computer: string): string {
  const key = usage.account?.key;
  if (!key || key === usage.source) return usage.source;
  return key.startsWith(`${usage.source}:home:`) ? `${usage.source}|${key}@${computer}` : `${usage.source}|${key}`;
}

/** Percent used and left, with a passed reset reported as reset rather than as its old percent. */
export function settleWindow(window: UsageWindow, now: number): AccountWindow {
  const out: AccountWindow = { id: window.id, name: window.name };
  const resetAt = date(window.resetsAt);
  const reset = window.reset === true || Number.isFinite(resetAt) && resetAt <= now;
  const left = windowLeft(window, now);
  if (reset) out.reset = true;
  else if (typeof window.usedPercent === "number") out.usedPercent = window.usedPercent;
  if (left !== undefined) out.leftPercent = left;
  if (window.resetsAt && !reset) { out.resetsAt = window.resetsAt; const until = resetsIn(window.resetsAt, now); if (until) out.resetsIn = until; }
  if (window.limited && !reset) out.limited = true;
  if (window.usedUSD !== undefined) out.usedUSD = window.usedUSD;
  if (window.limitUSD !== undefined) out.limitUSD = window.limitUSD;
  return out;
}

/** Least room across an account's windows, undefined when none has a percent. */
export function roomLeft(windows: readonly AccountWindow[]): number | undefined {
  const known = windows.map(w => w.leftPercent).filter((value): value is number => value !== undefined);
  return known.length ? Math.min(...known) : undefined;
}

function accountName(usage: AccountUsage): string | undefined {
  const named = (usage as AccountUsage & { accountName?: unknown }).accountName;
  const label = usage.account?.label;
  return usage.account?.email ?? (typeof named === "string" && named ? named : undefined)
    ?? (label && label.toLowerCase() !== (HARNESS_NAMES[usage.source] ?? usage.source).toLowerCase() ? label : undefined);
}

/** One row per account across every computer's report. */
export function mergeAccountUsage(reports: readonly ComputerUsage[], now = Date.now()): Pick<AccountUsageView, "accounts" | "noData"> {
  const groups = new Map<string, Array<{ computer: string; usage: AccountUsage }>>();
  for (const report of reports) for (const usage of report.accounts) {
    const id = accountIdentity(usage, report.computer);
    groups.set(id, [...groups.get(id) ?? [], { computer: report.computer, usage }]);
  }
  const accounts: AccountUsageRow[] = [];
  const empty = new Map<string, { computers: string[]; messages: string[] }>();
  for (const [id, group] of groups) {
    const reporting = group.filter(item => hasData(item.usage));
    if (!reporting.length) {
      const entry = empty.get(group[0].usage.source) ?? { computers: [], messages: [] };
      for (const item of group) {
        if (!entry.computers.includes(item.computer)) entry.computers.push(item.computer);
        if (item.usage.message && !entry.messages.includes(item.usage.message)) entry.messages.push(item.usage.message);
      }
      empty.set(group[0].usage.source, entry);
      continue;
    }
    const source = group[0].usage.source;
    // One allowance: the freshest report with windows stands whole, never mixed with another read.
    const withWindows = reporting.filter(item => item.usage.windows.length);
    const standing = (withWindows.length ? withWindows : reporting).reduce(newer);
    const windows = standing.usage.windows.map(window => settleWindow(window, now));
    const spend = mergedSpend(source, reporting);
    const updated = date(standing.usage.updatedAt);
    const leftPercent = roomLeft(windows);
    const name = accountName(standing.usage);
    const computers = reporting.map(item => ({ name: item.computer, ...(source === "claude" && item.usage.account?.id ? { account: item.usage.account.id } : {}) }))
      .filter((item, index, list) => list.findIndex(other => other.name === item.name && other.account === item.account) === index);
    accounts.push({
      id, harness: source, name: HARNESS_NAMES[source] ?? source, ...(name ? { account: name } : {}), windows,
      ...(leftPercent !== undefined ? { leftPercent } : {}),
      nearLimit: windows.some(w => w.limited) || leftPercent !== undefined && leftPercent < NEAR_LIMIT_LEFT,
      ...(spend ? { spend } : {}),
      ...(standing.usage.updatedAt ? { updatedAt: standing.usage.updatedAt } : {}),
      ...(Number.isFinite(updated) ? { age: ageText(now - updated) } : {}),
      stale: !Number.isFinite(updated) || now - updated > STALE_AFTER_MS || windows.some(w => w.reset),
      from: standing.computer, computers,
      ...(standing.usage.message ? { message: standing.usage.message } : {}),
    });
  }
  const order = (source: string) => { const at = (USAGE_SOURCES as readonly string[]).indexOf(source); return at < 0 ? USAGE_SOURCES.length : at; };
  accounts.sort((a, b) => order(a.harness) - order(b.harness) || (a.account ?? "").localeCompare(b.account ?? "") || a.id.localeCompare(b.id));
  const noData = [...empty].filter(([source]) => !accounts.some(row => row.harness === source))
    .map(([source, entry]) => ({ harness: source, name: HARNESS_NAMES[source] ?? source, computers: entry.computers, ...(entry.messages[0] ? { message: entry.messages[0] } : {}) }))
    .sort((a, b) => order(a.harness) - order(b.harness));
  return { accounts, noData };
}

/** OpenCode's ledgers are per computer and add up; OpenRouter is one key seen from several, counted once per key. */
function mergedSpend(source: string, reporting: Array<{ computer: string; usage: AccountUsage }>): AccountUsageRow["spend"] | undefined {
  const spends = reporting.filter(item => item.usage.spend);
  if (!spends.length) return undefined;
  const round = (value: number) => Math.round(value * 100) / 100;
  if (source === "opencode" || source === "opencode-go") {
    return { amountUSD: round(spends.reduce((sum, item) => sum + item.usage.spend!.amountUSD, 0)), period: spends[0].usage.spend!.period };
  }
  if (source === "openrouter") {
    const byKey = new Map<string, { computer: string; usage: AccountUsage }>();
    for (const item of spends) { const key = item.usage.accountId ?? `computer:${item.computer}`; const seen = byKey.get(key); byKey.set(key, seen ? newer(seen, item) : item); }
    return { amountUSD: round([...byKey.values()].reduce((sum, item) => sum + item.usage.spend!.amountUSD, 0)), period: spends[0].usage.spend!.period };
  }
  return spends.reduce(newer).usage.spend;
}

export interface ReadAccountUsageOptions {
  /** This computer's Hook; tests pass the fixture's socket. */
  hook?: (route: string) => Promise<Json>;
  peers?: () => Promise<{ peers: HookPeer[]; peerError?: string }>;
  peer?: (peer: HookPeer, route: string) => Promise<Json>;
  store?: string | null;
  now?: number;
}

/** This Hook's usage and every linked Hook's, merged by account. */
export async function readAccountUsage(options: ReadAccountUsageOptions = {}): Promise<AccountUsageView> {
  const hook = options.hook ?? (route => hookRequest(route, undefined, undefined, 30_000));
  const ask = options.peer ?? ((peer, route) => peerRequest(peer, route, undefined, 20_000));
  const [health, local, linked] = await Promise.all([hook("/v1/health"), hook(USAGE_ROUTE), (options.peers ?? optionalHookPeers)()]);
  const here = typeof object(health.computer).name === "string" ? String(object(health.computer).name) : "this computer";
  const reports: ComputerUsage[] = [{ computer: here, accounts: accountsOf(local) }];
  const unreachable: AccountUsageView["unreachable"] = [];
  const peerNames = new Map<string, string[]>();
  await Promise.all(linked.peers.map(async peer => {
    try {
      const [usage, peerHealth] = await Promise.all([ask(peer, USAGE_ROUTE), ask(peer, "/v1/health").catch(() => ({}) as Json)]);
      reports.push({ computer: peer.name, accounts: accountsOf(usage) });
      const computer = object(object(peerHealth).computer);
      peerNames.set(peer.name, [computer.name, ...(Array.isArray(computer.aliases) ? computer.aliases : [])].filter((name): name is string => typeof name === "string"));
    } catch (error) {
      const code = errorCode(error);
      unreachable.push({ computer: peer.name, error: error instanceof Error ? error.message.slice(0, 300) : "Unreachable.", ...(code ? { code } : {}) });
    }
  }));
  // Peers answer in any order; this computer first, then by name, so the standing report never depends on timing.
  reports.sort((a, b) => a.computer === here ? -1 : b.computer === here ? 1 : a.computer.localeCompare(b.computer));
  unreachable.sort((a, b) => a.computer.localeCompare(b.computer));
  const store = options.store !== undefined ? options.store : findPhrenPath();
  const notLinked = notLinkedFrom(store, here, linked.peers.map(peer => ({ name: peer.name, address: peer.address, names: peerNames.get(peer.name) })));
  return { ...mergeAccountUsage(reports, options.now ?? Date.now()), computers: reports.map(report => report.computer), unreachable, notLinked,
    enrolled: linked.peers.length, ...(linked.peerError ? { peerError: linked.peerError } : {}) };
}

function accountsOf(answer: Json): AccountUsage[] {
  return Array.isArray(answer.accounts) ? (answer.accounts as unknown[]).filter((item): item is AccountUsage => {
    const row = object(item);
    return typeof row.source === "string" && Array.isArray(row.windows);
  }) : [];
}

const ago = (age: string) => age === "0m" ? "just now" : `${age} ago`;
const title = (row: AccountUsageRow) => row.account ? `${row.name} · ${row.account}` : row.name;

/** The one-line answer a conductor reads first: how many, and which accounts are tight or stale. */
export function usageSummary(view: AccountUsageView): string {
  const parts = [`${view.accounts.length} account${view.accounts.length === 1 ? "" : "s"} across ${view.computers.length} computer${view.computers.length === 1 ? "" : "s"}.`];
  const near = view.accounts.filter(row => row.nearLimit);
  if (near.length) parts.push(`Near a limit: ${near.map(row => `${title(row)} (${row.leftPercent ?? 0}% left${tightest(row)?.resetsIn ? `, resets in ${tightest(row)!.resetsIn}` : ""})`).join("; ")}.`);
  const withRoom = view.accounts.filter(row => !row.nearLimit && row.leftPercent !== undefined);
  if (view.accounts.some(row => row.leftPercent !== undefined) && !withRoom.length) parts.push("Every account with limits is near one: tell the owner before dispatching.");
  const stale = view.accounts.filter(row => row.stale);
  if (stale.length) parts.push(`Stale: ${stale.map(row => `${title(row)} (${row.windows.some(w => w.reset) ? "a window reset since its report" : `reported ${row.age ? ago(row.age) : "at an unknown time"}`})`).join("; ")}.`);
  if (view.unreachable.length) parts.push(`Unreachable: ${view.unreachable.map(item => item.computer).join(", ")}.`);
  if (view.notLinked.length) parts.push(`Not linked, so not checked: ${view.notLinked.map(item => item.name).join(", ")}.`);
  return parts.join(" ");
}

function tightest(row: AccountUsageRow): AccountWindow | undefined {
  return row.windows.filter(w => w.leftPercent !== undefined).sort((a, b) => a.leftPercent! - b.leftPercent!)[0];
}

/** `phren dispatch usage` without --json. */
export function formatAccountUsage(view: AccountUsageView): string {
  const lines = [`Usage by account from ${view.computers.join(", ")}`];
  for (const row of view.accounts) {
    const where = row.computers.map(c => c.account && c.account !== "default" ? `${c.name} (${c.account})` : c.name).join(", ");
    const flags = [row.nearLimit ? `near limit, ${row.leftPercent ?? 0}% left` : row.leftPercent !== undefined ? `${row.leftPercent}% left` : "",
      row.stale ? `stale${row.age ? `, reported ${ago(row.age)}` : ""}` : row.age ? ago(row.age) : ""].filter(Boolean).join("; ");
    lines.push(`${title(row)}  on ${where}${flags ? `  (${flags})` : ""}`);
    for (const w of row.windows) {
      const used = w.reset ? "reset, no new report" : w.usedPercent !== undefined ? `${w.usedPercent}% used` : w.usedUSD !== undefined ? `$${w.usedUSD.toFixed(2)}${w.limitUSD !== undefined ? ` of $${w.limitUSD.toFixed(2)}` : ""}` : "";
      lines.push(`  ${w.name.padEnd(30)} ${used.padEnd(22)}${w.limited ? "limited now  " : ""}${w.resetsIn ? `resets in ${w.resetsIn}` : ""}`.trimEnd());
    }
    if (row.spend) lines.push(`  spend ${row.spend.period.replace(/_/g, " ").padEnd(24)} $${row.spend.amountUSD.toFixed(2)}`);
    if (row.message) lines.push(`  ${row.message}`);
  }
  if (view.noData.length) {
    lines.push("No numbers reported");
    for (const item of view.noData) lines.push(`  ${item.name} (${item.computers.join(", ")})${item.message ? `: ${item.message}` : ""}`);
  }
  if (view.unreachable.length) {
    lines.push("Unreachable");
    for (const item of view.unreachable) lines.push(`  ${item.computer}: ${item.error}`);
  }
  if (view.notLinked.length) {
    lines.push("Not linked, so not checked");
    for (const item of view.notLinked) lines.push(`  ${item.name}${item.aliases?.length ? ` (also ${item.aliases.join(", ")})` : ""}`);
  }
  if (view.peerError) lines.push(`Linked computers skipped: ${view.peerError}`);
  return lines.join("\n");
}
