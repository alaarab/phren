import { el } from "../../dom.js";
import { rowShell, age } from "./rows.js";
import { checksWord, hostTerms, pullStanding } from "../../git-review.js";
import { createPullsFeed } from "../../shell/project-pulls.js";

export const PULLS_SHOWN = 8;
export const PULLS_REFRESH_MS = 121_000;

const REVIEW = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required" };

/** Which group a request sorts in: 0 conflicts, 1 changes requested, 2 failing checks, 3 ready to merge, 4 the rest. */
export function pullRank(row) {
  if (row.conflicts) return 0;
  if (row.review === "CHANGES_REQUESTED") return 1;
  if (row.checks === "failing") return 2;
  if (row.review === "APPROVED" && row.checks === "passing" && !row.draft) return 3;
  return 4;
}

/** Ranks 0 to 3 are the ones that need someone. */
export const needsAction = (row) => row.rank < 4;

/**
 * One row per open request across every project the feeds answered: the same
 * repository seen from several computers (same host, repository and number)
 * counts once, taking the richer read. Sorted by `pullRank`, newest first
 * within a rank.
 */
export function inboxRows(reads) {
  const byKey = new Map();
  for (const { computer, project, directory, data } of reads) {
    const host = data?.host ?? null;
    const repo = String(host?.webUrl || host?.domain || `${computer}/${project}`).toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
    const current = data?.current && typeof data.current.number === "number" ? data.current : null;
    for (const listed of Array.isArray(data?.pulls) ? data.pulls : []) {
      if (typeof listed?.number !== "number") continue;
      // The checked-out branch's own request is read in full; the list is thinner.
      const pull = current && current.number === listed.number ? { ...listed, ...current } : listed;
      const row = {
        key: `${repo}#${pull.number}`, computer, project, directory, host, terms: hostTerms(host),
        number: pull.number, title: String(pull.title ?? ""), author: String(pull.author ?? ""), url: String(pull.url ?? ""),
        checks: pull.checks ?? "", review: pull.reviewDecision ?? "", mergeState: pull.mergeState ?? "",
        conflicts: pull.conflicts === true || pull.mergeState === "DIRTY", behind: pull.mergeState === "BEHIND",
        draft: pull.draft === true || pull.mergeState === "DRAFT", comments: Number(pull.comments) || 0,
        updated: String(pull.updated ?? ""), pipeline: host?.kind === "gitlab" || host?.kind === "gitboy",
        standing: pullStanding(pull),
      };
      row.rank = pullRank(row);
      const seen = byKey.get(row.key);
      if (!seen || detail(row) > detail(seen)) byKey.set(row.key, seen ? { ...row, computer: seen.computer, project: seen.project, directory: seen.directory } : row);
    }
  }
  const time = (row) => Date.parse(row.updated) || 0;
  return [...byKey.values()].sort((a, b) => a.rank - b.rank || time(b) - time(a) || b.number - a.number);
}

// How much one read says about a request, to pick between copies of the same one.
const detail = (row) => (row.checks ? 1 : 0) + (row.review ? 1 : 0) + (row.mergeState ? 1 : 0);

/** What the card calls its requests: "pull requests", "merge requests" (every host GitLab) or both. */
export function inboxWords(rows) {
  const longs = new Set(rows.map((row) => row.terms.long));
  const shorts = new Set(rows.map((row) => row.terms.short));
  if (longs.size === 1) return { plural: `${[...longs][0]}s`, short: `${[...shorts][0]}s` };
  return { plural: "pull and merge requests", short: "requests" };
}

const capital = (text) => text[0].toUpperCase() + text.slice(1);

export function createPulls({ block, computers, openProject, isVisible, now = () => Date.now() }) {
  let result = { pulls: [], loading: false, failed: false };
  let expanded = false;
  let timer = null;
  const feed = createPullsFeed({
    computers,
    onUpdate(update) { result = update; render(); },
    canRead: () => isVisible() && document.visibilityState !== "hidden",
    now,
  });
  function row(item) {
    const shell = rowShell({ tone: item.rank < 3 ? "failed" : item.rank === 3 ? "done" : undefined, sub: undefined });
    shell.button.classList.add("home-pull");
    shell.button.dataset.key = item.key;
    shell.title.textContent = `${item.terms.ref}${item.number} ${item.title}`;
    shell.title.title = [item.standing, item.comments ? `${item.comments} comment${item.comments === 1 ? "" : "s"}` : "", item.url].filter(Boolean).join(" · ");
    const meta = el("span", "home-row-meta home-pull-meta");
    const project = el("span", "home-project", item.project);
    project.title = `${item.project} · ${item.computer}`;
    meta.append(project);
    if (item.author) meta.append(el("span", "home-pull-author", `@${item.author}`));
    const word = checksWord(item.checks, item.pipeline ? "Pipeline" : "Checks");
    if (word) meta.append(el("span", `home-pull-checks ${item.checks}`, word));
    if (REVIEW[item.review]) meta.append(el("span", `home-pull-chip review-${item.review.toLowerCase()}`, REVIEW[item.review]));
    if (item.conflicts) meta.append(el("span", "home-pull-chip conflicts", "Conflicts"));
    else if (item.behind) meta.append(el("span", "home-pull-chip behind", "Behind"));
    if (item.draft) meta.append(el("span", "home-pull-chip draft", "Draft"));
    const when = age(item.updated);
    if (when) meta.append(el("span", "home-age", when));
    shell.button.append(meta);
    shell.button.addEventListener("click", () => openProject(item));
    return shell.button;
  }

  function render() {
    const scope = block("pulls");
    if (!scope) return;
    const rows = inboxRows(result.pulls);
    const words = inboxWords(rows.length ? rows : [{ terms: hostTerms(null) }]);
    const loadingOnly = result.loading && !rows.length;
    scope.hidden = !(rows.length || loadingOnly || result.failed);
    scope.querySelector(".pulls-title").textContent = capital(rows.length ? words.plural : "pull requests");
    scope.querySelector(".count").textContent = rows.length ? String(rows.length) : "";
    const list = scope.querySelector(".home-list");
    if (!rows.length) {
      list.replaceChildren(result.failed ? el("div", "home-empty danger", "Could not read pull requests from your computers.") : el("div", "home-empty", "Reading pull requests…"));
      return;
    }
    const shown = expanded ? rows : rows.slice(0, PULLS_SHOWN);
    const nodes = shown.map(row);
    if (rows.length > PULLS_SHOWN) {
      const more = el("button", "home-more", expanded ? "Show fewer" : `Show all ${rows.length} ${words.short}`);
      more.type = "button";
      more.addEventListener("click", () => { expanded = !expanded; render(); });
      nodes.push(more);
    }
    list.replaceChildren(...nodes);
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { void feed.read().then(() => { if (timer !== null) schedule(); }); }, PULLS_REFRESH_MS);
  }
  const onVisibility = () => { if (isVisible() && document.visibilityState !== "hidden") void feed.read(); };

  return {
    render,
    /** Home's online computers changed (or Home opened): read what is missing or stale. */
    update() { if (isVisible()) void feed.read(); },
    show() {
      document.addEventListener("visibilitychange", onVisibility);
      void feed.read();
      schedule();
      render();
    },
    hide() {
      clearTimeout(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
