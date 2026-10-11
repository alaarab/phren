// One diff as a centre-tab document: Monaco's diff editor over two whole
// versions of a file (HEAD, the index, the working file, or a commit and its
// parent) read through /v1/git/file. Side by side or inline, syntax and
// word-level highlighting from Monaco, unchanged regions folded, change
// navigation, and staging or unstaging the hunk under the cursor or the whole
// file. Hooks without /v1/git/file fall back to reverse-applying the patch.

import { hookPost, readRepoFile } from "./api.js";
import { reverseApply } from "./patch.js";
import { store } from "./shell/store.js";
import { diffModes, diffSides, hunkAt, hunkPatch, lineChangeTotals, splitHunks, stepChange } from "./git-review.js";

const SIDE_KEY = "phren.desktop.diff.sideBySide";
const FOLD_KEY = "phren.desktop.diff.foldUnchanged";
const WS_KEY = "phren.desktop.diff.ignoreWhitespace";
const MODE_LABEL = { all: "All", unstaged: "Unstaged", staged: "Staged" };

const CSS = `
.dd-bar{flex:none;display:flex;align-items:center;gap:6px;min-height:36px;padding:4px 10px;border-bottom:1px solid var(--border);font:12px system-ui,sans-serif;color:var(--muted);flex-wrap:wrap}
.dd-path{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:40%}
.dd-path .dd-old{color:var(--muted)}
.dd-sha{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:11px;color:var(--accent);background:var(--raised);border-radius:999px;padding:1px 8px}
.dd-segs{display:inline-flex;gap:2px;background:var(--surface);border-radius:999px;padding:2px}
.dd-seg{border:none;background:none;color:var(--muted);font:11.5px system-ui,sans-serif;padding:3px 10px;border-radius:999px;cursor:pointer}
.dd-seg:hover{color:var(--text-2)}
.dd-seg.sel{background:var(--card);color:var(--accent)}
.dd-spacer{flex:1}
.dd-counts{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:11.5px;white-space:nowrap}
.dd-counts .a{color:var(--done)}.dd-counts .d{color:var(--danger)}
.dd-pos{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:11.5px;min-width:44px;text-align:center}
.dd-icon{width:26px;height:26px;border:1px solid var(--border);border-radius:7px;background:var(--raised);color:var(--text-2);cursor:pointer;font-size:12px;line-height:1}
.dd-icon:hover:not(:disabled){border-color:var(--border-strong);color:var(--text)}
.dd-icon:disabled{opacity:.35;cursor:default}
.dd-btn{border:1px solid var(--border-strong);background:var(--raised);color:var(--text-2);border-radius:8px;font:600 11.5px system-ui,sans-serif;padding:4px 10px;cursor:pointer;white-space:nowrap}
.dd-btn:hover:not(:disabled){color:var(--text);border-color:var(--accent)}
.dd-btn:disabled{opacity:.35;cursor:default}
.dd-btn.primary{background:var(--accent-solid);border-color:transparent;color:var(--text)}
.dd-toggle{display:inline-flex;align-items:center;cursor:pointer;user-select:none;white-space:nowrap;border:1px solid var(--border);border-radius:999px;padding:3px 9px;font-size:11.5px;color:var(--muted);background:none}
.dd-toggle:hover{color:var(--text-2);border-color:var(--border-strong)}
.dd-toggle.on{color:var(--accent);background:var(--card);border-color:var(--border-strong)}
.dd-toggle input{position:absolute;opacity:0;width:0;height:0}
.dd-host{flex:1;min-height:0;position:relative}
.dd-empty{position:absolute;inset:0;display:flex;flex-direction:column;gap:6px;align-items:center;justify-content:center;color:var(--muted);font:13px system-ui,sans-serif}
`;

function injectStyle() {
  if (document.getElementById("diff-doc-style")) return;
  const style = document.createElement("style");
  style.id = "diff-doc-style";
  style.textContent = CSS;
  document.head.appendChild(style);
}

function node(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function button(cls, label, title, onClick) {
  const b = node("button", cls, label);
  b.type = "button";
  if (title) { b.title = title; b.setAttribute("aria-label", title); }
  b.addEventListener("click", onClick);
  return b;
}

function readFlag(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v === "1"; } catch { return fallback; }
}
function writeFlag(key, value) { try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* private mode */ } }

/** Tell the Changes pane (and any other diff of the session) that the index moved. */
export function announceGitChange(computer, target) {
  window.dispatchEvent(new CustomEvent("phren:git-changed", { detail: { computer, session: target?.session } }));
}

/**
 * Mount a diff document. `env` carries the editor's shared pieces (the
 * workspace loader, language lookup, editor options, the banner helpers).
 * `opts.commit` ({sha, parent, oldPath, short}) shows a commit's change to
 * this file; otherwise the working tree's.
 */
export function openDiffDoc(el, opts, env) {
  injectStyle();
  const computer = opts.computer;
  const target = opts.child && opts.child.target;
  const commit = opts.commit || null;
  const scope = (extra = {}) => ({ target, ...(opts.worktree ? { worktree: opts.worktree } : {}), ...extra });

  let monaco = null;
  let diffEditor = null;
  let originalModel = null;
  let modifiedModel = null;
  let sections = [];
  let fileStatus = "";
  let mode = "unstaged";
  let modes = [];
  let changes = [];
  let current = -1;
  let busy = false;
  let repository;
  let sideBySide = readFlag(SIDE_KEY, true);
  let fold = readFlag(FOLD_KEY, true);
  let ignoreWhitespace = readFlag(WS_KEY, false);
  let disposed = false;
  // Whether this Hook serves /v1/git/file and /v1/git/apply; read before the first load.
  let review = store.can(computer, "gitReview") === true;
  let pendingLine = opts.line != null ? opts.line : null;
  const subs = [];

  const root = node("div", "ed-doc dd-doc");
  const bar = node("div", "dd-bar");
  const banner = node("div", "ed-banner");
  const host = node("div", "dd-host");
  const editorHost = node("div");
  editorHost.style.cssText = "position:absolute;inset:0";
  host.appendChild(editorHost);
  root.append(bar, banner, host);
  el.appendChild(root);

  function showBanner(kind, text) {
    banner.className = "ed-banner " + kind;
    banner.textContent = text;
    banner.style.display = "flex";
  }
  function clearBanner() { banner.style.display = "none"; banner.textContent = ""; }

  const canStage = () => !commit && !opts.readOnly && review && (mode === "unstaged" || mode === "staged");
  const patchFor = (kind) => (sections.find((s) => s.kind === kind) || {}).patch || "";

  // ---------------------------------------------------------------- toolbar
  function renderBar() {
    bar.replaceChildren();
    const pathEl = node("span", "dd-path");
    if (commit && commit.oldPath && commit.oldPath !== opts.path) {
      pathEl.append(node("span", "dd-old", commit.oldPath + " → "), document.createTextNode(opts.path));
    } else pathEl.textContent = opts.path;
    pathEl.title = opts.path;
    bar.appendChild(pathEl);
    if (commit) bar.appendChild(node("span", "dd-sha", commit.short || commit.sha.slice(0, 7)));
    if (modes.length > 1) {
      const segs = node("span", "dd-segs");
      segs.setAttribute("role", "tablist");
      for (const m of modes) {
        const b = button("dd-seg" + (m === mode ? " sel" : ""), MODE_LABEL[m], `Show ${MODE_LABEL[m].toLowerCase()} changes`, () => { if (m !== mode) { mode = m; load(); } });
        b.dataset.mode = m;
        segs.appendChild(b);
      }
      bar.appendChild(segs);
    } else if (!commit && modes.length === 1) {
      bar.appendChild(node("span", "dd-sha", MODE_LABEL[modes[0]]));
    }
    const totals = lineChangeTotals(changes);
    const counts = node("span", "dd-counts");
    counts.append(node("span", "a", "+" + totals.added), document.createTextNode(" "), node("span", "d", "−" + totals.removed));
    bar.appendChild(counts);

    const prev = button("dd-icon", "↑", "Previous change (Alt+F5)", () => go(-1));
    const pos = node("span", "dd-pos", changes.length ? `${current < 0 ? "–" : current + 1}/${changes.length}` : "0/0");
    const next = button("dd-icon", "↓", "Next change (F7)", () => go(1));
    prev.disabled = next.disabled = !changes.length;
    prev.dataset.act = "prev"; next.dataset.act = "next";
    bar.append(prev, pos, next);

    if (canStage()) {
      const staged = mode === "staged";
      const hunks = splitHunks(patchFor(mode)).hunks;
      const hunkBtn = button("dd-btn", staged ? "Unstage hunk" : "Stage hunk",
        staged ? "Unstage the change under the cursor" : "Stage the change under the cursor", () => stageHunk());
      hunkBtn.disabled = busy || !hunks.length;
      hunkBtn.dataset.act = "hunk";
      const fileBtn = button("dd-btn primary", staged ? "Unstage file" : "Stage file", null, () => stageFile());
      fileBtn.disabled = busy;
      fileBtn.dataset.act = "file";
      bar.append(hunkBtn, fileBtn);
    }
    // View toggles last, so on a narrow tab they wrap and the actions stay put.
    bar.appendChild(node("span", "dd-spacer"));
    bar.appendChild(toggle("Split", "Side by side (off: inline)", sideBySide, (v) => { sideBySide = v; writeFlag(SIDE_KEY, v); diffEditor?.updateOptions({ renderSideBySide: v }); }));
    bar.appendChild(toggle("Fold", "Fold unchanged regions", fold, (v) => { fold = v; writeFlag(FOLD_KEY, v); diffEditor?.updateOptions({ hideUnchangedRegions: { enabled: v } }); }));
    bar.appendChild(toggle("Whitespace", "Ignore whitespace-only changes", ignoreWhitespace, (v) => { ignoreWhitespace = v; writeFlag(WS_KEY, v); diffEditor?.updateOptions({ ignoreTrimWhitespace: v }); }));
  }

  /** A pill that is a checkbox: `on` while set, the full meaning in its title. */
  function toggle(label, title, value, onChange) {
    const wrap = node("label", "dd-toggle" + (value ? " on" : ""));
    wrap.title = title;
    wrap.style.position = "relative";
    const box = document.createElement("input");
    box.type = "checkbox"; box.checked = value;
    box.setAttribute("aria-label", title);
    box.addEventListener("change", () => { wrap.classList.toggle("on", box.checked); onChange(box.checked); });
    wrap.append(box, document.createTextNode(label));
    return wrap;
  }

  // ---------------------------------------------------------------- navigation
  function modifiedEditor() { return diffEditor ? diffEditor.getModifiedEditor() : null; }

  function go(delta) {
    const ed = modifiedEditor();
    if (!ed || !changes.length) return;
    const line = ed.getPosition()?.lineNumber ?? 0;
    const from = current >= 0 && changes[current] ? Math.max(1, changes[current].modifiedStartLineNumber || 1) : line;
    current = stepChange(changes, delta > 0 ? Math.max(line, from) : Math.min(line || from, from), delta);
    reveal(changes[current]);
    renderBar();
  }

  function reveal(change) {
    if (!change) return;
    const ed = modifiedEditor();
    const lineNumber = Math.max(1, change.modifiedStartLineNumber || change.modifiedEndLineNumber || 1);
    ed.revealLineInCenter(lineNumber);
    ed.setPosition({ lineNumber, column: 1 });
  }

  // ---------------------------------------------------------------- staging
  async function stageHunk() {
    const ed = modifiedEditor();
    const { header, hunks } = splitHunks(patchFor(mode));
    if (!ed || !hunks.length) return;
    const line = ed.getPosition()?.lineNumber ?? 1;
    const i = hunkAt(hunks, line, "new");
    await write(() => hookPost(computer, "/v1/git/apply", scope({ patch: hunkPatch(header, hunks[i]), reverse: mode === "staged", ...(repository ? { expectedRepository: repository } : {}) })));
  }

  async function stageFile() {
    const route = mode === "staged" ? "/v1/git/unstage" : "/v1/git/stage";
    await write(() => hookPost(computer, route, scope({ paths: [opts.path], ...(repository ? { expectedRepository: repository } : {}) })));
  }

  async function write(call) {
    if (busy) return;
    busy = true; renderBar();
    try {
      const res = await call();
      if (res && res.ok === false) showBanner("danger", res.output || "Git refused this change.");
      else clearBanner();
      announceGitChange(computer, target);
      await load(true);
    } catch (err) {
      showBanner("danger", err.message || String(err));
    } finally { busy = false; renderBar(); }
  }

  // ---------------------------------------------------------------- load
  async function version(ref, path) {
    if (ref === null) {
      if (fileStatus === "D") return { text: "", missing: true };
      try {
        const file = await readRepoFile(computer, opts.worktree ? { ...target, worktree: opts.worktree } : target, path);
        return file.binary ? { text: "", binary: true } : { text: file.text };
      } catch (err) {
        if (err.status === 404) return { text: "", missing: true };
        throw err;
      }
    }
    return hookPost(computer, "/v1/git/file", scope({ ref, path }));
  }

  async function readSections() {
    if (commit) return;
    const res = await hookPost(computer, "/v1/diff", scope(opts.worktree ? {} : { paths: [opts.path] }));
    const file = (res.files || []).find((f) => f.path === opts.path);
    sections = (file && file.sections) || [];
    fileStatus = (file && file.status) || "";
    repository = res.repository || res.root || repository;
  }

  async function sides() {
    if (review && !commit) {
      try { return await newSides(); }
      catch (err) {
        // A Hook that predates /v1/git/file answers 404 for the route itself.
        if (err.status !== 404 || !/Unknown Phren Hook route/i.test(err.message || "")) throw err;
        review = false;
      }
    }
    if (!review && !commit) {
      // An older Hook: rebuild HEAD by reverse-applying the patch to the working file.
      const working = await version(null, opts.path);
      const patch = sections.filter((s) => s.patch && !s.binary).sort((a) => (a.kind === "unstaged" ? -1 : 1)).map((s) => s.patch).join("\n");
      let original = working.text;
      if (fileStatus === "?") original = "";
      else if (patch) { try { original = reverseApply(working.text, patch); } catch { showBanner("muted", "Diff unavailable for this file."); } }
      return { original: { text: original }, modified: working, readOnly: true };
    }
    return newSides();
  }

  async function newSides() {
    const plan = diffSides(mode, commit);
    if (commit && !plan.original) return { original: { text: "", missing: true }, modified: await version(plan.modified, opts.path) };
    const [original, modified] = await Promise.all([
      version(plan.original, plan.originalPath || opts.path),
      version(plan.modified, opts.path),
    ]);
    return { original, modified };
  }

  async function load(keepPosition = false) {
    if (disposed) return;
    const position = keepPosition ? modifiedEditor()?.getPosition() : null;
    try {
      await readSections();
      if (!commit) {
        const plan = diffModes(sections);
        modes = plan.modes;
        if (!modes.includes(mode)) mode = plan.initial;
        if (fileStatus === "?" && !modes.length) modes = ["unstaged"];
      }
      const pair = await sides();
      if (disposed) return;
      const unreadable = [pair.original, pair.modified].find((v) => v.binary || v.tooLarge);
      if (unreadable) showBanner("muted", unreadable.binary ? "Binary file: there is no text to compare." : "This file is over 2 MB, too large to compare here.");
      else if (!keepPosition) clearBanner();
      const language = env.languageFor(monaco, opts.path);
      if (!originalModel) {
        originalModel = monaco.editor.createModel(pair.original.text || "", language);
        modifiedModel = monaco.editor.createModel(pair.modified.text || "", language);
        diffEditor = monaco.editor.createDiffEditor(editorHost, {
          ...env.options(),
          renderSideBySide: sideBySide,
          useInlineViewWhenSpaceIsLimited: false,
          originalEditable: false,
          readOnly: true,
          renderMarginRevertIcon: false,
          ignoreTrimWhitespace: ignoreWhitespace,
          hideUnchangedRegions: { enabled: fold, contextLineCount: 3, minimumLineCount: 4, revealLineCount: 20 },
          maxComputationTime: 5000,
          maxFileSize: 50,
          diffWordWrap: "inherit",
        });
        diffEditor.setModel({ original: originalModel, modified: modifiedModel });
        const modified = diffEditor.getModifiedEditor();
        if (env.askAction) modified.addAction(env.askAction(modified));
        modified.addAction({ id: "phren.diff.next", label: "Next change", keybindings: [monaco.KeyCode.F7], run: () => go(1) });
        modified.addAction({ id: "phren.diff.prev", label: "Previous change", keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.F5], run: () => go(-1) });
        if (canStage()) {
          modified.addAction({ id: "phren.diff.stageHunk", label: "Stage or unstage this hunk", contextMenuGroupId: "1_modification",
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyS], run: () => stageHunk() });
        }
        subs.push(diffEditor.onDidUpdateDiff(() => {
          changes = diffEditor.getLineChanges() || [];
          if (current >= changes.length) current = changes.length - 1;
          renderBar();
          if (pendingLine != null) {
            modified.revealLineInCenter(pendingLine); modified.setPosition({ lineNumber: pendingLine, column: 1 }); pendingLine = null;
          } else if (!keepPosition && current < 0 && changes.length) { current = 0; reveal(changes[0]); renderBar(); }
        }));
      } else {
        monaco.editor.setModelLanguage(originalModel, language);
        monaco.editor.setModelLanguage(modifiedModel, language);
        originalModel.setValue(pair.original.text || "");
        modifiedModel.setValue(pair.modified.text || "");
        if (!keepPosition) current = -1;
        if (position) { modifiedEditor().setPosition(position); modifiedEditor().revealPositionInCenterIfOutsideViewport(position); }
      }
      renderBar();
      if (!changes.length && !commit && !sections.length && fileStatus !== "?") host.dataset.empty = "1";
    } catch (err) {
      showBanner("danger", err.message || "Could not read this diff.");
      renderBar();
    }
  }

  // Another surface staged or committed: re-read this diff when it is the same session.
  function onGitChanged(e) {
    if (disposed || commit || busy) return;
    if (e.detail?.computer === computer && e.detail?.session === target?.session) load(true);
  }
  window.addEventListener("phren:git-changed", onGitChanged);

  renderBar();
  Promise.all([env.loadMonaco(), store.capabilities(computer)])
    .then(([m, caps]) => { monaco = m; review = caps.gitReview === true; return load(); }).catch(() => showBanner("danger", "Could not open the diff editor."));

  return {
    save() {},
    isDirty: () => false,
    tryClose: () => opts.onCloseRequest?.(),
    reveal(line) {
      if (line == null) return;
      const ed = modifiedEditor();
      if (!ed) { pendingLine = line; return; }
      ed.revealLineInCenter(line); ed.setPosition({ lineNumber: line, column: 1 });
    },
    focus() { modifiedEditor()?.focus(); },
    show() { diffEditor?.layout(); },
    hide() {},
    refresh: () => load(true),
    close() {
      disposed = true;
      window.removeEventListener("phren:git-changed", onGitChanged);
      for (const s of subs) s.dispose?.();
      diffEditor?.dispose(); diffEditor = null;
      originalModel?.dispose(); modifiedModel?.dispose();
      el.replaceChildren();
    },
  };
}
