// Changes workbench pane: working tree, history, branches, pull requests and
// worktrees, each scoped to the session (or a worker's worktree). Its CSS
// (changes/styles.js) is injected once; helpers live in changes/util.js. It
// re-renders fully from module state.
import { isShown, watchShown } from "./shown.js";
import { hookGet, hookPost, readRepoFile } from "./api.js";
import { projectOf } from "./shell/store.js";
import { ADDED_FILE_MAX_LINES, additionHunks, parsePatch, wordSegments } from "./patch.js";
import { branchProblem, capitalize, checksSummary, checksWord, durationText, fixItPrompt, groupRuns, hostTerms, localForRemote, mergeAvailability, mergeMethods, pipelineSegments, pullStanding, relativeTime, syncAction, tokenPage, trackingText } from "./git-review.js";
import { announceGitChange } from "./diff-doc.js";
import { loadBranchTasks, renderBranchTasks } from "./branch-tasks.js";
import { openLaunchSheet } from "./shell/launch.js";
import { armMerge, disarmMerge, isArmed, onArmedChange } from "./shell/merge-when-green.js";
import { CHANGES_CSS } from "./changes/styles.js";
import { basename, button, dirname, div, escapeHtml, hostMark, hunkHeader, icon, planPublish, prReason, pushReason, relTime, span, stagePlan, tileClass } from "./changes/util.js";

// The phone's Changes tabs, minus Working tree (the Files pane owns that here).
// "Session" is what this agent changed, from the Hook's per-call capture.
// Short labels so six fit the panel; each carries its full name as a title.
const VIEWS = [["changes", "Changes", "Uncommitted changes"], ["session", "Session", "What this agent changed"], ["history", "History", "Commit history"],
  ["branches", "Branches", "Branches"], ["pulls", "PRs", "Pull requests and checks"], ["worktrees", "Workers", "Other worktrees and the workers in them"]];
// gitboy's /memory/files contract takes up to 500 paths; a working tree past that is a bulk change.
const KNOWS_MAX_PATHS = 200;
// The pulls label follows the remote's host ("MRs" on GitLab) once /v1/git/pulls answers.


export function openChanges(el, ctx) {
  const computer = ctx.computer;
  const target = ctx.child && ctx.child.target;
  const state = {
    view: "changes", status: null, expanded: null, diffs: {}, addedText: {},
    draft: "", confirm: null, error: "", landed: "",
    log: null, logRef: null,
    branches: null, pulls: null, worktrees: null,
    worktree: null, worktreeTitle: null,
    rowMenu: null, sheet: null, notice: null, copyToast: null, busy: null,
    commit: null, session: null, sessionOpen: null,
    connect: null, merge: null,
    // Phren findings about the changed files: `key` is the project and paths asked for.
    knows: { key: "", findings: [], open: false, file: null, full: null },
    // "Seen this before" for the current request's failing checks: `key` is the head and the failures asked about.
    seen: { key: "", results: [] },
    // Phren tasks naming the current request's branch: `key` is the project and branch asked about.
    branchTasks: { key: "", tasks: [], done: new Set(), busy: null, error: "" },
  };
  let timer = null;
  let commitBtn = null;
  let toastTimer = null;
  let visible = true;
  // The footer's PR action needs the branch's pull request; loaded quietly once.
  let pullsRequested = false;

  injectStyle();

  const scopeBody = (extra = {}) => {
    const b = { target, ...extra };
    if (state.worktree) b.worktree = state.worktree;
    return b;
  };
  const repo = () => (state.status && state.status.repository) || undefined;
  // What the remote's host calls its requests; generic until /v1/git/pulls says.
  const terms = () => hostTerms(state.pulls && state.pulls.host);
  // Only this pane's own commit box counts: the chat composer beside it is a
  // textarea too, and is focused most of the time.
  const typing = () => { const a = document.activeElement; return !!a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT" || a.tagName === "SELECT") && el.contains(a); };
  // A half-typed token or an open merge confirmation must survive the 10-second re-read.
  const canPoll = () => visible && document.visibilityState === "visible" && isShown(el) && !state.confirm && !state.sheet && !typing()
    && !(state.connect && state.connect.token) && !(state.merge && state.merge.confirm);

  function render() {
    el.innerHTML = "";
    const root = div("chg");
    root.appendChild(renderTop());
    root.appendChild(renderBody());
    if (state.view === "changes") root.appendChild(renderFooter());
    if (state.notice) root.appendChild(renderNotice());
    if (state.copyToast) root.appendChild(renderToast());
    if (state.sheet) root.appendChild(renderSheet());
    el.appendChild(root);
    const ta = root.querySelector(".chg-msg");
    if (ta) autosize(ta);
  }

  function toast(text) {
    state.copyToast = text;
    render();
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { state.copyToast = null; render(); }, 1600);
  }

  function copy(text, label) {
    const done = () => toast("Copied " + (label || text));
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done);
    else done();
  }

  function selectView(key) {
    if (state.view === key) return;
    state.view = key;
    state.expanded = null; state.rowMenu = null; state.error = ""; state.confirm = null;
    if (key !== "history") { state.logRef = null; state.commit = null; }
    refresh();
  }

  function openWorktree(wt) {
    state.worktree = wt.id;
    state.worktreeTitle = worktreeTitle(wt);
    state.status = null; state.expanded = null; state.diffs = {}; state.addedText = {};
    state.log = null; state.branches = null; state.pulls = null; state.worktrees = null;
    state.view = "changes"; state.error = ""; state.confirm = null;
    pullsRequested = false;
    refresh();
  }

  function closeWorktree() {
    state.worktree = null; state.worktreeTitle = null;
    state.status = null; state.log = null; state.branches = null; state.pulls = null; state.worktrees = null;
    state.view = "worktrees"; state.error = "";
    pullsRequested = false;
    refresh();
  }

  async function refresh() {
    if (!target) { state.error = "This session has no target."; render(); return; }
    try {
      if (state.view === "changes") await loadChanges();
      else if (state.view === "history") { await loadHistory(); if (state.commit && !state.commit.data) await loadCommit(state.commit.sha); }
      else if (state.view === "session") { state.session = await hookPost(computer, "/v1/git/session-changes", scopeBody()); if (!state.status) await loadStatusQuiet(); }
      else if (state.view === "branches") { state.branches = await hookPost(computer, "/v1/git/branches", scopeBody()); await loadStatusQuiet(); }
      else if (state.view === "pulls") { state.pulls = await hookPost(computer, "/v1/git/pulls", scopeBody()); await loadStatusQuiet(); }
      else if (state.view === "worktrees") state.worktrees = await hookPost(computer, "/v1/git/worktrees", scopeBody());
      state.error = "";
      loadPullsQuiet();
    } catch (e) {
      state.error = e.message || String(e);
    }
    render();
  }

  async function loadChanges() {
    const res = await hookPost(computer, "/v1/git/status", scopeBody());
    state.status = res;
    if (state.expanded) {
      const f = (res.files || []).find((x) => x.path === state.expanded.path && !!x.staged === state.expanded.staged);
      if (!f) state.expanded = null;
      else await loadDiff(f);
    }
    loadPullsQuiet();
    loadKnowsQuiet();
  }

  // gitboy's "Phren remembers": findings citing the files being changed, or a
  // function in them. Asked again only when the set of files changes; best effort.
  async function loadKnowsQuiet() {
    const project = ctx.child ? projectOf(ctx.child) : "";
    const paths = [...new Set((state.status?.files || []).map((f) => f.path))].sort().slice(0, KNOWS_MAX_PATHS);
    const key = project + "\u0000" + paths.join("\u0000");
    if (key === state.knows.key) return;
    state.knows.key = key;
    state.knows.findings = [];
    if (state.knows.file && !paths.includes(state.knows.file)) state.knows.file = null;
    if (!project || !paths.length) return;
    let findings = [];
    try {
      const body = await hookGet(computer, `/v1/projects/${encodeURIComponent(project)}/memory/files`, paths.map((p) => ["path", p]));
      findings = Array.isArray(body?.findings) ? body.findings : [];
    } catch { /* an older Hook or a project outside the store: no card */ }
    if (state.knows.key !== key) return;
    state.knows.findings = findings;
    if (findings.length && !typing()) render();
  }

  // The branch bar shows on every view; other views read status quietly.
  async function loadStatusQuiet() {
    try { state.status = await hookPost(computer, "/v1/git/status", scopeBody()); } catch { /* the bar just hides */ }
  }

  async function loadCommit(sha) {
    state.commit = { sha, data: null, error: "" };
    try { state.commit.data = await hookPost(computer, "/v1/git/show", scopeBody({ sha })); }
    catch (e) { state.commit.error = e.status === 404 && /Unknown Phren Hook route/.test(e.message) ? "Update Phren on this computer to open commits." : e.message || String(e); }
  }

  // The branch's pull request drives the footer's PR action; best effort.
  async function loadPullsQuiet() {
    if (pullsRequested) return;
    pullsRequested = true;
    try {
      state.pulls = await hookPost(computer, "/v1/git/pulls", scopeBody());
      // The branch bar's pull request chip shows on every view.
      if (!typing()) render();
    } catch { /* optional: the PRs tab reports its own failure */ }
  }

  async function loadHistory() {
    state.log = await hookPost(computer, "/v1/git/log", scopeBody({ limit: 60, ...(state.logRef ? { ref: state.logRef } : {}) }));
  }

  async function loadDiff(f) {
    const res = await hookPost(computer, "/v1/diff", scopeBody({ paths: [f.path] }));
    const data = (res.files || []).find((x) => x.path === f.path) || (res.files || [])[0];
    state.diffs[f.path] = data;
    // A new file has no diff hunks until it is staged; read its content instead.
    const added = f.status === "?" || f.status === "A";
    const hasHunks = ((data && data.sections) || []).some((s) => !s.binary && parsePatch(s.patch || "").length > 0);
    if (added && !hasHunks) {
      try { state.addedText[f.path] = (await readRepoFile(computer, target, f.path)).text || ""; }
      catch { state.addedText[f.path] = null; }
    }
  }

  // Run a write, then refresh; a failure becomes the one error line and never refetches.
  async function write(fn) {
    try {
      await fn();
      state.error = ""; state.confirm = null;
      announce();
      await refresh();
    } catch (e) {
      state.confirm = null; state.error = e.message || String(e);
      render();
    }
  }

  const doStage = (f) => stage([f]);
  const doUnstage = (f) => write(() => hookPost(computer, "/v1/git/unstage", scopeBody({ paths: [f.path], expectedRepository: repo() })));
  const doStageAll = () => stage(state.status?.files || []);

  function stage(files) {
    if (state.busy || state.confirm) return;
    const plan = stagePlan(files);
    if (!plan.paths.length) return;
    state.error = plan.error;
    if (plan.error) { render(); return; }
    const body = scopeBody({ paths: plan.paths, expectedRepository: repo() });
    if (plan.confirm) { state.confirm = { kind: "stage", plan, body }; render(); }
    else sendStage(plan, body);
  }

  async function sendStage(plan, body, confirmed = false) {
    if (state.busy) return;
    state.busy = "stage"; render();
    try {
      await hookPost(computer, "/v1/git/stage", { ...body, ...(confirmed ? { confirmBulk: true } : {}) });
      state.error = ""; state.confirm = null;
      announce();
      await refresh();
    } catch (e) {
      // A stale status may miss a directory or an untracked binary. Only the
      // Hook's staging gate can offer a retry with the user's confirmation.
      if (!confirmed && e.status === 409 && /confirmBulk=true/.test(e.message)) {
        state.confirm = { kind: "stage", plan, body, detail: "This selection includes a folder or a binary or unknown untracked file." };
        state.error = "";
      } else { state.confirm = null; state.error = e.message || String(e); }
    } finally { state.busy = null; render(); }
  }
  const doDiscard = () => write(() => hookPost(computer, "/v1/git/discard", scopeBody({ paths: [state.confirm.path], expectedRepository: repo() })));

  async function doCommit() {
    if (state.busy) return;
    state.busy = "commit";
    try {
      const res = await hookPost(computer, "/v1/git/commit", scopeBody({ message: state.draft.trim(), expectedRepository: repo() }));
      if (res && res.ok === false) { state.notice = { title: "The commit was refused", message: res.output || "git commit failed." }; }
      else { state.draft = ""; state.landed = `Committed ${res.short || ""} ${res.subject || ""}`.trim(); }
      state.error = ""; state.confirm = null;
      await refresh();
    } catch (e) { state.notice = { title: "Could not commit", message: e.message || String(e) }; }
    finally { state.busy = null; render(); }
  }

  async function doPush(confirmDefault) {
    if (state.busy) return;
    state.busy = "push";
    try {
      const res = await hookPost(computer, "/v1/git/push", scopeBody({ expectedRepository: repo(), ...(confirmDefault ? { confirmDefault: true } : {}) }));
      if (res && res.ok === false) { state.notice = { title: "The push was refused", message: res.output || "git push failed." }; }
      else { state.landed = `Pushed to ${res.upstream || "origin"}`; state.confirm = null; }
      state.error = "";
      await refresh();
    } catch (e) {
      if (e.status === 409 && e.body && e.body.defaultBranch) { state.confirm = { kind: "push", branch: e.body.defaultBranch }; state.error = ""; }
      else state.notice = { title: "Could not push", message: e.message || String(e) };
    } finally { state.busy = null; render(); }
  }

  async function doPullRequest(draft, fields) {
    if (state.busy) return;
    state.busy = "pr";
    try {
      const body = scopeBody({ draft: !!draft, ...(fields || {}) });
      const res = await hookPost(computer, "/v1/git/pr", body);
      const t = hostTerms(res && res.host);
      if (res && res.ok && res.url) state.notice = { title: res.existing ? `This branch already has a ${t.long}` : `${capitalize(t.long)} opened`, message: res.url, url: res.url, site: t.name };
      else state.notice = { title: `Could not open a ${t.long}`, message: res.message || res.output || `The ${t.long} was not created.` };
      state.sheet = null;
      await refresh();
    } catch (e) { state.notice = { title: `Could not open a ${terms().long}`, message: e.message || String(e) }; }
    finally { state.busy = null; render(); }
  }

  // Tell diff tabs the index moved; this pane's own listener skips its echo.
  let announcedAt = 0;
  function announce() { announcedAt = Date.now(); announceGitChange(computer, target); }

  // ---- branch moves: fetch, pull, switch, create ----------------------------
  async function sync(kind) {
    if (state.busy) return;
    state.busy = kind; render();
    try {
      const res = await hookPost(computer, `/v1/git/${kind}`, scopeBody({ expectedRepository: repo() }));
      if (res && res.ok === false) state.notice = { title: kind === "pull" ? "The pull was refused" : "The fetch was refused", message: res.output || `git ${kind} failed.` };
      else state.landed = kind === "pull" ? (res.commits ? `Pulled ${res.commits} commit${res.commits === 1 ? "" : "s"}` : "Already up to date") : `Fetched ${res.remote || "origin"}`;
      pullsRequested = false;
      announce();
      await loadStatusQuiet();
      await refresh();
    } catch (e) { state.notice = { title: kind === "pull" ? "Could not pull" : "Could not fetch", message: newerHook(e, kind) }; }
    finally { state.busy = null; render(); }
  }

  async function checkout(request) {
    if (state.busy) return;
    state.busy = "checkout"; state.confirm = null; render();
    try {
      const res = await hookPost(computer, "/v1/git/checkout", scopeBody({ branch: request.branch, ...(request.create ? { create: true } : {}),
        ...(request.startPoint ? { startPoint: request.startPoint } : {}), ...(request.carry ? { carryChanges: true } : {}), expectedRepository: repo() }));
      if (res && res.ok === false) state.notice = { title: "Git refused the switch", message: res.output || "git switch failed." };
      else {
        state.landed = res.created ? `Created and switched to ${res.branch}` : `Switched to ${res.branch}`;
        if (res.carried) state.landed += ` with ${res.carried} uncommitted file${res.carried === 1 ? "" : "s"}`;
        state.sheet = null; state.log = null; state.commit = null; pullsRequested = false; state.pulls = null;
      }
      announce();
      await loadStatusQuiet();
      await refresh();
    } catch (e) {
      if (e.status === 409 && e.code === "git-dirty") state.confirm = { kind: "carry", request, message: e.message };
      else if (state.sheet && state.sheet.kind === "branch") state.sheet.error = newerHook(e, "checkout");
      else state.notice = { title: "Could not switch branches", message: newerHook(e, "checkout") };
    } finally { state.busy = null; render(); }
  }

  function newerHook(e, what) {
    if (e && e.status === 404 && /Unknown Phren Hook route/.test(e.message || "")) {
      return `Update Phren on ${computer} to ${what === "checkout" ? "switch branches" : what} from the desktop.`;
    }
    return (e && e.message) || String(e);
  }

  function openBranchSheet(startPoint) {
    state.sheet = { kind: "branch", name: startPoint ? localForRemote(startPoint) : "", startPoint: startPoint || null, error: "" };
    render();
    el.querySelector(".chg-sheet input[data-key=name]")?.focus();
  }

  // ---- header ---------------------------------------------------------------
  function renderTop() {
    const top = div("chg-top");
    const segs = div("chg-segs");
    const t = terms();
    for (const [key, label, title] of VIEWS) {
      if ((key === "worktrees" || key === "session") && state.worktree) continue;
      const seg = button(key === "pulls" ? t.short + "s" : label, "chg-seg" + (state.view === key ? " sel" : ""), () => selectView(key));
      seg.title = key === "pulls" ? `${capitalize(t.long)}s and checks` : title;
      seg.dataset.view = key;
      segs.appendChild(seg);
    }
    top.appendChild(segs);
    if (state.status && !(state.view === "history" && state.commit)) top.appendChild(renderBranchBar(state.status));
    if (state.view === "changes" && state.status) top.appendChild(div("chg-sub", subline(state.status)));
    else if (state.view === "history" && state.logRef) top.appendChild(div("chg-sub", "History · " + state.logRef));
    else if (state.view === "worktrees" && state.worktrees) top.appendChild(div("chg-sub", worktreeCaption(state.worktrees)));
    if (state.worktree) top.appendChild(renderScope());
    return top;
  }

  function renderBranchBar(s) {
    const bar = div("chg-branchbar");
    const name = button("", "chg-bb-name", () => selectView("branches"));
    name.title = "Branches";
    name.appendChild(span("chg-bb-glyph", "⑂"));
    name.appendChild(span("", s.branch || "detached HEAD"));
    const track = trackingText(s);
    if (track) name.appendChild(span("chg-bb-track" + (s.upstream ? "" : " unpushed"), track));
    bar.appendChild(name);
    const pr = state.pulls && state.pulls.current;
    if (pr && pr.head === s.branch) {
      const t = terms();
      const chip = button(`${t.ref}${pr.number}`, "chg-bb-pr " + (pr.checks || "none"), () => selectView("pulls"));
      chip.title = `${capitalize(t.long)} ${t.ref}${pr.number}` + (pr.checks ? ` · checks ${pr.checks}` : "");
      bar.appendChild(chip);
    }
    const act = syncAction(s);
    if (act) {
      const b = button(state.busy === act.kind ? (act.kind === "pull" ? "Pulling…" : "Fetching…") : act.label, "chg-bb-btn" + (act.kind === "pull" ? " pull" : ""), () => sync(act.kind));
      b.disabled = !!state.busy;
      b.dataset.act = act.kind;
      b.title = act.kind === "pull" ? `Fast-forward ${s.branch} to ${s.upstream}` : `Fetch ${s.upstream ? s.upstream.split("/")[0] : "origin"} and update ahead/behind`;
      bar.appendChild(b);
    }
    const nb = button("+ Branch", "chg-bb-btn", () => openBranchSheet(null));
    nb.title = "Create a branch here and switch to it";
    nb.disabled = !!state.busy;
    nb.dataset.act = "new-branch";
    bar.appendChild(nb);
    return bar;
  }

  function renderScope() {
    const bar = div("chg-scope");
    bar.appendChild(button("← All worktrees", "chg-scope-back", closeWorktree));
    bar.appendChild(div("chg-scope-name", state.worktreeTitle || "worktree"));
    return bar;
  }

  function subline(s) {
    // The branch bar above names the branch; this line counts the work.
    const n = s.totalFiles != null ? s.totalFiles : (s.files || []).length;
    if (!n) return "Nothing uncommitted";
    let line = `${n} file${n === 1 ? "" : "s"} changed`;
    const counts = [];
    if (s.additions) counts.push("+" + s.additions);
    if (s.deletions) counts.push("−" + s.deletions);
    if (counts.length) line += " " + counts.join(" ");
    return line;
  }

  function worktreeCaption(res) {
    const rows = Array.isArray(res) ? res : (res.worktrees || []);
    return `${rows.length} worktree${rows.length === 1 ? "" : "s"}`;
  }

  // ---- body ----------------------------------------------------------------
  function renderBody() {
    if (state.view === "history") return state.commit ? renderCommit() : renderHistory();
    if (state.view === "session") return renderSession();
    if (state.view === "branches") return renderBranches();
    if (state.view === "pulls") return renderPulls();
    if (state.view === "worktrees") return renderWorktrees();
    return renderChanges();
  }

  function renderChanges() {
    const body = div("chg-body");
    if (!state.status) { body.appendChild(div("chg-empty", state.error ? state.error : "Loading…")); return body; }
    const staged = (state.status.files || []).filter((f) => f.staged);
    const changed = (state.status.files || []).filter((f) => !f.staged);
    if (!staged.length && !changed.length) {
      const empty = div("chg-empty");
      empty.appendChild(div("chg-empty-check", "✓"));
      empty.appendChild(div("", "Working tree clean"));
      body.appendChild(empty);
      return body;
    }
    if (state.knows.findings.length) body.appendChild(renderKnows());
    if (staged.length) body.appendChild(renderSection("STAGED", staged));
    if (changed.length) body.appendChild(renderSection("CHANGES", changed));
    return body;
  }

  const citedFile = (item) => (item.citation && item.citation.file ? item.citation.file.replace(/^\.\//, "") : "");
  const knowsFor = (path) => state.knows.findings.filter((item) => item.match !== "symbol" && citedFile(item) === path);

  function renderKnows() {
    const k = state.knows;
    const card = div("chg-knows" + (k.open ? " open" : ""));
    const head = button("", "chg-knows-h", () => { k.open = !k.open; if (!k.open) k.file = null; render(); });
    head.setAttribute("aria-expanded", String(k.open));
    const files = new Set(k.findings.map(citedFile).filter(Boolean));
    const count = k.findings.length;
    head.append(span("chg-knows-mark", "◆"), span("", "Phren remembers"),
      span("chg-knows-sub", `${count} ${count === 1 ? "finding" : "findings"} about ${files.size > 1 ? `${files.size} of these files` : "these files"}`),
      span("chg-knows-chev", "›"));
    card.appendChild(head);
    if (!k.open) return card;
    const shown = k.file ? knowsFor(k.file) : k.findings;
    if (k.file) {
      const filter = div("chg-knows-filter");
      filter.append(span("", "In"), span("chg-chip", basename(k.file)));
      filter.appendChild(button("Show all", "chg-knows-cite", () => { k.file = null; render(); }));
      card.appendChild(filter);
    }
    const list = div("chg-knows-list");
    for (const item of shown) list.appendChild(renderKnowsItem(item));
    card.appendChild(list);
    return card;
  }

  function renderKnowsItem(item) {
    const k = state.knows;
    const row = div("chg-knows-item" + (k.full === item.id ? " full" : ""));
    row.title = k.full === item.id ? "" : "Show the whole finding";
    row.onclick = () => { k.full = k.full === item.id ? null : item.id; render(); };
    row.appendChild(div("chg-knows-text", item.text || ""));
    const meta = div("chg-knows-meta");
    if (item.type) meta.appendChild(span("chg-chip", item.type));
    const file = citedFile(item);
    const where = item.citation && item.citation.name ? item.citation.name : file ? basename(file) + (item.citation.line ? `:${item.citation.line}` : "") : "";
    if (where) {
      const cite = button(where, "chg-knows-cite", (e) => {
        e.stopPropagation();
        if (file) ctx.openFile(file, item.citation.line ? { line: item.citation.line } : {});
      });
      cite.title = file ? `Open ${file}` : where;
      meta.appendChild(cite);
    }
    const when = relativeTime(item.created);
    if (when) meta.appendChild(span("chg-pr-num", when));
    row.appendChild(meta);
    return row;
  }

  function renderSection(title, files) {
    const sec = div("chg-sec");
    const head = div("chg-sec-h");
    head.appendChild(span("", title));
    head.appendChild(span("chg-pill", String(files.length)));
    sec.appendChild(head);
    for (const f of files) {
      sec.appendChild(renderFileRow(f));
      if (state.confirm && state.confirm.kind === "discard" && state.confirm.path === f.path) sec.appendChild(renderDiscardConfirm(f));
      else if (state.expanded && state.expanded.path === f.path && state.expanded.staged === !!f.staged) sec.appendChild(renderDiff(f));
    }
    return sec;
  }

  function renderFileRow(f) {
    const row = div("chg-row");
    // Modified and renamed files open their diff as a centre tab; untracked and
    // deleted files have nothing to read, so they expand inline.
    row.onclick = () => {
      if (f.status === "?" || f.status === "D") toggleDiff(f);
      else ctx.openFile(f.path, { diff: true });
    };
    row.appendChild(div("chg-tile " + tileClass(f.status), f.status === "?" ? "?" : f.status));
    const main = div("chg-main");
    main.appendChild(div("chg-name", basename(f.path)));
    const dir = dirname(f.path);
    if (dir) main.appendChild(div("chg-folder", dir));
    row.appendChild(main);
    const stat = div("chg-stat");
    if (f.additions) stat.appendChild(span("chg-adds", "+" + f.additions));
    if (f.deletions) stat.appendChild(span("chg-dels", "−" + f.deletions));
    row.appendChild(stat);
    const known = knowsFor(f.path).length;
    if (known) {
      const badge = button("◆ " + known, "chg-knows-badge", (e) => { e.stopPropagation(); state.knows.open = true; state.knows.file = f.path; render(); });
      badge.title = `${known} Phren ${known === 1 ? "finding" : "findings"} about this file`;
      row.appendChild(badge);
    }
    const actions = div("chg-actions");
    actions.appendChild(icon("↗", "Open file", () => ctx.openFile(f.path)));
    if (f.status !== "?" && f.status !== "D") actions.appendChild(icon("⇄", "Open side-by-side diff", () => ctx.openFile(f.path, { diff: true })));
    if (f.staged) actions.appendChild(icon("−", "Unstage", () => doUnstage(f)));
    else {
      actions.appendChild(icon("+", "Stage", () => doStage(f)));
      actions.appendChild(icon("⋯", "More actions", () => { state.rowMenu = state.rowMenu === f.path ? null : f.path; render(); }));
    }
    row.appendChild(actions);
    if (state.rowMenu === f.path) row.appendChild(renderRowMenu(f));
    return row;
  }

  function renderRowMenu(f) {
    const menu = div("chg-row-menu");
    menu.onclick = (e) => e.stopPropagation();
    menu.appendChild(button("Discard", "chg-row-item danger", () => { state.rowMenu = null; state.confirm = { kind: "discard", path: f.path }; render(); }));
    return menu;
  }

  function renderDiscardConfirm(f) {
    const row = div("chg-confirm");
    row.appendChild(span("", `Discard changes to ${basename(f.path)}? This cannot be undone.`));
    row.appendChild(button("Discard", "chg-btn danger", doDiscard));
    row.appendChild(button("Cancel", "chg-btn stage", () => { state.confirm = null; render(); }));
    return row;
  }

  // ---- diff ----------------------------------------------------------------
  function renderDiff(f) {
    const wrap = div("chg-diff");
    const data = state.diffs[f.path];
    const sections = (data && data.sections) || [];
    const hasHunks = sections.some((s) => !s.binary && parsePatch(s.patch || "").length > 0);
    // Added or untracked file with no diff hunks: show its content as additions.
    if ((f.status === "?" || f.status === "A") && !hasHunks) {
      const text = state.addedText[f.path];
      if (text == null) { wrap.appendChild(div("chg-diff-label", "Loading file…")); return wrap; }
      const { hunks, truncated } = additionHunks(text);
      const box = div("chg-diff-sec");
      if (!hunks.length) box.appendChild(div("chg-diff-label", "Empty file."));
      else renderHunks(box, hunks, f.path);
      if (truncated) box.appendChild(div("chg-diff-label", `Showing the first ${ADDED_FILE_MAX_LINES} lines`));
      wrap.appendChild(box);
      return wrap;
    }
    if (!data) { wrap.appendChild(div("chg-diff-label", "Loading diff…")); return wrap; }
    if (!sections.length) { wrap.appendChild(div("chg-diff-label", "No changes to show.")); return wrap; }
    const multi = sections.length > 1;
    for (const sec of sections) {
      const box = div("chg-diff-sec");
      if (multi) box.appendChild(div("chg-diff-label", sec.kind === "staged" ? "Staged" : "Unstaged"));
      if (sec.binary) box.appendChild(div("chg-diff-label", "Binary file"));
      else renderPatch(box, sec.patch || "", f.path);
      if (sec.truncated) box.appendChild(div("chg-diff-label", "Diff truncated."));
      wrap.appendChild(box);
    }
    return wrap;
  }

  function renderPatch(box, patch, path) {
    const parsed = parsePatch(patch);
    renderHunks(box, Array.isArray(parsed) ? parsed : (parsed && parsed.hunks) || [], path);
  }

  function renderHunks(box, hunks, path) {
    for (const hunk of hunks) {
      const header = hunkHeader(hunk);
      if (header) box.appendChild(div("chg-hunk", header));
      const lines = hunk.lines || [];
      annotate(lines);
      for (const line of lines) box.appendChild(renderDiffLine(line, path));
    }
  }

  function renderDiffLine(line, path) {
    const kind = line.kind === "add" ? "add" : line.kind === "del" ? "del" : "";
    const row = div("chg-line" + (kind ? " " + kind : ""));
    row.appendChild(span("ln", line.kind === "add" ? "" : line.oldLine != null ? String(line.oldLine) : ""));
    row.appendChild(span("ln", line.kind === "del" ? "" : line.newLine != null ? String(line.newLine) : ""));
    row.appendChild(span("mark", kind === "add" ? "+" : kind === "del" ? "−" : " "));
    const code = div("code");
    if (line.segments && line.segments.length) {
      const cls = kind === "del" ? "chg-word old-changed" : "chg-word new-changed";
      code.innerHTML = line.segments.map((s) => s.changed ? `<span class="${cls}">${escapeHtml(s.text)}</span>` : escapeHtml(s.text)).join("");
    } else {
      code.textContent = line.text == null ? "" : line.text;
    }
    row.appendChild(code);
    const askNo = line.newLine != null ? line.newLine : line.oldLine;
    if (askNo != null) {
      row.appendChild(button("Ask", "chg-ask", (e) => { e.stopPropagation(); ctx.ask(`${path}:${askNo}\n> ${line.text || ""}\n`); }));
    }
    return row;
  }

  // Tag adjacent del→add pairs so wordSegments can tint only the changed words.
  function annotate(lines) {
    let i = 0;
    while (i < lines.length) {
      if (lines[i].kind !== "del") { i++; continue; }
      let d = i; while (d < lines.length && lines[d].kind === "del") d++;
      let a = d; while (a < lines.length && lines[a].kind === "add") a++;
      const dels = lines.slice(i, d), adds = lines.slice(d, a);
      for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
        const seg = wordSegments(dels[k].text || "", adds[k].text || "");
        dels[k].segments = seg.old; adds[k].segments = seg.new;
      }
      i = a;
    }
  }

  async function toggleDiff(f) {
    state.rowMenu = null;
    const same = state.expanded && state.expanded.path === f.path && state.expanded.staged === !!f.staged;
    if (same) { state.expanded = null; render(); return; }
    state.expanded = { path: f.path, staged: !!f.staged };
    render();
    try { await loadDiff(f); state.error = ""; } catch (e) { state.error = e.message || String(e); }
    render();
  }

  // ---- footer (working tree) -----------------------------------------------
  function renderFooter() {
    commitBtn = null;
    const foot = div("chg-footer");
    if (state.error) foot.appendChild(div("chg-error", state.error));
    if (state.confirm && state.confirm.kind === "push") {
      const row = div("chg-confirm");
      row.appendChild(span("", `Push to ${state.confirm.branch}, the default branch?`));
      row.appendChild(button("Push to " + state.confirm.branch, "chg-btn danger", () => doPush(true)));
      row.appendChild(button("Cancel", "chg-btn stage", () => { state.confirm = null; render(); }));
      foot.appendChild(row);
    }
    if (state.confirm && state.confirm.kind === "stage") {
      const request = state.confirm;
      const { plan } = request;
      const card = div("chg-confirm chg-stage-confirm");
      card.appendChild(div("", `Stage ${plan.paths.length} ${plan.paths.length === 1 ? "path" : "paths"}?`));
      if (plan.directories.length) card.appendChild(div("", "Folders and their contents: " + plan.directories.join(", ")));
      if (plan.binary.length) card.appendChild(div("", "Untracked binary files without a text diff: " + plan.binary.join(", ")));
      if (plan.unknown.length) card.appendChild(div("", "Untracked files without complete counts: " + plan.unknown.join(", ")));
      if (request.detail) card.appendChild(div("", request.detail));
      const list = div("chg-stage-paths");
      for (const path of plan.paths.slice(0, 10)) list.appendChild(div("", path));
      if (plan.paths.length > 10) list.appendChild(div("", `and ${plan.paths.length - 10} more`));
      card.appendChild(list);
      const actions = div("chg-actions-row");
      const confirm = button("Stage", "chg-btn stage", () => sendStage(plan, request.body, true));
      const cancel = button("Cancel", "chg-btn stage", () => { state.confirm = null; render(); });
      confirm.disabled = cancel.disabled = !!state.busy;
      actions.append(confirm, cancel);
      card.appendChild(actions);
      foot.appendChild(card);
    }
    const s = state.status;
    if (!s) return foot;
    const plan = planPublish(s, state.pulls && state.pulls.current);
    if (plan.isEmpty && !state.landed) return foot;
    if (plan.commit) {
      const row = div("chg-commit");
      const ta = document.createElement("textarea");
      ta.className = "chg-msg"; ta.placeholder = "Commit message"; ta.rows = 1; ta.value = state.draft;
      ta.addEventListener("input", () => { state.draft = ta.value; autosize(ta); updateCommitBtn(); });
      ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && state.draft.trim()) { e.preventDefault(); doCommit(); } });
      row.appendChild(ta);
      commitBtn = button("✓ Commit", "chg-btn commit", doCommit);
      commitBtn.disabled = !state.draft.trim() || !!state.busy;
      commitBtn.title = state.draft.trim() ? "Commit the staged files (⌘Enter)" : "Write a commit message first.";
      row.appendChild(commitBtn);
      foot.appendChild(row);
    } else if (plan.stageAll > 0) {
      foot.appendChild(button("Stage all " + plan.stageAll, "chg-btn stage", doStageAll));
    }
    const actions = div("chg-actions-row");
    const push = button(plan.push || "Push", "chg-btn push", () => doPush(false));
    push.disabled = !plan.push || !!state.busy;
    if (!plan.push) push.title = pushReason(s) || "Nothing to push.";
    actions.appendChild(push);
    const existing = plan.pull && plan.pull.existing;
    const t = terms();
    const prBtn = button(existing ? `${t.short} ${t.ref}${existing}` : `Create ${t.short}`, "chg-btn stage", () => {
      if (existing) window.open(plan.pull.url, "_blank", "noopener");
      else if (plan.pull && plan.pull.open) openPrSheet(s);
    });
    prBtn.disabled = !plan.pull || !!state.busy;
    if (!plan.pull) prBtn.title = prReason(s, t.long);
    actions.appendChild(prBtn);
    foot.appendChild(actions);
    if (state.landed) foot.appendChild(div("chg-note", state.landed));
    return foot;
  }

  function updateCommitBtn() {
    if (!commitBtn) return;
    const staged = (state.status?.files || []).some((f) => f.staged);
    commitBtn.disabled = !state.draft.trim() || !staged || !!state.busy;
  }

  function openPrSheet(s) {
    state.sheet = { title: "", body: "", base: s.defaultBranch || "main", head: s.branch || "" };
    render();
  }

  function autosize(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 96) + "px";
  }

  // ---- history -------------------------------------------------------------
  function sectionHead(title, count) {
    const head = div("chg-sec-h");
    head.appendChild(span("", title));
    if (count != null) head.appendChild(span("chg-pill", String(count)));
    return head;
  }

  function renderHistory() {
    const body = div("chg-body");
    if (!state.log) { body.appendChild(div("chg-empty", state.error ? state.error : "Loading…")); return body; }
    const commits = state.log.commits || [];
    const uncommitted = state.log.uncommitted;
    if (uncommitted && uncommitted.files > 0) body.appendChild(renderUncommittedRow(uncommitted));
    if (!commits.length) {
      const empty = div("chg-empty");
      empty.appendChild(div("chg-empty-icon", "⟲"));
      empty.appendChild(div("", "No commits yet"));
      body.appendChild(empty);
      return body;
    }
    for (const c of commits) body.appendChild(renderCommitRow(c));
    return body;
  }

  function renderUncommittedRow(u) {
    const row = div("chg-log-row");
    const mid = div("chg-log-mid");
    mid.appendChild(div("chg-log-subject", "Uncommitted changes"));
    mid.appendChild(div("chg-log-meta", `${u.files} file${u.files === 1 ? "" : "s"}`));
    row.appendChild(mid);
    const stat = div("chg-stat");
    if (u.additions) stat.appendChild(span("chg-adds", "+" + u.additions));
    if (u.deletions) stat.appendChild(span("chg-dels", "−" + u.deletions));
    row.appendChild(stat);
    return row;
  }

  function renderCommitRow(c) {
    const row = div("chg-log-row");
    row.appendChild(span("chg-sha", c.short || (c.sha || "").slice(0, 7)));
    const mid = div("chg-log-mid");
    mid.appendChild(div("chg-log-subject", c.subject || ""));
    mid.appendChild(div("chg-log-meta", `${c.author || ""} · ${relTime(c.date)}`));
    const refs = (c.refs || []).filter((r) => r && r.name);
    if (refs.length) {
      const wrap = div("chg-refs");
      for (const r of refs) wrap.appendChild(span("chg-ref " + (r.kind || ""), r.name));
      mid.appendChild(wrap);
    }
    row.appendChild(mid);
    row.title = c.sha || "";
    row.onclick = async () => { await loadCommit(c.sha); render(); };
    row.appendChild(icon("⧉", "Copy " + (c.short || ""), () => copy(c.sha, c.short || "")));
    return row;
  }

  // ---- commit detail ---------------------------------------------------------
  function renderCommit() {
    const body = div("chg-body");
    const head = div("chg-commit-head");
    head.appendChild(button("← History", "chg-back", () => { state.commit = null; render(); }));
    const c = state.commit;
    if (!c.data) { head.appendChild(div("chg-empty", c.error || "Loading commit…")); body.appendChild(head); return body; }
    const d = c.data;
    head.appendChild(div("chg-commit-subject", d.subject || ""));
    if (d.body) head.appendChild(div("chg-commit-body", d.body));
    const meta = div("chg-commit-meta");
    meta.appendChild(button(d.short || d.sha.slice(0, 7), "chg-copy", () => copy(d.sha, d.short)));
    meta.appendChild(span("", `${d.author || ""} · ${relTime(d.date)}`));
    if (d.committer && d.committer !== d.author) meta.appendChild(span("", `committed by ${d.committer}`));
    if ((d.parents || []).length > 1) meta.appendChild(span("chg-chip", `merge of ${d.parents.length}`));
    const stat = div("chg-stat");
    stat.appendChild(span("", `${d.totalFiles} file${d.totalFiles === 1 ? "" : "s"}`));
    if (d.additions) stat.appendChild(span("chg-adds", "+" + d.additions));
    if (d.deletions) stat.appendChild(span("chg-dels", "−" + d.deletions));
    meta.appendChild(stat);
    head.appendChild(meta);
    const refs = (d.refs || []).filter((r) => r && r.name);
    if (refs.length) {
      const wrap = div("chg-refs");
      for (const r of refs) wrap.appendChild(span("chg-ref " + (r.kind || ""), r.name));
      head.appendChild(wrap);
    }
    body.appendChild(head);
    const sec = div("chg-sec");
    sec.appendChild(sectionHead("FILES", (d.files || []).length));
    for (const f of d.files || []) {
      const row = div("chg-row");
      row.dataset.path = f.path;
      row.appendChild(div("chg-tile " + tileClass(f.status), f.status));
      const main = div("chg-main");
      main.appendChild(div("chg-name", basename(f.path)));
      const dir = f.oldPath && f.oldPath !== f.path ? `${f.oldPath} →` : dirname(f.path);
      if (dir) main.appendChild(div("chg-folder", dir));
      row.appendChild(main);
      const st = div("chg-stat");
      if (f.binary) st.appendChild(span("", "binary"));
      else { if (f.additions) st.appendChild(span("chg-adds", "+" + f.additions)); if (f.deletions) st.appendChild(span("chg-dels", "−" + f.deletions)); }
      row.appendChild(st);
      row.onclick = () => ctx.openFile(f.path, { commit: { sha: d.sha, short: d.short, parent: (d.parents || [])[0] || null, oldPath: f.oldPath || f.path },
        ...(state.worktree ? { worktree: state.worktree } : {}) });
      sec.appendChild(row);
    }
    if (d.truncated) sec.appendChild(div("chg-note", `Showing ${(d.files || []).length} of ${d.totalFiles} files; some patches were cut short.`));
    body.appendChild(sec);
    return body;
  }

  // ---- this session -----------------------------------------------------------
  function renderSession() {
    const body = div("chg-body");
    const res = state.session;
    if (!res) { body.appendChild(div("chg-empty", state.error ? newerHook({ status: /Unknown Phren Hook route/.test(state.error) ? 404 : 0, message: state.error }, "review this session's changes") : "Loading…")); return body; }
    const files = res.files || [];
    if (!files.length) {
      const empty = div("chg-empty");
      empty.appendChild(div("chg-empty-icon", "◇"));
      empty.appendChild(div("", "This session has not changed any files yet"));
      empty.appendChild(div("chg-folder", "Edits and shell commands the agent runs are recorded here as they happen."));
      body.appendChild(empty);
      return body;
    }
    body.appendChild(div("chg-session-sum", `${res.calls} tool call${res.calls === 1 ? "" : "s"} changed ${res.totalFiles} file${res.totalFiles === 1 ? "" : "s"} · +${res.additions} −${res.deletions}` + (res.others ? ` · ${res.others} in other repositories` : "")));
    const sec = div("chg-sec");
    sec.appendChild(sectionHead("CHANGED BY THIS AGENT", files.length));
    const uncommitted = new Set((state.status?.files || []).map((f) => f.path));
    for (const f of files) {
      const row = div("chg-row");
      row.dataset.path = f.path;
      row.appendChild(div("chg-tile " + tileClass(f.status), f.status));
      const main = div("chg-main");
      main.appendChild(div("chg-name", basename(f.path)));
      main.appendChild(div("chg-folder", [dirname(f.path), `${f.edits.length} edit${f.edits.length === 1 ? "" : "s"}`, uncommitted.has(f.path) ? "uncommitted" : "committed"].filter(Boolean).join(" · ")));
      row.appendChild(main);
      const st = div("chg-stat");
      if (f.added) st.appendChild(span("chg-adds", "+" + f.added));
      if (f.removed) st.appendChild(span("chg-dels", "−" + f.removed));
      row.appendChild(st);
      const actions = div("chg-actions");
      if (uncommitted.has(f.path) && f.status !== "D") actions.appendChild(icon("⇄", "Open the file's uncommitted diff", () => ctx.openFile(f.path, { diff: true })));
      actions.appendChild(icon("↗", "Open file", () => ctx.openFile(f.path)));
      row.appendChild(actions);
      row.onclick = () => { state.sessionOpen = state.sessionOpen === f.path ? null : f.path; render(); };
      sec.appendChild(row);
      if (state.sessionOpen === f.path) {
        const wrap = div("chg-diff");
        if (f.redacted || f.binary) wrap.appendChild(div("chg-diff-label", f.binary ? "Binary file" : "Patch hidden: this looks like a secrets file."));
        f.edits.forEach((e, i) => {
          const box = div("chg-diff-sec");
          const label = div("chg-edit-label");
          label.appendChild(span("", `Edit ${i + 1} of ${f.edits.length}`));
          const es = div("chg-stat");
          if (e.added) es.appendChild(span("chg-adds", "+" + e.added));
          if (e.removed) es.appendChild(span("chg-dels", "−" + e.removed));
          label.appendChild(es);
          box.appendChild(label);
          if (e.patch) renderPatch(box, e.patch, f.path);
          if (e.truncated) box.appendChild(div("chg-diff-label", "Patch truncated."));
          wrap.appendChild(box);
        });
        sec.appendChild(wrap);
      }
    }
    body.appendChild(sec);
    return body;
  }

  // ---- branches ------------------------------------------------------------
  function renderBranches() {
    const body = div("chg-body");
    const res = state.branches;
    if (!res) { body.appendChild(div("chg-empty", state.error ? state.error : "Loading…")); return body; }
    const local = res.local || [], remote = res.remote || [];
    if (!local.length && !remote.length) {
      const empty = div("chg-empty");
      empty.appendChild(div("chg-empty-icon", "⑂"));
      empty.appendChild(div("", "No branches yet"));
      body.appendChild(empty);
      return body;
    }
    if (state.confirm && ["switch", "track", "carry"].includes(state.confirm.kind)) body.appendChild(renderBranchConfirm());
    if (local.length) {
      body.appendChild(sectionHead("LOCAL", local.length));
      for (const b of local) body.appendChild(renderBranchRow(b, res.current, false));
    }
    if (remote.length) {
      body.appendChild(sectionHead("REMOTE", remote.length));
      for (const b of remote) body.appendChild(renderBranchRow(b, res.current, true));
    }
    return body;
  }

  function renderBranchRow(b, current, isRemote) {
    const row = div("chg-branch-row");
    row.appendChild(span("chg-branch-check", b.name === current ? "✓" : ""));
    row.appendChild(span("chg-branch-name", b.name));
    if (b.upstream) row.appendChild(span("chg-branch-up", b.upstream));
    const track = div("chg-track");
    if (b.ahead > 0) track.appendChild(span("up", "↑" + b.ahead));
    if (b.behind > 0) track.appendChild(span("down", "↓" + b.behind));
    row.appendChild(track);
    row.dataset.branch = b.name;
    const isCurrent = !isRemote && b.name === current;
    if (isCurrent) row.title = `${b.name} is checked out`;
    else if (isRemote) row.title = `Check out ${b.name} as a local branch`;
    else row.title = `Switch to ${b.name}`;
    row.onclick = () => {
      if (isCurrent) return;
      if (isRemote) {
        const local = localForRemote(b.name);
        const exists = (state.branches?.local || []).some((l) => l.name === local);
        state.confirm = exists ? { kind: "switch", branch: local } : { kind: "track", branch: local, startPoint: b.name };
      } else state.confirm = { kind: "switch", branch: b.name };
      render();
    };
    row.appendChild(icon("⧉", "Copy " + b.name, () => copy(b.name, b.name)));
    row.appendChild(icon("⟲", "History of " + b.name, () => { state.logRef = b.name; state.view = "history"; state.commit = null; refresh(); }));
    if (!isRemote) row.appendChild(icon("+", "New branch from " + b.name, () => openBranchSheet(b.name)));
    return row;
  }

  function renderBranchConfirm() {
    const c = state.confirm;
    const row = div("chg-confirm");
    if (c.kind === "carry") {
      row.appendChild(span("", c.message));
      row.appendChild(button("Switch with changes", "chg-btn commit", () => checkout({ ...c.request, carry: true })));
    } else if (c.kind === "track") {
      row.appendChild(span("", `Check out ${c.startPoint} as ${c.branch}, tracking it?`));
      row.appendChild(button("Check out", "chg-btn commit", () => checkout({ branch: c.branch, create: true, startPoint: c.startPoint })));
    } else {
      row.appendChild(span("", `Switch to ${c.branch}?`));
      row.appendChild(button("Switch", "chg-btn commit", () => checkout({ branch: c.branch })));
    }
    row.appendChild(button("Cancel", "chg-btn stage", () => { state.confirm = null; render(); }));
    return row;
  }

  // ---- pull requests -------------------------------------------------------
  function pullColor(p) {
    if (p.draft) return "var(--muted)";
    if (p.state === "MERGED") return "var(--accent)";
    if (p.state === "CLOSED") return "var(--danger)";
    if (p.state === "OPEN") return "var(--done)";
    return "var(--muted)";
  }


  function renderPulls() {
    const body = div("chg-body");
    const res = state.pulls;
    if (!res) { body.appendChild(div("chg-empty", state.error ? state.error : "Loading…")); return body; }
    body.appendChild(renderHostBar(res));
    if (res.available === false) {
      // GitLab and gitboy sign in with a token this computer stores; the rest
      // say why in the host's own terms (a missing CLI, an unplaced remote).
      if (res.reason === "auth" && res.host && (res.host.kind === "gitlab" || res.host.kind === "gitboy")) { body.appendChild(renderConnect(res)); return body; }
      const empty = div("chg-empty");
      empty.appendChild(hostMark(res.host && res.host.kind, 28));
      const t = hostTerms(res.host);
      empty.appendChild(div("", `${capitalize(t.long)}s are not available here`));
      empty.appendChild(div("chg-folder", res.message || `${t.name} did not answer on this computer.`));
      body.appendChild(empty);
      return body;
    }
    const pulls = res.pulls || [];
    if (res.current) body.appendChild(renderCurrentPull(res.current, res.host));
    if (!pulls.length && !res.current) {
      const empty = div("chg-empty");
      empty.appendChild(hostMark(res.host && res.host.kind, 28));
      empty.appendChild(div("", `No open ${terms().long}s`));
      body.appendChild(empty);
      return body;
    }
    const others = pulls.filter((p) => !res.current || p.number !== res.current.number);
    if (others.length) body.appendChild(sectionHead(`OPEN ${terms().long.toUpperCase()}S`, others.length));
    for (const p of others) body.appendChild(renderPullRow(p));
    return body;
  }

  // The remote's host, who this computer reads it as, and a way out to its site.
  function renderHostBar(res) {
    const host = res.host || {};
    const bar = div("chg-host");
    bar.appendChild(hostMark(host.kind, 18));
    const who = div("chg-host-who");
    who.appendChild(div("chg-host-name", host.kind ? `${host.name}${host.domain && !/^(github|gitlab)\.com$/.test(host.domain) ? ` · ${host.domain}` : ""}` : "No git host"));
    const account = res.account;
    const via = account ? { environment: "from the environment", file: "connected here", cli: "via glab" }[account.source] || "" : host.kind === "github" ? "via gh" : "";
    const line = account && account.user ? `@${account.user}${via ? ` · ${via}` : ""}` : via;
    if (line || (account && account.source === "file")) {
      const sub = div("chg-host-sub", line);
      if (account && account.source === "file") { const out = button("Disconnect", "chg-host-link", () => doConnect("")); sub.appendChild(out); }
      who.appendChild(sub);
    }
    bar.appendChild(who);
    if (host.webUrl) bar.appendChild(button(`Open on ${host.kind ? host.name : "the host"} ↗`, "chg-host-btn", () => window.open(host.webUrl, "_blank", "noopener")));
    return bar;
  }

  function renderConnect(res) {
    const host = res.host;
    const c = state.connect || (state.connect = { token: "", error: "" });
    const card = div("chg-connect");
    const head = div("chg-connect-h");
    head.appendChild(hostMark(host.kind, 30));
    const words = div("");
    words.appendChild(div("chg-connect-title", `Connect ${host.name}`));
    words.appendChild(div("chg-connect-sub", `See ${hostTerms(host).long}s, pipelines and reviews for ${host.domain} here, and merge from this pane.`));
    head.appendChild(words);
    card.appendChild(head);
    const steps = div("chg-connect-steps");
    const page = tokenPage(host);
    const one = div("chg-connect-step");
    one.appendChild(span("chg-connect-n", "1"));
    const oneBody = div("chg-connect-body");
    oneBody.appendChild(span("", host.kind === "gitlab" ? "Create a personal access token with the api scope" : "Create a token with gitboy's Phren Hook preset (read:user, read:repo, write:repo)"));
    if (page) oneBody.appendChild(button("Open token page ↗", "chg-host-btn", () => window.open(page, "_blank", "noopener")));
    one.appendChild(oneBody);
    steps.appendChild(one);
    const two = div("chg-connect-step");
    two.appendChild(span("chg-connect-n", "2"));
    const twoBody = div("chg-connect-body row");
    two.appendChild(twoBody);
    const input = document.createElement("input");
    input.type = "password"; input.className = "chg-connect-input"; input.placeholder = host.kind === "gitlab" ? "glpat-…" : "gbp_…";
    input.autocomplete = "off"; input.spellcheck = false; input.value = c.token;
    input.oninput = () => { c.token = input.value; c.error = ""; };
    input.onkeydown = (e) => { if (e.key === "Enter") doConnect(c.token); };
    twoBody.appendChild(input);
    twoBody.appendChild(button(state.busy === "connect" ? "Checking…" : "Connect", "chg-btn commit", () => doConnect(c.token)));
    steps.appendChild(two);
    card.appendChild(steps);
    if (c.error) card.appendChild(div("chg-error", c.error));
    card.appendChild(div("chg-connect-foot", `The token is checked with ${host.name}, then stored only on that computer (mode 600), never in your Phren store. You can also run: phren bridge git-host set ${host.domain} ${host.kind}`));
    return card;
  }

  async function doConnect(token) {
    if (state.busy) return;
    state.busy = "connect"; render();
    try {
      const res = await hookPost(computer, "/v1/git/host-token", scopeBody({ token: String(token || "").trim(), expectedRepository: repo() }));
      if (res && res.ok) {
        state.connect = null;
        toast(res.disconnected ? `Disconnected ${res.domain}` : `Connected${res.user ? ` as @${res.user}` : ""}`);
        state.pulls = await hookPost(computer, "/v1/git/pulls", scopeBody());
      } else (state.connect || (state.connect = { token: "" })).error = (res && res.message) || "The host refused that token.";
    } catch (e) { (state.connect || (state.connect = { token: "" })).error = newerHook(e, "host-token"); }
    finally { state.busy = null; render(); }
  }

  function renderCurrentPull(p, host) {
    const t = terms();
    const card = div("chg-req " + (p.checks || "none"));
    const top = div("chg-req-top");
    top.appendChild(span("chg-req-state " + reqState(p), reqStateLabel(p)));
    top.appendChild(span("chg-req-num", `${t.ref}${p.number}`));
    if (p.updated) top.appendChild(span("chg-req-age", relativeTime(p.updated)));
    card.appendChild(top);
    const title = div("chg-req-title", p.title || "");
    title.title = p.url || "";
    title.onclick = () => { if (p.url) window.open(p.url, "_blank", "noopener"); };
    card.appendChild(title);
    const route = div("chg-req-route");
    route.appendChild(span("chg-chip", p.head || ""));
    route.appendChild(span("chg-req-arrow", "→"));
    route.appendChild(span("chg-chip", p.base || ""));
    if (p.author) route.appendChild(span("chg-req-by", `by @${p.author}`));
    if (typeof p.ahead === "number" && p.ahead) route.appendChild(span("chg-req-by", `${p.ahead} ahead`));
    if (typeof p.behind === "number" && p.behind) route.appendChild(span("chg-req-by", `${p.behind} behind`));
    card.appendChild(route);

    const chips = div("chg-req-chips");
    const review = { APPROVED: ["Approved", "ok"], CHANGES_REQUESTED: ["Changes requested", "bad"], REVIEW_REQUIRED: ["Review required", "wait"] }[p.reviewDecision];
    if (review) chips.appendChild(span("chg-pill " + review[1], review[0] + (p.approvals ? ` · ${p.approvals.given}${p.approvals.required ? `/${p.approvals.required}` : ""}` : "")));
    else if (p.approvals && p.approvals.given) chips.appendChild(span("chg-pill ok", `${p.approvals.given} approval${p.approvals.given === 1 ? "" : "s"}`));
    if (typeof p.comments === "number" && p.comments) chips.appendChild(span("chg-pill", `${p.comments} comment${p.comments === 1 ? "" : "s"}`));
    if (p.conflicts) chips.appendChild(span("chg-pill bad", "Conflicts"));
    if (chips.childNodes.length) card.appendChild(chips);

    void loadTasks(p);
    const tasks = state.branchTasks;
    if (tasks.tasks.length && tasks.key === tasksKey(p)) {
      card.appendChild(renderBranchTasks({ computer, project: projectOf(ctx.child), branch: p.head, state: tasks, rerender: render }));
    }

    const runs = p.checkRuns || [];
    if (runs.length || p.pipeline) card.appendChild(renderPipeline(p, runs));
    else if (p.checks == null) card.appendChild(div("chg-log-meta", `No checks reported for this ${t.long}.`));

    const merge = mergeAvailability(p);
    if (p.mergeState || (p.blockers && p.blockers.length)) card.appendChild(renderMergeBanner(p));
    if (merge.show) card.appendChild(renderMergeBar(p, host, merge));
    return card;
  }

  function reqState(p) { return p.state === "MERGED" ? "merged" : p.state === "CLOSED" ? "closed" : p.draft ? "draft" : "open"; }
  function reqStateLabel(p) { return { merged: "Merged", closed: "Closed", draft: "Draft", open: "Open" }[reqState(p)]; }

  function renderPipeline(p, runs) {
    const box = div("chg-pipe");
    const head = div("chg-pipe-h");
    // GitHub reports checks; GitLab and gitboy run a pipeline.
    const what = state.pulls && state.pulls.host && state.pulls.host.kind !== "github" ? "Pipeline" : "Checks";
    const word = checksWord(p.checks, what) || "Checks";
    const label = span("chg-pipe-word " + (p.checks || ""), word);
    if (p.pipeline && p.pipeline.url) { label.classList.add("link"); label.onclick = () => window.open(p.pipeline.url, "_blank", "noopener"); label.title = p.pipeline.url; }
    head.appendChild(label);
    if (runs.length) head.appendChild(span("chg-pipe-sum", checksSummary(runs)));
    box.appendChild(head);
    const bar = div("chg-pipe-bar");
    for (const seg of pipelineSegments(runs)) {
      const s = div("chg-pipe-seg " + seg.state);
      s.style.flexGrow = String(seg.count);
      s.title = `${seg.count} ${seg.state}`;
      bar.appendChild(s);
    }
    if (runs.length) box.appendChild(bar);
    for (const group of groupRuns(runs)) {
      const list = div("chg-checks-list");
      if (group.name) list.appendChild(div("chg-check-group", group.name));
      for (const r of group.runs) {
        const row = div("chg-check" + (r.url ? " link" : ""));
        row.appendChild(span("chg-check-state " + r.state, { failing: "✕", pending: "", passing: "✓", skipped: "–", neutral: "○" }[r.state] ?? "○"));
        const name = span("chg-check-name", r.name);
        if (r.detail) name.title = r.detail;
        row.appendChild(name);
        if (r.detail && r.state === "failing") row.appendChild(span("chg-check-detail", r.detail));
        const d = durationText(r.seconds);
        if (d) row.appendChild(span("chg-check-wf", d));
        if (r.url) { row.title = r.url; row.onclick = () => window.open(r.url, "_blank", "noopener"); row.appendChild(span("chg-check-go", "↗")); }
        list.appendChild(row);
      }
      box.appendChild(list);
    }
    const failing = runs.filter((r) => r.state === "failing");
    if (failing.length) {
      void loadSeen(p, failing);
      if (ctx.child && p.head) box.appendChild(renderFixIt(p, failing));
      if (state.seen.results.length) box.appendChild(renderSeen(failing));
    }
    return box;
  }

  const tasksKey = (p) => `${ctx.child ? projectOf(ctx.child) : ""}\u0000${p.head || ""}`;

  // The project's open tasks that name this request's branch, asked once per
  // branch; an older Hook shows nothing.
  async function loadTasks(p) {
    const key = tasksKey(p);
    if (!ctx.child || !p.head || key === state.branchTasks.key) return;
    state.branchTasks = { key, tasks: [], done: new Set(), busy: null, error: "" };
    const tasks = await loadBranchTasks(computer, projectOf(ctx.child), p.head);
    if (state.branchTasks.key !== key || !tasks || !tasks.length) return;
    state.branchTasks.tasks = tasks;
    if (!typing()) render();
  }

  // gitboy's "Seen this before" on a failed job: the project's findings and
  // truths that match the failing checks' names and messages. Asked once per
  // head and set of failures; best effort.
  async function loadSeen(p, failing) {
    const project = ctx.child ? projectOf(ctx.child) : "";
    const q = failing.map((r) => [r.name, r.detail].filter(Boolean).join(": ")).join("\n").slice(0, 1000);
    const key = `${project}\u0000${p.number}\u0000${p.headSha || ""}\u0000${q}`;
    if (!project || !q.trim() || key === state.seen.key) return;
    state.seen = { key, results: [] };
    let results = [];
    try {
      const body = await hookGet(computer, `/v1/projects/${encodeURIComponent(project)}/memory/search`, { q, limit: "3" });
      results = Array.isArray(body?.results) ? body.results : [];
    } catch { /* an older Hook or a project outside the store: nothing to show */ }
    if (state.seen.key !== key) return;
    state.seen.results = results;
    if (results.length && !typing()) render();
  }

  // A new worker on this branch with the failures and what Phren remembers,
  // through the launch sheet so the harness and computer can still change.
  function renderFixIt(p, failing) {
    const row = div("chg-fixit");
    const go = button("Fix it", "chg-btn commit", () => {
      const t = terms();
      openLaunchSheet({
        project: projectOf(ctx.child), computer, title: `Fix ${t.ref}${p.number}`, label: `Fix ${t.ref}${p.number}`,
        prompt: fixItPrompt({ ref: t.ref, number: p.number, title: p.title, head: p.head, url: p.url, failing, remembered: state.seen.results }),
      });
    });
    go.title = "Start a new agent on this branch with the failing checks";
    row.append(go, span("chg-fixit-sub", `Start a new agent on ${p.head} with ${failing.length === 1 ? "the failure" : `the ${failing.length} failures`}${state.seen.results.length ? " and what Phren remembers" : ""}`));
    return row;
  }

  function renderSeen(failing) {
    const box = div("chg-seen");
    const head = div("chg-seen-h");
    head.append(span("chg-knows-mark", "◆"), span("", "Seen this before"), span("chg-knows-sub", "Phren remembers"));
    box.appendChild(head);
    for (const hit of state.seen.results) {
      const row = div("chg-seen-item");
      row.appendChild(div("chg-knows-text", hit.text || ""));
      const meta = div("chg-knows-meta");
      meta.appendChild(span("chg-chip", hit.kind === "truth" ? "truth" : (hit.finding && hit.finding.type) || "finding"));
      const cite = hit.finding && hit.finding.citation;
      if (cite && (cite.name || cite.file)) meta.appendChild(span("chg-pr-num", cite.name || basename(cite.file) + (cite.line ? `:${cite.line}` : "")));
      const ask = button("Ask the agent", "chg-knows-cite", () => ctx.ask(seenPrompt(failing, hit)));
      ask.title = "Put this failure and what Phren remembers in the chat";
      meta.appendChild(ask);
      row.appendChild(meta);
      box.appendChild(row);
    }
    return box;
  }

  const seenPrompt = (failing, hit) => [
    `CI is failing on this branch: ${failing.map((r) => r.detail ? `${r.name} (${r.detail})` : r.name).join(", ")}.`,
    `Phren remembers: ${hit.text}`,
    "Check whether this is the same problem and fix it.",
    "",
  ].join("\n");

  function renderMergeBanner(p) {
    const tone = p.mergeState === "CLEAN" ? "ok" : p.mergeState === "DIRTY" ? "bad" : p.mergeState === "UNKNOWN" ? "" : "wait";
    const banner = div("chg-merge-banner " + tone);
    banner.appendChild(div("chg-merge-word", p.mergeDetail || pullStanding({ mergeState: p.mergeState }) || "Merge state unknown"));
    const extra = (p.blockers || []).filter((b) => b !== p.mergeDetail);
    if (extra.length) { const ul = document.createElement("ul"); for (const b of extra) { const li = document.createElement("li"); li.textContent = b; ul.appendChild(li); } banner.appendChild(ul); }
    return banner;
  }

  function renderMergeBar(p, host, avail) {
    const m = state.merge && state.merge.number === p.number ? state.merge : (state.merge = { number: p.number, method: mergeMethods(host)[0][0], confirm: false });
    const bar = div("chg-merge");
    if (!avail.enabled) { bar.appendChild(div("chg-log-meta", avail.why)); return bar; }
    const methodLabel = (mergeMethods(host).find(([k]) => k === m.method) || [, "Merge"])[1];
    if (m.confirm) {
      const sha = p.headSha ? p.headSha.slice(0, 7) : "";
      bar.appendChild(div("chg-merge-ask", `${methodLabel} ${terms().ref}${p.number}${sha ? ` at ${sha}` : ""} into ${p.base || "its base"}?`));
      const row = div("chg-merge-row");
      row.appendChild(button("Cancel", "chg-btn stage", () => { m.confirm = false; render(); }));
      row.appendChild(button(state.busy === "merge" ? "Merging…" : "Confirm merge", "chg-btn merge", () => doMerge(p)));
      bar.appendChild(row);
      return bar;
    }
    if (isArmed(computer, repo(), p.number)) {
      const row = div("chg-merge-row");
      row.appendChild(div("chg-merge-armed", `${methodLabel} when checks pass`));
      row.appendChild(button("Cancel", "chg-btn stage", () => disarmMerge(computer, repo(), p.number)));
      bar.appendChild(row);
      bar.appendChild(div("chg-log-meta", "While this app is open. New commits or a failing check cancel it."));
      return bar;
    }
    const row = div("chg-merge-row");
    const select = document.createElement("select");
    select.className = "chg-merge-method";
    for (const [key, label] of mergeMethods(host)) { const o = document.createElement("option"); o.value = key; o.textContent = label; if (key === m.method) o.selected = true; select.appendChild(o); }
    select.onchange = () => { m.method = select.value; };
    row.appendChild(select);
    row.appendChild(button(avail.ready ? "Merge" : "Merge…", "chg-btn merge" + (avail.ready ? " ready" : ""), () => { m.confirm = true; render(); }));
    bar.appendChild(row);
    if (!avail.ready && p.checks !== "failing" && state.pulls?.current?.number === p.number) {
      bar.appendChild(button("Merge when checks pass", "chg-btn stage chg-merge-later", () => armMerge({
        computer, scope: scopeBody(), number: p.number, method: m.method, headSha: p.headSha, repository: repo(),
        ref: terms().ref, title: p.title || "", project: projectOf(ctx.child),
      })));
    }
    if (!avail.ready) bar.appendChild(div("chg-log-meta", `${host && host.kind ? host.name : "The host"} decides; it will refuse while checks or reviews block it.`));
    return bar;
  }

  async function doMerge(p) {
    if (state.busy) return;
    state.busy = "merge"; render();
    const m = state.merge;
    try {
      const res = await hookPost(computer, "/v1/git/pr/merge", scopeBody({ number: p.number, method: m.method, ...(p.headSha ? { expectedHeadSha: p.headSha } : {}), expectedRepository: repo() }));
      if (res && res.ok) { state.merge = null; toast(`Merged ${terms().ref}${p.number}`); state.landed = `merged-${p.number}`; }
      else state.notice = { title: res && res.reason === "blocked" ? `${terms().ref}${p.number} can't be merged yet` : "The merge was refused", message: (res && res.message) || "The host refused the merge." };
      m.confirm = false;
      state.pulls = await hookPost(computer, "/v1/git/pulls", scopeBody());
    } catch (e) { state.notice = { title: "Could not merge", message: newerHook(e, "pr/merge") }; }
    finally { state.busy = null; render(); }
  }

  function renderPullRow(p) {
    const row = div("chg-pr-row");
    const dot = div("chg-dot");
    dot.style.background = pullColor(p);
    row.appendChild(dot);
    const mid = div("chg-main");
    const title = div("chg-pr-title");
    title.appendChild(span("chg-req-num", `${terms().ref}${p.number}`));
    title.appendChild(document.createTextNode(" " + (p.title || "")));
    mid.appendChild(title);
    const meta = div("chg-pr-meta");
    if (p.draft) meta.appendChild(span("chg-req-state draft", "Draft"));
    if (p.head) meta.appendChild(span("chg-chip", p.head));
    if (p.author) meta.appendChild(span("chg-req-by", `@${p.author}`));
    if (p.updated) meta.appendChild(span("chg-req-by", relativeTime(p.updated)));
    mid.appendChild(meta);
    row.appendChild(mid);
    row.title = p.url || "";
    row.onclick = () => { if (p.url) window.open(p.url, "_blank", "noopener"); };
    return row;
  }

  // ---- worktrees -----------------------------------------------------------
  function worktreeTitle(w) { return (w.worker && w.worker.label) || w.branch || w.path || "worktree"; }

  function worktreeDetail(w) {
    if (w.main) return (w.branch || "detached") + " · main checkout";
    if (w.worker) return w.branch || "detached";
    return w.branch == null ? "detached · " + w.path : w.path;
  }

  function renderWorktrees() {
    const body = div("chg-body");
    const res = state.worktrees;
    if (!res) { body.appendChild(div("chg-empty", state.error ? state.error : "Loading…")); return body; }
    const rows = (res.worktrees || []).filter(Boolean);
    if (!rows.length) {
      const empty = div("chg-empty");
      empty.appendChild(div("chg-empty-icon", "⑂"));
      empty.appendChild(div("", "No other worktrees"));
      body.appendChild(empty);
      return body;
    }
    const workers = rows.filter((w) => w.worker);
    const others = rows.filter((w) => !w.worker);
    if (workers.length) { body.appendChild(sectionHead("WORKERS", workers.length)); for (const w of workers) body.appendChild(renderWorktreeRow(w)); }
    if (others.length) { body.appendChild(sectionHead(workers.length ? "OTHER WORKTREES" : "WORKTREES", others.length)); for (const w of others) body.appendChild(renderWorktreeRow(w)); }
    return body;
  }

  function renderWorktreeRow(w) {
    const row = div("chg-wt-row");
    row.appendChild(div("chg-wt-glyph", w.worker ? (w.worker.provider || "◆").slice(0, 1).toUpperCase() : "⑂"));
    const mid = div("chg-wt-mid");
    mid.appendChild(div("chg-wt-title", worktreeTitle(w)));
    mid.appendChild(div("chg-wt-detail", worktreeDetail(w)));
    row.appendChild(mid);
    const track = div("chg-track");
    if (w.ahead > 0) track.appendChild(span("up", "↑" + w.ahead));
    if (w.behind > 0) track.appendChild(span("down", "↓" + w.behind));
    if (w.changed > 0) track.appendChild(span("chg-dels", w.changed + " changed"));
    row.appendChild(track);
    row.title = w.path || "";
    row.onclick = () => openWorktree(w);
    return row;
  }

  // ---- notices, toast, sheet ----------------------------------------------
  function renderNotice() {
    const n = state.notice;
    const box = div("chg-notice");
    box.appendChild(div("chg-notice-title", n.title || ""));
    if (n.message) box.appendChild(div("", n.message));
    if (n.url) {
      const a = document.createElement("a");
      a.className = "chg-notice-link"; a.href = n.url; a.textContent = `View on ${n.site || "the git host"}`;
      a.target = "_blank"; a.rel = "noopener";
      box.appendChild(a);
    }
    const actions = div("chg-sheet-actions");
    actions.appendChild(button("Dismiss", "chg-btn stage", () => { state.notice = null; render(); }));
    box.appendChild(actions);
    return box;
  }

  function renderToast() {
    const t = div("chg-toast");
    t.appendChild(span("", state.copyToast));
    return t;
  }

  function sheetField(label, key, value, multiline, placeholder) {
    const wrap = div("chg-field");
    const l = document.createElement("label"); l.textContent = label; wrap.appendChild(l);
    const input = document.createElement(multiline ? "textarea" : "input");
    input.dataset.key = key; input.value = value || ""; input.placeholder = placeholder || "";
    if (multiline) input.rows = 3;
    wrap.appendChild(input);
    return wrap;
  }

  function submitPr(card, draft) {
    const fields = { title: "", body: "", base: "", head: (state.sheet && state.sheet.head) || "" };
    for (const el of card.querySelectorAll("[data-key]")) fields[el.dataset.key] = el.value;
    doPullRequest(draft, fields);
  }

  function renderBranchSheet(sheet) {
    const s = state.sheet;
    const card = div("chg-sheet-card");
    card.appendChild(div("chg-sheet-h", s.startPoint ? `New branch from ${s.startPoint}` : "New branch"));
    const field = sheetField("Branch name", "name", s.name, false, "feature/name");
    const input = field.querySelector("input");
    const problem = div("chg-error", s.error || "");
    const create = button(state.busy === "checkout" ? "Creating…" : "Create and switch", "chg-btn commit", () => submit());
    const check = () => {
      s.name = input.value.trim();
      const why = s.name ? branchProblem(s.name) : "";
      problem.textContent = why || s.error || "";
      create.disabled = !s.name || !!why || !!state.busy;
    };
    const submit = () => { check(); if (!create.disabled) { s.error = ""; checkout({ branch: s.name, create: true, startPoint: s.startPoint || undefined }); } };
    input.addEventListener("input", () => { s.error = ""; check(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") { state.sheet = null; render(); } });
    card.appendChild(field);
    card.appendChild(problem);
    card.appendChild(div("chg-log-meta", s.startPoint ? `Starts at ${s.startPoint}${s.startPoint.includes("/") && !(state.branches?.local || []).some((b) => b.name === s.startPoint) ? " and tracks it" : ""}.`
      : "Starts at the current commit. Uncommitted changes come along."));
    const actions = div("chg-sheet-actions");
    actions.appendChild(button("Cancel", "chg-btn stage", () => { state.sheet = null; render(); }));
    actions.appendChild(create);
    card.appendChild(actions);
    sheet.appendChild(card);
    check();
    return sheet;
  }

  function renderSheet() {
    const s = state.sheet;
    if (s.kind === "branch") {
      const sheet = div("chg-sheet");
      sheet.onclick = (e) => { if (e.target === sheet) { state.sheet = null; render(); } };
      return renderBranchSheet(sheet);
    }
    const sheet = div("chg-sheet");
    sheet.onclick = (e) => { if (e.target === sheet) { state.sheet = null; render(); } };
    const card = div("chg-sheet-card");
    const t = terms();
    card.appendChild(div("chg-sheet-h", `Open a ${t.long}`));
    card.appendChild(sheetField("Title", "title", s.title, false, "Derived from the commits"));
    card.appendChild(sheetField("Body", "body", s.body, true, "Derived from the commits"));
    card.appendChild(sheetField("Base", "base", s.base, false, "Default branch"));
    card.appendChild(div("chg-log-meta", `The computer opens this on ${t.name}, titled from the commits.`));
    const actions = div("chg-sheet-actions");
    actions.appendChild(button("Cancel", "chg-btn stage", () => { state.sheet = null; render(); }));
    actions.appendChild(button("Open as draft", "chg-btn stage", () => submitPr(card, true)));
    actions.appendChild(button(state.busy === "pr" ? "Opening…" : `Open ${t.long}`, "chg-btn commit", () => submitPr(card, false)));
    card.appendChild(actions);
    sheet.appendChild(card);
    return sheet;
  }

  // ---- lifecycle -----------------------------------------------------------
  // A re-read skipped while the pane was off screen runs when it comes back.
  let skipped = false;
  function startTimer() { timer = setInterval(() => { if (canPoll()) refresh(); else if (!isShown(el)) skipped = true; }, 10000); }
  function stopTimer() { if (timer) clearInterval(timer); timer = null; }
  const stopWatchingShown = watchShown(el, () => { if (skipped && canPoll()) { skipped = false; refresh(); } });

  // A diff tab staged a hunk or a file: re-read this pane when it is the same session.
  const onGitChanged = (e) => {
    if (Date.now() - announcedAt < 1000) return;
    if (e.detail?.computer === computer && e.detail?.session === target?.session && !state.busy) refresh();
  };
  window.addEventListener("phren:git-changed", onGitChanged);
  // Arming re-draws the merge bar; a merge or disarm by the watch re-reads.
  const stopArmedChange = onArmedChange(() => { if (state.view === "pulls" && !state.busy) refresh(); });

  startTimer();
  refresh();

  return {
    refresh,
    showView: selectView,
    close() { visible = false; stopTimer(); stopWatchingShown(); window.removeEventListener("phren:git-changed", onGitChanged); stopArmedChange(); el.innerHTML = ""; },
  };
}

function injectStyle() {
  if (document.getElementById("changes-style")) return;
  const style = document.createElement("style");
  style.id = "changes-style";
  style.textContent = CHANGES_CSS;
  document.head.appendChild(style);
}

// Kept importable from here (projects.js, src/changes.test.ts).
export { hostMark, isDefaultBranch, planPublish, prReason, pushReason } from "./changes/util.js";
