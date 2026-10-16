// What every registered project's checkout says about its open pull requests,
// for Home's Pull requests card, under a load budget: one read per project per
// two minutes (the project page's own read counts: it writes the same cache),
// at most 2 requests at once per computer and 4 in all, and a project whose
// host answered "unavailable" (no host, no checkout, no sign-in) is left alone
// for ten minutes. Nothing is asked while the page is hidden. Plain browser ES module.

import { hookGet } from "../api.js";

export const PULLS_FRESH_MS = 120_000;
export const PULLS_SKIP_MS = 600_000;
// Which projects a computer registers changes rarely; one read per computer per ten minutes.
export const REPOS_FRESH_MS = 600_000;
export const PER_COMPUTER = 2;
export const IN_TOTAL = 4;

const key = (computer, project) => `${computer}\u0000${project}`;
// key -> { at, data } (an answer) or { at, skipUntil } (nothing to show here); shared with the Projects page.
const cache = new Map();
const repoLists = new Map(); // computer -> { at, repos }

/** The Hook's `/v1/projects/:project/git` answer names no host, or says it cannot list. */
export function unavailable(data) {
  return !data || data.available === false || !data.host?.kind;
}

/** The Projects page hands over the read it just made, so Home does not repeat it. */
export function rememberProjectGit(computer, project, data, now = Date.now()) {
  cache.set(key(computer, project), unavailable(data) ? { at: now, data, skipUntil: now + PULLS_SKIP_MS } : { at: now, data });
}

/** A fresh answer for the Projects page: null when none is younger than two minutes. */
export function freshProjectGit(computer, project, now = Date.now()) {
  const hit = cache.get(key(computer, project));
  return hit?.data && now - hit.at < PULLS_FRESH_MS ? hit.data : null;
}

/** What to do about one project now: "use" its cached answer, "skip" it, or "fetch". */
export function planRead(entry, now = Date.now()) {
  if (!entry) return "fetch";
  if (entry.skipUntil && now < entry.skipUntil) return "skip";
  if (now - entry.at < PULLS_FRESH_MS) return entry.data ? "use" : "skip";
  return "fetch";
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

/**
 * The feed: `read()` looks at every online computer's registered projects and
 * calls `onUpdate({ pulls, loading, failed })` as answers land. `pulls` is
 * `[{ computer, project, directory, data }]` for projects that answered with a host.
 */
export function createPullsFeed({ computers, onUpdate, canRead = () => document.visibilityState !== "hidden", now = () => Date.now(), get = hookGet }) {
  const limit = createLimiter();
  let running = null;
  let lastRound = 0;
  // A read still queued when the page is hidden never goes out.
  const guard = () => { if (!canRead()) throw CANCELLED; };

  function snapshot(entries) {
    const pulls = [];
    for (const { computer, project, directory } of entries) {
      const hit = cache.get(key(computer, project));
      if (hit?.data && !unavailable(hit.data)) pulls.push({ computer, project, directory, data: hit.data });
    }
    return pulls;
  }

  async function repos(computer) {
    const hit = repoLists.get(computer);
    if (hit && now() - hit.at < REPOS_FRESH_MS) return hit.repos;
    const body = await limit(computer, () => { guard(); return get(computer, "/v1/projects/repos"); });
    const list = (Array.isArray(body?.repos) ? body.repos : []).filter((r) => r.registered && r.name);
    repoLists.set(computer, { at: now(), repos: list });
    return list;
  }

  async function round() {
    const entries = [];
    let attempted = 0;
    let failed = 0;
    const emit = (loading) => {
      const pulls = snapshot(entries);
      onUpdate({ pulls, loading, failed: !loading && attempted > 0 && failed === attempted && !pulls.length });
    };
    emit(true);
    await Promise.all(computers().map(async (computer) => {
      let list;
      try { list = await repos(computer); } catch (error) { if (error !== CANCELLED) { attempted++; failed++; } return; }
      await Promise.all(list.map(async (repo) => {
        const entry = { computer, project: repo.name, directory: repo.directory };
        entries.push(entry);
        const k = key(computer, repo.name);
        if (planRead(cache.get(k), now()) !== "fetch") return;
        attempted++;
        try {
          const data = await limit(computer, () => { guard(); return get(computer, `/v1/projects/${encodeURIComponent(repo.name)}/git`); });
          rememberProjectGit(computer, repo.name, data, now());
        } catch (error) {
          // No checkout here is an answer, not an outage.
          if (error === CANCELLED) { attempted--; return; }
          if (error?.status === 404) cache.set(k, { at: now(), skipUntil: now() + PULLS_SKIP_MS });
          else failed++;
        }
        emit(true);
      }));
    }));
    lastRound = now();
    emit(false);
  }

  return {
    /** One round, unless one is running or the page is hidden. Per-project freshness keeps repeats cheap. */
    read() {
      if (running) return running;
      if (!canRead() || !computers().length) return Promise.resolve();
      running = round().catch(() => {}).finally(() => { running = null; });
      return running;
    },
    lastRound: () => lastRound,
  };
}

/** For tests. */
export function resetProjectPulls() { cache.clear(); repoLists.clear(); }
