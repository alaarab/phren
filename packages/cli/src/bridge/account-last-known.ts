// What a launch last knew about this computer's Claude accounts: each home's login type (Console or
// subscription), bound to a privacy-preserving login fingerprint, and the last accounts.yaml policy
// that parsed. Kept in the bridge dir so a slow probe or an unreadable file does not force a launch
// back to default. See docs/accounts.md.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeLoginFingerprint, type ClaudeHome } from "./claude-accounts.js";
import { withFileLock } from "../governance/locks.js";
import { isAccountRole, isPoolTag, type AccountRole } from "./account-pools.js";
import { bridgeRoot } from "./protocol.js";

export type LoginKind = "console" | "subscription";
export interface KnownLogin { kind: LoginKind; fingerprint: string }
export interface KnownSettings { pool?: string; role?: AccountRole }
export interface KnownPolicy { settings: Record<string, KnownSettings>; allowedPools?: string[] }
export interface LastKnown { logins?: Record<string, KnownLogin>; policy?: KnownPolicy }

const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const MAX_POOLS = 32;
const file = () => path.join(bridgeRoot(), "account-last-known.json");

function loginsOf(raw: unknown): Record<string, KnownLogin> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, KnownLogin> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!SLUG.test(id) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const { kind, fingerprint } = value as { kind?: unknown; fingerprint?: unknown };
    if ((kind === "console" || kind === "subscription") && typeof fingerprint === "string" && FINGERPRINT.test(fingerprint)) {
      out[id] = { kind, fingerprint };
    }
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

function parse(raw: unknown): LastKnown {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const known: LastKnown = {};
  const logins = loginsOf(value.logins);
  if (logins) known.logins = logins;
  const policy = policyOf(value.policy);
  if (policy) known.policy = policy;
  return known;
}

function readSync(): LastKnown {
  try { return parse(JSON.parse(readFileSync(file(), "utf8"))); } catch { return {}; }
}

/** The last-known logins and policy, or empty when there is no readable file. */
export async function readLastKnown(): Promise<LastKnown> { return readSync(); }

/** A home's last-known login type, only when it belongs to the home's current login. */
export function knownLogin(last: LastKnown, home: ClaudeHome): LoginKind | undefined {
  const entry = last.logins?.[home.id];
  return entry && entry.fingerprint === claudeLoginFingerprint(home) ? entry.kind : undefined;
}

function writeSync(value: LastKnown): void {
  const target = file();
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
}

let writes: Promise<unknown> = Promise.resolve();
/** Read, change and write under the file's shared lock, one change at a time; a failure never rejects. */
function update(change: (value: LastKnown) => void): Promise<void> {
  const run = writes.then(() => {
    try {
      withFileLock(file(), () => {
        const value = readSync();
        const before = JSON.stringify(value);
        change(value);
        if (JSON.stringify(value) !== before) writeSync(value);
      });
    } catch { /* Best effort: a lost record only costs one more background probe. */ }
  });
  writes = run;
  return run;
}

/** Remembers a home's login type once Claude answered for the fingerprint seen before the probe. */
export function rememberLogin(home: ClaudeHome, seenFingerprint: string, kind: LoginKind): Promise<void> {
  if (!SLUG.test(home.id)) return Promise.resolve();
  return update(value => {
    // A later login already changed the home: this older answer is not about it.
    if (claudeLoginFingerprint(home) !== seenFingerprint) return;
    value.logins = { ...value.logins, [home.id]: { kind, fingerprint: seenFingerprint } };
  });
}

/** Remembers the last accounts.yaml policy that parsed. */
export function rememberPolicy(policy: KnownPolicy): Promise<void> {
  return update(value => { value.policy = policy; });
}
