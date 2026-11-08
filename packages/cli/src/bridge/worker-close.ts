import { createHash } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicInPrivateDir, BridgeError, bridgeRoot, type Json, type Target, type StartingTarget, targetSchema, startingTargetSchema } from "./protocol.js";
import { validateTarget, paneChatState } from "./herdr.js";
import { terminalProvider } from "./terminal.js";
import { paneTurn, workerStates, workerTurnKey } from "./dispatch-returns.js";
import type { HandOffQueue } from "./hand-off-queue.js";
import { originPaneSchema, reconcileIdempotencyKey, settleCancelledReservation, updateReceipt, type Receipt } from "./dispatch.js";
import { idempotencyKeySchema, requestIdempotencyCancel } from "./dispatch-idempotency.js";
import { removeDispatchSecrets } from "./dispatch-clone.js";
type ClosedTarget = Target | StartingTarget;
const closedTargetSchema = z.union([targetSchema, startingTargetSchema]);
const file = (target: ClosedTarget) => path.join(bridgeRoot(), "closed-workers", `${createHash("sha256").update(JSON.stringify([target.server, target.workspace, target.tab, target.pane, target.source, "session" in target ? target.session : target.startingToken])).digest("hex")}.json`);
export async function markWorkerClosed(target: ClosedTarget, terminal: string): Promise<void> {
  await atomicInPrivateDir(file(target), { target, terminal, at: new Date().toISOString() });
}
export async function intentionallyClosed(target: ClosedTarget): Promise<boolean> {
  try { const info = await lstat(file(target)); if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return false; const row = JSON.parse(await readFile(file(target), "utf8")); return closedTargetSchema.safeParse(row.target).success; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return false; }
}
export async function markPaneClosed(server: string, pane: Json): Promise<void> {
  const chat = await paneChatState(server, pane);
  const target = closedTargetSchema.safeParse({ server, workspace: pane.workspace_id, tab: pane.tab_id, pane: pane.pane_id, source: pane.agent,
    ...(chat.sessionId ? { session: chat.sessionId } : { starting: true, startingToken: chat.startingToken }) });
  if (target.success) await markWorkerClosed(target.data, String(pane.terminal_id));
  // A dispatch may still hold the launch token before its first identity poll.
  const starting = startingTargetSchema.safeParse({ server, workspace: pane.workspace_id, tab: pane.tab_id, pane: pane.pane_id,
    source: pane.agent, starting: true, startingToken: chat.startingToken });
  if (starting.success) await markWorkerClosed(starting.data, String(pane.terminal_id));
}

/** Whether this pane still runs the session (or starting binding) the dispatch recorded. */
export type PaneBinding = "match" | "different" | "unknown";

/** The exact recorded binding: the session id, or a starting target's starting token. */
export function paneBinding(target: Target | StartingTarget, pane: Json | undefined, chat: Json): PaneBinding {
  if (!pane || pane.agent !== target.source) return "different";
  const paneSession = typeof pane.sessionId === "string" ? pane.sessionId : typeof pane.session_id === "string" ? pane.session_id : undefined;
  if ("session" in target) {
    const actual = paneSession ?? (typeof chat.sessionId === "string" ? chat.sessionId : undefined);
    if (!actual) return "unknown";
    return actual === target.session ? "match" : "different";
  }
  const token = typeof pane.startingToken === "string" ? pane.startingToken
    : typeof chat.startingToken === "string" ? chat.startingToken : undefined;
  if (!token) return "unknown";
  return token === target.startingToken ? "match" : "different";
}

export function paneRunsTarget(target: Target | StartingTarget, pane: Json | undefined, chat: Json): boolean {
  return paneBinding(target, pane, chat) === "match";
}

async function retainCancelled(dispatchId: string, duringPlacement: boolean, paths: { cloneDir?: string; gitConfigFile?: string; agentTokenFile?: string }): Promise<void> {
  await finalizeCancelled(dispatchId, duringPlacement);
  await removeDispatchSecrets(paths);
  await updateReceipt(dispatchId, value => {
    if (value.retainedUntil) return false;
    value.retainedUntil = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
    return true;
  }).catch(() => undefined);
}

async function finalizeCancelled(dispatchId: string, duringPlacement = false): Promise<boolean> {
  const at = new Date().toISOString();
  let cancelled = false;
  await updateReceipt(dispatchId, value => {
    if (value.closedAt) return false;
    value.closedAt = at;
    value.state = "failed";
    value.error = "cancelled";
    value.returned = { state: "failed", at, error: "cancelled", read: false };
    cancelled = true;
    return true;
  }, { duringPlacement });
  return cancelled;
}

/**
 * Cancel a running dispatch by id or idempotency key. The intent is recorded
 * first; the pane is closed only while it still runs the recorded session, and
 * the terminal `cancelled` return is written only after the pane is confirmed
 * gone. A close that cannot be confirmed leaves the intent for a later retry.
 */
export async function cancelDispatch(input: unknown): Promise<Json> {
  const data = z.union([
    z.object({ dispatch: z.string().uuid() }).strict(),
    z.object({ idempotencyKey: idempotencyKeySchema }).strict(),
  ]).parse(input);
  let dispatchId: string | undefined;
  let record: Awaited<ReturnType<typeof reconcileIdempotencyKey>> = undefined;
  if ("dispatch" in data) dispatchId = data.dispatch;
  else { record = await reconcileIdempotencyKey(data.idempotencyKey); dispatchId = record?.dispatchId; }
  // An unknown key names no dispatch; a known one whose receipt is gone still
  // answers with the id it named.
  if (!dispatchId) return { ok: true, closed: false };
  let placement = false;
  const receipt = await updateReceipt(dispatchId, value => {
    // This callback runs under the receipt lock and sees the durable phase,
    // including launching/sending that dispatchStatus() reports as uncertain.
    placement = value.state === "launching" || value.state === "sending";
    if (value.cancelRequestedAt) return false;
    value.cancelRequestedAt = new Date().toISOString();
    return true;
  }, { duringPlacement: true });
  if (!receipt) {
    if (record && (record.phase === "reserved" || record.phase === "launching")) {
      const cancelled = await requestIdempotencyCancel(record.key);
      if (cancelled) await settleCancelledReservation(cancelled);
      return { ok: true, dispatch: dispatchId, closed: false };
    }
    return { ok: true, dispatch: dispatchId, closed: false };
  }
  if (receipt.closedAt) return { ok: true, dispatch: dispatchId, closed: false };
  // The launcher sees cancelRequestedAt and closes the pane it just created;
  // this call reports the intent as pending.
  if (placement) return { ok: true, dispatch: dispatchId, closed: false, pending: true };
  return closeVerifiedWorker(receipt);
}

/** The one close path: exact binding, confirmed snapshot, terminal return only after it is gone. */
export async function closeVerifiedWorker(receipt: Receipt): Promise<Json> {
  const dispatchId = receipt.id;
  const duringPlacement = receipt.state === "launching" || receipt.state === "sending";
  const target = receipt.target;
  const cleanupPaths = { cloneDir: receipt.cloneDir, gitConfigFile: receipt.gitConfigFile, agentTokenFile: receipt.agentTokenFile };
  if (!target) {
    // No pane was recorded: there is nothing to close, and the worker is gone.
    await retainCancelled(dispatchId, duringPlacement, cleanupPaths);
    return { ok: true, dispatch: dispatchId, closed: false, gone: true };
  }
  const { snapshot, findPane } = await import("./herdr.js");
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, attempt === 1 ? 100 : 300));
    let before: Json;
    try { before = await snapshot(target.server); } catch { return { ok: true, dispatch: dispatchId, closed: false, pending: true }; }
    const pane = findPane(before, target);
    if (!pane) {
      // A successful snapshot with no pane is a vanished worker; a failed
      // snapshot above stays pending instead of claiming success.
      await retainCancelled(dispatchId, duringPlacement, cleanupPaths);
      return { ok: true, dispatch: dispatchId, closed: false, gone: true };
    }
    const paneSession = typeof pane.sessionId === "string" ? pane.sessionId : typeof pane.session_id === "string" ? pane.session_id : undefined;
    const paneToken = typeof pane.startingToken === "string" ? pane.startingToken : undefined;
    let chat: Json = {};
    if (!paneSession && !paneToken) {
      try { chat = await paneChatState(target.server, pane, { tokenWhenIdentified: false }); }
      catch { return { ok: true, dispatch: dispatchId, closed: false, pending: true }; }
    }
    const binding = paneBinding(target, pane, chat);
    if (binding === "different") {
      // A replacement session now owns the pane: never close it.
      return { ok: true, dispatch: dispatchId, closed: false };
    }
    if (binding === "unknown") {
      // Missing identity evidence: fail closed and retry later.
      return { ok: true, dispatch: dispatchId, closed: false, pending: true };
    }
    await markPaneClosed(target.server, pane).catch(() => undefined);
    await terminalProvider().closePane(target.server, target.pane).catch(() => undefined);
    let after: Json;
    try { after = await snapshot(target.server); } catch { return { ok: true, dispatch: dispatchId, closed: false, pending: true }; }
    if (!findPane(after, target)) {
      await retainCancelled(dispatchId, duringPlacement, cleanupPaths);
      return { ok: true, dispatch: dispatchId, closed: true };
    }
  }
  // The intent stays recorded; a later close retries it.
  return { ok: true, dispatch: dispatchId, closed: false, pending: true };
}

/** Called on the worker's computer only after the sender read the done return.
 * Recheck this exact ended turn and skip any new work, background work or inbox. */
export async function closeFinishedWorker(input: unknown, queue?: HandOffQueue): Promise<Json> {
  const data = z.object({ target: targetSchema, turn: z.string().regex(/^[a-f0-9]{16}$/), dispatch: z.string().uuid() }).strict().parse(input);
  if (queue) return queue.whenNoPending(data.target, () => closeFinishedWorker(input));
  const { snapshot, findPane } = await import("./herdr.js");
  if (await intentionallyClosed(data.target) && !findPane(await snapshot(data.target.server), data.target)) return { ok: true, closed: true, replayed: true };
  const pane = await validateTarget(data.target, false, true);
  if (!["idle", "done"].includes(String(pane.agent_status))) return { ok: true, closed: false };
  const seen = (await workerStates({ targets: [{ ...data.target, dispatch: data.dispatch }] })).workers[0];
  const turn = workerTurnKey(seen);
  // A turn still working, one that stopped mid-task or with background work
  // running, or whose checkout could not be read, keeps its pane.
  if ((seen.state !== "done" && seen.state !== "idle") || !seen.completed || seen.background || seen.error || seen.unfinished || seen.unchecked || turn !== data.turn) return { ok: true, closed: false };
  // One final fresh binding before the terminal mutation.
  const current = await validateTarget(data.target, false, true);
  if (current.terminal_id !== pane.terminal_id || !["idle", "done"].includes(String(current.agent_status))) throw new BridgeError(409, "The worker resumed before it could close.");
  const record = await paneTurn(data.target.server, current, data.target.source);
  if (record?.prompt && (!record.stop || record.stop.seq <= record.prompt.seq || record.terminal !== current.terminal_id
    || record.session !== data.target.session || workerTurnKey({ endedAt: record.stop.at, stopSeq: record.stop.seq }) !== data.turn)) return { ok: true, closed: false };
  await markWorkerClosed(data.target, String(pane.terminal_id));
  try { await terminalProvider().closePane(data.target.server, data.target.pane); }
  catch (error) {
    // A refused close must not suppress a later genuine disappearance. Keep
    // the marker on an ambiguous transport failure if the pane is now gone.
    const remaining = await snapshot(data.target.server).catch(() => undefined);
    if (remaining && findPane(remaining, data.target)?.terminal_id === pane.terminal_id) await rm(file(data.target), { force: true });
    throw error;
  }
  return { ok: true, closed: true };
}

/** An agent closing the pane it runs in, once its work is committed and reported:
 * the sanctioned form of `herdr pane close`, which an agent's auto mode refuses.
 * Only the caller's own pane (named by its terminal variables) is ever closed, and
 * after the reply, so the agent's `phren` call still returns. */
export async function closeOwnPane(input: unknown, delayMs = 500): Promise<Json> {
  const data = z.object({ origin: originPaneSchema }).strict().parse(input);
  const { snapshot, findPane } = await import("./herdr.js");
  const pane = findPane(await snapshot(data.origin.server), data.origin);
  if (!pane) return { ok: true, closed: false, reason: "The pane is already gone." };
  await markPaneClosed(data.origin.server, pane);
  const timer = setTimeout(() => { void terminalProvider().closePane(data.origin.server, data.origin.pane).catch(() => undefined); }, delayMs);
  timer.unref();
  return { ok: true, closed: true, pane: data.origin.pane };
}
