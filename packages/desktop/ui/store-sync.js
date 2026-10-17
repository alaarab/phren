// "Sync now" for a computer's Phren store. The Hook's POST /v1/store/pull-now
// only queues a pull: it answers {ok:true} at once, may start the pull 10 to 30
// seconds later, retries when Git is busy and does not report the outcome. So
// the desktop says "Sync requested" and then watches the store's head quietly.
// The head is a working-tree snapshot, so a change is "Memory updated", never a
// count of pulled changes, and no change is never "Up to date". Results are
// approximate until the Hook reports pull outcomes.
import { hookGet, hookPost } from "./api.js";

export const THROTTLE_MS = 10_000;
/** Waits between head reads after the request: 2, 4, 8, 16 s, then 15 s (45 s in all). */
export const WATCH_DELAYS = [2000, 4000, 8000, 16_000, 15_000];

/** The line shown for a sync state. `error` is an Error (or message) from the Hook. */
export function syncResultMessage({ state, error = null } = {}) {
  if (error) {
    const message = String(error.message ?? error).trim();
    // The Hook answers a store it cannot match with a bare "Not found."
    if (error.status === 404 && (!message || /^not found\.?$/i.test(message))) return "This store has no matching remote branch to pull.";
    return message || "The sync failed.";
  }
  if (state === "updated") return "Memory updated";
  if (state === "quiet") return "Sync requested — no new changes so far";
  return "Sync requested";
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

/** The button's label and title: a computer with several stores syncs only its primary one. */
export function syncLabel(directory) {
  const count = Array.isArray(directory?.stores) ? directory.stores.filter((s) => s.available !== false).length : 1;
  return count > 1
    ? { text: "Sync primary store", title: "Pulls this computer's primary store. Secondary and team stores are not included." }
    : { text: "Sync now", title: "Pull this computer's store" };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read the head after each delay; true as soon as it differs from `before`. A failed read is skipped. */
export async function watchHead({ readHead, before, delays = WATCH_DELAYS, wait = sleep, cancelled = () => false }) {
  let baseline = before;
  for (const delay of delays) {
    await wait(delay);
    if (cancelled()) return false;
    let sha;
    try { sha = await readHead(); } catch { continue; }
    if (baseline === undefined) { baseline = sha; continue; }
    if (sha !== baseline) return true;
  }
  return false;
}

/** Queue the pull on the computer's Hook. Throws when the request fails; otherwise returns the head to compare against. */
export async function requestPull(computer) {
  const identity = pullIdentity(await hookGet(computer, "/v1/tasks/stores"));
  if (!identity) throw new Error("This computer's store has no synced remote to pull.");
  let before;
  try { before = (await hookGet(computer, "/v1/store/head")).sha; } catch { /* the watch takes its first good read as the baseline */ }
  await hookPost(computer, "/v1/store/pull-now", identity);
  return before;
}

const lastStarted = new Map();

/** A button and status line for one computer. `getComputer()` names it (null when offline). */
export function createSyncControl({ el, getComputer, onSynced, delays = WATCH_DELAYS }) {
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
  let watching = 0;
  let label = syncLabel(null);
  let shown = null;

  const say = (text, error) => { status.textContent = text; status.classList.toggle("error", !!error); status.hidden = !text; };
  const paint = () => {
    button.textContent = running ? "Syncing…" : label.text;
    button.title = getComputer() ? label.title : "Computer offline";
  };
  const settle = () => {
    clearTimeout(timer);
    const computer = getComputer();
    const left = throttleLeft(lastStarted.get(computer), Date.now());
    button.disabled = running || left > 0 || !computer;
    paint();
    if (!running && left > 0 && computer) timer = setTimeout(settle, left);
  };

  async function loadLabel(computer) {
    label = syncLabel(null);
    if (computer) { try { label = syncLabel(await hookGet(computer, "/v1/tasks/stores")); } catch { /* keep the single-store label */ } }
    if (getComputer() === computer) paint();
  }

  button.addEventListener("click", async () => {
    const computer = getComputer();
    if (!computer || running || throttleLeft(lastStarted.get(computer), Date.now()) > 0) return;
    const token = ++watching;
    running = true;
    lastStarted.set(computer, Date.now());
    say("Syncing…", false);
    settle();
    let before;
    try {
      before = await requestPull(computer);
    } catch (error) {
      running = false;
      say(syncResultMessage({ error }), true);
      settle();
      return;
    }
    running = false;
    say(syncResultMessage({ state: "requested" }), false);
    settle();
    const updated = await watchHead({ readHead: async () => (await hookGet(computer, "/v1/store/head")).sha, before, delays,
      cancelled: () => token !== watching });
    if (token !== watching) return;
    say(syncResultMessage({ state: updated ? "updated" : "quiet" }), false);
    if (updated) await onSynced?.(computer);
  });

  return {
    el: root,
    /** The shown computer changed (or went offline): drop the old line and re-read the label. */
    reset(computer) {
      if (computer !== shown) { shown = computer; watching += 1; running = false; say("", false); void loadLabel(computer); }
      settle();
    },
  };
}
