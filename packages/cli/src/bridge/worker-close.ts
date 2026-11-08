import { createHash } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicInPrivateDir, BridgeError, bridgeRoot, type Json, type Target, type StartingTarget, targetSchema, startingTargetSchema } from "./protocol.js";
import { validateTarget, paneChatState } from "./herdr.js";
import { terminalProvider } from "./terminal.js";
import { paneTurn, workerStates, workerTurnKey } from "./dispatch-returns.js";
import type { HandOffQueue } from "./hand-off-queue.js";
import { dispatchStatus, originPaneSchema, updateReceipt } from "./dispatch.js";
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

/**
 * Cancel a running dispatch by id: stop its agent, close its pane, and record
 * a failed `cancelled` return so `phren dispatch wait` ends with that error.
 * Idempotent: a dispatch already closed answers `closed: false`.
 */
export async function cancelDispatch(input: unknown): Promise<Json> {
  const data = z.object({ dispatch: z.string().uuid() }).strict().parse(input);
  const receipt = (await dispatchStatus()).find(row => row.id === data.dispatch);
  if (!receipt) throw new BridgeError(404, "Unknown dispatch.");
  if (receipt.closedAt) return { ok: true, dispatch: data.dispatch, closed: false };
  if (["launching", "sending"].includes(receipt.state)) throw new BridgeError(409, "This dispatch is still being placed; try closing it again in a moment.");
  const at = new Date().toISOString();
  let cancelled = false;
  const current = await updateReceipt(data.dispatch, value => {
    if (value.closedAt) return false;
    value.closedAt = at;
    value.state = "failed";
    value.error = "cancelled";
    value.returned = { state: "failed", at, error: "cancelled", read: false };
    cancelled = true;
    return true;
  });
  if (!current || !cancelled) return { ok: true, dispatch: data.dispatch, closed: false };
  const target = current.target;
  if (target) {
    const { snapshot, findPane } = await import("./herdr.js");
    const pane = findPane(await snapshot(target.server).catch(() => ({})), target);
    if (pane) await markPaneClosed(target.server, pane).catch(() => undefined);
    await terminalProvider().closePane(target.server, target.pane).catch(() => undefined);
  }
  return { ok: true, dispatch: data.dispatch, closed: true };
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
