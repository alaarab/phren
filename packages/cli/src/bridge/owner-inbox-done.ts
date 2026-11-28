/** The production `done` probe for manual owner inbox items: their linked
 * pull request says the owner's action already happened. Evidence is
 * read through caches that never block a tick (a pull read starts here and a
 * later tick sees it), and anything missing, unread or still open leaves the
 * item alone. */
import type { ForgeItem } from "../forge/links.js";
import type { InboxItem } from "./owner-inbox.js";
import { cachedPull } from "./pull-status.js";

/** Test seams: the forge pull read. */
export interface DoneReaders {
  pull?: (url: string) => Promise<ForgeItem | undefined>;
}

/** Item id → resolution for the open manual items whose action happened. */
export async function ownerInboxDone(items: InboxItem[], readers: DoneReaders = {}): Promise<Map<string, string>> {
  const pull = readers.pull ?? cachedPull;
  const resolutions = new Map<string, string>();
  const open = items.filter(item => item.kind === "manual" && item.state === "open");
  await Promise.all(open.map(async item => {
    const after = Date.parse(item.updatedAt);
    if (item.pr) {
      const value = await pull(item.pr, after).catch(() => undefined);
      if (value?.state === "merged" || value?.state === "closed") {
        resolutions.set(item.id, value.state === "merged" ? "done: PR merged" : "done: PR closed without merging");
        return;
      }
    }
  }));
  return resolutions;
}
