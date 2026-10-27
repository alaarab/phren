// `phren bridge accounts add`: a new Claude home that shares the default home's setup.
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { homeDir } from "../home-paths.js";
import { claudeHome, claudeHomes, DEFAULT_ACCOUNT, isAccountSlug, setAccountLabel } from "./claude-accounts.js";
import { atomic } from "./protocol.js";

/** Entries of the default home every account shares by symlink. */
export const SHARED_ENTRIES = ["settings.json", "CLAUDE.md", "skills", "agents", "commands", "plugins"];

const exists = (file: string) => lstat(file).then(() => true, () => false);

async function readObject(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

async function mcpServersOf(file: string): Promise<Record<string, unknown>> {
  const servers = (await readObject(file))?.mcpServers;
  return servers && typeof servers === "object" && !Array.isArray(servers) ? servers as Record<string, unknown> : {};
}

/** Write the default home's user-scope mcpServers into one home's .claude.json; the default's entries win by name. */
async function mergeMcpServers(file: string, servers: Record<string, unknown>): Promise<boolean> {
  const present = await exists(file);
  const existing = present ? await readObject(file) : {};
  if (!existing) return false; // Unreadable or not an object: leave the owner's file alone.
  const current = existing.mcpServers && typeof existing.mcpServers === "object" && !Array.isArray(existing.mcpServers) ? existing.mcpServers as Record<string, unknown> : {};
  const merged = { ...current, ...servers };
  if (present && JSON.stringify(merged) === JSON.stringify(current)) return false;
  await atomic(file, JSON.stringify({ ...existing, mcpServers: merged }, null, 2) + "\n", 0o600);
  return true;
}

/** Refresh every extra home's mcpServers from the default home. Returns the ids that changed. */
export async function syncAccountMcpServers(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const homes = claudeHomes(env);
  const servers = await mcpServersOf(homes[0].configFile);
  const changed: string[] = [];
  for (const home of homes.slice(1)) if (await mergeMcpServers(home.configFile, servers)) changed.push(home.id);
  return changed;
}

export interface AddedAccount { id: string; dir: string; linked: string[]; created: boolean }

/** A valid account name for `name`, or for the account's email when one is known: its user and the
 * first part of its domain (`ala@alaarab.com` is `ala-alaarab`), lowercase, runs of anything else as one dash. */
export function suggestAccountSlug(name: string, email?: string): string {
  const [user, domain = ""] = email?.includes("@") ? email.trim().split("@") : [name];
  const from = domain ? `${user}-${domain.split(".")[0]}` : user;
  const slug = from.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 32).replace(/-+$/, "");
  return !slug ? "account" : slug === DEFAULT_ACCOUNT ? "default-2" : slug;
}

/** Why `slug` is not an account name, with one that is. */
export function badAccountSlug(slug: string, email?: string): string {
  return `"${slug}" is not an account name: use 1 to 32 lowercase letters, digits and dashes, and not "default". Try "${suggestAccountSlug(slug, email)}".`;
}

const run = promisify(execFile);

/** Whether this is an ssh session on a Mac whose login keychain it cannot use: Claude keeps a Mac's login
 * there, so a /login made in such a session is never saved. A local session is never checked. */
export async function sshKeychainLocked(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
  exec: (file: string, args: string[], options: { timeout: number }) => Promise<unknown> = run): Promise<boolean> {
  if (platform !== "darwin" || !(env.SSH_CONNECTION || env.SSH_CLIENT)) return false;
  // A locked keychain answers "User interaction is not allowed"; one unlocked for this session answers its settings.
  try { await exec("security", ["show-keychain-info"], { timeout: 5_000 }); return false; } catch { return true; }
}

export function keychainLockedMessage(slug: string, label?: string): string {
  const labelArg = label ? ` --label '${label.replace(/'/g, "'\\''")}'` : "";
  return "This Mac's login keychain is locked to this ssh session, so Claude can't save a login made here. "
    + `On the Mac itself, run: phren bridge accounts add ${slug}${labelArg}. `
    + "Or unlock the keychain for this session first (security unlock-keychain ~/Library/Keychains/login.keychain-db) and run it again.";
}

export async function addClaudeAccount(slug: string, opts: { label?: string; email?: string; env?: NodeJS.ProcessEnv; keychainLocked?: () => Promise<boolean> } = {}): Promise<AddedAccount> {
  const env = opts.env ?? process.env;
  // A label given as the account's email names the account well.
  const email = opts.email ?? (opts.label?.includes("@") ? opts.label : undefined);
  if (slug === DEFAULT_ACCOUNT || !isAccountSlug(slug)) throw new Error(badAccountSlug(slug, email));
  const source = claudeHome(DEFAULT_ACCOUNT, env)!;
  const dir = path.join(homeDir(env), `.claude-${slug}`);
  if (dir === source.dir) throw new Error(`~/.claude-${slug} is the default Claude home.`);
  const created = !(await exists(dir));
  // Checked before a new home is made: it would wait on a login this session can't save. Refreshing an
  // existing home's links and label needs no keychain.
  if (created && await (opts.keychainLocked ?? (() => sshKeychainLocked(env)))()) throw new Error(keychainLockedMessage(slug, opts.label));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700); // An existing home keeps its login: tighten it too.
  const linked: string[] = [];
  for (const name of SHARED_ENTRIES) {
    const target = path.join(source.dir, name), link = path.join(dir, name);
    if (!(await exists(target)) || await exists(link)) continue;
    await symlink(target, link);
    linked.push(name);
  }
  await mergeMcpServers(path.join(dir, ".claude.json"), await mcpServersOf(source.configFile));
  if (opts.label) await setAccountLabel(slug, opts.label);
  return { id: slug, dir, linked, created };
}
