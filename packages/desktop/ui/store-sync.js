// "Sync now" for a computer's Phren store. The Hook's POST /v1/store/pull-now
// only queues a pull (the answer is {ok:true}; the Hook starts it within ten
// seconds), so the result is read back from the store: its head before and
// after, and the files that differ between the two trees.
import { hookGet, hookPost } from "./api.js";

export const THROTTLE_MS = 10_000;
const POLL_MS = 1500;
const WINDOW_MS = 16_000;

/** How many store files were added, removed or changed between two trees. */
export function countChanges(before, after) {
  const was = new Map((Array.isArray(before) ? before : []).filter((n) => n?.type === "blob").map((n) => [n.path, n.sha]));
  const now = new Map((Array.isArray(after) ? after : []).filter((n) => n?.type === "blob").map((n) => [n.path, n.sha]));
  let changes = 0;
  for (const [path, sha] of now) if (was.get(path) !== sha) changes += 1;
  for (const path of was.keys()) if (!now.has(path)) changes += 1;
  return changes;
}

/** The line shown after a sync. `error` is an Error (or message) from the Hook. */
export function syncResultMessage({ changed = false, changes = null, error = null } = {}) {
  if (error) {
    const message = String(error.message ?? error).trim();
    // The Hook answers a store it cannot match with a bare "Not found."
    if (error.status === 404 && (!message || /^not found\.?$/i.test(message))) return "This store has no matching remote branch to pull.";
    return message || "The sync failed.";
  }
  if (!changed) return "Up to date";
  if (changes === null) return "Pulled changes";
  if (changes <= 0) return "Up to date";
  return `Pulled ${changes} ${changes === 1 ? "change" : "changes"}`;
}

/** Milliseconds left before another sync may start (0 when allowed). */
export function throttleLeft(lastStartedAt, now, ms = THROTTLE_MS) {
  if (!Number.isFinite(lastStartedAt)) return 0;
  return Math.max(0, lastStartedAt + ms - now);
}

/** The store a pull can name: the primary one with an ID and a GitHub remote. */
export function pullIdentity(directory) {
  const stores = Array.isArray(directory?.stores) ? directory.stores : [];
  const store = stores.find((s) => s.primary && s.id && s.repositoryIdentity) ?? stores.find((s) => s.id && s.repositoryIdentity);
  if (!store) return null;
  return { storeId: store.id, repository: store.repositoryIdentity.repository, branch: store.repositoryIdentity.branch };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readTree(computer, sha) {
  try { return (await hookGet(computer, "/v1/store/tree", { sha })).tree ?? []; } catch { return null; }
}

/** Ask the computer's Hook to pull its store, then wait for the store to move. Returns {changed, changes}. */
export async function syncStoreNow(computer, { pollMs = POLL_MS, windowMs = WINDOW_MS } = {}) {
  const identity = pullIdentity(await hookGet(computer, "/v1/tasks/stores"));
  if (!identity) throw new Error("This computer's store has no synced remote to pull.");
  const before = (await hookGet(computer, "/v1/store/head")).sha;
  await hookPost(computer, "/v1/store/pull-now", identity);
  const started = Date.now();
  while (Date.now() - started < windowMs) {
    await sleep(pollMs);
    const after = (await hookGet(computer, "/v1/store/head")).sha;
    if (after === before) continue;
    const [was, now] = await Promise.all([readTree(computer, before), readTree(computer, after)]);
    return { changed: true, changes: was && now ? countChanges(was, now) : null };
  }
  return { changed: false, changes: 0 };
}

const lastStarted = new Map();

/** A button and result line for one computer; `getComputer()` names it at click time. */
export function createSyncControl({ el, getComputer, onSynced }) {
  const root = el("div", "mem-sync");
  const button = el("button", "mem-sync-btn", "Sync now");
  button.type = "button";
  const status = el("div", "mem-sync-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.hidden = true;
  root.append(button, status);
  let running = false;
  let timer = null;

  const say = (text, error) => { status.textContent = text; status.classList.toggle("error", !!error); status.hidden = !text; };
  const settle = (computer) => {
    clearTimeout(timer);
    const left = throttleLeft(lastStarted.get(computer), Date.now());
    button.disabled = left > 0 || !computer;
    if (left > 0) timer = setTimeout(() => settle(getComputer()), left);
  };

  button.addEventListener("click", async () => {
    const computer = getComputer();
    if (!computer || running || throttleLeft(lastStarted.get(computer), Date.now()) > 0) return;
    running = true;
    lastStarted.set(computer, Date.now());
    button.disabled = true;
    button.textContent = "Syncing…";
    say("Syncing…", false);
    try {
      const result = await syncStoreNow(computer);
      say(syncResultMessage(result), false);
      await onSynced?.(computer, result);
    } catch (error) {
      say(syncResultMessage({ error }), true);
    } finally {
      running = false;
      button.textContent = "Sync now";
      settle(getComputer());
    }
  });

  return {
    el: root,
    /** The computer shown changed: clear the old line and re-evaluate the throttle. */
    reset(computer) { if (!running) { say("", false); settle(computer); } },
  };
}
