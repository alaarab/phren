/**
 * Lifecycle reports to Phren Hook when phren-agent runs inside a Herdr pane,
 * or a tmux pane on a computer without Herdr.
 *
 * Codex, Claude Code and Copilot deliver these through their own hook
 * settings (`phren bridge install` edits them); phren-agent has no settings
 * file, so it calls the installed hook bundle itself with the same JSON on
 * stdin. That is what binds this session's event log to the pane the iPhone
 * is looking at. Strictly best effort: no Herdr, no bundle, or a slow bundle
 * must never slow down or fail a turn.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type HerdrHookEvent = "SessionStart" | "UserPromptSubmit" | "Stop";

export interface HerdrHookRunner {
  (command: string, args: string[], stdin: string): void;
}

const HOOK_TIMEOUT_MS = 3000;

/** The bundle to call, or null when this process is in neither a Herdr nor a
 * tmux pane, or nothing is installed. The Hook finds the pane from the same
 * variables; inside Herdr only Herdr's pane counts. */
export function herdrHookBundle(env: NodeJS.ProcessEnv = process.env): string | null {
  const herdr = env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID;
  const tmux = env.HERDR_ENV !== "1" && !!env.TMUX && !!env.TMUX_PANE;
  if (!herdr && !tmux) return null;
  const root = env.PHREN_BRIDGE_HOME || path.join(os.homedir(), ".local/share/phren/bridge");
  const bundle = path.join(root, "current/bridge-hook.mjs");
  try {
    return fs.statSync(bundle).isFile() ? bundle : null;
  } catch {
    return null;
  }
}

function defaultRunner(command: string, args: string[], stdin: string): void {
  const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], env: process.env });
  const timer = setTimeout(() => child.kill(), HOOK_TIMEOUT_MS);
  timer.unref();
  child.on("error", () => clearTimeout(timer));
  child.on("exit", () => clearTimeout(timer));
  child.unref();
  child.stdin.on("error", () => { /* the bundle may exit before reading */ });
  child.stdin.end(stdin);
}

let currentSession: string | null = null;

/** The session whose event log later reports name. Set once at startup. */
export function setHerdrHookSession(sessionId: string | null): void {
  currentSession = sessionId;
}

/**
 * Fire-and-forget one lifecycle event for the current session. Returns the
 * payload that was sent, or null when nothing was (no session, not under
 * Herdr, no bundle) — so callers and tests can see what happened without
 * awaiting anything.
 */
export function emitHerdrHook(
  event: HerdrHookEvent,
  options: { sessionId?: string | null; env?: NodeJS.ProcessEnv; runner?: HerdrHookRunner; cwd?: string } = {},
): Record<string, unknown> | null {
  const sessionId = options.sessionId ?? currentSession;
  if (!sessionId) return null;
  const env = options.env ?? process.env;
  const bundle = herdrHookBundle(env);
  if (!bundle) return null;
  const payload = { hook_event_name: event, session_id: sessionId, cwd: options.cwd ?? process.cwd() };
  try {
    (options.runner ?? defaultRunner)(process.execPath, [bundle, "hook", "phren"], JSON.stringify(payload));
  } catch {
    return null;
  }
  return payload;
}
