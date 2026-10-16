import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicInPrivateDir, BridgeError, bridgeRoot, type Json } from "./protocol.js";
import type { PeerIdentity } from "./request-origin.js";
import { terminalProvider } from "./terminal.js";
import { briefArrival, briefId, assertUnusedLaunchId } from "./launch-brief.js";
import { moveToSchema, projectName } from "./dispatch.js";

export const continuationLaunchSchema = z.object({
  workerDispatch: briefId.optional(), worker: z.boolean().default(false), computerId: z.string().uuid(), project: projectName, to: moveToSchema.refine(to => to.computer === undefined, "A receiving launch is local only."), label: z.string().max(200),
  brief: z.object({ id: z.string().uuid(), text: z.string().min(1).max(32768) }).strict(),
}).strict();
type Placement = { hash: string; worker?: boolean; workerDispatch?: string; state: "uncertain" | "placed" | "not-placed"; createdAt?: number; server?: string; caller?: PeerIdentity; paneTarget?: Json; result?: Json };
const queues = new Map<string, Promise<Json>>();
const creating = new Map<string, Placement>();
const fileFor = (id: string) => path.join(bridgeRoot(), "move-launches", `${z.string().uuid().parse(id)}.json`);

/** A durable intent precedes creation. An interrupted intent is reconciled by
 * its brief arrival, never by creating another pane. */
export async function continuationPlacement(id: string, includeCreating = true): Promise<Placement | undefined> {
  let saved: Placement;
  try { saved = JSON.parse(await readFile(fileFor(id), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return includeCreating ? creating.get(fileFor(id)) : undefined; throw error; }
  if (!saved.result) {
    const arrived = (await briefArrival(id))?.accepted?.target;
    if (arrived) {
      saved = { ...saved, state: "placed", result: { target: arrived, briefLaunched: true } };
      await atomicInPrivateDir(fileFor(id), JSON.stringify(saved));
    }
  }
  if (!saved.result && !queues.has(fileFor(id)) && saved.createdAt && Date.now() - saved.createdAt >= 10 * 60_000 && saved.server) {
    // A unique creation label covers a crash between create() and onPlaced().
    // Failure to inspect the terminal keeps the placement uncertain.
    const panes = await terminalProvider().listPanes(saved.server);
    if (!panes.some(pane => pane.label === `move-${id}` || saved.paneTarget && pane.pane === saved.paneTarget.pane)) {
      saved = { ...saved, state: "not-placed" }; await atomicInPrivateDir(fileFor(id), JSON.stringify(saved));
    }
  }
  return saved;
}

export async function launchContinuation(input: unknown, launch: (data: z.infer<typeof continuationLaunchSchema>, placed: (paneTarget: Json) => Promise<void>) => Promise<Json>, authorization?: { caller?: PeerIdentity; server: string }): Promise<Json> {
  const data = continuationLaunchSchema.parse(input);
  const file = fileFor(data.brief.id);
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  const pending = queues.get(file);
  if (pending) { await pending.catch(() => undefined); return launchContinuation(data, launch, authorization); }
  const metadata = { hash, worker: data.worker, ...(data.workerDispatch ? { workerDispatch: data.workerDispatch } : {}), createdAt: Date.now(), ...authorization };
  creating.set(file, { ...metadata, state: "uncertain" });
  const work = (async () => {
    const saved = await continuationPlacement(data.brief.id, false);
    if (saved) {
      if (JSON.stringify(saved.caller) !== JSON.stringify(authorization?.caller)) throw new BridgeError(403, "This peer is not the launch's recorded counterpart.");
      if (saved.hash !== hash) throw new BridgeError(409, "This move id already names a different launch.");
      if (saved.result) return saved.result;
      throw new BridgeError(409, "This move's launch is uncertain; inspect its existing pane or wait for its arrival. It will not be launched twice.");
    }
    await assertUnusedLaunchId(data.brief.id);
    await atomicInPrivateDir(file, JSON.stringify({ ...metadata, state: "uncertain" }));
    let paneTarget: Json | undefined;
    const result = await launch(data, async pane => {
      paneTarget = pane;
      await atomicInPrivateDir(file, JSON.stringify({ ...metadata, state: "uncertain", paneTarget }));
    });
    await atomicInPrivateDir(file, JSON.stringify({ ...metadata, state: "placed", paneTarget, result }));
    return result;
  })();
  queues.set(file, work);
  try { return await work; } finally { queues.delete(file); creating.delete(file); }
}

/** An owner-admitted source move publishes one canonical intent privately.
 * The receiving Hook pulls it back over its own verified reverse enrollment. */
const intentFile = (id: string) => path.join(bridgeRoot(), "move-intents", `${z.string().uuid().parse(id)}.json`);
export async function saveContinuationIntent(input: Json): Promise<void> {
  const id = z.string().uuid().parse((input.brief as Json).id);
  const previous = await readFile(intentFile(id), "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return undefined; });
  const encoded = JSON.stringify(input);
  if (previous && previous !== encoded) throw new BridgeError(409, "This move id already has a different launch intent.");
  await atomicInPrivateDir(intentFile(id), encoded);
}
export async function continuationIntent(id: string): Promise<Json> {
  try { return JSON.parse(await readFile(intentFile(id), "utf8")); }
  catch { throw new BridgeError(404, "No owner-admitted continuation intent is recorded."); }
}
