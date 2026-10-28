// Account pools and roles: which Claude accounts may do which work. All opt-in; a store that sets none behaves
// exactly as before. See docs/accounts.md.
//
// - An account slot's `pool` is a short tag (`personal`, `client-a`) and its `role` says how it is used
//   automatically: `helpers` (helper runs, `last-resort` only when no `helpers` account fits) or `off` (never
//   chosen automatically; still by hand). An account with no role is an ordinary one, as every account was.
// - A project (its `phren.project.yaml`) and a computer (this Hook's `accounts.yaml`) may list `allowedPools`:
//   the pools whose accounts may do its work. No list means any pool.
//
// Kept in `<bridge>/accounts.yaml` beside the labels (`claude`) and the API credits (`credits`):
//   slots: { <slug>: { pool: <tag>, role: helpers | last-resort | off } }
//   allowedPools: [<tag>, …]
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readProjectConfig, resolveProjectConfigPath, setProjectConfigField } from "../project-config.js";
import { accountsFile, isAccountSlug, parseAccountsYaml, updateAccountsFile } from "./claude-accounts.js";
import { object } from "./protocol.js";

/** A project's name, as dispatch takes it (dispatch.ts `projectName`). */
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export const ACCOUNT_ROLES = ["helpers", "last-resort", "off"] as const;
export type AccountRole = typeof ACCOUNT_ROLES[number];
export interface AccountSettings { pool?: string; role?: AccountRole }

const POOL = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_POOLS = 32;
export const isPoolTag = (value: unknown): value is string => typeof value === "string" && POOL.test(value);
export const isAccountRole = (value: unknown): value is AccountRole => typeof value === "string" && (ACCOUNT_ROLES as readonly string[]).includes(value);
const poolHelp = "A pool is 1 to 32 lowercase letters, digits and dashes, like personal or client-a.";

function readSync(): Record<string, unknown> {
  try { return parseAccountsYaml(readFileSync(accountsFile(), "utf8")); } catch { return {}; }
}
const update = updateAccountsFile;

const settingsOf = (raw: unknown): AccountSettings => {
  const item = object(raw);
  return { ...(isPoolTag(item.pool) ? { pool: item.pool } : {}), ...(isAccountRole(item.role) ? { role: item.role } : {}) };
};

const settingsFrom = (parsed: Record<string, unknown>): Record<string, AccountSettings> =>
  Object.fromEntries(Object.entries(object(parsed.slots)).filter(([slug]) => isAccountSlug(slug))
    .map(([slug, raw]) => [slug, settingsOf(raw)] as const).filter(([, settings]) => Object.keys(settings).length));

/** Every slot's pool and role that is set, by slug. For listings: an unreadable file reads as none set. */
export function accountSettings(): Record<string, AccountSettings> { return settingsFrom(readSync()); }

/**
 * The slots' pools and roles and this computer's allowed pools, for a caller that enforces them: an
 * `accounts.yaml` that is there but can't be read throws rather than reading as "nothing restricted".
 */
export function accountPolicy(): { settings: Record<string, AccountSettings>; allowedPools?: string[] } {
  let text: string | undefined;
  try { text = readFileSync(accountsFile(), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let parsed: Record<string, unknown>;
  try { parsed = parseAccountsYaml(text); } catch (error) { throw new Error(`${accountsFile()} can't be read (${error instanceof Error ? error.message.split("\n")[0] : "bad YAML"}); fix it first.`); }
  const allowedPools = poolsOf(parsed.allowedPools);
  return { settings: settingsFrom(parsed), ...(allowedPools ? { allowedPools } : {}) };
}

/** Sets or clears (`null`) a slot's pool and role; a field left out stays as it is. */
export async function setAccountSettings(slug: string, change: { pool?: string | null; role?: AccountRole | null }): Promise<AccountSettings> {
  if (!isAccountSlug(slug)) throw new Error(`"${slug}" is not an account name: use lowercase letters, digits and dashes.`);
  if (change.pool !== undefined && change.pool !== null && !isPoolTag(change.pool)) throw new Error(poolHelp);
  if (change.role !== undefined && change.role !== null && !isAccountRole(change.role)) throw new Error(`A role is ${ACCOUNT_ROLES.join(", ")}.`);
  let next: AccountSettings = {};
  await update(parsed => {
    const slots = { ...object(parsed.slots) } as Record<string, unknown>;
    next = settingsOf(slots[slug]);
    for (const key of ["pool", "role"] as const) {
      if (change[key] === null) delete next[key];
      else if (change[key] !== undefined) (next as Record<string, string>)[key] = change[key]!;
    }
    if (Object.keys(next).length) slots[slug] = next; else delete slots[slug];
    if (Object.keys(slots).length) parsed.slots = slots; else delete parsed.slots;
  });
  return next;
}

/** A list of pool tags as stored: the valid ones, at most MAX_POOLS, or undefined for no list. */
const poolsOf = (raw: unknown): string[] | undefined => Array.isArray(raw) ? [...new Set(raw.filter(isPoolTag))].slice(0, MAX_POOLS) : undefined;

function checkedPools(pools: readonly string[] | null): string[] | null {
  if (pools === null) return null;
  if (!pools.length) throw new Error("List at least one pool, or clear the list.");
  if (pools.length > MAX_POOLS) throw new Error(`At most ${MAX_POOLS} pools.`);
  for (const pool of pools) if (!isPoolTag(pool)) throw new Error(poolHelp);
  return [...new Set(pools)];
}

/** The pools this computer's accounts may do work for, or undefined: any. */
export function computerAllowedPools(): string[] | undefined { return poolsOf(readSync().allowedPools); }

export async function setComputerAllowedPools(pools: readonly string[] | null): Promise<string[] | undefined> {
  const next = checkedPools(pools);
  await update(parsed => { if (next) parsed.allowedPools = next; else delete parsed.allowedPools; });
  return next ?? undefined;
}

/** The pools whose accounts may do a project's work, from its `phren.project.yaml`, or undefined: any. */
export function projectAllowedPools(phrenPath: string, project: string): string[] | undefined {
  return poolsOf(readProjectConfig(phrenPath, project).allowedPools);
}

export function setProjectAllowedPools(phrenPath: string, project: string, pools: readonly string[] | null): string[] | undefined {
  const next = checkedPools(pools);
  setProjectConfigField(phrenPath, project, "allowedPools", next ?? undefined);
  return next ?? undefined;
}

/** Whether an account in `pool` may work where `allowed` is the list: no list is any pool; a list leaves out an
 * account with no pool. */
export function poolAllowed(allowed: readonly string[] | undefined, pool: string | undefined): boolean {
  return !allowed || pool !== undefined && allowed.includes(pool);
}

/** `phren bridge accounts pool|role|allowed-pools …`: the lines to print. */
export async function accountPoolsCommand(args: readonly string[], projectStore: () => string, exists: (slug: string) => boolean): Promise<string[]> {
  const [command, ...rest] = args;
  const known = (slug: string | undefined) => {
    if (!slug || slug.startsWith("-")) throw new Error(POOLS_USAGE);
    if (!exists(slug)) throw new Error(`There is no Claude account "${slug}" on this computer.`);
    return slug;
  };
  const describe = (slug: string, settings: AccountSettings) => `${slug}: pool ${settings.pool ?? "none"}, role ${settings.role ?? "none"}.`;
  if (command === "pool" && rest.length === 2) {
    const slug = known(rest[0]);
    return [describe(slug, await setAccountSettings(slug, { pool: rest[1] === "--clear" ? null : rest[1] }))];
  }
  if (command === "role" && rest.length === 2) {
    const slug = known(rest[0]);
    if (rest[1] !== "--clear" && !isAccountRole(rest[1])) throw new Error(`A role is ${ACCOUNT_ROLES.join(", ")}, or --clear.`);
    return [describe(slug, await setAccountSettings(slug, { role: rest[1] === "--clear" ? null : rest[1] as AccountRole }))];
  }
  if (command === "allowed-pools") {
    const at = rest.indexOf("--project"), project = at === -1 ? undefined : rest[at + 1];
    if (at !== -1 && (!project || project.startsWith("-"))) throw new Error(POOLS_USAGE);
    const configPath = project && PROJECT.test(project) ? resolveProjectConfigPath(projectStore(), project) : null;
    if (project && (!configPath || !existsSync(path.dirname(configPath)))) throw new Error(`There is no project "${project}" in the store.`);
    const tags = at === -1 ? rest : rest.filter((_, i) => i !== at && i !== at + 1);
    const where = project ? `Project ${project}` : "This computer";
    const show = (pools: string[] | undefined) => `${where}: ${pools ? `allowed pools ${pools.join(", ")}.` : "any pool."}`;
    if (!tags.length) return [show(project ? projectAllowedPools(projectStore(), project) : computerAllowedPools())];
    const pools = tags.length === 1 && tags[0] === "--clear" ? null : tags;
    return [show(project ? setProjectAllowedPools(projectStore(), project, pools) : await setComputerAllowedPools(pools))];
  }
  throw new Error(POOLS_USAGE);
}

export const POOLS_USAGE = "Usage: phren bridge accounts pool <id> <tag>|--clear | role <id> helpers|last-resort|off|--clear | allowed-pools [--project <name>] [<tag>… | --clear]";
