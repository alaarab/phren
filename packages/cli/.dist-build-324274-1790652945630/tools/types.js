import { parseStoreQualified } from "../store-routing.js";
import { describeUnavailableStore, resolveAllStores } from "../store-registry.js";
import { logger } from "../logger.js";
/**
 * Error raised when a project is claimed by a store that is attached on this
 * machine but whose directory is missing. Distinct class so callers
 * can special-case it if they ever want to offer an interactive fix.
 */
export class StoreUnavailableError extends Error {
    storeName;
    storePath;
    constructor(store, project) {
        super(`Refusing to write "${project}": it belongs to a store that is not available here. ` +
            `${describeUnavailableStore(store)} ` +
            `Writing it to the primary store instead would copy ${store.role}-store data into your personal store, ` +
            `so phren stopped instead. Re-run once the store is attached, or use "phren team unsubscribe ${store.name} ${project}" ` +
            `if this project should no longer live there.`);
        this.name = "StoreUnavailableError";
        this.storeName = store.name;
        this.storePath = store.path;
    }
}
/**
 * Resolve the effective phrenPath and bare project name for a project input.
 * Handles store-qualified names ("store/project") by routing to the correct store.
 * Returns the primary store path for bare names that no store claims.
 *
 * Note on the bare-name path: a store that claims the project but is missing
 * locally used to fall through to the primary store, which quietly relocated
 * team-store projects into the user's personal store. That fallback is gone for
 * writes — see {@link StoreAccessMode}.
 */
export function resolveStoreForProject(ctx, projectInput, mode = "write") {
    const { storeName, projectName } = parseStoreQualified(projectInput);
    const stores = resolveAllStores(ctx.phrenPath);
    if (!storeName) {
        // Check if any non-readonly store claims this project via projects[] array.
        // This enables automatic write routing: once a project is claimed by a team
        // store (via `phren team add-project`), writes go there without needing the
        // store-qualified prefix.
        const claiming = stores.find((s) => s.role !== "readonly" && s.role !== "primary" && s.projects?.includes(projectName));
        if (claiming) {
            if (claiming.available !== false) {
                return { phrenPath: claiming.path, project: projectName, storeRole: claiming.role };
            }
            if (mode === "write")
                throw new StoreUnavailableError(claiming, projectName);
            logger.debug("store-routing", `read for "${projectName}" fell back to primary: ${describeUnavailableStore(claiming)}`);
        }
        return { phrenPath: ctx.phrenPath, project: projectName, storeRole: "primary" };
    }
    const store = stores.find((s) => s.name === storeName);
    if (!store) {
        throw new Error(`Store "${storeName}" not found`);
    }
    if (store.role === "readonly") {
        throw new Error(`Store "${storeName}" is read-only`);
    }
    // An explicitly named store has no defensible fallback — the caller asked for
    // that store by name, so say it isn't here rather than answering from another.
    if (store.available === false) {
        throw new StoreUnavailableError(store, projectName);
    }
    return { phrenPath: store.path, project: projectName, storeRole: store.role };
}
/**
 * Convert an McpToolResult into the MCP SDK response format.
 * Single shared implementation — replaces the per-file jsonResponse() duplicates.
 */
export function mcpResponse(payload) {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}
