import type { AgentHooks } from "./agent-hooks.js";
import { dispatchStatus, updateReceipt, type Receipt } from "./dispatch.js";
import { isLocalComputer } from "./dispatch-hosts.js";
import { WATCH_MS, workerReaders, workerStates } from "./dispatch-returns.js";
import { paneChatState, recentServers, snapshot } from "./herdr.js";
import { inboxTargetSchema, type InboxSnapshot, type InboxSource } from "./owner-inbox.js";
import { hookPeers, peerRequest, type HookPeer } from "./peers.js";
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

  // A saved return/approval is only a candidate. A worker on this computer is re-observed here, without SSH, so a
  // closed pane never stays live because its last return waits. This runs on every five-second tick, and an SSH
  // login per tick per computer (forever, for receipts the returns loop stopped watching) crowded a peer's sshd, so
  // a worker on another computer is asked about at most once an hour, and only past the returns loop's watch:
  // within it, its row comes from what that loop last observed and stored on the receipt (`remoteSource`),
  // refreshed every POLL_MS.
  const candidates = (await dispatchStatus()).filter(receipt => !receipt.closedAt && receipt.target && receipt.worker?.state !== "gone"
    && receipt.returned && ["needs-you", "blocked"].includes(receipt.returned.state));
  const now = Date.now();
  const local: Receipt[] = [], aged = new Map<string, Receipt[]>();
  for (const receipt of candidates) {
    if (isLocalComputer(receipt.computer)) { local.push(receipt); continue; }
    if (now - Date.parse(receipt.createdAt) >= WATCH_MS) { aged.set(receipt.computer, [...aged.get(receipt.computer) ?? [], receipt]); continue; }
    const source = remoteSource(receipt);
    if (source) sources.push(source);
  }
  const answered = async (receipt: Receipt, seen: Json | undefined, computer?: string) => {
    if (!seen || ["unavailable", "unknown"].includes(String(seen.state))) { unavailableDispatches.push(receipt.id); return; }
    if (["gone", "closed"].includes(String(seen.state))) {
      // A closed worker, or one gone after the returns loop stopped watching it, is closed on its receipt so it
      // stops being a candidate at all, unless its return is still unread: then a conductor taking over is still
      // handed it (conductor-succession.ts skips closed receipts).
      if (seen.state === "closed" || (now - Date.parse(receipt.createdAt) >= WATCH_MS && receipt.returned?.read !== false)) await closeReceipt(receipt.id, now);
      return;
    }
    const source = liveSource(receipt, seen, computer);
    if (!source) return;
    // The local prompt and dispatch return describe the same wait. Keep
    // the dispatch's project/receipt metadata as well as its live target.
    const prompt = computer ? -1 : sources.findIndex(row => JSON.stringify(row.target) === JSON.stringify(source.target) && !row.computer);
    if (prompt >= 0) sources.splice(prompt, 1);
    sources.push(source);
  };
  for (let offset = 0; offset < local.length; offset += 64) {
    const batch = local.slice(offset, offset + 64);
    const input = { targets: batch.map(receipt => ({ ...receipt.target!, dispatch: receipt.id })) };
    let workers: Json[];
    try {
      workers = objects((await workerStates(input, { ...workerReaders(target => hooks.workerApproval(target) as Json | undefined), snapshot })).workers);
    } catch { workers = []; }
    for (const [index, receipt] of batch.entries()) await answered(receipt, workers[index]);
  }
  if (aged.size) {
    const peers = await hookPeers().catch(() => []);
    for (const [computer, receipts] of aged) {
      const seen = await agedStates(computer, receipts, peers.find(peer => peer.name === computer), now);
      for (const receipt of receipts) await answered(receipt, seen?.get(receipt.id), computer);
    }
  }
  return { sources, unavailableDispatches };
}

/** A live worker observation as an inbox row: an approval it waits on, blocked, or stopped with a question. */
function liveSource(receipt: Receipt, seen: Json, computer?: string): InboxSource | undefined {
  const approval = object(seen.approval);
  const actionId = typeof approval.actionId === "string" ? approval.actionId : undefined;
  const question = ["idle", "done"].includes(String(seen.state)) && seen.completed && !seen.error && !seen.interrupted
    ? (typeof seen.reply === "string" ? ownerQuestion(seen.reply) : undefined) ?? seen.unfinished : undefined;
  if (!actionId && seen.state !== "blocked" && !question) return undefined;
  return { source: `dispatch:${receipt.id}:${actionId ?? "waiting"}`, kind: actionId || seen.state === "blocked" ? "blocked" : "needs-you",
    title: clean(approval.request ?? question ?? `${receipt.label} needs input`),
    project: receipt.project, ...(computer ? { computer } : {}), target: receipt.target as InboxSource["target"], dispatch: receipt.id,
    ...(actionId ? { actionId } : {}) };
}

/** How often the inbox asks another computer about its receipts past the returns loop's watch, failed or not. */
export const AGED_CHECK_MS = 60 * 60 * 1000;
const agedChecks = new Map<string, { at: number; seen?: Map<string, Json> }>();
/** Forgets the hourly answers (tests). */
export function resetAgedChecks(): void { agedChecks.clear(); }

/**
 * What another computer says of receipts the returns loop no longer watches: asked once per `AGED_CHECK_MS` per
 * computer (one request, at most 64 receipts), the answer kept until the next, and a failure waited out as long.
 * A receipt that aged into the set since keeps no answer until then: hidden, not resolved, and no SSH.
 */
async function agedStates(computer: string, receipts: Receipt[], peer: HookPeer | undefined, now: number): Promise<Map<string, Json> | undefined> {
  const hit = agedChecks.get(computer);
  if (hit && now - hit.at < AGED_CHECK_MS) return hit.seen;
  const entry: { at: number; seen?: Map<string, Json> } = { at: now };
  agedChecks.set(computer, entry);
  if (!peer) return undefined;
  const batch = receipts.slice(0, 64);
  try {
    const workers = objects((await peerRequest(peer, "/v1/dispatch/workers", { targets: batch.map(receipt => ({ ...receipt.target!, dispatch: receipt.id })) })).workers);
    entry.seen = new Map(batch.flatMap((receipt, index) => workers[index] ? [[receipt.id, workers[index]] as [string, Json]] : []));
  } catch { /* waited out until the next check */ }
  return entry.seen;
}

/**
 * A dispatch on another computer, within the returns loop's watch, as that loop last saw it, with no SSH of its
 * own: waiting on an approval it forwarded (blocked, answerable by its `actionId`), blocked, or stopped with a
 * question for the owner. A worker the loop saw back at work, or gone, has no row.
 */
export function remoteSource(receipt: Receipt): InboxSource | undefined {
  const approval = receipt.approval, state = receipt.worker?.state ?? receipt.returned?.state;
  if (!approval && state !== "blocked" && state !== "needs-you") return undefined;
  const actionId = approval?.actionId;
  return { source: `dispatch:${receipt.id}:${actionId ?? "waiting"}`, kind: actionId || state === "blocked" ? "blocked" : "needs-you",
    title: clean(approval?.request ?? approval?.title ?? receipt.returned?.question ?? `${receipt.label} needs input`),
    project: receipt.project, computer: receipt.computer, target: receipt.target as InboxSource["target"], dispatch: receipt.id,
    ...(actionId ? { actionId } : {}) };
}

/** Records a receipt closed, under the receipt lock, unless something closed it first. */
async function closeReceipt(id: string, now: number): Promise<void> {
  await updateReceipt(id, current => {
    if (current.closedAt) return false;
    current.closedAt = new Date(now).toISOString(); return true;
  }).catch(() => undefined);
}
