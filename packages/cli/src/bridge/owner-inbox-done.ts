/** The production `done` probe for manual owner inbox items: their linked
 * pull request or task says the owner's action already happened. Evidence is
 * read through caches that never block a tick (a pull read starts here and a
 * later tick sees it), and anything missing, unread or still open leaves the
 * item alone. */
import { readTasksAcrossProjects, type TaskDoc } from "../data/tasks.js";
import type { ForgeItem } from "../task/work.js";
import type { InboxItem } from "./owner-inbox.js";
import { cachedPull } from "./task-work-live.js";
import { phrenStoreRoot } from "./transcripts.js";

/** Test seams: the forge pull read and the task-section read. */
export interface DoneReaders {
  pull?: (url: string) => Promise<ForgeItem | undefined>;
  task?: (bid: string) => Promise<boolean | undefined>;
}

const TASK_TTL_MS = 60_000;
let taskDocs: { at: number; docs: TaskDoc[] } | undefined;

/** Positive evidence only: every task with this stable id sits in the Done
 * section of a store project. A missing task, an unreadable store or a task
 * still Active or Queue says nothing. */
async function taskDone(bid: string, after: number): Promise<boolean> {
  const stableId = bid.replace(/^bid:/, "");
  if (!/^[a-f0-9]{8}$/.test(stableId)) return false;
  const now = Date.now();
  if (!taskDocs || now - taskDocs.at >= TASK_TTL_MS || taskDocs.at <= after) {
    let docs: TaskDoc[] = [];
    try { docs = readTasksAcrossProjects(phrenStoreRoot()); } catch { docs = []; }
    taskDocs = { at: now, docs };
  }
  let done = false, open = false;
  for (const doc of taskDocs.docs) for (const item of [...doc.items.Active, ...doc.items.Queue, ...doc.items.Done]) {
    if (item.stableId !== stableId || item.identityAmbiguous) continue;
    if (item.section === "Done") done = true; else open = true;
  }
  return done && !open;
}

/** Item id → resolution for the open manual items whose action happened. */
export async function ownerInboxDone(items: InboxItem[], readers: DoneReaders = {}): Promise<Map<string, string>> {
  const pull = readers.pull ?? cachedPull;
  const task = readers.task ?? taskDone;
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
    if (item.task && await task(item.task, after).catch(() => false)) resolutions.set(item.id, `done: task ${item.task} is Done`);
  }));
  return resolutions;
}
