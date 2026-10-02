// Claude Code runs its agent hooks as a fresh process per event. Loading the
// ~2 MB Hook bundle for each one cost a loaded machine past Claude's timeout
// ("UserPromptSubmit hook timed out", output discarded), losing delivery
// confirmation, dispatch returns and turn records. Install writes this small
// script into each version's folder next to its bundle, so `current/` always
// pairs the script with the daemon it talks to: in a Herdr pane it sends the same /hook
// body agentHook (agent-hooks.ts) builds over agent.sock and prints the same
// reply; anything it cannot place itself (a tmux pane, another agent) runs the
// bundle's full handler in the same process.
//
// It must stay dependency-free and in step with agentHook. The daemon gates
// the git module itself and the hook module's settings entries are removed
// when it is off, so the store's module config is not read here.
import path from "node:path";

/** The script's file name in a version's folder, beside `bridge-hook.mjs`. */
export const FAST_HOOK_FILE = "claude-hook.mjs";
export const fastHookPath = (versionDir: string) => path.join(versionDir, FAST_HOOK_FILE);

/**
 * How long a PreToolUse or PostToolUse callback may run, from its process's
 * start. Install registers them for every tool call (Codex takes no matcher),
 * and Codex kills a hook at 10 s: on the Mini under a load average near 130
 * (2026-10-01) the old 8 s socket wait, after a slow start, ran past it and
 * Codex showed "Hook failed: hook timed out after 10s" on every call. These
 * callbacks only snapshot changed files for the phone and nothing waits on
 * them, so once the budget is spent they give up and the tool runs.
 */
export const TOOL_HOOK_BUDGET_MS = 5_000;

/** Keep permission replies and turn context, without turning tool callbacks into approvals. */
export function hookOutput(event: string, result: string): string {
  if (event === "PermissionRequest") return result;
  if (event !== "SessionStart" && event !== "UserPromptSubmit") return "";
  try {
    const reply = JSON.parse(result);
    if (event === "UserPromptSubmit" && reply?.decision === "block") return result;
    const output = reply?.hookSpecificOutput;
    if (output?.hookEventName === event && typeof output.additionalContext === "string" && output.additionalContext.trim()) {
      return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: output.additionalContext } });
    }
  } catch { /* A malformed reply adds no context. */ }
  return "";
}

/** The forwarder's source, with the ToolUse budget written in. */
export const fastHookSource = (toolBudgetMs = TOOL_HOOK_BUDGET_MS) => `// Installed by Phren Hook: Claude Code's hook events, forwarded to the running Hook.
import { request } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const env = process.env, source = process.argv[2];
const hookOutput = ${hookOutput.toString()};
async function full() {
  const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), "bridge-hook.mjs");
  process.argv = [process.argv[0], bundle, "hook", source];
  await import(pathToFileURL(bundle).href);
}
function herdrPane() {
  if (!env.HERDR_SOCKET_PATH) return undefined;
  const socket = path.resolve(env.HERDR_SOCKET_PATH), root = path.resolve(env.PHREN_HERDR_HOME || path.join(homedir(), ".config/herdr"));
  const server = socket === path.join(root, "herdr.sock") ? "default"
    : socket.startsWith(path.join(root, "sessions") + path.sep) ? path.basename(path.dirname(socket)) : undefined;
  const { HERDR_WORKSPACE_ID: workspace, HERDR_TAB_ID: tab, HERDR_PANE_ID: pane } = env;
  return server && workspace && tab && pane ? { server, workspace, tab, pane } : undefined;
}
const plain = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
async function forward(place) {
  let input = "";
  for await (const chunk of process.stdin) { input += chunk.toString(); if (input.length > 1_048_576) return; }
  const value = plain(JSON.parse(input));
  if (value.agent_id || value.agentId || value.isSidechain || value.is_sidechain) return;
  const target = { ...place, source, session: value.session_id || value.sessionId };
  const event = String(value.hook_event_name || "SessionStart");
  const dispatchId = (event === "SessionStart" || event === "UserPromptSubmit") && /^[A-Za-z0-9_-]{8,64}$/.test(env.PHREN_DISPATCH_ID ?? "") ? env.PHREN_DISPATCH_ID : undefined;
  const tasks = Array.isArray(value.background_tasks)
    ? value.background_tasks.filter(task => !["completed", "failed", "killed", "stopped"].includes(String(plain(task).status))) : undefined;
  const stop = event !== "Stop" ? {} : { ...(tasks ? { background: tasks.length } : {}),
    ...(typeof value.last_assistant_message === "string" && value.last_assistant_message.trim() ? { reply: value.last_assistant_message.slice(0, 16_384) } : {}) };
  const data = JSON.stringify({ target, event, ...(dispatchId ? { dispatchId } : {}),
    tool: value.tool_name, input: value.tool_input, toolUseId: value.tool_use_id, cwd: value.cwd,
    ...(event === "UserPromptSubmit" && typeof value.prompt === "string" ? { prompt: value.prompt.slice(0, 65_536) } : {}), ...stop });
  const socketPath = path.join(env.PHREN_BRIDGE_HOME || path.join(homedir(), ".local/share/phren/bridge"), "agent.sock");
  // A tool call's callback fits its budget from process start, or is skipped.
  const left = Math.floor(${toolBudgetMs} - performance.now());
  if (event.endsWith("ToolUse") && left <= 0) return;
  await new Promise(resolve => {
    const req = request({ socketPath, path: "/hook", method: "POST", timeout: event === "PermissionRequest" ? 58_000 : event.endsWith("ToolUse") ? left : 12_000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, res => {
      let result = "";
      res.on("data", chunk => { result += chunk.toString(); if (result.length > 16_384) req.destroy(); });
      res.on("end", () => { if (res.statusCode === 200) process.stdout.write(hookOutput(event, result)); resolve(); });
      res.on("error", () => resolve());
    });
    req.on("error", () => resolve()); req.on("timeout", () => { req.destroy(); resolve(); }); req.end(data);
  });
}
// Outside Herdr a tmux pane is placed by asking tmux, which the bundle does.
if (source !== "claude" || (env.HERDR_ENV !== "1" && env.TMUX)) await full().catch(() => {});
else if (env.HERDR_ENV === "1") { const place = herdrPane(); if (place) await forward(place).catch(() => {}); }
`;
export const FAST_HOOK_SOURCE = fastHookSource();
