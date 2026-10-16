import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicInPrivateDir, BridgeError, bridgeRoot, type Json } from "./protocol.js";
import { briefArrival } from "./launch-brief.js";
import { moveToSchema, projectName } from "./dispatch.js";

export const continuationLaunchSchema = z.object({
  worker: z.boolean().default(false), computerId: z.string().uuid(), project: projectName, to: moveToSchema.refine(to => to.computer === undefined, "A receiving launch is local only."), label: z.string().max(200),
  brief: z.object({ id: z.string().uuid(), text: z.string().min(1).max(32768) }).strict(),
}).strict();
type Placement = { hash: string; worker?: boolean; state: "uncertain" | "placed"; paneTarget?: Json; result?: Json };
const queues = new Map<string, Promise<Json>>();
const fileFor = (id: string) => path.join(bridgeRoot(), "move-launches", `${z.string().uuid().parse(id)}.json`);

/** A durable intent precedes creation. An interrupted intent is reconciled by
 * its brief arrival, never by creating another pane. */
export async function continuationPlacement(id: string): Promise<Placement | undefined> {
  let saved: Placement;
  try { saved = JSON.parse(await readFile(fileFor(id), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!saved.result) {
    const arrived = (await briefArrival(id))?.accepted?.target;
    if (arrived) {
      saved = { ...saved, state: "placed", result: { target: arrived, briefLaunched: true } };
      await atomicInPrivateDir(fileFor(id), JSON.stringify(saved));
    }
  }
  return saved;
}

export async function launchContinuation(input: unknown, launch: (data: z.infer<typeof continuationLaunchSchema>, placed: (paneTarget: Json) => Promise<void>) => Promise<Json>): Promise<Json> {
  const data = continuationLaunchSchema.parse(input);
  const file = fileFor(data.brief.id);
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  const pending = queues.get(file);
  if (pending) { await pending.catch(() => undefined); return launchContinuation(data, launch); }
  const work = (async () => {
    const saved = await continuationPlacement(data.brief.id);
    if (saved) {
      if (saved.hash !== hash) throw new BridgeError(409, "This move id already names a different launch.");
      if (saved.result) return saved.result;
      throw new BridgeError(409, "This move's launch is uncertain; inspect its existing pane or wait for its arrival. It will not be launched twice.");
    }
    await atomicInPrivateDir(file, JSON.stringify({ hash, worker: data.worker, state: "uncertain" }));
    let paneTarget: Json | undefined;
    const result = await launch(data, async pane => {
      paneTarget = pane;
      await atomicInPrivateDir(file, JSON.stringify({ hash, worker: data.worker, state: "uncertain", paneTarget }));
    });
    await atomicInPrivateDir(file, JSON.stringify({ hash, worker: data.worker, state: "placed", paneTarget, result }));
    return result;
  })();
  queues.set(file, work);
  try { return await work; } finally { queues.delete(file); }
}
