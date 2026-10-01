import { createHash } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicInPrivateDir, BridgeError, bridgeRoot, type Json, type Target, type StartingTarget, targetSchema, startingTargetSchema } from "./protocol.js";
import { validateTarget, paneChatState } from "./herdr.js";
import { terminalProvider } from "./terminal.js";
import { paneTurn, workerStates, workerTurnKey } from "./dispatch-returns.js";
import type { HandOffQueue } from "./hand-off-queue.js";
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
  // A turn that stopped mid-task, or whose checkout could not be read, keeps its pane.
  if (!seen.completed || seen.background || seen.error || seen.unfinished || seen.unchecked || turn !== data.turn) return { ok: true, closed: false };
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
