// What this computer can launch: each harness's install state and, for Claude and Codex, its accounts.
// Served as GET /v1/harnesses and as `harnesses` on /v1/dispatch/capacity. See docs/accounts.md.
import { existsSync } from "node:fs";
import path from "node:path";
import { codexHome } from "../home-paths.js";
import { claudeAccountRef, claudeAuthStatus, claudeHomes, CODEX_ACCOUNT } from "./claude-accounts.js";
import { toolVersion } from "./health.js";
const SOURCES = ["claude", "codex", "opencode", "copilot"];
export async function harnessInventory(deps = {}) {
    const env = deps.env ?? process.env;
    const probe = deps.toolVersion ?? ((tool) => toolVersion(tool));
    const harnesses = await Promise.all(SOURCES.map(async (source) => {
        const found = await probe(source);
        // Only a missing binary is definite; a slow or failing --version (a loaded computer) stays usable.
        if (found.status === "missing")
            return { source, installed: false, usable: false, reason: "Not installed" };
        const base = { source, installed: true, ...(found.version ? { version: found.version } : {}) };
        if (source === "claude") {
            const accounts = await Promise.all(claudeHomes(env).map(async (home) => {
                const auth = await claudeAuthStatus(home, deps.authRunner);
                // An unanswered sign-in check stays usable: only Claude saying "logged out" hides an account.
                const usable = auth.signedIn || auth.unknown === true;
                return { ...claudeAccountRef(home), signedIn: auth.signedIn, usable,
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
export function harnessInventoryWithin(ms, deps = {}) {
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => resolve(undefined), ms); });
    return Promise.race([harnessInventory(deps).catch(() => undefined), late]).finally(() => clearTimeout(timer));
}
/** `PHREN_LAUNCH_CHECK=off`: no early launch refusal and no `harnesses` advertised to dispatch (tests, or a misreporting computer). */
export function launchCheckOff(env = process.env) {
    return /^(off|0|false|no)$/i.test(env.PHREN_LAUNCH_CHECK?.trim() ?? "");
}
/** Whether a launch of `source` (and `accountId`) should work on a computer with this inventory. */
export function hasUsable(inventory, source, accountId) {
    const entry = inventory.harnesses.find(item => item.source === source);
    if (!entry || !entry.installed)
        return { ok: false, code: "harness_unavailable", reason: entry?.reason ?? "Not installed" };
    if (!entry.accounts) {
        return accountId && accountId !== "default"
            ? { ok: false, code: "account_unavailable", reason: `${source} has no accounts` }
            : entry.usable ? { ok: true } : { ok: false, code: "harness_unavailable", reason: entry.reason ?? "Unavailable" };
    }
    const id = accountId?.trim() || "default";
    const account = entry.accounts.find(item => item.id === id);
    if (!account)
        return { ok: false, code: "account_unavailable", reason: `No ${source} account "${id}"` };
    if (!account.usable)
        return { ok: false, code: "account_unavailable", reason: account.reason ?? "Not signed in" };
    return { ok: true };
}
