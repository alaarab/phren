// Changes workbench pane: uncommitted changes, inline diffs, history, branches.
// Owns its own CSS (injected once) and re-renders fully from module state.
import { hookPost, readRepoFile } from "./api.js";
import { ADDED_FILE_MAX_LINES, additionHunks, parsePatch, wordSegments } from "./patch.js";

const TITLE = { changes: "Uncommitted changes", history: "History", branches: "Branches" };

const CSS = `
.chg{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--text-2);font:13px/1.45 system-ui,sans-serif}
.chg-top{padding:12px 12px 8px;position:relative;flex:none}
.chg-menu-btn{display:inline-flex;align-items:center;gap:6px;background:none;border:none;padding:0;color:var(--text);font:600 15px system-ui,sans-serif;cursor:pointer}
.chg-menu-btn:hover{color:var(--accent-hover)}
.chg-caret{color:var(--muted);font-size:11px}
.chg-sub{margin-top:3px;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)}
.chg-menu-backdrop{position:fixed;inset:0;z-index:8}
.chg-menu{position:absolute;top:40px;left:12px;z-index:9;min-width:180px;background:var(--card);border:1px solid var(--border-strong);border-radius:14px;padding:6px;box-shadow:0 16px 40px rgba(0,0,0,.5)}
.chg-menu-row{display:flex;align-items:center;gap:10px;height:36px;padding:0 10px;border-radius:9px;color:var(--text-2);font-size:13px;cursor:pointer}
.chg-menu-row:hover,.chg-menu-row.sel{background:var(--raised)}
.chg-menu-row .glyph{width:16px;text-align:center;color:var(--accent)}
.chg-body{flex:1;min-height:0;overflow:auto;padding:0 12px 12px}
.chg-sec{margin-top:12px}
.chg-sec-h{display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.chg-pill{background:var(--raised);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--text-2)}
.chg-row{display:flex;align-items:center;gap:10px;min-height:40px;padding:4px 6px;border-radius:10px;cursor:pointer;position:relative}
.chg-row:hover{background:var(--surface)}
.chg-row-menu{position:absolute;top:36px;right:6px;z-index:7;min-width:140px;background:var(--card);border:1px solid var(--border-strong);border-radius:12px;padding:6px;box-shadow:0 16px 40px rgba(0,0,0,.5)}
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
.chg-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:40px 0;color:var(--muted)}
.chg-empty-check{font-size:22px;color:var(--done)}
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
.chg-confirm{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;font-size:12.5px;color:var(--text-2)}
.chg-confirm>span:first-child{flex:1}
.chg-commit{display:flex;align-items:flex-end;gap:8px}
.chg-msg{flex:1;min-height:34px;max-height:96px;resize:none;padding:8px 10px;background:var(--sunken);border:1px solid var(--border);border-radius:12px;color:var(--text);font:13px/1.4 system-ui,sans-serif;outline:none}
.chg-msg:focus{border-color:var(--border-strong)}
.chg-btn{border:none;border-radius:10px;padding:9px 14px;font:600 13px system-ui,sans-serif;cursor:pointer;white-space:nowrap}
.chg-btn.commit{background:var(--accent-solid);color:var(--text)}
.chg-btn.commit:disabled{opacity:.35;cursor:default}
.chg-btn.stage{background:var(--raised);color:var(--text)}
.chg-btn.danger{background:var(--danger);color:var(--bg)}
.chg-btn.push{background:var(--card);color:var(--accent);border-radius:999px}
.chg-log-row{display:flex;gap:10px;padding:7px 6px;border-bottom:1px solid var(--border)}
.chg-sha{flex:none;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12px;color:var(--accent)}
.chg-log-mid{min-width:0}
.chg-log-subject{color:var(--text);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-log-meta{color:var(--muted);font-size:12px;margin-top:1px}
.chg-branch-row{display:flex;align-items:center;gap:8px;min-height:36px;padding:0 6px;border-bottom:1px solid var(--border)}
.chg-branch-check{width:14px;color:var(--done)}
.chg-branch-name{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--text)}
`;

export function openChanges(el, ctx) {
  const computer = ctx.computer;
  const target = ctx.child && ctx.child.target;
  const state = {
    view: "changes", menuOpen: false, status: null, expanded: null, diffs: {}, addedText: {},
    draft: "", confirm: null, error: "", log: null, branches: null, rowMenu: null,
  };
  let timer = null;
  let commitBtn = null;

  injectStyle();

  const repo = () => (state.status && state.status.repository) || undefined;
  const changedPaths = () => [...new Set((state.status?.files || []).filter((f) => !f.staged).map((f) => f.path))];
  const typing = () => document.activeElement && document.activeElement.tagName === "TEXTAREA";
  const canPoll = () => document.visibilityState === "visible" && !state.confirm && !state.menuOpen && !typing();

  function render() {
    el.innerHTML = "";
    const root = div("chg");
    root.appendChild(renderTop());
    root.appendChild(renderBody());
    if (state.view === "changes") root.appendChild(renderFooter());
    el.appendChild(root);
    const ta = root.querySelector(".chg-msg");
    if (ta) autosize(ta);
  }

  async function refresh() {
    if (!target) { state.error = "This session has no target."; render(); return; }
    try {
      if (state.view === "changes") await loadChanges();
      else if (state.view === "history") state.log = (await hookPost(computer, "/v1/git/log", { target, limit: 60 })).commits || [];
      else state.branches = await hookPost(computer, "/v1/git/branches", { target });
      state.error = "";
    } catch (e) {
      state.error = e.message || String(e);
    }
    render();
  }

  async function loadChanges() {
    const res = await hookPost(computer, "/v1/git/status", { target });
    state.status = res;
    if (state.expanded) {
      const f = (res.files || []).find((x) => x.path === state.expanded.path && !!x.staged === state.expanded.staged);
      if (!f) state.expanded = null;
      else await loadDiff(f);
    }
  }

  async function loadDiff(f) {
    const res = await hookPost(computer, "/v1/diff", { target, paths: [f.path] });
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
      await refresh();
    } catch (e) {
      state.confirm = null; state.error = e.message || String(e);
      render();
    }
  }

  const doStage = (f) => write(() => hookPost(computer, "/v1/git/stage", { target, paths: [f.path], expectedRepository: repo() }));
  const doUnstage = (f) => write(() => hookPost(computer, "/v1/git/unstage", { target, paths: [f.path], expectedRepository: repo() }));
  const doStageAll = () => write(() => hookPost(computer, "/v1/git/stage", { target, paths: changedPaths(), confirmBulk: true, expectedRepository: repo() }));
  const doCommit = () => write(async () => {
    await hookPost(computer, "/v1/git/commit", { target, message: state.draft.trim(), expectedRepository: repo() });
    state.draft = "";
  });
  const doDiscard = () => write(() => hookPost(computer, "/v1/git/discard", { target, paths: [state.confirm.path], expectedRepository: repo() }));

  async function doPush() {
    try {
      await hookPost(computer, "/v1/git/push", { target, expectedRepository: repo() });
      state.error = ""; state.confirm = null;
      await refresh();
    } catch (e) {
      if (e.status === 409 && e.body && e.body.defaultBranch) {
        state.error = ""; state.confirm = { kind: "push", branch: e.body.defaultBranch };
      } else {
        state.confirm = null; state.error = e.message || String(e);
      }
      render();
    }
  }

  async function confirmPush() {
    try {
      await hookPost(computer, "/v1/git/push", { target, expectedRepository: repo(), confirmDefault: true });
      state.error = ""; state.confirm = null;
      await refresh();
    } catch (e) {
      state.confirm = null; state.error = e.message || String(e);
      render();
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

  // ---- header / menu -------------------------------------------------------
  function renderTop() {
    const top = div("chg-top");
    const btn = button(TITLE[state.view] + " ▾", "chg-menu-btn", () => { state.menuOpen = !state.menuOpen; render(); });
    top.appendChild(btn);
    if (state.view === "changes" && state.status) top.appendChild(div("chg-sub", subline(state.status)));
    if (state.menuOpen) {
      const backdrop = div("chg-menu-backdrop");
      backdrop.onclick = () => { state.menuOpen = false; render(); };
      top.appendChild(backdrop);
      top.appendChild(renderMenu());
    }
    return top;
  }

  function renderMenu() {
    const menu = div("chg-menu");
    for (const [view, glyph, label] of [["changes", "✓", "Changes"], ["history", "⟲", "History"], ["branches", "⑂", "Branches"]]) {
      const row = div("chg-menu-row" + (state.view === view ? " sel" : ""));
      row.appendChild(span("glyph", glyph));
      row.appendChild(span("", label));
      row.onclick = () => { state.view = view; state.menuOpen = false; state.expanded = null; state.confirm = null; refresh(); };
      menu.appendChild(row);
    }
    return menu;
  }

  function subline(s) {
    const n = s.totalFiles != null ? s.totalFiles : (s.files || []).length;
    if (!n) return "Working tree clean";
    return `${s.branch || "detached"} · ${n} file${n === 1 ? "" : "s"} +${s.additions || 0} −${s.deletions || 0}`;
  }

  // ---- body ----------------------------------------------------------------
  function renderBody() {
    if (state.view === "history") return renderHistory();
    if (state.view === "branches") return renderBranches();
    return renderChanges();
  }

  function renderChanges() {
    const body = div("chg-body");
    if (!state.status) { body.appendChild(div("chg-empty", "Loading…")); return body; }
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
    row.appendChild(span("", `Discard changes to ${basename(f.path)}?`));
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

  // ---- history / branches --------------------------------------------------
  function renderHistory() {
    const body = div("chg-body");
    const commits = state.log || [];
    if (!commits.length) { body.appendChild(div("chg-empty", "No commits.")); return body; }
    for (const c of commits) {
      const row = div("chg-log-row");
      row.appendChild(span("chg-sha", c.short || (c.sha || "").slice(0, 7)));
      const mid = div("chg-log-mid");
      mid.appendChild(div("chg-log-subject", c.subject || ""));
      mid.appendChild(div("chg-log-meta", `${c.author || ""} · ${relTime(c.date)}`));
      row.appendChild(mid);
      body.appendChild(row);
    }
    return body;
  }

  function renderBranches() {
    const body = div("chg-body");
    const res = state.branches || {};
    const list = Array.isArray(res.branches) ? res.branches : [];
    const current = res.current || res.currentBranch || "";
    if (!list.length) { body.appendChild(div("chg-empty", "No branches.")); return body; }
    for (const b of list) {
      const name = typeof b === "string" ? b : b.name;
      const isCurrent = (b && typeof b === "object" && b.current) || name === current;
      const row = div("chg-branch-row");
      row.appendChild(span("chg-branch-check", isCurrent ? "✓" : ""));
      row.appendChild(span("chg-branch-name", name));
      body.appendChild(row);
    }
    return body;
  }

  // ---- footer --------------------------------------------------------------
  function renderFooter() {
    commitBtn = null;
    const foot = div("chg-footer");
    if (state.error) foot.appendChild(div("chg-error", state.error));
    if (state.confirm && state.confirm.kind === "push") {
      const row = div("chg-confirm");
      row.appendChild(span("", `Push to ${state.confirm.branch}, the default branch?`));
      row.appendChild(button("Push", "chg-btn commit", confirmPush));
      row.appendChild(button("Cancel", "chg-btn stage", () => { state.confirm = null; render(); }));
      foot.appendChild(row);
    }
    const s = state.status;
    if (!s) return foot;
    const stagedCount = (s.files || []).filter((f) => f.staged).length;
    const paths = changedPaths();
    const row = div("chg-commit");
    const ta = document.createElement("textarea");
    ta.className = "chg-msg"; ta.placeholder = "Commit message"; ta.rows = 1; ta.value = state.draft;
    ta.addEventListener("input", () => { state.draft = ta.value; autosize(ta); updateCommitBtn(); });
    row.appendChild(ta);
    if (stagedCount) {
      commitBtn = button("✓ Commit", "chg-btn commit", doCommit);
      commitBtn.disabled = !(state.draft.trim() && stagedCount);
      row.appendChild(commitBtn);
    } else if (paths.length) {
      row.appendChild(button("Stage all", "chg-btn stage", doStageAll));
    }
    if (s.ahead > 0) row.appendChild(button(`↑ Push ${s.ahead}`, "chg-btn push", doPush));
    foot.appendChild(row);
    return foot;
  }

  function updateCommitBtn() {
    if (!commitBtn) return;
    const staged = (state.status?.files || []).some((f) => f.staged);
    commitBtn.disabled = !(state.draft.trim() && staged);
  }

  function autosize(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 96) + "px";
  }

  // ---- lifecycle -----------------------------------------------------------
  function startTimer() {
    timer = setInterval(() => { if (canPoll()) refresh(); }, 10000);
  }
  function stopTimer() { if (timer) clearInterval(timer); timer = null; }

  startTimer();
  refresh();

  return {
    refresh,
    close() { stopTimer(); el.innerHTML = ""; },
  };
}

// ---- helpers ---------------------------------------------------------------
function injectStyle() {
  if (document.getElementById("changes-style")) return;
  const style = document.createElement("style");
  style.id = "changes-style";
  style.textContent = CSS;
  document.head.appendChild(style);
}

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
