import { createHash } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicInPrivateDir, BridgeError, bridgeRoot, objects, type Json, type Target, type StartingTarget, targetSchema, startingTargetSchema } from "./protocol.js";
import { validateTarget, paneChatState, paneStartingToken, clearStartingToken, clearStartingTokenByToken } from "./herdr.js";
import { terminalProvider } from "./terminal.js";
import { paneTurn, workerStates, workerTurnKey } from "./dispatch-returns.js";
import type { HandOffQueue } from "./hand-off-queue.js";
import { originPaneSchema, reconcileIdempotencyKey, scanStartingToken, settleCancelledReservation, startingTargetFromPane, updateReceipt, type Receipt } from "./dispatch.js";
import { idempotencyKeySchema, withIdempotencyKeyLock, type IdempotencyRecord } from "./dispatch-idempotency.js";
import { dispatchClonePaths, removeDispatchClone, removeDispatchSecrets, type DispatchClonePaths } from "./dispatch-clone.js";
import { launchInProgress, removeWorkerFile, terminateWorker, workerAlive, workerPid } from "./worker-identity.js";
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
    const ended = value.endedAt ?? value.closedAt ?? new Date().toISOString();
    if (!value.endedAt) value.endedAt = ended;
    if (!value.retainedUntil) value.retainedUntil = new Date(Date.parse(ended) + 7 * 24 * 60 * 60_000).toISOString();
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
  let placement = false;
  let receipt: Receipt | undefined;
  const mark = (value: Receipt, at: string) => {
    placement = value.state === "launching" || value.state === "sending";
    if (value.cancelRequestedAt) return false;
    value.cancelRequestedAt = at;
    return true;
  };
  if ("dispatch" in data) {
    dispatchId = data.dispatch;
    receipt = await updateReceipt(dispatchId, value => mark(value, new Date().toISOString()), { duringPlacement: true });
  } else {
    // The key lock serializes this marker with first-receipt creation.
    await withIdempotencyKeyLock(data.idempotencyKey, async (current, save) => {
      record = current;
      dispatchId = current?.dispatchId;
      if (!dispatchId) return;
      const at = new Date().toISOString();
      const updated = await updateReceipt(dispatchId, value => mark(value, at), { duringPlacement: true });
      if (updated) receipt = updated;
      else if (current && !current.cancelRequestedAt) { current.cancelRequestedAt = at; await save(current); }
    });
  }
  // An unknown key names no dispatch; a known one whose receipt is gone still
  // answers with the id it named.
  if (!dispatchId) return { ok: true, closed: false };
  if (!receipt) {
    // Assigned inside the lock callback, so read it through its declared type.
    const reserved = record as IdempotencyRecord | undefined;
    if (reserved && (reserved.phase === "reserved" || reserved.phase === "launching")) {
      if (await launchInProgress(reserved.dispatchId)) return { ok: true, dispatch: dispatchId, closed: false, pending: true };
      await settleCancelledReservation(reserved);
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

/** Close the recorded pane only after the worker is gone and the pane is just its shell. */
async function closeIdlePane(server: string, target: Target | StartingTarget): Promise<void> {
  try {
    const snapshot = await terminalProvider().snapshot(server);
    const pane = objects(snapshot.panes).find(p => p.pane_id === target.pane && p.tab_id === target.tab && p.workspace_id === target.workspace);
    if (!pane || typeof pane.pane_id !== "string") return;
    const info = await terminalProvider().processes(server, pane.pane_id).catch(() => undefined);
    // A replacement session in this pane is running something other than the
    // shell; never close it. Only a bare shell prompt is safe to close.
    if (!info || info.shellPid === undefined || info.foregroundPids.length === 0) return;
    if (!info.foregroundPids.every(pid => pid === info.shellPid)) return;
    await terminalProvider().closePane(server, pane.pane_id).catch(() => undefined);
  } catch { /* leave the pane */ }
}

/** A keyed worker is closed by its durable process identity, never by a pane's inherited token. */
async function closeKeyedWorker(receipt: Receipt, duringPlacement: boolean, cleanupPaths: Partial<DispatchClonePaths>): Promise<Json> {
  const dispatchId = receipt.id;
  const finalize = async (closed: boolean): Promise<Json> => {
    await retainCancelled(dispatchId, duringPlacement, cleanupPaths);
    await removeWorkerFile(dispatchId);
    clearStartingTokenByToken(receipt.startingToken ?? "");
    return { ok: true, dispatch: dispatchId, closed, ...(closed ? {} : { gone: true }) };
  };
  const alive = await workerAlive(dispatchId, receipt.workerFile, receipt.submittedAt);
  if (alive === "unknown") return { ok: true, dispatch: dispatchId, closed: false, pending: true };
  const closePaneIfIdle = async () => {
    const server = receipt.launchServer ?? receipt.target?.server;
    if (server && receipt.target) await closeIdlePane(server, receipt.target);
  };
  if (alive === "gone") { await closePaneIfIdle(); return finalize(false); }
  const worker = await workerPid(dispatchId, receipt.workerFile);
  if (!worker) return { ok: true, dispatch: dispatchId, closed: false, pending: true };
  // Terminate through the recorded process identity first; never signal or
  // close based on a PID match alone.
  await terminateWorker(worker.pid, worker.start);
  if (await workerAlive(dispatchId, receipt.workerFile, receipt.submittedAt) !== "gone") {
    return { ok: true, dispatch: dispatchId, closed: false, pending: true };
  }
  await closePaneIfIdle();
  return finalize(true);
}

/** The one close path: exact binding, confirmed snapshot, terminal return only after it is gone. */
export async function closeVerifiedWorker(receipt: Receipt): Promise<Json> {
  const dispatchId = receipt.id;
  const duringPlacement = receipt.state === "launching" || receipt.state === "sending";
  const cleanupPaths = receipt.idempotencyKey
    ? dispatchClonePaths(receipt.id)
    : { cloneDir: receipt.cloneDir, gitConfigFile: receipt.gitConfigFile, agentTokenFile: receipt.agentTokenFile };
  if (receipt.idempotencyKey) return closeKeyedWorker(receipt, duringPlacement, cleanupPaths);
  let target = receipt.target;
  if (!target) {
    // A launch whose reply was lost may still have started its worker: take
    // the binding from the worker's own arrival record when there is one.
    const { briefArrival } = await import("./launch-brief.js");
    const arrival = await briefArrival(dispatchId).catch(() => undefined);
    target = arrival?.accepted?.target ?? arrival?.started?.target;
    if (target) {
      receipt.target = target;
      receipt.launchOutcome = "started";
      await updateReceipt(dispatchId, value => {
        if (!value.target) value.target = target;
        value.launchOutcome = "started";
        return true;
      }, { duringPlacement: true }).catch(() => undefined);
    }
  }
  if (!target && receipt.launchOutcome === "not-started") {
    // The launch request was never sent (or was refused before creating
    // anything): no worker can be running, so finalize without a scan.
    await retainCancelled(dispatchId, duringPlacement, cleanupPaths);
    clearStartingTokenByToken(receipt.startingToken ?? "");
    return { ok: true, dispatch: dispatchId, closed: false, gone: true };
  }
  if (!target) {
    // The launch's own starting token is the proof: a successful snapshot
    // with no pane carrying it, and no recovered session, means no worker.
    const scan = await scanStartingToken(receipt);
    if (scan.ok && scan.pane) {
      const adopted = startingTargetFromPane(receipt, scan.pane);
      if (adopted) {
        target = adopted;
        receipt.target = adopted;
        receipt.launchOutcome = "started";
        await updateReceipt(dispatchId, value => {
          if (!value.target) value.target = adopted;
          value.launchOutcome = "started";
          return true;
        }, { duringPlacement: true }).catch(() => undefined);
      }
    } else if (scan.ok && !duringPlacement) {
      await retainCancelled(dispatchId, duringPlacement, cleanupPaths);
      clearStartingTokenByToken(receipt.startingToken ?? "");
      return { ok: true, dispatch: dispatchId, closed: false, gone: true };
    }
  }
  if (!target) return { ok: true, dispatch: dispatchId, closed: false, pending: true };
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
      clearStartingTokenByToken(receipt.startingToken ?? "");
      return { ok: true, dispatch: dispatchId, closed: false, gone: true };
    }
    const paneSession = typeof pane.sessionId === "string" ? pane.sessionId : typeof pane.session_id === "string" ? pane.session_id : undefined;
    const paneToken = typeof pane.startingToken === "string" ? pane.startingToken : paneStartingToken(target.server, pane);
    let chat: Json = {};
    if (!paneSession && !paneToken) {
      try { chat = await paneChatState(target.server, pane, { tokenWhenIdentified: false }); }
      catch { return { ok: true, dispatch: dispatchId, closed: false, pending: true }; }
    }
    const observed = paneToken && typeof pane.startingToken !== "string" ? { ...pane, startingToken: paneToken } : pane;
    const binding = paneBinding(target, observed, chat);
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
      clearStartingTokenByToken(receipt.startingToken ?? "");
      return { ok: true, dispatch: dispatchId, closed: true };
    }
  }
  // The intent stays recorded; a later close retries it.
  return { ok: true, dispatch: dispatchId, closed: false, pending: true };
}

/** The Hook that launched the worker owns its clone and token: a confirmed close removes both. */
async function releaseClosedFiles(dispatchId: string): Promise<void> {
  const paths = dispatchClonePaths(dispatchId);
  await removeDispatchSecrets(paths);
  await removeDispatchClone(paths);
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
  // Clean up files only for the dispatch durably bound to this exact pane and
  // session: a request naming another dispatch must never delete its clone.
  const owner = await updateReceipt(data.dispatch, () => false).catch(() => undefined);
  const bound = owner?.target && owner.target.server === data.target.server && owner.target.pane === data.target.pane
    && owner.target.workspace === data.target.workspace && owner.target.tab === data.target.tab
    // A starting target has no session yet: the binding can't be proven, so no cleanup.
    && "session" in owner.target && owner.target.session === data.target.session;
  if (bound) await releaseClosedFiles(data.dispatch);
  clearStartingToken(data.target.server, pane);
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
