/**
 * Agents running in a Herdr workspace.
 *
 * `herdr agent list` prints one JSON envelope describing every agent pane —
 * which agent, what it is doing, which directory, and whether it is focused —
 * and answers in a few milliseconds, so it is cheap enough to poll.
 *
 * Nothing Herdr-specific may leak past this file: the rest of phren only ever
 * sees `AgentRecord`.
 */

import { execFileSync } from "child_process";
import { clampInt, resolveExecCommand } from "../../utils-helpers.js";
import { debugLog } from "../../shared.js";
import { errorMessage } from "../../utils.js";
import type { AgentProvider, AgentRecord, AgentStatus } from "../types.js";

/** Injected so tests never shell out. */
export type CommandExistsFn = (cmd: string) => boolean;
export type RunJsonFn = (argv: string[], timeoutMs: number) => unknown | null;

interface HerdrAgent {
  agent?: unknown;
  agent_status?: unknown;
  cwd?: unknown;
  foreground_cwd?: unknown;
  focused?: unknown;
  pane_id?: unknown;
  terminal_title_stripped?: unknown;
  terminal_title?: unknown;
}

/** Herdr's vocabulary for what an agent is doing, mapped onto phren's. */
function toStatus(raw: unknown): AgentStatus {
  switch (String(raw ?? "").toLowerCase()) {
    case "working":
    case "running":
    case "busy":
      return "working";
    case "done":
    case "complete":
    case "completed":
      return "done";
    case "error":
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

export function runHerdrJson(argv: string[], timeoutMs: number): unknown | null {
  try {
    const exec = resolveExecCommand("herdr");
    const out = execFileSync(exec.command, argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: exec.shell,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    }).trim();
    if (!out) return null;
    return JSON.parse(out);
  } catch (err: unknown) {
    debugLog(`herdr provider: ${errorMessage(err)}`);
    return null;
  }
}

/** Pull the agent array out of Herdr's envelope, tolerating shape drift. */
export function parseHerdrAgents(payload: unknown): AgentRecord[] {
  if (typeof payload !== "object" || payload === null) return [];
  const result = (payload as { result?: unknown }).result;
  const agents = typeof result === "object" && result !== null ? (result as { agents?: unknown }).agents : undefined;
  if (!Array.isArray(agents)) return [];
  const out: AgentRecord[] = [];
  for (const entry of agents) {
    if (typeof entry !== "object" || entry === null) continue;
    const a = entry as HerdrAgent;
    const cwd = typeof a.foreground_cwd === "string" && a.foreground_cwd ? a.foreground_cwd : a.cwd;
    const paneId = a.pane_id;
    if (typeof cwd !== "string" || !cwd || typeof paneId !== "string" || !paneId) continue;
    const title = typeof a.terminal_title_stripped === "string" && a.terminal_title_stripped
      ? a.terminal_title_stripped
      : typeof a.terminal_title === "string" ? a.terminal_title : paneId;
    out.push({
      id: paneId,
      label: title,
      cwd,
      status: toStatus(a.agent_status),
      kind: typeof a.agent === "string" ? a.agent : undefined,
      focused: a.focused === true,
      focus: ["herdr", "agent", "focus", paneId],
      provider: "herdr",
    });
  }
  return out;
}

export function createHerdrProvider(
  commandExists: CommandExistsFn,
  runJson: RunJsonFn = runHerdrJson,
): AgentProvider {
  return {
    name: "herdr",
    available: () => commandExists("herdr"),
    list() {
      const timeoutMs = clampInt(process.env.PHREN_HERDR_TIMEOUT_MS, 3000, 250, 30000);
      return parseHerdrAgents(runJson(["agent", "list"], timeoutMs));
    },
  };
}
