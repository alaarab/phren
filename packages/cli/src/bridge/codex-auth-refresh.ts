import { readFile } from "node:fs/promises";
import path from "node:path";
import { codexHome } from "../home-paths.js";
import { logger } from "../logger.js";
import { AppServerUnsupportedError } from "./codex-app-server.js";
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
export async function lastCodexRefresh(file = path.join(codexHome(), "auth.json")): Promise<number | undefined> {
  try {
    const auth = object(JSON.parse(await readFile(file, "utf8")));
    if (!object(auth.tokens).refresh_token) return undefined;
    const at = Date.parse(String(auth.last_refresh ?? ""));
    return Number.isFinite(at) ? at : 0;
  } catch { return undefined; }
}

/** Codex's own refresh threshold; a sign-in refreshed longer ago than this plus a day has not been kept alive. */
const CODEX_SIGNIN_STALE_MS = 9 * 86_400_000;

/** A doctor line for the ChatGPT sign-in Codex shares on this computer, or undefined when there is none
 * to judge (no Codex, or an API key). A refresh token that has gone unused for over 9 days has expired
 * server-side, and every `codex exec` and Hook-run worker then fails with a 401 until `codex login`. */
export async function codexSignInCheck(file?: string, now = Date.now()): Promise<{ ok: boolean; message: string } | undefined> {
  const at = await lastCodexRefresh(file);
  if (at === undefined) return undefined;
  const days = Math.floor((now - at) / 86_400_000);
  if (at === 0 || now - at > CODEX_SIGNIN_STALE_MS) {
    return { ok: false, message: `Codex sign-in was last refreshed ${at === 0 ? "at an unknown time" : `${days} days ago`} and has probably expired (run: codex login)` };
  }
  return { ok: true, message: `Codex sign-in refreshed ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}` };
}

export function codexAuthRefreshEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(?:0|off|false|no)$/i.test(env.PHREN_CODEX_AUTH_REFRESH ?? "");
}

export interface CodexAuthRefresher {
  /** One proactive refresh through Codex's own flow (`account/read` with
   * `refreshToken`). */
  refreshAuth(): Promise<void>;
}

/** Checks the sign-in's age and refreshes it once when it is due. One check
 * runs at a time; a failed refresh is logged and tried again next tick. */
export class CodexAuthKeeper {
  private running?: Promise<boolean>;
  constructor(private readonly refresher: CodexAuthRefresher, private readonly file?: string, private readonly now = () => Date.now()) {}

  tick(): Promise<boolean> {
    this.running ??= this.check().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async check(): Promise<boolean> {
    const before = await lastCodexRefresh(this.file);
    if (before === undefined || this.now() - before < REFRESH_AFTER_MS) return false;
    try {
      await this.refresher.refreshAuth();
    } catch (error) {
      // An old codex cannot run the server the refresh needs; that is a fact about this
      // computer, not a failure to repeat in the log every hour.
      if (error instanceof AppServerUnsupportedError) { logger.debug("codex-auth", `Sign-in refresh skipped: ${error.message}`); return false; }
      logger.warn("codex-auth", `Could not refresh the Codex sign-in ahead of its workers: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    const after = await lastCodexRefresh(this.file);
    const refreshed = after !== undefined && after > before;
    if (refreshed) logger.info("codex-auth", "Refreshed the Codex sign-in ahead of its workers.");
    else logger.warn("codex-auth", "Codex accepted the refresh request, but auth.json still shows the old sign-in.");
    return refreshed;
  }
}
