import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicInPrivateDir, BridgeError, bridgeRoot, type Json, type Target, targetSchema } from "./protocol.js";
import { paneIdentity, findPane, snapshot, validateTarget } from "./herdr.js";
import { originPaneSchema } from "./dispatch.js";
import { paneTurn } from "./dispatch-returns.js";
import type { TurnRecord } from "./turn-records.js";

import { integratorSchema, prsSchema, reportText as text, type Integrator, type PullRequest } from "./return-contract.js";
export { integratorSchema, prsSchema, pullRequestSchema } from "./return-contract.js";
const reportSchema = z.object({ target: targetSchema, terminal: text(200), promptSeq: z.number().int(), prs: prsSchema, at: z.string().datetime() }).strict();
const key = (target: Target) => createHash("sha256").update(JSON.stringify([target.server, target.workspace, target.tab, target.pane, target.source, target.session])).digest("hex");
const reportFile = (target: Target) => path.join(bridgeRoot(), "worker-reports", `${key(target)}.json`);

/** The worker reports PR evidence to its own Hook, without direct messaging or
 * GitHub comments. Bound to this terminal and submitted turn, not the next one. */
export async function reportWorker(input: unknown): Promise<Json> {
  const data = z.object({ origin: originPaneSchema, prs: prsSchema }).strict().parse(input);
  const pane = findPane(await snapshot(data.origin.server), data.origin);
  if (!pane) throw new BridgeError(409, "The worker pane changed.");
  const session = await paneIdentity(data.origin.server, pane, true);
  const target = targetSchema.parse({ ...data.origin, source: pane.agent, session });
  await validateTarget(target, false, true);
  const record = await paneTurn(target.server, pane, target.source);
  if (!record?.prompt || record.session !== session || record.terminal !== pane.terminal_id) throw new BridgeError(409, "The Hook has not recorded this worker's submitted turn yet.");
  await atomicInPrivateDir(reportFile(target), reportSchema.parse({ target, terminal: record.terminal, promptSeq: record.prompt.seq, prs: data.prs, at: new Date().toISOString() }));
  return { ok: true, target, prs: data.prs };
}
export async function workerPrs(target: Target, record: TurnRecord): Promise<PullRequest[] | undefined> {
  try {
    const file = reportFile(target), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 131072) return undefined;
    const report = reportSchema.parse(JSON.parse(await readFile(file, "utf8")));
    return report.terminal === record.terminal && report.promptSeq === record.prompt?.seq ? report.prs : undefined;
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
