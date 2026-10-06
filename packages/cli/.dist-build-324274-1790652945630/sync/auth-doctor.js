import { findStoreByName, removeStoreFromRegistry } from "../store-registry.js";
import { activeStoreAuthFailure, AUTH_UNREGISTER_AFTER_MS, storeAuthDetail } from "./auth.js";
/** Only the interactive CLI supplies confirmation; hooks and MCP never remove stores. */
export async function storeCredentialCheck(phrenPath, store, fix, confirm, now = Date.now()) {
    if (store.available === false || store.role === "primary")
        return;
    const auth = activeStoreAuthFailure(store.path);
    if (!auth)
        return;
    const check = { name: `store:${store.name}`, ok: false, detail: storeAuthDetail(auth) };
    if (now - auth.firstFailedAt <= AUTH_UNREGISTER_AFTER_MS)
        return check;
    check.detail += "; auth has failed for more than a week; phren doctor --fix can offer to unregister this store";
    if (!fix || !confirm)
        return check;
    const projects = store.projects?.length ? ` Its project claims (${store.projects.join(", ")}) will be removed.` : "";
    if (!await confirm(`Unregister store '${store.name}' (${auth.remote}) after more than a week of failed authentication? Local files will be kept.${projects}`))
        return check;
    // Recheck after the user answers: sync or registry configuration may have changed.
    const current = findStoreByName(phrenPath, store.name);
    const failure = activeStoreAuthFailure(store.path);
    if (!current || current.id !== store.id || current.path !== store.path || current.role === "primary"
        || failure?.remote !== auth.remote || failure.firstFailedAt !== auth.firstFailedAt)
        return check;
    removeStoreFromRegistry(phrenPath, store.name);
    return { name: check.name, ok: true, detail: `unregistered '${store.name}'; local files kept` };
}
