import type { AgentHooks } from "./agent-hooks.js";
import { dispatchStatus, type Receipt } from "./dispatch.js";
import { isLocalComputer } from "./dispatch-hosts.js";
import { workerReaders, workerStates } from "./dispatch-returns.js";
import { paneChatState, recentServers, snapshot } from "./herdr.js";
import { inboxTargetSchema, type InboxSnapshot, type InboxSource } from "./owner-inbox.js";
import { hookPeers, peerRequest } from "./peers.js";
import { ownerQuestion } from "./schedule-watch.js";
import { objects, object, type Json } from "./protocol.js";

const clean = (text: unknown) => String(text).replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 500);

/** Read the actual panes and pending asks, never a stored inbox's live flag.
 * Called on reads and on the Hook's five-second activity tick. */
export async function ownerInboxSources(hooks: AgentHooks): Promise<InboxSnapshot> {
  const sources: InboxSource[] = [], unavailableDispatches: string[] = [];
  for (const server of await recentServers()) {
    const name = String(server.session), state = await snapshot(name);
    for (const pane of objects(state.panes)) {
      const chat = await paneChatState(name, pane, { tokenWhenIdentified: false });
      const parsed = inboxTargetSchema.safeParse({ server: name, workspace: pane.workspace_id, tab: pane.tab_id, pane: pane.pane_id, source: pane.agent,
        ...(chat.sessionId ? { session: chat.sessionId } : { starting: true, startingToken: chat.startingToken }) });
      if (!parsed.success) continue;
      const target = parsed.data, waiting = ["blocked", "waiting"].includes(String(pane.agent_status));
      if ("session" in target) {
        // Refresh terminal-derived questions even with no phone chat open.
        await hooks.syncTerminalDialog(target, waiting);
        if (!waiting) hooks.clearTerminalPrompt(target);
      }
      const approval = "session" in target ? hooks.workerApproval(target) : undefined;
      const question = "session" in target ? hooks.servedQuestion(target) : undefined;
      const terminal = waiting && "session" in target ? hooks.terminalPrompt(target) : undefined;
      const request = approval?.request ?? question?.message ?? terminal?.request ?? terminal?.message
        ?? (waiting ? `${pane.agent} needs terminal input.` : undefined);
      if (!request) continue;
      const actionId = approval?.actionId ?? (typeof question?.actionId === "string" ? question.actionId : undefined);
      sources.push({ source: `prompt:${JSON.stringify(target)}:${actionId ?? "waiting"}`, kind: "blocked", title: clean(request), target,
        ...(actionId ? { actionId } : {}) });
    }
  }

  // A saved return/approval is only a candidate: re-observe its worker. In
  // particular a closed pane must not stay live because its last return waits.
  const candidates = (await dispatchStatus()).filter(receipt => !receipt.closedAt && receipt.target
    && receipt.returned && ["needs-you", "blocked"].includes(receipt.returned.state));
  const groups = new Map<string, Receipt[]>();
  for (const receipt of candidates) {
    const computer = isLocalComputer(receipt.computer) ? "local" : receipt.computer;
    groups.set(computer, [...(groups.get(computer) ?? []), receipt]);
  }
  const peers = groups.size && [...groups.keys()].some(name => name !== "local") ? await hookPeers() : [];
  for (const [computer, receipts] of groups) {
    for (let offset = 0; offset < receipts.length; offset += 64) {
      const batch = receipts.slice(offset, offset + 64);
      const input = { targets: batch.map(receipt => ({ ...receipt.target!, dispatch: receipt.id })) };
      let workers: Json[];
      try {
        const peer = peers.find(peer => peer.name === computer);
        const result = computer === "local"
          ? await workerStates(input, { ...workerReaders(target => hooks.workerApproval(target) as Json | undefined), snapshot })
          : peer ? await peerRequest(peer, "/v1/dispatch/workers", input) : undefined;
        workers = objects(result?.workers);
      } catch { workers = []; }
      for (const [index, receipt] of batch.entries()) {
        const seen = workers[index];
        if (!seen || ["unavailable", "unknown"].includes(String(seen.state))) { unavailableDispatches.push(receipt.id); continue; }
        if (["gone", "closed"].includes(String(seen.state))) continue;
        const approval = object(seen.approval);
        const actionId = typeof approval.actionId === "string" ? approval.actionId : undefined;
        const question = ["idle", "done"].includes(String(seen.state)) && seen.completed && !seen.error && !seen.interrupted
          ? (typeof seen.reply === "string" ? ownerQuestion(seen.reply) : undefined) ?? seen.unfinished : undefined;
        if (!actionId && seen.state !== "blocked" && !question) continue;
        const source: InboxSource = { source: `dispatch:${receipt.id}:${actionId ?? "waiting"}`, kind: actionId || seen.state === "blocked" ? "blocked" : "needs-you",
          title: clean(approval.request ?? question ?? `${receipt.label} needs input`),
          project: receipt.project, ...(computer !== "local" ? { computer } : {}), target: receipt.target as InboxSource["target"], dispatch: receipt.id,
          ...(actionId ? { actionId } : {}) };
        // The local prompt and dispatch return describe the same wait. Keep
        // the dispatch's project/receipt metadata as well as its live target.
        const local = sources.findIndex(row => JSON.stringify(row.target) === JSON.stringify(source.target) && !row.computer);
        if (computer === "local" && local >= 0) sources.splice(local, 1);
        sources.push(source);
      }
    }
  }
  return { sources, unavailableDispatches };
}
