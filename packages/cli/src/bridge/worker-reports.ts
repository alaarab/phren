import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicInPrivateDir, BridgeError, bridgeRoot, type Json, type Target, targetSchema } from "./protocol.js";
import { paneIdentity, findPane, snapshot, validateTarget } from "./herdr.js";
import { originPaneSchema } from "./dispatch.js";
import { paneTurn } from "./dispatch-returns.js";
import { briefArrival, briefId } from "./launch-brief.js";
import type { TurnRecord } from "./turn-records.js";

import { integratorSchema, prsSchema, reportText as text, type Integrator, type PullRequest } from "./return-contract.js";
export { integratorSchema, prsSchema, pullRequestSchema } from "./return-contract.js";
// `promptSeq` is absent for a report bound by its dispatch instead of a recorded prompt (`reportWorker`).
const reportSchema = z.object({ target: targetSchema, terminal: text(200), promptSeq: z.number().int().optional(), prs: prsSchema, at: z.string().datetime() }).strict();
const key = (target: Target) => createHash("sha256").update(JSON.stringify([target.server, target.workspace, target.tab, target.pane, target.source, target.session])).digest("hex");
const reportFile = (target: Target) => path.join(bridgeRoot(), "worker-reports", `${key(target)}.json`);

/** The worker reports PR evidence to its own Hook, without direct messaging or
 * GitHub comments. Bound to this terminal and submitted turn, not the next one.
 *
 * The pane's turn record can miss that turn: a nested agent run in the
 * worker's own pane (`claude -p` from its shell) inherits the pane's
 * variables, and its hooks replace the record with its own conversation. A
 * worker whose dispatch this Hook saw arrive in this pane and conversation
 * still reports; the evidence binds to its current turn, the one the next
 * Stop ends, and never to a prompt submitted after the report. */
export async function reportWorker(input: unknown): Promise<Json> {
  const data = z.object({ origin: originPaneSchema, prs: prsSchema, dispatch: briefId.optional() }).strict().parse(input);
  const pane = findPane(await snapshot(data.origin.server), data.origin);
  if (!pane) throw new BridgeError(409, "The worker pane changed.");
  const session = await paneIdentity(data.origin.server, pane, true);
  const target = targetSchema.parse({ ...data.origin, source: pane.agent, session });
  await validateTarget(target, false, true);
  const record = await paneTurn(target.server, pane, target.source);
  const promptSeq = record?.prompt && record.session === session && record.terminal === pane.terminal_id ? record.prompt.seq : undefined;
  if (promptSeq === undefined && !(typeof pane.terminal_id === "string" && await arrivedHere(data.dispatch ?? (record && record.session === session ? record.dispatch : undefined), target)))
    throw new BridgeError(409, "The Hook has not recorded this worker's submitted turn yet, and no dispatch it launched arrived in this pane.");
  await atomicInPrivateDir(reportFile(target), reportSchema.parse({ target, terminal: pane.terminal_id, ...(promptSeq !== undefined ? { promptSeq } : {}), prs: data.prs, at: new Date().toISOString() }));
  return { ok: true, target, prs: data.prs };
}
/** Whether this Hook launched dispatch `id` and its brief arrived in exactly this pane and conversation. */
async function arrivedHere(id: string | undefined, target: Target): Promise<boolean> {
  if (!id) return false;
  const arrival = await briefArrival(id);
  return [arrival?.accepted, arrival?.started].some(event => event && key(event.target) === key(target));
}
export async function workerPrs(target: Target, record: TurnRecord): Promise<PullRequest[] | undefined> {
  try {
    const file = reportFile(target), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 131072) return undefined;
    const report = reportSchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (report.terminal !== record.terminal) return undefined;
    if (report.promptSeq !== undefined) return report.promptSeq === record.prompt?.seq ? report.prs : undefined;
    return !record.prompt || Date.parse(record.prompt.at) <= Date.parse(report.at) ? report.prs : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}
export async function readIntegrator(): Promise<Integrator | undefined> {
  try { return integratorSchema.parse(JSON.parse(await readFile(path.join(bridgeRoot(), "integrator.json"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
}
export async function setIntegrator(input: unknown): Promise<Json> {
  if (input === null) { const { rm } = await import("node:fs/promises"); await rm(path.join(bridgeRoot(), "integrator.json"), { force: true }); return { ok: true, integrator: null }; }
  const data = integratorSchema.parse(input);
  await atomicInPrivateDir(path.join(bridgeRoot(), "integrator.json"), data);
  return { ok: true, integrator: data };
}
