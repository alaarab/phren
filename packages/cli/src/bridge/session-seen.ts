// Which finished turn of a pane a person last marked seen, on the phone or on
// the desktop. One tiny file per pane beside its turn record (turn-records.ts),
// written atomically, so the mark survives a Hook restart and every client
// reads the same one. A session row carries it as `seenCompletion`; the phone
// calls it unread while the row's own `completion.id` differs.
import { lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { snapshot } from "./herdr.js";
import { atomicInPrivateDir, BridgeError, bridgeRoot, id, type Json, objects, serverName } from "./protocol.js";

const completion = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const seenSchema = z.object({ completion });
const MAX_SEEN_BYTES = 4_096;

/** `{ server, pane, completion }` marks a finished turn seen; `unread: true`
 * clears the stored `seenCompletion` again, but only when it equals the
 * completion the client sent. */
export const seenRequest = z.object({ server: serverName, pane: id, completion, unread: z.literal(true).optional() });

export function seenPath(server: string, pane: string): string {
  return path.join(bridgeRoot(), "turns", encodeURIComponent(serverName.parse(server)), encodeURIComponent(pane) + ".seen.json");
}

/** The completion a client last marked seen for `pane`, absent when none was. */
export async function readSessionSeen(server: string, pane: string): Promise<string | undefined> {
  try {
    const file = seenPath(server, pane);
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_SEEN_BYTES) return undefined;
    const parsed = seenSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data.completion : undefined;
  } catch { return undefined; }
}

/** Records `completion` as the pane's seen turn, or clears the mark when
 * `unread` names it. Last writer wins; each pane's read/compare/delete or
 * write runs whole, so a stale clear never removes a concurrent write. */
let writes: Promise<unknown> = Promise.resolve();

export function setSessionSeen(server: string, pane: string, completionId: string, unread = false): Promise<void> {
  const run = writes.then(async () => {
    const file = seenPath(server, pane);
    if (unread) {
      if (await readSessionSeen(server, pane) !== completionId) return;
      try { await unlink(file); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return;
    }
    await atomicInPrivateDir(file, { completion: completionId });
  });
  writes = run.catch(() => undefined);
  return run;
}

/** Everything the route touches outside this file; tests pass their own. */
export interface SeenDeps {
  snapshot(server: string): Promise<Json>;
}

/** `POST /v1/sessions/seen`: stores what the client sent (last writer wins),
 * or clears `seenCompletion` when `unread: true` and the stored mark equals
 * the completion sent. */
export async function markSessionSeen(data: Json, deps: SeenDeps = { snapshot }): Promise<Json> {
  const { server, pane, completion: completionId, unread } = seenRequest.parse(data);
  const s = await deps.snapshot(server);
  if (!objects(s.panes).some(value => value.pane_id === pane)) throw new BridgeError(404, "No pane with that id on this computer.");
  await setSessionSeen(server, pane, completionId, unread === true);
  return { ok: true };
}
