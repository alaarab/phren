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

// Baselines outlive a request leaving the watch set or a failed read this long.
export const REVIEW_GRACE_MS = 6 * 3_600_000;
// A review change this soon after the owner's own action in the app is not news.
export const OWN_ACTION_MS = 120_000;

/** One request across every session and computer that sees it: its web URL
 *  without the request path (host + repository + number), else project + number. */
export function prKey(pull, project) {
  const url = typeof pull.url === "string" ? pull.url.replace(/\/(?:-\/)?(?:pull|pulls|merge_requests)\/\d+.*$/, "") : "";
  return /^https?:\/\//.test(url) ? `${url.toLowerCase()}#${pull.number}` : `${project}#${pull.number}`;
}

const NOT_CONFLICTED = new Set(["CLEAN", "BLOCKED", "BEHIND", "UNSTABLE", "HAS_HOOKS", "DRAFT"]);

/** What a look tells about a request's review and merge state, on top of what
 *  was known: `known` is `{ approved, changes, conflicts }` or undefined. A
 *  missing decision or an UNKNOWN merge state says nothing, so the known
 *  value is carried; a state clears only on a positive opposite value
 *  (CLEAN, BLOCKED or BEHIND clears conflicts; REVIEW_REQUIRED or
 *  CHANGES_REQUESTED clears approval; APPROVED or REVIEW_REQUIRED clears
 *  changes requested). Returns the new state and the states that just began;
 *  nothing begins on first sight. */
export function reviewStep(known, { decision, mergeState, conflicts }) {
  const was = known ?? { approved: false, changes: false, conflicts: false };
  const next = {
    changes: decision === "CHANGES_REQUESTED" ? true : decision === "APPROVED" || decision === "REVIEW_REQUIRED" ? false : was.changes,
    approved: decision === "APPROVED" ? true : decision === "CHANGES_REQUESTED" || decision === "REVIEW_REQUIRED" ? false : was.approved,
    conflicts: mergeState === "DIRTY" || conflicts === true ? true : NOT_CONFLICTED.has(mergeState) ? false : was.conflicts,
  };
  const began = known ? ["changes", "approved", "conflicts"].filter((state) => next[state] && !was[state]) : [];
  return { next, began };
}

/** The notification for one review transition: title and body. */
export function reviewNotice({ pull, state }) {
  const ref = `${pull.ref || "#"}${pull.number}`;
  const title = state === "changes" ? `Changes requested on ${ref} ${pull.title}`
    : state === "approved" ? `Approved: ${ref} ${pull.title}`
    : `${ref} ${pull.title} now has conflicts`;
  return { title: title.trim(), body: `${pull.project} \u00b7 ${pull.computer}` };
}

/** The shell key of a pull request notification: its computer and project,
 *  then the session that carries it, so a click can fall back to the project. */
export function pullsKey(pull) {
  return `pulls:${encodeURIComponent(pull.computer)}|${encodeURIComponent(pull.project)}|${pull.key}`;
}

/** Read a `pulls:` key back: `{ computer, project, session }`, or null. */
export function parsePullsKey(key) {
  if (!key.startsWith("pulls:")) return null;
  const [computer, project, ...rest] = key.slice(6).split("|");
  if (rest.length === 0) return null;
  try { return { computer: decodeURIComponent(computer), project: decodeURIComponent(project), session: rest.join("|") }; }
  catch { return null; }
}

const ownActions = new Map();

/** The owner approved, merged or asked for changes in the app: a review change
 *  on that request in the next two minutes is not announced. `pull` has `url`,
 *  `number` and `project`. */
export function noteOwnAction(pull, now = Date.now()) {
  ownActions.set(prKey(pull, pull.project), now);
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

/** Fold one tick's reads into the baselines; returns the transitions to
 *  announce, one per request, carried by its most recently active session.
 *  Requests not read this tick (a failed read, a session that left) keep
 *  their baseline for REVIEW_GRACE_MS. Mutates `reviews`. */
export function reviewLook(reviews, seen, now) {
  const byPr = new Map();
  for (const item of seen) {
    const id = prKey(item.pull, item.w.project);
    const held = byPr.get(id);
    const at = Date.parse(item.w.child?.lastChangedAt ?? "") || 0;
    if (!held || at > held.at) byPr.set(id, { ...item, at });
  }
  const out = [];
  for (const [id, { w, pull, ref }] of byPr) {
    const { next, began } = reviewStep(reviews.get(id)?.state, { decision: pull.reviewDecision, mergeState: pull.mergeState, conflicts: pull.conflicts });
    reviews.set(id, { state: next, seenAt: now });
    const own = now - (ownActions.get(id) ?? -Infinity) < OWN_ACTION_MS;
    if (own) continue;
    const info = { ...w, number: pull.number, title: pull.title || "", ref };
    for (const state of began) out.push({ pull: info, state });
  }
  for (const [id, held] of reviews) if (now - held.seenAt > REVIEW_GRACE_MS) reviews.delete(id);
  for (const [id, at] of ownActions) if (now - at > OWN_ACTION_MS) ownActions.delete(id);
  return out;
}

/** Start watching; `notify(title, body, { key })` is the shell's (absent in a
 *  browser), `enabled()` the checks notification setting, `reviewEnabled()` the
 *  review and conflicts one. A notification's key is `pullsKey`. */
export function startCiWatch({ notify, enabled, reviewEnabled = () => false }) {
  let previous = new Map();
  const reviews = new Map(); // prKey -> { state, seenAt }: the baselines, kept REVIEW_GRACE_MS
  let running = false;
  let watchedKeys = "";
  const notifying = () => !!notify && (enabled() || reviewEnabled());
  async function tick() {
    if (running || !(notifying() || interest > 0)) return;
    running = true;
    try {
      const current = new Map();
      const seen = [];
      const watched = watchedSessions(store.sessions());
      watchedKeys = keysOf(watched);
      await Promise.all(watched.map(async (w) => {
        const body = await hookPost(w.computer, "/v1/git/pulls", { target: w.target }).catch(() => null);
        // A failed read keeps what was known, so a passing blip never re-announces.
        if (!body) { for (const [key, known] of previous) if (known.key === w.key) current.set(key, known); return; }
        const pull = body.current;
        if (!pull || !pull.number || (pull.state && pull.state !== "OPEN")) return;
        current.set(`${w.key}\u0000${pull.number}`, { ...w, number: pull.number, title: pull.title || "", checks: pull.checks ?? null,
          url: pull.url,
          ref: body.host?.terms?.ref || "#" });
        seen.push({ w, pull, ref: body.host?.terms?.ref || "#" });
      }));
      const settled = ciTransitions(previous, current);
      for (const fn of settledListeners) for (const pull of settled) fn(pull);
      // One notice per request, however many sessions or computers see it.
      const told = new Set();
      if (notify && enabled()) for (const pull of settled) {
        const id = prKey({ number: pull.number, url: pull.url }, pull.project);
        if (told.has(id)) continue;
        told.add(id);
        notify(`${pull.project}: checks ${pull.checks === "failing" ? "failed" : "passed"}`, `${pull.ref}${pull.number} ${pull.title} · ${pull.computer}`);
      }
      for (const change of reviewLook(reviews, seen, Date.now())) {
        if (!reviewEnabled()) continue;
        const { title, body } = reviewNotice(change);
        notify(title, body, { key: pullsKey(change.pull) });
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
