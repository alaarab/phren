/**
 * Lifecycle reports to Phren Hook when phren-agent runs inside a Herdr pane,
 * or a tmux pane on a computer without Herdr.
 *
 * Codex, Claude Code and Copilot deliver these through their own hook
 * settings (`phren bridge install` edits them); phren-agent has no settings
 * file, so it calls the installed hook bundle itself with the same JSON on
 * stdin. That is what binds this session's event log to the pane the iPhone
 * is looking at. Strictly best effort: no Herdr, no bundle, or a slow bundle
 * is bounded and must never fail a turn.
 */
import { spawn } from "node:child_process";
import { request } from "node:http";
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

// Serialize lifecycle callbacks: a prompt must not overtake SessionStart,
// and a context read must wait until the Hook has bound the current log.
let pendingLifecycle: Promise<void> = Promise.resolve();
function defaultRunner(command: string, args: string[], stdin: string): void {
  pendingLifecycle = pendingLifecycle.then(() => new Promise<void>((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], env: process.env });
    const timer = setTimeout(() => { child.kill(); resolve(); }, HOOK_TIMEOUT_MS);
    timer.unref();
    const done = () => { clearTimeout(timer); resolve(); };
    child.on("error", done);
    child.on("exit", done);
    child.unref();
    child.stdin.on("error", () => { /* the bundle may exit before reading */ });
    child.stdin.end(stdin);
  })).catch(() => { /* lifecycle is best effort */ });
}

/** Only the root session asks; the Hook independently proves PID, terminal
 * and session identity. No inherited environment variable confers a role. */
export async function readConductorContext(sessionId: string): Promise<string | undefined> {
  if (sessionId !== currentSession || !herdrHookBundle()) return undefined;
  await pendingLifecycle;
  const root = process.env.PHREN_BRIDGE_HOME || path.join(os.homedir(), ".local/share/phren/bridge");
  return new Promise(resolve => {
    const req = request({ socketPath: path.join(root, "agent.sock"), path: "/conductor-context", method: "POST" }, res => {
      let text = "";
      res.on("data", chunk => {
        text += chunk;
        if (text.length > 131_072) req.destroy();
      });
      res.on("error", () => finish());
      res.on("end", () => {
        if (res.statusCode !== 200) { finish(); return; }
        try {
          const body = JSON.parse(text);
          finish(typeof body.context === "string" ? body.context : undefined);
        } catch { finish(); }
      });
    });
    const timer = setTimeout(() => { req.destroy(); finish(); }, HOOK_TIMEOUT_MS);
    function finish(context?: string) { clearTimeout(timer); resolve(context); }
    req.on("error", () => finish());
    req.end(JSON.stringify({ pid: process.pid, session: sessionId }));
  });
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

/** Ask the existing Hook approval/grant path before falling back to the
 * terminal. Only a definite allow/deny is an answer; failure is not consent. */
export async function askHerdrPermission(tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<boolean | undefined> {
  const bundle = herdrHookBundle();
  if (!bundle || !currentSession || signal?.aborted) return undefined;
  await pendingLifecycle;
  return new Promise(resolve => {
    const child = spawn(process.execPath, [bundle, "hook", "phren"], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    const finish = (answer?: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      resolve(answer);
    };
    const cancel = () => { child.kill(); finish(); };
    const timer = setTimeout(cancel, 60_000);
    signal?.addEventListener("abort", cancel, { once: true });
    child.on("error", () => finish());
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 16_384) cancel(); });
    child.on("close", () => {
      try {
        const decision = JSON.parse(output).hookSpecificOutput?.decision?.behavior;
        finish(decision === "allow" ? true : decision === "deny" ? false : undefined);
      } catch { finish(); }
    });
    child.stdin.on("error", () => { /* a missing Hook falls back to the terminal */ });
    child.stdin.end(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: currentSession,
      cwd: process.cwd(), tool_name: tool, tool_input: input }));
    if (signal?.aborted) cancel();
  });
}
