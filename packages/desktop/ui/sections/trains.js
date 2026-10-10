// Trains: release trains. Groups the open PRs waiting to ship per repository,
// along with the head commit's checks, the integrator for that computer and the
// owner's release authority. Merge and Publish appear only where the policy is
// ask-first; pressing one confirms the action through the Hook.
import { hookGet, hookPost } from "../api.js";
import { projectOf, sessions, store } from "../shell/store.js";

const CSS_ID = "trains-css";
const POLL_MS = 15_000;
const RELEASE_ACTIONS = ["merge", "publish", "deploy", "app-store", "github-admin"];
const RC_RE = /release[_\s-]?candidate|(^|[^a-z0-9])rc([^a-z0-9]|$)/i;

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement("link");
  link.id = CSS_ID;
  link.rel = "stylesheet";
  link.href = "./sections/trains.css";
  document.head.append(link);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A short age: "now", "5m", "3h", "2d". */
function age(iso) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const repoBasename = (repo) => String(repo ?? "").split("/").filter(Boolean).pop() ?? "";

function prNumber(url) {
  const match = /\/pull\/(\d+)/.exec(String(url ?? ""));
  return match ? Number(match[1]) : null;
}

/** A single check's word: failing, pending or passing. */
function checkWord(value) {
  if (typeof value === "string") {
    const v = value.toLowerCase();
    if (["failing", "failure", "failed", "error", "timed_out", "cancelled"].includes(v)) return "failing";
    if (["passing", "success", "successful", "completed", "neutral", "skipped"].includes(v)) return "passing";
    return "pending";
  }
  if (value && typeof value === "object") {
    const conclusion = String(value.conclusion ?? "").toUpperCase();
    const state = String(value.state ?? "").toUpperCase();
    const status = String(value.status ?? "").toUpperCase();
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"].includes(conclusion)
      || ["FAILURE", "ERROR"].includes(state)) return "failing";
    if (state && !status) return state === "SUCCESS" ? "passing" : "pending";
    if (status && status !== "COMPLETED") return "pending";
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) return "passing";
    return "pending";
  }
  return "pending";
}

/**
 * A check rollup in the shape the Hook exposes (a single word on `current`) or
 * a richer one (an array or name map of checks). Returns `{ state, counts, rc }`
 * where `rc` names a release-candidate check when one is present, or null.
 */
function normalizeChecks(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    return { state: checkWord(raw), counts: null, rc: null };
  }
  const entries = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === "object") entries.push({ name: String(item.name ?? item.context ?? ""), value: item });
      else entries.push({ name: "", value: item });
    }
  } else if (typeof raw === "object") {
    for (const [name, value] of Object.entries(raw)) entries.push({ name, value });
  } else return null;
  if (!entries.length) return null;
  const counts = { passing: 0, failing: 0, pending: 0 };
  let rc = null;
  for (const { name, value } of entries) {
    const state = checkWord(value);
    counts[state] += 1;
    if (name && RC_RE.test(name)) rc = { name, state };
  }
  const state = counts.failing ? "failing" : counts.pending ? "pending" : "passing";
  return { state, counts, rc };
}

export function mountTrains(container) {
  ensureCss();
  container.innerHTML = `
    <div class="trains">
      <aside class="trains-repos">
        <div class="trains-repos-head">
          <span class="trains-title">Trains</span>
          <span class="trains-sub" data-sub></span>
        </div>
        <div class="trains-repos-list" data-repos></div>
      </aside>
      <section class="trains-detail" data-detail></section>
    </div>`;

  const subEl = container.querySelector("[data-sub]");
  const reposEl = container.querySelector("[data-repos]");
  const detailEl = container.querySelector("[data-detail]");

  const state = {
    returns: new Map(),      // computer -> receipts[]
    pulls: new Map(),        // "computer\0project" -> { available, pulls, current, error }
    authority: new Map(),    // computer -> { source, byProject: Map, list }
    integrators: new Map(),  // computer -> Integrator | null
    selected: null,
    confirm: null,           // { key, action, project, computer, status, note }
    visible: false,
    error: "",
  };

  const onlineComputers = () => (store.merged?.computers ?? []).filter((c) => c.state === "online").map((c) => c.computer);
  const isOnline = (computer) => (store.merged?.computers ?? []).some((c) => c.computer === computer && c.state === "online");

  // ---- data -----------------------------------------------------------

  async function loadReturns(computer) {
    const body = await hookGet(computer, "/v1/dispatch").catch(() => null);
    state.returns.set(computer, Array.isArray(body?.dispatches) ? body.dispatches : []);
  }

  async function loadAuthority(computer) {
    try {
      const body = await hookGet(computer, "/v1/authority");
      const list = Array.isArray(body?.projects) ? body.projects : [];
      state.authority.set(computer, { source: body?.source, list, byProject: new Map(list.map((p) => [p.project, p])) });
    } catch { state.authority.delete(computer); }
  }

  async function loadIntegrator(computer) {
    const body = await hookGet(computer, "/v1/conductor/integrator").catch(() => null);
    state.integrators.set(computer, body?.integrator ?? null);
  }

  async function loadPull(computer, project, target) {
    const key = `${computer}\u0000${project}`;
    try {
      const body = await hookPost(computer, "/v1/git/pulls", { target });
      state.pulls.set(key, {
        available: body?.available === true,
        pulls: Array.isArray(body?.pulls) ? body.pulls : [],
        current: body?.current ?? null, error: "",
      });
    } catch (err) {
      state.pulls.set(key, { available: false, pulls: [], current: null, error: err?.message || String(err) });
    }
  }

  async function loadPulls() {
    const seen = new Set();
    const jobs = [];
    for (const row of sessions()) {
      if (!isOnline(row.computer)) continue;
      const project = projectOf(row.child);
      const key = `${row.computer}\u0000${project}`;
      if (!project || seen.has(key)) continue;
      seen.add(key);
      jobs.push(loadPull(row.computer, project, row.child.target));
    }
    await Promise.all(jobs);
  }

  async function poll() {
    const computers = onlineComputers();
    await Promise.all([
      ...computers.map(loadReturns),
      ...computers.map(loadAuthority),
      ...computers.map(loadIntegrator),
      loadPulls(),
    ]);
    render();
  }

  // ---- grouping -------------------------------------------------------

  function authorityFor(computer, project, repo) {
    const policy = state.authority.get(computer);
    if (!policy) return null;
    const slug = project || repoBasename(repo);
    const entry = policy.byProject.get(slug) ?? policy.byProject.get(repoBasename(repo)) ?? null;
    if (entry) return entry;
    return { project: slug, listed: false, go: [...RELEASE_ACTIONS], ask: [] };
  }

  function mergePr(group, key, data) {
    if (!key) return;
    let pr = group.prs.get(key);
    if (!pr) {
      pr = { key, number: data.number ?? null, title: "", branch: "", url: "", worker: "", author: "",
        draft: false, state: "", updated: "", checks: null, tests: "" };
      group.prs.set(key, pr);
    }
    if (data.number != null) pr.number = data.number;
    if (data.title) pr.title = data.title;
    if (data.branch || data.head) pr.branch = data.branch || data.head;
    if (data.url) pr.url = data.url;
    if (data.worker) pr.worker = data.worker;
    if (data.author) pr.author = data.author;
    if (data.draft != null) pr.draft = !!data.draft;
    if (data.state) pr.state = data.state;
    if (data.updated) pr.updated = data.updated;
    if (data.tests) pr.tests = data.tests;
    if (data.checks != null) pr.checks = normalizeChecks(data.checks) ?? pr.checks;
  }

  function buildRepos() {
    const groups = new Map();
    const ensure = (computer, name, seed) => {
      const key = `${computer}\u0000${name.toLowerCase()}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, computer, repo: seed.repo || name, project: seed.project || name, prs: new Map() };
        groups.set(key, group);
      } else {
        if (seed.repo && seed.repo.includes("/")) group.repo = seed.repo;
        if (seed.project) group.project = seed.project;
      }
      return group;
    };

    for (const [computer, list] of state.returns) {
      for (const receipt of list) {
        const prs = receipt.returned?.prs;
        if (!Array.isArray(prs) || !prs.length) continue;
        const project = String(receipt.project ?? "");
        for (const raw of prs) {
          if (!raw || typeof raw !== "object") continue;
          const repo = String(raw.repo ?? "");
          const name = repoBasename(repo) || project;
          if (!name) continue;
          const group = ensure(computer, name, { repo, project });
          const number = prNumber(raw.url);
          const prKey = number != null ? `#${number}` : (raw.url || raw.branch || "");
          mergePr(group, prKey, { number, branch: String(raw.branch ?? ""), url: String(raw.url ?? ""),
            worker: String(receipt.label || receipt.project || receipt.id || ""), tests: String(raw.tests ?? "") });
        }
      }
    }

    for (const row of sessions()) {
      if (!isOnline(row.computer)) continue;
      const project = projectOf(row.child);
      const entry = state.pulls.get(`${row.computer}\u0000${project}`);
      if (!entry?.available) continue;
      const group = ensure(row.computer, project, { repo: project, project });
      for (const pull of entry.pulls) if (pull && pull.number != null) mergePr(group, `#${pull.number}`, pull);
      const current = entry.current;
      if (current && current.number != null) {
        const pr = group.prs.get(`#${current.number}`);
        if (pr) pr.checks = normalizeChecks(current.checks) ?? pr.checks;
      }
    }

    const list = [...groups.values()];
    for (const group of list) {
      group.integrator = state.integrators.get(group.computer) ?? null;
      group.authority = authorityFor(group.computer, group.project, group.repo);
    }
    list.sort((a, b) => a.repo.localeCompare(b.repo));
    return list;
  }

  // ---- render ---------------------------------------------------------

  let repos = [];
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function worstChecks(group) {
    let seen = null;
    for (const pr of group.prs.values()) {
      if (!pr.checks) continue;
      if (pr.checks.state === "failing") return "failing";
      if (pr.checks.state === "pending") seen = "pending";
      else if (!seen) seen = "passing";
    }
    return seen;
  }

  function checksChip(checks) {
    const label = checks.counts
      ? [`${checks.counts.passing} pass`, checks.counts.failing ? `${checks.counts.failing} fail` : "",
        checks.counts.pending ? `${checks.counts.pending} pending` : ""].filter(Boolean).join(" · ")
      : (checks.state === "passing" ? "checks pass" : checks.state === "failing" ? "checks fail" : "checks pending");
    return el("span", `trains-chip ${checks.state}`, label);
  }

  function integratorLabel(group) {
    const it = group.integrator;
    if (!it) return "none set";
    const target = it.target ?? {};
    const session = String(target.session || "").replace(/^sess[-_]?/, "");
    const where = session || target.workspace || target.pane || "";
    return where ? `${it.computer || group.computer} · ${where}` : (it.computer || group.computer);
  }

  function authorityLine(group) {
    const wrap = el("div", "trains-authority");
    if (!group.authority) {
      wrap.append(el("span", "trains-note", `Release authority is not available on ${group.computer}.`));
      return wrap;
    }
    for (const action of RELEASE_ACTIONS) {
      const ask = (group.authority.ask ?? []).includes(action);
      wrap.append(el("span", `trains-chip ${ask ? "ask" : "go"}`, `${action}: ${ask ? "ask-first" : "autonomous"}`));
    }
    return wrap;
  }

  function repoRow(group) {
    const row = el("button", `trains-row${group.key === state.selected ? " selected" : ""}`);
    const main = el("div", "trains-row-main");
    main.append(el("div", "trains-row-title", group.repo));
    const meta = el("div", "trains-row-meta");
    const checks = worstChecks(group);
    if (checks) meta.append(el("span", `trains-chip ${checks}`, checks));
    meta.append(el("span", "trains-row-host", group.computer));
    main.append(meta);
    row.append(main, el("span", "trains-row-count", String(group.prs.size)));
    row.addEventListener("click", () => select(group.key));
    return row;
  }

  function renderRepos() {
    reposEl.replaceChildren();
    if (!repos.length) {
      const text = !onlineComputers().length ? "No computer online."
        : state.error || "No open pull requests waiting.";
      reposEl.append(el("div", "trains-empty", text));
      return;
    }
    const head = el("div", "trains-group");
    head.append(el("span", "trains-group-label", "Repositories"), el("span", "trains-group-count", String(repos.length)));
    reposEl.append(head, ...repos.map(repoRow));
  }

  function prRow(group, pr) {
    const wrap = el("div", "trains-pr");
    const main = el("div", "trains-pr-main");
    const body = el("div", "trains-pr-main-body");
    const title = pr.url ? el("a", "trains-pr-title") : el("div", "trains-pr-title");
    if (pr.url) { title.href = pr.url; title.target = "_blank"; title.rel = "noopener noreferrer"; }
    if (pr.number != null) title.append(el("span", "trains-pr-number", `#${pr.number} `));
    title.append(document.createTextNode(pr.title || pr.branch || pr.url || "Pull request"));
    body.append(title);

    const meta = el("div", "trains-pr-meta");
    if (pr.branch) meta.append(el("span", "trains-pr-branch", pr.branch));
    const who = pr.worker || pr.author;
    if (who) meta.append(el("span", "trains-pr-author", who));
    if (pr.draft) meta.append(el("span", "trains-chip", "draft"));
    if (pr.checks) meta.append(checksChip(pr.checks));
    if (pr.checks?.rc) meta.append(el("span", "trains-chip rc", `RC ${pr.checks.rc.state}`));
    if (pr.tests) { const note = el("span", "trains-autonomous", pr.tests); note.title = pr.tests; meta.append(note); }
    const updated = age(pr.updated);
    if (updated) meta.append(el("span", "trains-pr-age", updated));
    for (const action of ["merge", "publish"]) {
      if (actionVerdict(group, action) === "go") {
        meta.append(el("span", "trains-autonomous", action === "merge" ? "The integrator merges this" : "The integrator publishes this"));
      }
    }
    body.append(meta);
    main.append(body);

    const actions = el("div", "trains-pr-actions");
    for (const action of ["merge", "publish"]) {
      if (actionVerdict(group, action) !== "ask") continue;
      const btn = el("button", "trains-btn accent", cap(action));
      const busy = state.confirm?.status === "saving" && state.confirm?.groupKey === group.key && state.confirm?.prKey === pr.key;
      btn.disabled = busy;
      btn.addEventListener("click", () => askConfirm(group, pr, action));
      actions.append(btn);
    }
    if (actions.childNodes.length) main.append(actions);
    wrap.append(main);
    if (state.confirm?.groupKey === group.key && state.confirm?.prKey === pr.key) wrap.append(inlineConfirm(group, pr));
    return wrap;
  }

  function actionVerdict(group, action) {
    if (!group.authority) return null;
    return (group.authority.ask ?? []).includes(action) ? "ask" : "go";
  }

  function renderDetail() {
    detailEl.replaceChildren();
    const group = repos.find((g) => g.key === state.selected) ?? null;
    if (!group) { detailEl.append(el("div", "trains-empty", "Select a repository.")); return; }

    const head = el("div", "trains-head");
    const top = el("div", "trains-head-top");
    top.append(el("div", "trains-head-title", group.repo));
    head.append(top);
    const meta = el("div", "trains-head-meta");
    meta.append(el("span", "trains-meta-label", "on"), el("span", "trains-row-host", group.computer));
    if (group.project) meta.append(el("span", "trains-row-repo mono", group.project));
    meta.append(el("span", "trains-meta-label", "integrator"), el("span", "trains-integrator", integratorLabel(group)));
    head.append(meta);
    head.append(authorityLine(group));
    detailEl.append(head);

    const section = el("section");
    const label = el("h3", "trains-section-label");
    label.append(document.createTextNode("Pull requests"), el("span", "trains-section-count", String(group.prs.size)));
    section.append(label);
    const prs = [...group.prs.values()].sort((a, b) => (b.number ?? 0) - (a.number ?? 0));
    if (!prs.length) section.append(el("div", "trains-note", "No open pull requests for this repository."));
    else {
      const list = el("div", "trains-prs");
      for (const pr of prs) list.append(prRow(group, pr));
      section.append(list);
    }
    detailEl.append(section);
  }

  function render() {
    repos = buildRepos();
    if (!repos.some((g) => g.key === state.selected)) { state.selected = repos[0]?.key ?? null; state.confirm = null; }
    subEl.textContent = onlineComputers().length
      ? `${repos.length} repositor${repos.length === 1 ? "y" : "ies"}` : "No computer online";
    renderRepos();
    renderDetail();
  }

  function select(key) {
    if (state.selected === key) return;
    state.selected = key;
    state.confirm = null;
    renderRepos();
    renderDetail();
  }

  // ---- actions --------------------------------------------------------

  function askConfirm(group, pr, action) {
    state.confirm = {
      groupKey: group.key, prKey: pr.key, action,
      project: group.authority?.project ?? group.project,
      computer: group.computer, status: "idle", note: "",
    };
    renderDetail();
  }

  function inlineConfirm(group, pr) {
    const box = el("div", "trains-inline");
    const confirm = state.confirm;
    const what = `${group.repo}${pr.number != null ? ` #${pr.number}` : ""}${pr.title ? ` ${pr.title}` : pr.branch ? ` ${pr.branch}` : ""}`;
    box.append(el("div", "trains-inline-text", `Allow ${confirm.action} for ${what}? This lets one agent dispatch ${confirm.action} in ${confirm.project} within the next 30 minutes. Nothing is ${confirm.action === "merge" ? "merged" : "published"} by this button itself; the integrator does it.`));
    const actions = el("div", "trains-inline-actions");
    const go = el("button", "trains-btn accent", `Allow ${confirm.action}`);
    go.disabled = confirm.status === "saving";
    go.addEventListener("click", () => { void confirmAction(group, pr); });
    const cancel = el("button", "trains-btn ghost", "Cancel");
    cancel.addEventListener("click", () => { state.confirm = null; renderDetail(); });
    actions.append(go, cancel);
    if (confirm.note) actions.append(el("span", `trains-inline-note ${confirm.status}`, confirm.note));
    box.append(actions);
    return box;
  }

  async function confirmAction(group, pr) {
    const confirm = state.confirm;
    if (!confirm) return;
    confirm.status = "saving";
    confirm.note = "Confirming…";
    renderDetail();
    try {
      const body = await hookPost(confirm.computer, "/v1/authority/confirm", { project: confirm.project, actions: [confirm.action] });
      const confirmation = body?.confirmation;
      confirm.status = "done";
      confirm.note = confirmation?.expiresAt
        ? `Confirmed until ${new Date(confirmation.expiresAt).toLocaleTimeString()}.` : "Confirmed.";
    } catch (err) {
      confirm.status = "failed";
      confirm.note = err?.message || "Could not confirm.";
    }
    renderDetail();
  }

  // ---- wiring ---------------------------------------------------------

  let timer = null;
  function startPoll() { if (!timer) timer = setInterval(() => { void poll(); }, POLL_MS); }
  function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

  const unsubscribe = store.subscribe(() => { if (state.visible) void poll(); });

  return {
    show() { state.visible = true; startPoll(); void poll(); },
    hide() { state.visible = false; stopPoll(); },
    destroy() { stopPoll(); unsubscribe(); },
  };
}
