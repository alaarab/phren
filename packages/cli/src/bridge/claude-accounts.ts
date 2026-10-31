// Claude accounts on this computer: one Claude config home per account.
// ~/.claude is the "default" account and is launched without CLAUDE_CONFIG_DIR,
// so its keychain item and ~/.claude.json stay where Claude Code put them.
// Every ~/.claude-<slug> holding a .claude.json is another account. See docs/accounts.md.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { dump, load } from "js-yaml";
import { withFileLock } from "../governance/locks.js";
import { claudeConfigDir, homeDir } from "../home-paths.js";
import { bridgeRoot } from "./protocol.js";

import { claudePlan, monthlyAnniversary, subscriptionDate, type Subscription } from "./subscription.js";

export const DEFAULT_ACCOUNT = "default";
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface ClaudeHome {
  /** "default", or the slug of ~/.claude-<slug>. */
  id: string;
  /** The config directory (CLAUDE_CONFIG_DIR for non-default homes). */
  dir: string;
  /** Where Claude Code keeps this home's .claude.json. */
  configFile: string;
  isDefault: boolean;
}

/** What rows, usage and receipts carry to name an account. */
export interface AccountRef { id: string; label: string; key: string; email?: string }

export function isAccountSlug(value: string): boolean { return value === DEFAULT_ACCOUNT || SLUG.test(value); }

function defaultHome(env: NodeJS.ProcessEnv): ClaudeHome {
  const configured = Boolean(env.CLAUDE_CONFIG_DIR?.trim());
  const dir = claudeConfigDir(env);
  // Claude keeps .claude.json inside CLAUDE_CONFIG_DIR when set, else beside ~/.claude.
  return { id: DEFAULT_ACCOUNT, dir, configFile: path.join(configured ? dir : homeDir(env), ".claude.json"), isDefault: true };
}

/** Every Claude home on this computer, default first, then by slug. */
export function claudeHomes(env: NodeJS.ProcessEnv = process.env): ClaudeHome[] {
  const homes = [defaultHome(env)];
  const home = homeDir(env);
  let names: string[] = [];
  try { names = readdirSync(home); } catch { return homes; }
  for (const name of names.sort()) {
    if (!name.startsWith(".claude-")) continue;
    const id = name.slice(".claude-".length);
    if (!SLUG.test(id) || id === DEFAULT_ACCOUNT) continue;
    const dir = path.join(home, name);
    if (dir === homes[0].dir) continue;
    try {
      if (!statSync(dir).isDirectory() || !existsSync(path.join(dir, ".claude.json"))) continue;
    } catch { continue; }
    homes.push({ id, dir, configFile: path.join(dir, ".claude.json"), isDefault: false });
  }
  return homes;
}

export function claudeHome(id: string | undefined, env: NodeJS.ProcessEnv = process.env): ClaudeHome | undefined {
  const wanted = id?.trim() || DEFAULT_ACCOUNT;
  return claudeHomes(env).find(home => home.id === wanted);
}

/** The home a transcript or other file lives in, by longest matching directory. */
export function claudeHomeOfPath(file: string, env: NodeJS.ProcessEnv = process.env): ClaudeHome | undefined {
  const resolved = path.resolve(file);
  return claudeHomes(env)
    .filter(home => resolved.startsWith(home.dir + path.sep))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}

/** Environment a launch into this home needs; empty for the default home. */
export function claudeLaunchEnv(home: ClaudeHome): Record<string, string> {
  return home.isDefault ? {} : { CLAUDE_CONFIG_DIR: home.dir };
}

/** The config home a running Claude process uses, from its CLAUDE_CONFIG_DIR. */
export function claudeHomeOfEnv(value: string | undefined, env: NodeJS.ProcessEnv = process.env): ClaudeHome | undefined {
  if (!value?.trim()) return claudeHome(DEFAULT_ACCOUNT, env);
  const dir = path.resolve(value.trim());
  return claudeHomes(env).find(home => home.dir === dir);
}

// ── labels (<bridge>/accounts.yaml) ─────────────────────────────────────────

export const accountsFile = () => path.join(bridgeRoot(), "accounts.yaml");

/** `accounts.yaml` as an object: empty when there is none (or it is blank), an error when it is there but is
 * not a mapping, so a write never replaces what it couldn't read. */
export function parseAccountsYaml(text: string | undefined): Record<string, unknown> {
  if (text === undefined || !text.trim()) return {};
  const parsed = load(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  throw new Error(`${accountsFile()} is not a mapping; fix or remove it first.`);
}

let accountsWrites: Promise<unknown> = Promise.resolve();
/**
 * The one way `accounts.yaml` is changed (labels, credits, pools): reads it, applies `change`, and writes it back
 * atomically. Writes in this process run one at a time, and each holds the file's lock against other processes
 * (the CLI beside the Hook), so no write drops another's change. A file that can't be read is never replaced.
 */
export function updateAccountsFile(change: (parsed: Record<string, unknown>) => void): Promise<void> {
  const run = accountsWrites.then(async () => {
    await mkdir(bridgeRoot(), { recursive: true, mode: 0o700 });
    const file = accountsFile();
    withFileLock(file, () => {
      let text: string | undefined;
      try { text = readFileSync(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const parsed = parseAccountsYaml(text);
      change(parsed);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { writeFileSync(temporary, dump(parsed), { mode: 0o600, flag: "wx" }); renameSync(temporary, file); }
      finally { rmSync(temporary, { force: true }); }
    });
  });
  accountsWrites = run.catch(() => undefined);
  return run;
}

function readLabels(): Record<string, string> {
  try {
    const parsed = load(readFileSync(accountsFile(), "utf8"));
    const claude = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).claude : undefined;
    if (!claude || typeof claude !== "object") return {};
    return Object.fromEntries(Object.entries(claude as Record<string, unknown>)
      .filter(([id, label]) => isAccountSlug(id) && typeof label === "string" && label.trim().length > 0 && label.length <= 40)
      .map(([id, label]) => [id, (label as string).trim()]));
  } catch { return {}; }
}

export function accountLabel(id: string, labels = readLabels()): string {
  if (labels[id]) return labels[id];
  if (id === DEFAULT_ACCOUNT) return "Claude";
  return id.split("-").filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export async function setAccountLabel(id: string, label: string): Promise<void> {
  if (!isAccountSlug(id)) throw new Error(`"${id}" is not an account name: use lowercase letters, digits and dashes.`);
  const clean = label.trim();
  if (!clean || clean.length > 40 || /[\u0000-\u001f]/.test(clean)) throw new Error("A label is 1 to 40 printable characters.");
  await updateAccountsFile(parsed => {
    const claude = parsed.claude && typeof parsed.claude === "object" ? parsed.claude as Record<string, unknown> : {};
    parsed.claude = { ...claude, [id]: clean };
  });
}

// ── identity (.claude.json oauthAccount, no tokens) ─────────────────────────

interface OauthIdentity { uuid?: string; email?: string; organization?: string; plan?: string; startedAt?: string; checkedAt?: string }
const identityCache = new Map<string, OauthIdentity & { mtimeMs: number; size: number }>();

function oauthIdentity(configFile: string): OauthIdentity {
  try {
    const stat = statSync(configFile);
    if (!stat.isFile() || stat.size > 16_777_216) return {};
    const cached = identityCache.get(configFile);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
    const config = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
    const account = config.oauthAccount && typeof config.oauthAccount === "object" ? config.oauthAccount as Record<string, unknown> : {};
    const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : undefined;
    const email = typeof account.emailAddress === "string" && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(account.emailAddress) ? account.emailAddress : undefined;
    const fetched = typeof account.profileFetchedAt === "number" ? subscriptionDate(Math.floor(account.profileFetchedAt / 1000)) : undefined;
    const value = { mtimeMs: stat.mtimeMs, size: stat.size, uuid: id(account.accountUuid), email, organization: id(account.organizationUuid),
      plan: claudePlan(account), startedAt: subscriptionDate(account.subscriptionCreatedAt), checkedAt: fetched };
    identityCache.set(configFile, value);
    return value;
  } catch { return {}; }
}

/**
 * Stable across computers for one subscription; home-scoped when unknown.
 * One login can belong to several organizations (a personal plan and a Team
 * seat), each its own allowance, so the organization is part of the key.
 */
export function claudeAccountKey(home: ClaudeHome): string {
  const { uuid, email, organization } = oauthIdentity(home.configFile);
  const login = uuid ?? email;
  if (!login) return `claude:home:${home.id}`;
  return "claude:" + createHash("sha256").update(organization ? `${login}|${organization}` : login).digest("hex").slice(0, 12);
}

/** The login's email, so the phone can name a card merged across computers. Usage rows only. */
export function claudeAccountEmail(home: ClaudeHome): string | undefined { return oauthIdentity(home.configFile).email; }

/** A login is recorded but its profile names no plan Phren knows. */
export function claudePlanUnknown(home: ClaudeHome): boolean {
  const identity = oauthIdentity(home.configFile);
  return Boolean(identity.uuid ?? identity.email) && !identity.plan;
}

/**
 * The account home's own subscription, independent of the quota snapshot's
 * age. `checkedAt` is when Claude Code last fetched the profile, so the
 * newest profile wins when computers disagree about a plan that changed.
 */
export function claudeAccountSubscription(home: ClaudeHome, now = new Date(), fallbackPlan?: string): Subscription | undefined {
  const { plan: profilePlan, startedAt, checkedAt } = oauthIdentity(home.configFile);
  const plan = profilePlan ?? fallbackPlan;
  if (!plan) return undefined;
  const renewsAt = startedAt && profilePlan ? monthlyAnniversary(startedAt, now) : undefined;
  return { plan, ...(startedAt && profilePlan ? { startedAt } : {}), ...(renewsAt ? { renewsAt, renewsEstimated: true } : {}), checkedAt: checkedAt ?? now.toISOString() };
}

export function claudeAccountRef(home: ClaudeHome, labels = readLabels()): AccountRef {
  return { id: home.id, label: accountLabel(home.id, labels), key: claudeAccountKey(home) };
}

/**
 * A privacy-preserving fingerprint of a home's login: the signed-in account's stable identity and the
 * credential file's own metadata, never the main config file's (a trust prompt or project setting
 * rewrites it without changing the login). A re-login changes it, so cached and persisted answers for
 * the old login are dropped. Undefined when the config names no identity: the last classification is
 * then kept rather than discarded. Only the hash is ever stored.
 */
export function claudeLoginFingerprint(home: ClaudeHome): string | undefined {
  const identity = oauthIdentity(home.configFile);
  // accountUuid is the login; the organization separates two seats of one login. Email only when no uuid.
  const stable = identity.uuid ? `${identity.uuid}|${identity.organization ?? ""}` : identity.email;
  if (!stable) return undefined;
  let credentials: { mtimeMs: number; size: number; ino: number } | undefined;
  try {
    const value = statSync(path.join(home.dir, ".credentials.json"));
    if (value.isFile()) credentials = { mtimeMs: value.mtimeMs, size: value.size, ino: value.ino };
  } catch { /* No credentials file here (macOS often keeps its own in the keychain). */ }
  return createHash("sha256")
    .update([stable, credentials?.mtimeMs ?? "", credentials?.size ?? "", credentials?.ino ?? ""].join("|")).digest("hex");
}

export const CODEX_ACCOUNT: AccountRef = { id: DEFAULT_ACCOUNT, label: "Codex", key: "codex" };

/** Only for tests. */
export function clearAccountCaches(): void { identityCache.clear(); authCache.clear(); }

// ── sign-in state (`claude auth status --json`, cached) ─────────────────────

/** `unknown`: Claude gave no answer (timeout, crash, unparseable), which must not block a launch. */
export interface AuthStatus { signedIn: boolean; unknown?: boolean; plan?: string; reason?: string; /** Signed in with a Console (API billing) login. */ console?: boolean }
const AUTH_CACHE_MS = 5 * 60_000;
const AUTH_TIMEOUT_MS = 10_000;
const SIGNED_OUT_CACHE_MS = 30_000;
const authCache = new Map<string, { at: number; fingerprint: string | undefined; value: Promise<AuthStatus>; signedIn?: boolean }>();

/** Parse `claude auth status --json`. Never keeps anything but the state and plan. */
export function parseAuthStatus(output: string): AuthStatus {
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    if (value.loggedIn !== true) return { signedIn: false, reason: "Not signed in" };
    const plan = typeof value.subscriptionType === "string" && /^[a-z0-9_-]{1,32}$/i.test(value.subscriptionType) ? value.subscriptionType : undefined;
    return { signedIn: true, ...(plan ? { plan } : {}), ...(value.authMethod === "console" ? { console: true } : {}) };
  } catch { return { signedIn: false, unknown: true, reason: "Claude did not report its sign-in state" }; }
}

export type AuthRunner = (home: ClaudeHome) => Promise<string>;

/** How the sign-in probe starts Claude: an npm install on Windows is `claude.cmd`, which only a shell starts. */
export function claudeAuthSpawn(platform: NodeJS.Platform = process.platform): { command: string; shell: boolean } {
  return { command: "claude", shell: platform === "win32" };
}

const runAuthStatus: AuthRunner = home => new Promise(resolve => {
  let out = "", done = false;
  const { command, shell } = claudeAuthSpawn();
  const child = spawn(command, ["auth", "status", "--json"], {
    cwd: homeDir(), stdio: ["ignore", "pipe", "ignore"], shell,
    env: { ...process.env, ...claudeLaunchEnv(home), NO_COLOR: "1" },
  });
  const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(out); } };
  const timer = setTimeout(() => { child.kill("SIGKILL"); finish(); }, AUTH_TIMEOUT_MS);
  child.stdout.on("data", (chunk: Buffer) => { if (out.length < 16_384) out += chunk.toString(); });
  child.on("error", finish); child.on("close", finish);
});

export function claudeAuthStatus(home: ClaudeHome, run: AuthRunner = runAuthStatus, now = Date.now()): Promise<AuthStatus> {
  const fingerprint = claudeLoginFingerprint(home);
  const cached = authCache.get(home.dir);
  // A re-login changes the fingerprint: an answer cached for the old login must not be reused.
  if (cached && cached.fingerprint === fingerprint && now - cached.at < (cached.signedIn === false ? SIGNED_OUT_CACHE_MS : AUTH_CACHE_MS)) return cached.value;
  const entry: { at: number; fingerprint: string | undefined; value: Promise<AuthStatus>; signedIn?: boolean } = { at: now, fingerprint, value: Promise.resolve({ signedIn: false }) };
  // A signed-out answer is kept briefly so a fresh /login shows up within half a minute.
  entry.value = run(home).then(parseAuthStatus, (): AuthStatus => ({ signedIn: false, unknown: true, reason: "Claude did not report its sign-in state" }))
    .then(status => { entry.signedIn = status.unknown ? false : status.signedIn; return status; });
  authCache.set(home.dir, entry);
  return entry.value;
}
