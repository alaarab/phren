// What a launch last knew about this computer's Claude accounts: each home's login type (Console or
// subscription) and the last accounts.yaml policy that parsed. Kept in the bridge dir so a slow probe or
// an unreadable file does not force a launch back to default. See docs/accounts.md.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isAccountRole, isPoolTag, type AccountRole } from "./account-pools.js";
import { atomicInPrivateDir, bridgeRoot } from "./protocol.js";

export type LoginKind = "console" | "subscription";
export interface KnownSettings { pool?: string; role?: AccountRole }
export interface KnownPolicy { settings: Record<string, KnownSettings>; allowedPools?: string[] }
export interface LastKnown { logins?: Record<string, LoginKind>; policy?: KnownPolicy }

const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_POOLS = 32;
const file = () => path.join(bridgeRoot(), "account-last-known.json");

function loginsOf(raw: unknown): Record<string, LoginKind> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, LoginKind> = {};
  for (const [id, kind] of Object.entries(raw as Record<string, unknown>)) {
    if (SLUG.test(id) && (kind === "console" || kind === "subscription")) out[id] = kind;
  }
  return Object.keys(out).length ? out : undefined;
}

function policyOf(raw: unknown): KnownPolicy | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as { settings?: unknown; allowedPools?: unknown };
  const rawSettings = value.settings && typeof value.settings === "object" && !Array.isArray(value.settings)
    ? value.settings as Record<string, unknown> : {};
  const settings: Record<string, KnownSettings> = {};
  for (const [id, item] of Object.entries(rawSettings)) {
    if (!SLUG.test(id) || !item || typeof item !== "object" || Array.isArray(item)) continue;
    const { pool, role } = item as { pool?: unknown; role?: unknown };
    const next: KnownSettings = { ...(isPoolTag(pool) ? { pool } : {}), ...(isAccountRole(role) ? { role } : {}) };
    if (Object.keys(next).length) settings[id] = next;
  }
  const allowedPools = Array.isArray(value.allowedPools)
    ? [...new Set(value.allowedPools.filter(isPoolTag))].slice(0, MAX_POOLS) : undefined;
  return { settings, ...(allowedPools ? { allowedPools } : {}) };
}

/** The last-known logins and policy, or empty when there is no readable file. */
export async function readLastKnown(): Promise<LastKnown> {
  try {
    const raw = JSON.parse(await readFile(file(), "utf8")) as Record<string, unknown>;
    const known: LastKnown = {};
    const logins = loginsOf(raw.logins);
    if (logins) known.logins = logins;
    const policy = policyOf(raw.policy);
    if (policy) known.policy = policy;
    return known;
  } catch { return {}; }
}

let writes: Promise<unknown> = Promise.resolve();
/** Read, change and write the file one change at a time; a failure never rejects the caller. */
function update(change: (value: LastKnown) => void): Promise<void> {
  const run = writes.then(async () => {
    const value = await readLastKnown();
    const before = JSON.stringify(value);
    change(value);
    if (JSON.stringify(value) !== before) await atomicInPrivateDir(file(), value);
  });
  writes = run.catch(() => undefined);
  return run.catch(() => undefined);
}

/** Remembers a home's login type once Claude answered definitively. */
export function rememberLogin(id: string, kind: LoginKind): Promise<void> {
  if (!SLUG.test(id)) return Promise.resolve();
  return update(value => { value.logins = { ...value.logins, [id]: kind }; });
}

/** Remembers the last accounts.yaml policy that parsed. */
export function rememberPolicy(policy: KnownPolicy): Promise<void> {
  return update(value => { value.policy = policy; });
}
