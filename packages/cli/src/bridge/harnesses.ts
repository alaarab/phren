// What this computer can launch: each harness's install state and, for Claude and Codex, its accounts.
// Served as GET /v1/harnesses and as `harnesses` on /v1/dispatch/capacity. See docs/accounts.md.
import { existsSync } from "node:fs";
import path from "node:path";
import { codexHome } from "../home-paths.js";
import { claudeAccountRef, claudeAuthStatus, claudeHomes, CODEX_ACCOUNT, type AccountRef, type AuthRunner } from "./claude-accounts.js";
import { toolVersion, type ToolVersion } from "./health.js";

export type HarnessSource = "claude" | "codex" | "opencode" | "copilot";
export interface HarnessAccount extends AccountRef { signedIn: boolean; usable: boolean; plan?: string; reason?: string }
export interface HarnessEntry {
  source: HarnessSource; installed: boolean; version?: string; usable: boolean; reason?: string; accounts?: HarnessAccount[];
}
export interface HarnessInventory { harnesses: HarnessEntry[] }
export interface HarnessDeps {
  toolVersion?: (tool: string) => Promise<ToolVersion>;
  authRunner?: AuthRunner;
  env?: NodeJS.ProcessEnv;
}

const SOURCES: HarnessSource[] = ["claude", "codex", "opencode", "copilot"];

export async function harnessInventory(deps: HarnessDeps = {}): Promise<HarnessInventory> {
  const env = deps.env ?? process.env;
  const probe = deps.toolVersion ?? ((tool: string) => toolVersion(tool));
  const harnesses = await Promise.all(SOURCES.map(async (source): Promise<HarnessEntry> => {
    const found = await probe(source);
    if (found.status !== "ok") return { source, installed: false, usable: false, reason: found.status === "missing" ? "Not installed" : found.detail || "Could not run" };
    const base = { source, installed: true, version: found.version };
    if (source === "claude") {
      const accounts = await Promise.all(claudeHomes(env).map(async (home): Promise<HarnessAccount> => {
        const auth = await claudeAuthStatus(home, deps.authRunner);
        return { ...claudeAccountRef(home), signedIn: auth.signedIn, usable: auth.signedIn,
          ...(auth.plan ? { plan: auth.plan } : {}), ...(auth.signedIn ? {} : { reason: auth.reason ?? "Not signed in" }) };
      }));
      const usable = accounts.some(account => account.usable);
      return { ...base, usable, ...(usable ? {} : { reason: "No signed-in Claude account" }), accounts };
    }
    if (source === "codex") {
      const signedIn = existsSync(path.join(codexHome(env), "auth.json"));
      return { ...base, usable: signedIn, ...(signedIn ? {} : { reason: "Not signed in" }),
        accounts: [{ ...CODEX_ACCOUNT, signedIn, usable: signedIn, ...(signedIn ? {} : { reason: "Not signed in" }) }] };
    }
    return { ...base, usable: true };
  }));
  return { harnesses };
}

/** The inventory, or undefined when it is not ready within `ms` (a cold `claude auth status` can take seconds). */
export function harnessInventoryWithin(ms: number, deps: HarnessDeps = {}): Promise<HarnessInventory | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); });
  return Promise.race([harnessInventory(deps).catch(() => undefined), late]).finally(() => clearTimeout(timer));
}

export type Availability = { ok: true } | { ok: false; code: "harness_unavailable" | "account_unavailable"; reason: string };

/** Whether a launch of `source` (and `accountId`) should work on a computer with this inventory. */
export function hasUsable(inventory: HarnessInventory, source: string, accountId?: string): Availability {
  const entry = inventory.harnesses.find(item => item.source === source);
  if (!entry || !entry.installed) return { ok: false, code: "harness_unavailable", reason: entry?.reason ?? "Not installed" };
  if (!entry.accounts) {
    return accountId && accountId !== "default"
      ? { ok: false, code: "account_unavailable", reason: `${source} has no accounts` }
      : entry.usable ? { ok: true } : { ok: false, code: "harness_unavailable", reason: entry.reason ?? "Unavailable" };
  }
  const id = accountId?.trim() || "default";
  const account = entry.accounts.find(item => item.id === id);
  if (!account) return { ok: false, code: "account_unavailable", reason: `No ${source} account "${id}"` };
  if (!account.usable) return { ok: false, code: "account_unavailable", reason: account.reason ?? "Not signed in" };
  return { ok: true };
}
