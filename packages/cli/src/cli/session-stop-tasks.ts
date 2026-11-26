/** The Stop hook's task check (issue #934): when an agent's turn ends, block
 * it once with the tasks the session took on and left Active, so it settles
 * them instead of walking away. Claude and Codex understand a Stop hook that
 * blocks; other harnesses cannot, so they are left alone. */
import { currentSessionId, resolutionPrompt, sessionTaskStates, unresolvedTasks, type SessionTaskState } from "../task/session-tasks.js";

export interface TaskStopDecision {
  decision: "block";
  reason: string;
  open: SessionTaskState[];
}

const STOP_TOOLS = new Set(["claude", "codex"]);
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function stopSession(
  payload: { session_id?: unknown; stop_hook_active?: unknown } | null | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const raw = payload?.session_id;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (SESSION_ID.test(trimmed)) return trimmed;
  }
  return currentSessionId(env);
}

/** The block a Stop hook should return, or undefined when there is nothing to
 * settle or the harness cannot be blocked. Never throws. */
export function taskStopDecision(input: {
  phrenPath: string;
  payload: { session_id?: unknown; stop_hook_active?: unknown } | null | undefined;
  tool: string;
  env?: NodeJS.ProcessEnv;
}): TaskStopDecision | undefined {
  try {
    const env = input.env ?? process.env;
    if (env.PHREN_TASK_STOP_CHECK === "off") return undefined;
    if (!STOP_TOOLS.has(input.tool)) return undefined;
    if (input.payload?.stop_hook_active === true) return undefined;
    const session = stopSession(input.payload, env);
    if (!session) return undefined;
    const open = unresolvedTasks(sessionTaskStates(input.phrenPath, session));
    if (!open.length) return undefined;
    return { decision: "block", reason: resolutionPrompt(open), open };
  } catch {
    return undefined;
  }
}

/** Write the Stop-hook decision as the one JSON object Claude Code expects on stdout. */
export function writeTaskStopDecision(
  decision: Pick<TaskStopDecision, "decision" | "reason">,
  out: { write(chunk: string): unknown } = process.stdout,
): void {
  out.write(JSON.stringify({ decision: decision.decision, reason: decision.reason }));
}
