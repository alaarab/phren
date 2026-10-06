import { readFile } from "node:fs/promises";
import path from "node:path";
import { codexHome } from "../home-paths.js";
import { logger } from "../logger.js";
import { object } from "./protocol.js";
/**
 * Every Codex process on a computer shares one ChatGPT sign-in in
 * `$CODEX_HOME/auth.json`, and each refreshes it when `last_refresh` grows
 * old (Codex's own threshold is 8 days). The refresh token rotates on every
 * use, so processes that reach the threshold together (a batch of workers,
 * one app-server per pane) race: one wins, the rest spend a token that is
 * already used and fail ("refresh token was already used"). Codex re-reads
 * the file before refreshing and skips when another process already did.
 * So the Hook refreshes first, once, before any process reaches the
 * threshold, and the others take that skip path.
 */
/** Refresh when the sign-in is this old: well before Codex's 8 days. */
export const REFRESH_AFTER_MS = 6 * 86_400_000;
/** The sign-in's last refresh, or undefined when auth.json holds no ChatGPT
 * sign-in (an API key, no file) and there is nothing to refresh. */
export async function lastCodexRefresh(file = path.join(codexHome(), "auth.json")) {
    try {
        const auth = object(JSON.parse(await readFile(file, "utf8")));
        if (!object(auth.tokens).refresh_token)
            return undefined;
        const at = Date.parse(String(auth.last_refresh ?? ""));
        return Number.isFinite(at) ? at : 0;
    }
    catch {
        return undefined;
    }
}
export function codexAuthRefreshEnabled(env = process.env) {
    return !/^(?:0|off|false|no)$/i.test(env.PHREN_CODEX_AUTH_REFRESH ?? "");
}
/** Checks the sign-in's age and refreshes it once when it is due. One check
 * runs at a time; a failed refresh is logged and tried again next tick. */
export class CodexAuthKeeper {
    refresher;
    file;
    now;
    running;
    constructor(refresher, file, now = () => Date.now()) {
        this.refresher = refresher;
        this.file = file;
        this.now = now;
    }
    tick() {
        this.running ??= this.check().finally(() => { this.running = undefined; });
        return this.running;
    }
    async check() {
        const before = await lastCodexRefresh(this.file);
        if (before === undefined || this.now() - before < REFRESH_AFTER_MS)
            return false;
        try {
            await this.refresher.refreshAuth();
        }
        catch (error) {
            logger.warn("codex-auth", `Could not refresh the Codex sign-in ahead of its workers: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
        const after = await lastCodexRefresh(this.file);
        const refreshed = after !== undefined && after > before;
        if (refreshed)
            logger.info("codex-auth", "Refreshed the Codex sign-in ahead of its workers.");
        else
            logger.warn("codex-auth", "Codex accepted the refresh request, but auth.json still shows the old sign-in.");
        return refreshed;
    }
}
