// Which Claude account a launch runs under when none is named, and which one
// a worker that hit its usage limit continues on. See docs/accounts.md.
//
// Every account stays in its own home and is used only by Claude Code there:
// this chooses a CLAUDE_CONFIG_DIR, it never moves a token or a request.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readInstallPreferences } from "../init/preferences.js";
import { logger } from "../logger.js";
import { findPhrenPath } from "../phren-paths.js";
import { DEFAULT_ACCOUNT } from "./claude-accounts.js";
import { harnessInventoryWithin, type HarnessInventory } from "./harnesses.js";
import { atomic, bridgeRoot } from "./protocol.js";
import type { AccountUsage, UsageWindow } from "./usage.js";

/** One window's room: percent left, and when it resets. A window whose reset has passed is full again. */
export interface WindowRoom { leftPercent?: number; resetsAt?: string }

/** One signed-in account on one computer, as launch and failover weigh it. */
export interface AccountRoom {
  account: string;
  /** The login's key (`claude:<hash>`), the same on every computer. */
  key?: string;
  usable?: boolean;
  fiveHour?: WindowRoom;
  week?: WindowRoom;
  /** A window is at 100% or refusing requests until `until`. */
  exhausted?: boolean;
  until?: string;
}

export interface AccountChoice { account: string; reason: string }

/** Claude's 5-hour session window and its 7-day window over all models. */
export const FIVE_HOUR = "five_hour", WEEK = "seven_day";

function windowRoom(window: UsageWindow | undefined, now: number): WindowRoom | undefined {
  if (!window) return undefined;
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  if (window.reset || Number.isFinite(reset) && reset <= now) return { leftPercent: 100 };
  const left = window.limited ? 0 : typeof window.usedPercent === "number" ? Math.max(0, Math.min(100, Math.round(100 - window.usedPercent))) : undefined;
  return { ...(left !== undefined ? { leftPercent: left } : {}), ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}) };
}

/** The 5-hour and weekly rooms of one usage row. */
export function accountWindows(usage: Pick<AccountUsage, "windows">, now: number): { fiveHour?: WindowRoom; week?: WindowRoom } {
  const fiveHour = windowRoom(usage.windows.find(w => w.id === FIVE_HOUR), now);
  const week = windowRoom(usage.windows.find(w => w.id === WEEK), now);
  return { ...(fiveHour ? { fiveHour } : {}), ...(week ? { week } : {}) };
}

const left = (room: WindowRoom | undefined) => room?.leftPercent;
/** Unknown room ranks below any known room: an account never reported is tried after one that is. */
const rank = (room: WindowRoom | undefined) => left(room) ?? -1;
const describe = (room: AccountRoom) => {
  const part = (name: string, window: WindowRoom | undefined) => left(window) === undefined ? `${name} unknown` : `${left(window)}% ${name} left`;
  return `${room.account} (${part("5-hour", room.fiveHour)}, ${part("weekly", room.week)})`;
};

/**
 * The account with the most headroom: the most left on the 5-hour window,
 * then on the weekly one, then `default`, then by id. An account that is not
 * usable (signed out), is out of quota, or that `blocked` names (it hit its
 * limit and its window has not reset) is never chosen. Undefined when none is left.
 */
export function chooseAccount(rooms: readonly AccountRoom[], blocked: (room: AccountRoom) => string | undefined = () => undefined): { choice?: AccountChoice; skipped: string[] } {
  const skipped: string[] = [];
  const open = rooms.filter(room => {
    const why = room.usable === false ? "not signed in" : room.exhausted ? `out of quota${room.until ? ` until ${room.until}` : ""}` : blocked(room);
    if (why) skipped.push(`${room.account}: ${why}`);
    return !why;
  });
  const sorted = [...open].sort((a, b) => rank(b.fiveHour) - rank(a.fiveHour) || rank(b.week) - rank(a.week)
    || Number(b.account === DEFAULT_ACCOUNT) - Number(a.account === DEFAULT_ACCOUNT) || a.account.localeCompare(b.account));
  const best = sorted[0];
  if (!best) return { skipped };
  const others = sorted.slice(1).map(describe);
  const reason = `most headroom: ${describe(best)}${others.length ? `; over ${others.join(", ")}` : ""}${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}`;
  return { choice: { account: best.account, reason: reason.slice(0, 400) }, skipped };
}

/** This computer's signed-in Claude accounts with their room, from the Hook's inventory and usage rows. */
export function claudeRooms(inventory: HarnessInventory | undefined, usage: readonly AccountUsage[], now: number): AccountRoom[] {
  const accounts = inventory?.harnesses.find(entry => entry.source === "claude")?.accounts ?? [];
  return accounts.map(account => {
    const row = usage.find(item => item.source === "claude" && (item.account?.id ?? DEFAULT_ACCOUNT) === account.id);
    const windows = row ? accountWindows(row, now) : {};
    const out = [windows.fiveHour, windows.week].filter(w => w?.leftPercent === 0);
    const until = out.map(w => w?.resetsAt).filter((value): value is string => Boolean(value)).sort().at(-1);
    return { account: account.id, ...(account.key ? { key: account.key } : {}), usable: account.usable, ...windows,
      ...(out.length ? { exhausted: true, ...(until ? { until } : {}) } : {}) };
  });
}

// ── Accounts that hit their limit ────────────────────────────────────────────

/** How long an account that hit its limit is left alone when its reset time is unknown: one 5-hour window. */
export const UNKNOWN_RESET_MS = 5 * 60 * 60_000;
const limitsFile = () => path.join(bridgeRoot(), "account-limits.json");
const limitSchema = z.object({ key: z.string().max(200), account: z.string().max(64), until: z.string().datetime(), at: z.string().datetime() }).strict();
const ledgerSchema = z.object({ limits: z.array(limitSchema).max(64) }).strict();
export type AccountLimit = z.infer<typeof limitSchema>;

/** How a login is told apart: its key, else its id on that computer (two unknown logins are not one). */
export const limitKey = (room: Pick<AccountRoom, "account" | "key">, computer: string) =>
  room.key && !room.key.includes(":home:") ? room.key : `${computer}/${room.account}`;

export async function readAccountLimits(now = Date.now()): Promise<AccountLimit[]> {
  try {
    const parsed = ledgerSchema.parse(JSON.parse(await readFile(limitsFile(), "utf8")));
    return parsed.limits.filter(entry => Date.parse(entry.until) > now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.warn("accounts", `Could not read account-limits.json: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

let ledgerWrites: Promise<unknown> = Promise.resolve();
/** Records that a login hit its limit: no launch or failover chooses it again before `until`. */
export function noteAccountLimit(entry: { key: string; account: string; until?: string }, now = Date.now()): Promise<void> {
  const run = ledgerWrites.then(async () => {
    const until = entry.until && Date.parse(entry.until) > now ? entry.until : new Date(now + UNKNOWN_RESET_MS).toISOString();
    const kept = (await readAccountLimits(now)).filter(item => item.key !== entry.key);
    await atomic(limitsFile(), { limits: [...kept, { key: entry.key, account: entry.account, until, at: new Date(now).toISOString() }].slice(-64) });
  });
  ledgerWrites = run.catch(() => undefined);
  return run;
}

/** Why `room` on `computer` is held back by the ledger, or undefined. */
export function limitedBy(limits: readonly AccountLimit[], computer: string): (room: AccountRoom) => string | undefined {
  return room => {
    const hit = limits.find(entry => entry.key === limitKey(room, computer));
    return hit ? `hit its limit, held until ${hit.until}` : undefined;
  };
}

// ── At launch ────────────────────────────────────────────────────────────────

type UsageReader = () => Promise<AccountUsage[]>;
let usageReader: UsageReader | undefined;
let inventoryReader: (() => Promise<HarnessInventory | undefined>) | undefined;
/** The Hook's usage reader (`AccountUsageReader.limits`); tests pass fakes for both. */
export function setChoiceReaders(readers: { usage?: UsageReader; inventory?: () => Promise<HarnessInventory | undefined> }): void {
  usageReader = readers.usage; inventoryReader = readers.inventory;
}

/** The value, or undefined once `ms` passes or it fails: a launch never waits on a slow reader. */
async function within<T>(ms: number, value: Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); timer.unref(); });
  try { return await Promise.race([value.catch(() => undefined), late]); } finally { clearTimeout(timer); }
}

/**
 * The account a Claude launch that names none runs under on this computer, or
 * undefined to launch as before (`default`): only when more than one account is
 * signed in here and their room can be read. Logged with the reason.
 */
export async function pickClaudeAccount(what: string, computer = "this computer", now = Date.now()): Promise<AccountChoice | undefined> {
  if (!usageReader) return undefined;
  const inventory = await within(2_500, (inventoryReader ?? (() => harnessInventoryWithin(2_500)))());
  const rooms = claudeRooms(inventory, [], now);
  if (rooms.filter(room => room.usable !== false).length < 2) return undefined;
  const usage = await within(2_500, usageReader());
  if (!usage) return undefined;
  const { choice, skipped } = chooseAccount(claudeRooms(inventory, usage, now), limitedBy(await readAccountLimits(now), computer));
  if (choice) logger.info("accounts", `${what}: Claude account ${choice.account}, ${choice.reason}.`);
  else logger.info("accounts", `${what}: no Claude account has room (${skipped.join("; ")}); launching under default.`);
  return choice;
}

// ── The switch ───────────────────────────────────────────────────────────────

const TRUE = new Set(["1", "true", "on", "yes"]), FALSE = new Set(["0", "false", "off", "no"]);

/** Whether a Claude worker that hits its usage limit is continued on another account. On unless
 *  `phren config account-failover off` or PHREN_ACCOUNT_FAILOVER=off. */
export function resolveAccountFailover(env: NodeJS.ProcessEnv = process.env, store: string | null = findPhrenPath()): { on: boolean; source: string } {
  const raw = env.PHREN_ACCOUNT_FAILOVER?.trim().toLowerCase();
  if (raw && TRUE.has(raw)) return { on: true, source: "PHREN_ACCOUNT_FAILOVER" };
  if (raw && FALSE.has(raw)) return { on: false, source: "PHREN_ACCOUNT_FAILOVER" };
  try {
    const value = store ? readInstallPreferences(store).accountFailover : undefined;
    if (typeof value === "boolean") return { on: value, source: "install preferences" };
  } catch { /* No preferences yet: the default applies. */ }
  return { on: true, source: "default" };
}
