import type { AgentHooks } from "./agent-hooks.js";
import { paneTurn } from "./dispatch-returns.js";
import { findPane, paneIdentity, snapshot } from "./herdr.js";
import { screenDialog } from "./pane-status.js";
import { type Target } from "./protocol.js";
import { readFinalTurn } from "./schedule-watch.js";
import { ownRecord, liveWork, takesPrompt } from "./session-activity.js";
import { promptGuards } from "./server-pane-routes.js";
import { childAgentTree, runningChildAgents } from "./transcripts.js";
import type { TurnQueuePane } from "./turn-queue.js";

/** Read the same guarded hook/plugin turn records used by dispatch returns.
 * OpenCode's plugin supplies timestamped turns rather than lifecycle hooks. */
export function turnQueuePaneReader(agentHooks: Pick<AgentHooks, "approval" | "terminalPrompt" | "servedQuestion">) {
  return async (target: Target): Promise<TurnQueuePane | undefined> => {
    const pane = findPane(await snapshot(target.server), { ...target, source: undefined });
    if (!pane) return undefined;
    const session = await paneIdentity(target.server, pane, true);
    if (pane.agent !== target.source || session !== target.session) return { terminal: String(pane.terminal_id), source: String(pane.agent), session, background: 0, held: true, ready: false };
    const record = ownRecord(await paneTurn(target.server, pane, target.source), pane, target.source, session);
    const guards = promptGuards(agentHooks, target);
    const [final, children, screen] = await Promise.all([
      session && target.source !== "phren" ? readFinalTurn(target.source, session) : undefined,
      session ? childAgentTree(target.source, session) : [],
      guards.screen!(),
    ]);
    return { terminal: String(pane.terminal_id), source: String(pane.agent), session, record,
      background: liveWork(record, final, runningChildAgents(children).length) ?? 0,
      held: guards.held!() || screenDialog(target.source, screen),
      ready: await takesPrompt(target.server, pane, session, guards) };
  };
}
