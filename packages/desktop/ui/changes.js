// Changes workbench pane: working tree, history, branches, pull requests and
// worktrees, each scoped to the session (or a worker's worktree). Owns its own
// CSS (injected once) and re-renders fully from module state.
import { hookPost, readRepoFile } from "./api.js";
import { ADDED_FILE_MAX_LINES, additionHunks, parsePatch, wordSegments } from "./patch.js";
import { branchProblem, checksSummary, localForRemote, pullStanding, syncAction, trackingText } from "./git-review.js";
import { announceGitChange } from "./diff-doc.js";

// The phone's Changes tabs, minus Working tree (the Files pane owns that here).
// "Session" is what this agent changed, from the Hook's per-call capture.
// Short labels so six fit the panel; each carries its full name as a title.
const VIEWS = [["changes", "Changes", "Uncommitted changes"], ["session", "Session", "What this agent changed"], ["history", "History", "Commit history"],
  ["branches", "Branches", "Branches"], ["pulls", "PRs", "Pull requests and checks"], ["worktrees", "Workers", "Other worktrees and the workers in them"]];

const CSS = `
.chg{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--text-2);font:13px/1.45 system-ui,sans-serif}
.chg-top{padding:12px 12px 8px;flex:none}
.chg-segs{display:flex;gap:3px;background:var(--surface);border-radius:999px;padding:3px}
.chg-seg{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;border:none;background:none;color:var(--muted);font:11.5px system-ui,sans-serif;padding:5px 4px;border-radius:999px;cursor:pointer;white-space:nowrap;transition:background .18s ease,color .18s ease}
.chg-seg:hover{color:var(--text-2)}
.chg-seg.sel{background:var(--card);color:var(--accent)}
.chg-sub{margin-top:7px;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-scope{display:flex;align-items:center;gap:8px;margin-top:7px;padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:10px}
.chg-scope-back{border:none;background:none;color:var(--accent);font:600 12px system-ui,sans-serif;cursor:pointer;padding:0}
.chg-scope-back:hover{color:var(--accent-hover)}
.chg-scope-name{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12px;color:var(--text)}
.chg-body{flex:1;min-height:0;overflow:auto;padding:0 12px 12px}
.chg-sec{margin-top:12px}
.chg-sec-h{display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.chg-pill{background:var(--raised);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--text-2)}
.chg-row{display:flex;align-items:center;gap:10px;min-height:44px;padding:4px 6px;border-radius:10px;cursor:pointer;position:relative}
.chg-row:hover{background:var(--surface)}
.chg-row-menu{position:absolute;top:40px;right:6px;z-index:7;min-width:140px;background:var(--card);border:1px solid var(--border-strong);border-radius:12px;padding:6px;box-shadow:0 16px 40px rgba(0,0,0,.5)}
.chg-row-item{display:block;width:100%;text-align:left;border:none;background:none;color:var(--text-2);font:13px system-ui,sans-serif;padding:8px 10px;border-radius:9px;cursor:pointer}
.chg-row-item:hover{background:var(--raised)}
.chg-row-item.danger{color:var(--danger)}
.chg-tile{flex:none;width:24px;height:24px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12px}
.chg-tile.M,.chg-tile.A{background:rgba(138,200,172,.16);color:var(--done)}
.chg-tile.D{background:rgba(239,152,152,.16);color:var(--danger)}
.chg-tile.R{background:var(--raised);color:var(--link)}
.chg-tile.Q{background:var(--raised);color:var(--muted)}
.chg-main{min-width:0;flex:1}
.chg-name{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-folder{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-stat{display:flex;gap:8px;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12px;white-space:nowrap}
.chg-adds{color:var(--done)}
.chg-dels{color:var(--danger)}
.chg-actions{display:flex;gap:4px;opacity:0;pointer-events:none}
.chg-row:hover .chg-actions{opacity:1;pointer-events:auto}
.chg-icon{width:26px;height:26px;border:none;border-radius:7px;background:var(--raised);color:var(--muted);font-size:12px;cursor:pointer}
.chg-icon:hover{background:var(--card);color:var(--text)}
.chg-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:40px 0;color:var(--muted);text-align:center}
.chg-empty-check{font-size:22px;color:var(--done)}
.chg-empty-icon{font-size:22px;color:var(--muted)}
.chg-diff{margin:2px 0 8px;border:1px solid var(--border);border-radius:10px;overflow:hidden}
.chg-diff-sec{border-top:1px solid var(--border)}
.chg-diff-sec:first-child{border-top:none}
.chg-diff-label{padding:5px 10px;background:var(--sunken);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.chg-hunk{padding:4px 10px;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--accent);border-top:1px solid var(--border)}
.chg-line{position:relative;display:flex;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.5}
.chg-line.add{background:rgba(138,200,172,.14)}
.chg-line.del{background:rgba(239,152,152,.14)}
.chg-line .ln{flex:none;width:38px;padding-right:8px;text-align:right;color:var(--dim);user-select:none}
.chg-line .mark{flex:none;width:14px;text-align:center;color:var(--dim)}
.chg-line .code{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;padding-right:44px}
.chg-word.old-changed{background:rgba(239,152,152,.32);border-radius:2px}
.chg-word.new-changed{background:rgba(138,200,172,.32);border-radius:2px}
.chg-ask{position:absolute;top:1px;right:6px;opacity:0;border:none;border-radius:6px;background:var(--card);color:var(--accent);font:600 10.5px system-ui,sans-serif;padding:2px 7px;cursor:pointer}
.chg-line:hover .chg-ask{opacity:1}
.chg-footer{position:sticky;bottom:0;flex:none;display:flex;flex-direction:column;gap:8px;padding:10px 12px;background:var(--bg);border-top:1px solid var(--border)}
.chg-error{color:var(--danger);font-size:12px}
.chg-note{color:var(--waiting);font-size:12px}
.chg-confirm{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;font-size:12.5px;color:var(--text-2)}
.chg-confirm>span:first-child{flex:1}
.chg-commit{display:flex;align-items:flex-end;gap:8px}
.chg-msg{flex:1;min-height:34px;max-height:96px;resize:none;padding:8px 10px;background:var(--sunken);border:1px solid var(--border);border-radius:12px;color:var(--text);font:13px/1.4 system-ui,sans-serif;outline:none}
.chg-msg:focus{border-color:var(--border-strong)}
.chg-btn{border:none;border-radius:10px;padding:9px 14px;font:600 13px system-ui,sans-serif;cursor:pointer;white-space:nowrap}
.chg-btn:disabled{cursor:default;opacity:.35}
.chg-btn.commit{background:var(--accent-solid);color:var(--text)}
.chg-btn.stage{background:var(--raised);color:var(--text)}
.chg-btn.danger{background:var(--danger);color:var(--bg)}
.chg-btn.push{background:var(--card);color:var(--accent);border-radius:999px}
.chg-actions-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.chg-log-row{display:flex;gap:10px;padding:9px 6px;border-bottom:1px solid var(--border);cursor:pointer;border-radius:8px}
.chg-log-row:hover{background:var(--surface)}
.chg-sha{flex:none;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12px;color:var(--accent)}
.chg-log-mid{min-width:0;flex:1}
.chg-log-subject{color:var(--text);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-log-meta{color:var(--muted);font-size:12px;margin-top:1px}
.chg-refs{display:flex;gap:4px;flex-wrap:wrap;margin-top:3px}
.chg-ref{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:10.5px;padding:1px 6px;border-radius:999px;background:var(--raised);color:var(--muted)}
.chg-ref.head{color:var(--done)}
.chg-ref.remote{color:var(--waiting)}
.chg-ref.local{color:var(--link)}
.chg-ref.tag{color:var(--muted)}
.chg-branch-row{display:flex;align-items:center;gap:10px;min-height:44px;padding:4px 6px;border-radius:10px;cursor:pointer}
.chg-branch-row:hover{background:var(--surface)}
.chg-branch-check{width:16px;color:var(--done);text-align:center}
.chg-branch-name{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--text);min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-branch-up{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted)}
.chg-track{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--muted);white-space:nowrap}
.chg-track .up{color:var(--done)}
.chg-track .down{color:var(--waiting)}
.chg-pr-row{display:flex;gap:10px;min-height:44px;padding:8px 6px;border-radius:10px;cursor:pointer;align-items:flex-start}
.chg-pr-row:hover{background:var(--surface)}
.chg-dot{flex:none;width:8px;height:8px;border-radius:50%;margin-top:6px}
.chg-pr-num{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)}
.chg-pr-title{font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-pr-meta{display:flex;gap:6px;align-items:center;margin-top:2px;flex-wrap:wrap}
.chg-chip{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted);background:var(--raised);border-radius:999px;padding:1px 7px}
.chg-checks{font-size:11px;border-radius:999px;padding:1px 8px}
.chg-checks.passing{background:rgba(138,200,172,.16);color:var(--done)}
.chg-checks.failing{background:rgba(239,152,152,.16);color:var(--danger)}
.chg-checks.pending{background:rgba(224,188,127,.16);color:var(--waiting)}
.chg-wt-row{display:flex;gap:10px;min-height:44px;padding:8px 6px;border-radius:10px;cursor:pointer;align-items:center}
.chg-wt-row:hover{background:var(--surface)}
.chg-wt-glyph{flex:none;width:24px;height:24px;border-radius:7px;display:flex;align-items:center;justify-content:center;background:var(--raised);color:var(--accent);font-size:12px}
.chg-wt-mid{min-width:0;flex:1}
.chg-wt-title{font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-wt-detail{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.chg-toast{position:sticky;bottom:0;display:flex;justify-content:center;padding:10px;pointer-events:none}
.chg-toast>span{background:var(--raised);border:1px solid var(--border-strong);border-radius:999px;padding:6px 14px;font-size:12.5px;color:var(--text)}
.chg-notice{margin:8px 0;padding:10px;background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;font-size:12.5px;color:var(--text-2)}
.chg-notice-title{font-weight:600;color:var(--text);margin-bottom:3px}
.chg-notice-link{display:inline-block;margin-top:6px;color:var(--link);cursor:pointer;text-decoration:none}
.chg-sheet{position:fixed;inset:0;z-index:12;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}
.chg-sheet-card{width:min(440px,90vw);background:var(--card);border:1px solid var(--border-strong);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:10px}
.chg-sheet-h{font-weight:600;font-size:15px;color:var(--text)}
.chg-field{display:flex;flex-direction:column;gap:4px}
.chg-field label{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.chg-field input,.chg-field textarea{background:var(--sunken);border:1px solid var(--border);border-radius:10px;color:var(--text);font:13px/1.4 system-ui,sans-serif;padding:8px 10px;outline:none;resize:vertical}
.chg-field input:focus,.chg-field textarea:focus{border-color:var(--border-strong)}
.chg-sheet-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.chg-branchbar{display:flex;align-items:center;gap:8px;margin-top:8px;min-height:30px}
.chg-bb-name{display:flex;align-items:center;gap:6px;min-width:0;flex:1;border:none;background:none;padding:0;cursor:pointer;color:var(--text);font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12.5px}
.chg-bb-name>span:first-of-type{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-bb-glyph{color:var(--accent)}
.chg-bb-track{flex:none;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--raised);color:var(--muted)}
.chg-bb-track.unpushed{color:var(--waiting)}
.chg-bb-btn{flex:none;border:1px solid var(--border);background:var(--raised);color:var(--text-2);border-radius:999px;font:600 11.5px system-ui,sans-serif;padding:4px 10px;cursor:pointer;white-space:nowrap}
.chg-bb-btn:hover:not(:disabled){border-color:var(--border-strong);color:var(--text)}
.chg-bb-btn:disabled{opacity:.4;cursor:default}
.chg-bb-btn.pull{color:var(--waiting)}
.chg-bb-pr{flex:none;font:600 11px "JetBrains Mono",ui-monospace,Menlo,monospace;padding:2px 8px;border-radius:999px;cursor:pointer;border:none}
.chg-bb-pr.passing{background:rgba(138,200,172,.16);color:var(--done)}
.chg-bb-pr.failing{background:rgba(239,152,152,.16);color:var(--danger)}
.chg-bb-pr.pending{background:rgba(224,188,127,.16);color:var(--waiting)}
.chg-bb-pr.none{background:var(--raised);color:var(--muted)}
.chg-commit-head{padding:10px 6px 12px;border-bottom:1px solid var(--border)}
.chg-back{border:none;background:none;color:var(--accent);font:600 12px system-ui,sans-serif;cursor:pointer;padding:0;margin-bottom:8px}
.chg-commit-subject{font-size:14px;font-weight:600;color:var(--text);line-height:1.35}
.chg-commit-body{margin-top:6px;white-space:pre-wrap;font-size:12.5px;color:var(--text-2)}
.chg-commit-meta{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin-top:8px;font-size:12px;color:var(--muted)}
.chg-copy{border:1px solid var(--border);background:var(--raised);color:var(--accent);font:11.5px "JetBrains Mono",ui-monospace,Menlo,monospace;border-radius:999px;padding:1px 8px;cursor:pointer}
.chg-log-row .chg-icon{opacity:0}
.chg-log-row:hover .chg-icon{opacity:1}
.chg-checks-list{margin:6px 0 10px;border:1px solid var(--border);border-radius:10px;overflow:hidden}
.chg-check{display:flex;align-items:center;gap:8px;padding:7px 10px;border-top:1px solid var(--border);font-size:12.5px;cursor:default}
.chg-check:first-child{border-top:none}
.chg-check.link{cursor:pointer}
.chg-check.link:hover{background:var(--surface)}
.chg-check-state{flex:none;width:16px;text-align:center;font-weight:700}
.chg-check-state.failing{color:var(--danger)}.chg-check-state.pending{color:var(--waiting)}.chg-check-state.passing{color:var(--done)}.chg-check-state.skipped,.chg-check-state.neutral{color:var(--muted)}
.chg-check-name{flex:1;min-width:0;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-check-wf{color:var(--muted);font-size:11.5px}
.chg-pr-card{margin-top:12px;padding:10px;border:1px solid var(--border-strong);border-radius:12px;background:var(--surface)}
.chg-pr-card-title{font-size:13.5px;font-weight:600;color:var(--text);cursor:pointer}
.chg-pr-card-title:hover{color:var(--link)}
.chg-pr-standing{margin-top:4px;font-size:12px;color:var(--waiting)}
.chg-session-sum{margin-top:10px;font-size:12px;color:var(--muted)}
.chg-edit-label{display:flex;align-items:center;gap:8px;padding:5px 10px;background:var(--sunken);font-size:11px;letter-spacing:.04em;color:var(--muted)}
.chg-edit-label .chg-stat{margin-left:auto}
`;

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
  const changedPaths = () => [...new Set((state.status?.files || []).filter((f) => !f.staged).map((f) => f.path))];
  const typing = () => document.activeElement && document.activeElement.tagName === "TEXTAREA";
  const canPoll = () => visible && document.visibilityState === "visible" && !state.confirm && !state.sheet && !typing();

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

  const doStage = (f) => write(() => hookPost(computer, "/v1/git/stage", scopeBody({ paths: [f.path], expectedRepository: repo() })));
  const doUnstage = (f) => write(() => hookPost(computer, "/v1/git/unstage", scopeBody({ paths: [f.path], expectedRepository: repo() })));
  const doStageAll = () => write(() => hookPost(computer, "/v1/git/stage", scopeBody({ paths: changedPaths(), confirmBulk: true, expectedRepository: repo() })));
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
      if (res && res.ok && res.url) state.notice = { title: res.existing ? "This branch already has a pull request" : "Pull request opened", message: res.url, url: res.url };
      else state.notice = { title: "Could not open a pull request", message: res.message || res.output || "gh pr create failed." };
      state.sheet = null;
      await refresh();
    } catch (e) { state.notice = { title: "Could not open a pull request", message: e.message || String(e) }; }
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
    for (const [key, label, title] of VIEWS) {
      if ((key === "worktrees" || key === "session") && state.worktree) continue;
      const seg = button(label, "chg-seg" + (state.view === key ? " sel" : ""), () => selectView(key));
      seg.title = title;
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
      const chip = button(`#${pr.number}`, "chg-bb-pr " + (pr.checks || "none"), () => selectView("pulls"));
      chip.title = `Pull request #${pr.number}` + (pr.checks ? ` · checks ${pr.checks}` : "");
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
    if (staged.length) body.appendChild(renderSection("STAGED", staged));
    if (changed.length) body.appendChild(renderSection("CHANGES", changed));
    return body;
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
    const prBtn = button(existing ? `PR #${existing}` : "Create PR", "chg-btn stage", () => {
      if (existing) window.open(plan.pull.url, "_blank", "noopener");
      else if (plan.pull && plan.pull.open) openPrSheet(s);
    });
    prBtn.disabled = !plan.pull || !!state.busy;
    if (!plan.pull) prBtn.title = prReason(s);
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

  function checkLabel(c) { return c === "passing" ? "checks pass" : c === "failing" ? "checks fail" : c === "pending" ? "checks pending" : ""; }

  function renderPulls() {
    const body = div("chg-body");
    const res = state.pulls;
    if (!res) { body.appendChild(div("chg-empty", state.error ? state.error : "Loading…")); return body; }
    if (res.available === false) {
      const empty = div("chg-empty");
      empty.appendChild(div("chg-empty-icon", "⇄"));
      empty.appendChild(div("", "GitHub CLI is not signed in on this computer"));
      empty.appendChild(div("chg-folder", "Install gh, then run gh auth login there."));
      body.appendChild(empty);
      return body;
    }
    const pulls = res.pulls || [];
    if (res.current) body.appendChild(renderCurrentPull(res.current));
    if (!pulls.length && !res.current) {
      const empty = div("chg-empty");
      empty.appendChild(div("chg-empty-icon", "⇄"));
      empty.appendChild(div("", "No open pull requests"));
      body.appendChild(empty);
      return body;
    }
    const others = pulls.filter((p) => !res.current || p.number !== res.current.number);
    if (res.current && others.length) body.appendChild(sectionHead("OPEN PULL REQUESTS", others.length));
    for (const p of others) body.appendChild(renderPullRow(p, res.current));
    return body;
  }

  function renderCurrentPull(p) {
    const card = div("chg-pr-card");
    card.appendChild(div("chg-sec-h", "THIS BRANCH"));
    const title = div("chg-pr-card-title", `#${p.number} ${p.title || ""}`);
    title.onclick = () => { if (p.url) window.open(p.url, "_blank", "noopener"); };
    card.appendChild(title);
    const meta = div("chg-pr-meta");
    meta.appendChild(span("chg-chip", (p.draft ? "draft · " : "") + String(p.state || "").toLowerCase()));
    if (p.base) meta.appendChild(span("chg-chip", "→ " + p.base));
    if (p.checks) meta.appendChild(span("chg-checks " + p.checks, checkLabel(p.checks)));
    card.appendChild(meta);
    const standing = pullStanding(p);
    if (standing) card.appendChild(div("chg-pr-standing", standing));
    const runs = p.checkRuns || [];
    if (runs.length) {
      card.appendChild(div("chg-log-meta", checksSummary(runs)));
      const list = div("chg-checks-list");
      for (const r of runs) {
        const row = div("chg-check" + (r.url ? " link" : ""));
        row.appendChild(span("chg-check-state " + r.state, { failing: "✕", pending: "●", passing: "✓", skipped: "–", neutral: "○" }[r.state] || "○"));
        row.appendChild(span("chg-check-name", r.name));
        if (r.workflow) row.appendChild(span("chg-check-wf", r.workflow));
        if (r.url) { row.title = r.url; row.onclick = () => window.open(r.url, "_blank", "noopener"); }
        list.appendChild(row);
      }
      card.appendChild(list);
    } else if (p.checks == null) card.appendChild(div("chg-log-meta", "No checks reported for this pull request."));
    return card;
  }

  function renderPullRow(p, current) {
    const row = div("chg-pr-row");
    const dot = div("chg-dot");
    dot.style.background = pullColor(p);
    row.appendChild(dot);
    const mid = div("chg-main");
    mid.appendChild(div("chg-pr-title", `#${p.number} ${p.title || ""}`));
    const meta = div("chg-pr-meta");
    if (p.head) meta.appendChild(span("chg-chip", p.head));
    if (p.base) meta.appendChild(span("chg-chip", "→ " + p.base));
    if (p.author) meta.appendChild(span("chg-chip", p.author));
    if (p.draft) meta.appendChild(span("chg-chip", "draft"));
    if (current && current.number === p.number && current.checks) meta.appendChild(span("chg-checks " + current.checks, checkLabel(current.checks)));
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
      a.className = "chg-notice-link"; a.href = n.url; a.textContent = "View on GitHub";
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
    card.appendChild(div("chg-sheet-h", "Open a pull request"));
    card.appendChild(sheetField("Title", "title", s.title, false, "Derived from the commits"));
    card.appendChild(sheetField("Body", "body", s.body, true, "Derived from the commits"));
    card.appendChild(sheetField("Base", "base", s.base, false, "Default branch"));
    card.appendChild(div("chg-log-meta", "Phren opens this with gh --fill on the computer."));
    const actions = div("chg-sheet-actions");
    actions.appendChild(button("Cancel", "chg-btn stage", () => { state.sheet = null; render(); }));
    actions.appendChild(button("Open as draft", "chg-btn stage", () => submitPr(card, true)));
    actions.appendChild(button(state.busy === "pr" ? "Opening…" : "Open pull request", "chg-btn commit", () => submitPr(card, false)));
    card.appendChild(actions);
    sheet.appendChild(card);
    return sheet;
  }

  // ---- lifecycle -----------------------------------------------------------
  function startTimer() { timer = setInterval(() => { if (canPoll()) refresh(); }, 10000); }
  function stopTimer() { if (timer) clearInterval(timer); timer = null; }

  // A diff tab staged a hunk or a file: re-read this pane when it is the same session.
  const onGitChanged = (e) => {
    if (Date.now() - announcedAt < 1000) return;
    if (e.detail?.computer === computer && e.detail?.session === target?.session && !state.busy) refresh();
  };
  window.addEventListener("phren:git-changed", onGitChanged);

  startTimer();
  refresh();

  return {
    refresh,
    close() { visible = false; stopTimer(); window.removeEventListener("phren:git-changed", onGitChanged); el.innerHTML = ""; },
  };
}

function injectStyle() {
  if (document.getElementById("changes-style")) return;
  const style = document.createElement("style");
  style.id = "changes-style";
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ---- helpers ---------------------------------------------------------------
function div(cls, text) {
  const d = document.createElement("div");
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}
function span(cls, text) {
  const s = document.createElement("span");
  if (cls) s.className = cls;
  if (text != null) s.textContent = text;
  return s;
}
function button(label, cls, onclick) {
  const b = document.createElement("button");
  b.type = "button"; b.className = cls; b.textContent = label;
  if (onclick) b.onclick = onclick;
  return b;
}
function icon(glyph, title, onclick) {
  const b = button(glyph, "chg-icon");
  b.title = title;
  b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
}

function basename(p) { const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }
function dirname(p) { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
function tileClass(status) {
  if (status === "M" || status === "A" || status === "D" || status === "R") return status;
  return "Q";
}

function hunkHeader(hunk) {
  if (typeof hunk.header === "string") return hunk.header;
  if (typeof hunk.heading === "string") return hunk.heading;
  if (typeof hunk.raw === "string") return hunk.raw;
  if (hunk.oldStart != null) return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  return "";
}

function relTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  const d = Math.floor(h / 24);
  if (d < 30) return d + "d";
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + "mo";
  return Math.floor(mo / 12) + "y";
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- publish plan (pure, unit tested) --------------------------------------
export function isDefaultBranch(status) {
  return !!status.defaultBranch && status.branch === status.defaultBranch;
}

/** Which publish actions the working tree allows, matching the phone. */
export function planPublish(status, current) {
  const plan = { stageAll: 0, commit: false, push: null, pull: null };
  const unstagedPaths = new Set((status.files || []).filter((f) => !f.staged).map((f) => f.path)).size;
  const hasStaged = (status.files || []).some((f) => f.staged);
  if (hasStaged) plan.commit = true; else plan.stageAll = unstagedPaths;
  const branch = status.branch;
  if (branch) {
    if (!status.upstream) plan.push = "Push branch";
    else if (status.ahead > 0) plan.push = "Push " + status.ahead;
    if (current && current.head === branch) plan.pull = { existing: current.number, url: current.url, checks: current.checks };
    else if (!isDefaultBranch(status) && status.upstream && status.ahead === 0) plan.pull = { open: true };
  }
  plan.isEmpty = plan.stageAll === 0 && !plan.commit && !plan.push && !plan.pull;
  return plan;
}

/** Why Push is disabled, or "" when it is possible. */
export function pushReason(status) {
  if (!status) return "";
  if (!status.branch) return "HEAD is detached.";
  if (status.upstream && status.ahead === 0) return "Nothing to push.";
  return "";
}

/** Why the pull request action is disabled, or "" when it is possible. */
export function prReason(status) {
  if (!status || !status.branch) return "No branch to open a pull request from.";
  if (isDefaultBranch(status)) return "This is the default branch.";
  if (!status.upstream) return "Push the branch first.";
  if (status.ahead > 0) return "Push " + status.ahead + " commit" + (status.ahead === 1 ? "" : "s") + " first.";
  return "";
}

