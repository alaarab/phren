// What every registered project's checkout says about its open pull requests,
// for Home's Pull requests card. Each `GET /v1/projects/:project/git` costs the
// Hook about ten git subprocesses and a forge call, so the card reads gently:
//  - every 5 minutes while Home is visible and the window has focus, every 15
//    while it is visible without focus, never while hidden;
//  - only projects with a session active in the last 7 days or an open request
//    last time ("hot"); the others at most every 30 minutes;
//  - not from a computer that is stressed or low on battery (like hover prefetch);
//  - at most 2 requests at once per computer and 4 in all, through the same
//    hookGet pool as every other read;
//  - a host that answers "no host", "sign in" or "no checkout" is left alone for
//    ten minutes, but a transient failure (timeout, rate limit, gh offline)
//    never replaces what was read before: the old rows stay, marked stale.
// The Projects page writes the same cache. Plain browser ES module.

import { hookGet } from "../api.js";

export const CADENCE_FOCUSED_MS = 300_000;
export const CADENCE_BLURRED_MS = 900_000;
export const COLD_MS = 1_800_000;
export const ACTIVE_MS = 7 * 86_400_000;
/** A read older than this is dropped from the card. */
export const DROP_MS = 1_200_000;
export const SKIP_MS = 600_000;
// Which projects a computer registers changes rarely; one read per computer per ten minutes.
export const REPOS_FRESH_MS = 600_000;
/** How long the Projects page treats an answer as fresh. */
export const PAGE_FRESH_MS = 120_000;
export const PER_COMPUTER = 2;
export const IN_TOTAL = 4;

const key = (computer, project) => `${computer}\u0000${project}`;
// key -> { at, tried, data, stale, failed, skipUntil, hadPulls }; shared with the Projects page.
const cache = new Map();
const repoLists = new Map(); // computer -> { at, repos }

/** "ok" (a host listed requests), "permanent" (no host, no sign-in: nothing to retry soon) or "transient". */
export function classify(data) {
  if (data && data.available !== false && data.host?.kind) return "ok";
  if (!data?.host?.kind || data.reason === "unknown-host" || data.reason === "auth") return "permanent";
  return "transient";
}

/**
 * Record one project's answer. A good answer replaces the entry. A bad one keeps
 * earlier good data (marked stale, tried now); with none, a permanent answer sets
 * the ten-minute skip and a transient one is a failed read to try again next round.
 * Returns "ok", "stale", "skip" or "failed".
 */
export function rememberProjectGit(computer, project, data, now = Date.now()) {
  const kind = classify(data);
  if (kind === "ok") {
    cache.set(key(computer, project), { at: now, tried: now, data, hadPulls: Array.isArray(data.pulls) && data.pulls.length > 0 });
    return "ok";
  }
  return recordBad(computer, project, kind, now);
}

/** The read itself failed (network, timeout): transient by definition. */
export function rememberFailure(computer, project, now = Date.now()) {
  return recordBad(computer, project, "transient", now);
}

function recordBad(computer, project, kind, now) {
  const k = key(computer, project);
  const prev = cache.get(k);
  if (prev?.data) { cache.set(k, { ...prev, tried: now, stale: true, failed: kind === "transient" }); return "stale"; }
  if (kind === "permanent") { cache.set(k, { at: now, tried: now, skipUntil: now + SKIP_MS }); return "skip"; }
  cache.set(k, { at: now, tried: now, failed: true });
  return "failed";
}

/** No checkout (or no route): an answer, not an outage. */
export function rememberNoCheckout(computer, project, now = Date.now()) {
  cache.set(key(computer, project), { at: now, tried: now, skipUntil: now + SKIP_MS });
}

/** A fresh, good answer for the Projects page; null for stale, unavailable or older than two minutes. */
export function freshProjectGit(computer, project, now = Date.now()) {
  const hit = cache.get(key(computer, project));
  if (!hit?.data || hit.stale || classify(hit.data) !== "ok") return null;
  return now - hit.at < PAGE_FRESH_MS ? hit.data : null;
}

/** What to do about one project now: "fetch", or "skip" (fresh enough, or told to leave it alone). */
export function planRead(entry, now, ttl) {
  if (!entry) return "fetch";
  if (entry.skipUntil && now < entry.skipUntil) return "skip";
  return now - (entry.tried ?? entry.at) < ttl ? "skip" : "fetch";
}

/** Run jobs with at most `total` running and `per` per computer: `limit(computer, run)`. */
export function createLimiter(per = PER_COMPUTER, total = IN_TOTAL) {
  let running = 0;
  const byComputer = new Map();
  const queue = [];
  function pump() {
    for (let i = 0; i < queue.length && running < total; i++) {
      const job = queue[i];
      if ((byComputer.get(job.computer) ?? 0) >= per) continue;
      queue.splice(i--, 1);
      running++;
      byComputer.set(job.computer, (byComputer.get(job.computer) ?? 0) + 1);
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
        running--;
        byComputer.set(job.computer, byComputer.get(job.computer) - 1);
        pump();
      });
    }
  }
  return (computer, run) => new Promise((resolve, reject) => { queue.push({ computer, run, resolve, reject }); pump(); });
}

const CANCELLED = Symbol("cancelled");
const defaultCadence = () => (typeof document !== "undefined" && document.hasFocus?.() !== false ? CADENCE_FOCUSED_MS : CADENCE_BLURRED_MS);

/**
 * The feed: `read()` looks at every online computer's registered projects and
 * calls `onUpdate({ pulls, loading, failed, unread, unreadComputers })` as answers
 * land. `pulls` is `[{ computer, project, directory, data, at, stale }]`.
 * `active(computer, project)` says a session there moved in the last 7 days;
 * `ready(computer)` says it may be read (not stressed, not low on battery);
 * `read({ force: true })` ignores freshness, skips and readiness.
 */
export function createPullsFeed({
  computers, onUpdate, active = () => false, ready = () => true,
  canRead = () => document.visibilityState !== "hidden", cadence = defaultCadence, now = () => Date.now(), get = hookGet,
}) {
  const limit = createLimiter();
  let running = null;
  let lastRound = 0;
  let settled = true;
  const failedComputers = new Set();
  // A read still queued when the page is hidden never goes out.
  const guard = () => { if (!canRead()) throw CANCELLED; };

  function snapshot(entries) {
    const pulls = [];
    let unread = 0;
    let readable = 0;
    for (const { computer, project, directory } of entries) {
      const hit = cache.get(key(computer, project));
      if (hit?.skipUntil && now() < hit.skipUntil) continue;
      readable++;
      const old = hit?.data && now() - hit.at > DROP_MS;
      if (hit?.data && !old) pulls.push({ computer, project, directory, data: hit.data, at: hit.at, stale: hit.stale === true });
      if (hit?.failed || hit?.stale || old) unread++;
    }
    return { pulls, unread, readable };
  }

  async function repos(computer, force) {
    const hit = repoLists.get(computer);
    if (hit && !force && now() - hit.at < REPOS_FRESH_MS) return hit.repos;
    const body = await limit(computer, () => { guard(); return get(computer, "/v1/projects/repos"); });
    const list = (Array.isArray(body?.repos) ? body.repos : []).filter((r) => r.registered && r.name);
    repoLists.set(computer, { at: now(), repos: list });
    return list;
  }

  async function round(force) {
    settled = false;
    const entries = [];
    let attempted = 0;
    let failed = 0;
    failedComputers.clear();
    const emit = (loading) => {
      const { pulls, unread, readable } = snapshot(entries);
      onUpdate({ pulls, loading, unread, unreadComputers: failedComputers.size,
        failed: !loading && !pulls.length && (failedComputers.size > 0 || (readable > 0 && unread === readable)) && attempted > 0 && failed === attempted });
    };
    emit(true);
    const hotTtl = force ? 0 : cadence();
    await Promise.all(computers().map(async (computer) => {
      if (!force && !ready(computer)) {
        // Not read now; keep showing what was read, and the repos it listed.
        for (const repo of repoLists.get(computer)?.repos ?? []) entries.push({ computer, project: repo.name, directory: repo.directory });
        return;
      }
      let list;
      try { list = await repos(computer, force); } catch (error) {
        if (error !== CANCELLED) { attempted++; failed++; failedComputers.add(computer); }
        return;
      }
      await Promise.all(list.map(async (repo) => {
        entries.push({ computer, project: repo.name, directory: repo.directory });
        const k = key(computer, repo.name);
        const prev = cache.get(k);
        const hot = active(computer, repo.name) || prev?.hadPulls === true;
        const ttl = force ? 0 : hot ? hotTtl : Math.max(hotTtl, COLD_MS);
        if (!force && planRead(prev, now(), ttl) !== "fetch") return;
        attempted++;
        try {
          const data = await limit(computer, () => { guard(); return get(computer, `/v1/projects/${encodeURIComponent(repo.name)}/git`); });
          if (rememberProjectGit(computer, repo.name, data, now()) === "failed") failed++;
        } catch (error) {
          if (error === CANCELLED) { attempted--; return; }
          if (error?.status === 404) rememberNoCheckout(computer, repo.name, now());
          else { failed++; rememberFailure(computer, repo.name, now()); }
        }
        emit(true);
      }));
    }));
    lastRound = now();
    settled = true;
    emit(false);
  }

  return {
    /** One round, unless one is running or the page is hidden. Per-project freshness keeps repeats cheap. */
    read({ force = false } = {}) {
      if (running) return running;
      if (!canRead() || !computers().length) return Promise.resolve();
      running = round(force).catch(() => {}).finally(() => { running = null; });
      return running;
    },
    busy: () => !settled,
    lastRound: () => lastRound,
    cadence,
  };
}

/** For tests. */
export function resetProjectPulls() { cache.clear(); repoLists.clear(); }
