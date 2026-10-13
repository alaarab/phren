// CI watch: a native notification when the pull request of a session's branch
// turns failing or passing, and the last look for Home's Checks strip. One
// /v1/git/pulls per repository every two minutes, only for sessions working
// now or active in the last two hours, and only while notifications are on or
// a view is showing the strip. Plain browser ES module.

import { hookPost } from "../api.js";
import { projectOf, store } from "./store.js";

export const CI_WATCH_MS = 120_000;
const ACTIVE_MS = 2 * 3_600_000;
// Repositories asked about per tick; the most recently active win.
const MAX_WATCHED = 6;

/** One session per computer and project, working or recently active, newest first. */
export function watchedSessions(rows, now = Date.now()) {
  const seen = new Set();
  const picked = [];
  const recent = (row) => Date.parse(row.child.lastChangedAt ?? "") || 0;
  for (const row of [...rows].sort((a, b) => recent(b) - recent(a))) {
    const project = projectOf(row.child);
    const key = `${row.computer}\u0000${project}`;
    if (!project || seen.has(key)) continue;
    if (row.child.agentStatus !== "working" && now - recent(row) > ACTIVE_MS) continue;
    seen.add(key);
    picked.push({ key, computer: row.computer, project, target: row.child.target, child: row.child });
    if (picked.length === MAX_WATCHED) break;
  }
  return picked;
}

/** The requests whose checks settled on failing or passing since the last
 *  look. A request seen for the first time only sets the baseline. */
export function ciTransitions(previous, current) {
  const settled = [];
  for (const [key, now] of current) {
    const before = previous.get(key);
    if (!before || before.checks === now.checks) continue;
    if (now.checks === "failing" || now.checks === "passing") settled.push(now);
  }
  return settled;
}

// Which sessions are watched, regardless of their recency order.
const keysOf = (watched) => watched.map((w) => w.key).sort().join("\n");

const CHECK_ORDER = { failing: 0, pending: 1, passing: 2 };

/** The open requests of the last look, failing first, then running, then
 *  passing, then those with no checks; newest number first within each. */
export function checksStrip(pulls) {
  const rank = (pull) => CHECK_ORDER[pull.checks] ?? 3;
  return [...pulls].sort((a, b) => rank(a) - rank(b) || b.number - a.number);
}

// The last look, shared with Home; `null` until the first tick finishes.
let lastLook = null;
const listeners = new Set();
let interest = 0;
let wake = null;

const settledListeners = new Set();

/** Hear each request whose checks just turned failing or passing (Since you left). Returns the stop. */
export function onChecksSettled(fn) {
  settledListeners.add(fn);
  return () => settledListeners.delete(fn);
}

/** The last look without following it (no extra polling); `null` before the first. */
export function lastChecks() { return lastLook; }

/** Follow the last look: `fn(pulls)` now and after each tick. While anyone
 *  follows, the watch polls even with notifications off. Returns the stop. */
export function followChecks(fn) {
  listeners.add(fn);
  interest += 1;
  fn(lastLook);
  wake?.();
  return () => { if (listeners.delete(fn)) interest -= 1; };
}

/** Start watching; `notify(title, body)` is the shell's (absent in a browser),
 *  `enabled()` the notification setting. */
export function startCiWatch({ notify, enabled }) {
  let previous = new Map();
  let running = false;
  let watchedKeys = "";
  const notifying = () => !!notify && enabled();
  async function tick() {
    if (running || !(notifying() || interest > 0)) return;
    running = true;
    try {
      const current = new Map();
      const watched = watchedSessions(store.sessions());
      watchedKeys = keysOf(watched);
      await Promise.all(watched.map(async (w) => {
        const body = await hookPost(w.computer, "/v1/git/pulls", { target: w.target }).catch(() => null);
        // A failed read keeps what was known, so a passing blip never re-announces.
        if (!body) { for (const [key, known] of previous) if (known.key === w.key) current.set(key, known); return; }
        const pull = body.current;
        if (!pull || !pull.number || (pull.state && pull.state !== "OPEN")) return;
        current.set(`${w.key}\u0000${pull.number}`, { ...w, number: pull.number, title: pull.title || "", checks: pull.checks ?? null,
          ref: body.host?.terms?.ref || "#" });
      }));
      const settled = ciTransitions(previous, current);
      for (const fn of settledListeners) for (const pull of settled) fn(pull);
      if (notifying()) for (const pull of settled) {
        notify(`${pull.project}: checks ${pull.checks === "failing" ? "failed" : "passed"}`, `${pull.ref}${pull.number} ${pull.title} · ${pull.computer}`);
      }
      previous = current;
      lastLook = [...current.values()];
      for (const fn of listeners) fn(lastLook);
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => { void tick(); }, CI_WATCH_MS);
  // Look early when the watched sessions change (the first look usually runs
  // before the overview has arrived) or a first follower arrives.
  const changed = () => keysOf(watchedSessions(store.sessions())) !== watchedKeys;
  wake = () => { if (lastLook === null || changed()) void tick(); };
  const unsubscribe = store.subscribe(() => { if (changed()) void tick(); });
  void tick();
  return { stop() { clearInterval(timer); unsubscribe(); wake = null; } };
}
