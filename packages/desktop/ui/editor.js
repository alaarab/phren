// Files workbench: lazy tree, quick open, editor tabs, save and diff for the
// desktop spike. Talks to a session's Hook through ./api.js; reverse-applies
// patches through ./patch.js.

import { hookPost, readRepoFile } from "./api.js";
import { reverseApply } from "./patch.js";

const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
const THEME = "phren";

let monacoPromise = null;

function injectStyle() {
  if (document.getElementById("editor-style")) return;
  const style = document.createElement("style");
  style.id = "editor-style";
  style.textContent = `
.ed-root{position:relative;display:flex;height:100%;min-height:0;background:var(--bg);color:var(--text-2);font-family:system-ui;}
.ed-root *{box-sizing:border-box;}
.ed-files{width:220px;flex:none;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--border);background:var(--bg);}
.ed-files-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 6px;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim);}
.ed-qp{border:1px solid var(--border);background:var(--surface);color:var(--muted);border-radius:6px;font-family:${MONO};font-size:11px;padding:1px 6px;cursor:pointer;}
.ed-qp:hover{color:var(--text);border-color:var(--border-strong);}
.ed-tree{flex:1;min-height:0;overflow:auto;padding-bottom:8px;}
.ed-children{margin-left:14px;}
.ed-node{display:flex;align-items:center;gap:4px;height:26px;padding:0 10px;font-family:${MONO};font-size:12.5px;color:var(--muted);white-space:nowrap;cursor:pointer;}
.ed-node:hover{background:var(--surface);}
.ed-node.active{color:var(--text);background:var(--card);}
.ed-disc{width:12px;flex:none;color:var(--dim);}
.ed-name{overflow:hidden;text-overflow:ellipsis;}
.ed-count{margin-left:auto;color:var(--dim);font-size:11px;}
.ed-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;}
.ed-tabs{flex:none;display:flex;align-items:stretch;height:36px;background:var(--bg);border-bottom:1px solid var(--border);overflow-x:auto;}
.ed-tab{display:flex;align-items:center;gap:6px;padding:0 10px;font-family:${MONO};font-size:12.5px;color:var(--muted);border-right:1px solid var(--border);cursor:pointer;white-space:nowrap;}
.ed-tab.active{color:var(--text);background:var(--card);box-shadow:inset 0 2px 0 var(--accent);}
.ed-tab .dot{width:8px;color:var(--accent);font-size:10px;}
.ed-tab .x{color:var(--dim);opacity:0;transition:opacity .18s ease;}
.ed-tab:hover .x{opacity:1;}
.ed-confirm{display:flex;align-items:center;gap:6px;padding:0 10px;font-size:12px;color:var(--waiting);white-space:nowrap;}
.ed-crumbs{flex:none;display:flex;align-items:center;gap:2px;height:28px;padding:0 12px;font-family:${MONO};font-size:12px;color:var(--muted);border-bottom:1px solid var(--border);overflow:hidden;}
.ed-crumbs .sep{color:var(--dim);}
.ed-banner{flex:none;display:none;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;font-size:12.5px;}
.ed-banner.waiting{background:rgba(224,188,127,.14);color:var(--waiting);}
.ed-banner.muted{background:var(--sunken);color:var(--muted);}
.ed-banner.danger{background:rgba(239,152,152,.14);color:var(--danger);}
.ed-btn{border:1px solid var(--border-strong);background:var(--raised);color:var(--text-2);border-radius:999px;font-size:11px;padding:2px 9px;cursor:pointer;}
.ed-btn:hover{color:var(--text);border-color:var(--accent);}
.ed-editors{position:relative;flex:1;min-height:0;}
.ed-editors>div{position:absolute;inset:0;}
.ed-quick{position:absolute;inset:0;z-index:30;display:none;align-items:flex-start;justify-content:center;background:rgba(0,0,0,.35);}
.ed-quick.open{display:flex;}
.ed-quick-box{margin-top:72px;width:min(620px,80%);background:var(--raised);border:1px solid var(--border-strong);border-radius:12px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.4);}
.ed-quick-input{width:100%;border:0;border-bottom:1px solid var(--border);background:var(--sunken);color:var(--text);font-family:${MONO};font-size:13px;padding:10px 12px;outline:none;}
.ed-quick-list{max-height:320px;overflow:auto;}
.ed-quick-item{padding:7px 12px;font-family:${MONO};font-size:12.5px;color:var(--muted);cursor:pointer;}
.ed-quick-item.sel{background:var(--card);color:var(--text);}
`;
  document.head.appendChild(style);
}

/** Load Monaco's AMD bundle once; resolves after the phren theme is defined. */
function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/monaco/vs/loader.js";
    script.onload = () => {
      window.require.config({ paths: { vs: "/vendor/monaco/vs" } });
      window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
    };
    script.onerror = () => reject(new Error("Could not load Monaco."));
    document.head.appendChild(script);
  }).then((monaco) => {
    // The editor sees one file at a time, never the project's modules, so the
    // TypeScript checker would underline every import. Keep syntax errors only.
    for (const defaults of [monaco.languages.typescript?.typescriptDefaults, monaco.languages.typescript?.javascriptDefaults]) {
      defaults?.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
    }
    monaco.editor.defineTheme(THEME, {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "keyword", foreground: "F28B82" },
        { token: "string", foreground: "7FB6F0" },
        { token: "number", foreground: "7FB6F0" },
        { token: "comment", foreground: "8B9098", fontStyle: "italic" },
        { token: "type", foreground: "F0A06E" },
        { token: "function", foreground: "C2AAFF" },
      ],
      colors: {
        "editor.background": "#141618",
        "editor.foreground": "#ECEDEE",
        "editorLineNumber.foreground": "#5C6168",
        "editorLineNumber.activeForeground": "#B994F4",
        "editor.selectionBackground": "#B994F44D",
        "editor.lineHighlightBackground": "#1E1E1E",
        "editorCursor.foreground": "#B994F4",
        "diffEditor.insertedTextBackground": "#8AC8AC33",
        "diffEditor.removedTextBackground": "#EF989833",
        "diffEditor.insertedLineBackground": "#8AC8AC1F",
        "diffEditor.removedLineBackground": "#EF98981F",
      },
    });
    return monaco;
  });
  return monacoPromise;
}

const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

/** True when every character of query appears in text in order. */
function fuzzy(query, text) {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let i = 0;
  for (let c = 0; c < t.length && i < q.length; c++) if (t[c] === q[i]) i++;
  return i === q.length;
}

function mkButton(label, onClick) {
  const b = document.createElement("button");
  b.className = "ed-btn";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

export function openFiles(el, ctx) {
  injectStyle();

  const computer = ctx.computer;
  const target = ctx.child && ctx.child.target;
  const tabs = [];
  const knownPaths = new Set();

  let monaco = null;
  let editor = null;
  let diffEditor = null;
  let active = null;
  let pendingClose = null;
  let hovered = false;

  // ------------------------------------------------------------- DOM
  const root = document.createElement("div");
  root.className = "ed-root";

  const filesCol = document.createElement("div");
  filesCol.className = "ed-files";
  const filesHeader = document.createElement("div");
  filesHeader.className = "ed-files-header";
  const filesTitle = document.createElement("span");
  filesTitle.textContent = "Files";
  const quickButton = document.createElement("button");
  quickButton.className = "ed-qp";
  quickButton.textContent = "⌘P";
  quickButton.addEventListener("click", openQuick);
  filesHeader.append(filesTitle, quickButton);
  const tree = document.createElement("div");
  tree.className = "ed-tree";
  filesCol.append(filesHeader, tree);

  const main = document.createElement("div");
  main.className = "ed-main";
  const tabStrip = document.createElement("div");
  tabStrip.className = "ed-tabs";
  const crumbs = document.createElement("div");
  crumbs.className = "ed-crumbs";
  const banner = document.createElement("div");
  banner.className = "ed-banner";
  const editors = document.createElement("div");
  editors.className = "ed-editors";
  const editorContainer = document.createElement("div");
  const diffContainer = document.createElement("div");
  diffContainer.style.display = "none";
  editors.append(editorContainer, diffContainer);
  main.append(tabStrip, crumbs, banner, editors);

  root.append(filesCol, main);

  const quick = document.createElement("div");
  quick.className = "ed-quick";
  const quickBox = document.createElement("div");
  quickBox.className = "ed-quick-box";
  const quickInput = document.createElement("input");
  quickInput.className = "ed-quick-input";
  quickInput.placeholder = "Search files by name";
  const quickList = document.createElement("div");
  quickList.className = "ed-quick-list";
  quickBox.append(quickInput, quickList);
  quick.appendChild(quickBox);
  quick.addEventListener("mousedown", (e) => { if (e.target === quick) closeQuick(); });
  root.appendChild(quick);

  el.appendChild(root);

  // ------------------------------------------------------------- editor plumbing
  const options = () => ({
    theme: THEME,
    fontFamily: MONO,
    fontSize: 13,
    minimap: { enabled: false },
    automaticLayout: true,
    scrollBeyondLastLine: false,
    renderLineHighlight: "line",
    padding: { top: 8 },
  });

  function askAction() {
    return {
      id: "phren.ask",
      label: "Ask the agent about this",
      contextMenuGroupId: "9_cutcopypaste",
      contextMenuOrder: 1,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyA],
      run: askSelection,
    };
  }

  function ensureEditor() {
    if (editor || !monaco) return;
    editor = monaco.editor.create(editorContainer, options());
    editor.addAction(askAction());
  }

  function ensureDiffEditor() {
    if (diffEditor || !monaco) return;
    diffEditor = monaco.editor.createDiffEditor(diffContainer, { ...options(), renderSideBySide: true, originalEditable: false });
    diffEditor.getModifiedEditor().addAction(askAction());
  }

  function askSelection(ed) {
    const model = ed.getModel();
    const sel = ed.getSelection();
    if (!active || !model || !sel) return;
    const text = model.getValueInRange(sel);
    ctx.ask(`${active.path}:${sel.startLineNumber}-${sel.endLineNumber}\n\`\`\`\n${text}\n\`\`\`\n`);
  }

  function languageFor(path) {
    const name = baseName(path);
    const dot = name.lastIndexOf(".");
    if (dot < 0) return "plaintext";
    const ext = name.slice(dot).toLowerCase();
    for (const lang of monaco.languages.getLanguages()) {
      if (lang.extensions && lang.extensions.some((e) => e.toLowerCase() === ext)) return lang.id;
    }
    return "plaintext";
  }

  // ------------------------------------------------------------- banner
  function showBanner(kind, text, actions) {
    banner.className = "ed-banner " + kind;
    banner.innerHTML = "";
    const msg = document.createElement("span");
    msg.textContent = text;
    banner.appendChild(msg);
    for (const [label, onClick] of actions || []) banner.appendChild(mkButton(label, onClick));
    banner.style.display = "flex";
  }
  function clearBanner() {
    banner.style.display = "none";
    banner.innerHTML = "";
  }

  // ------------------------------------------------------------- tabs
  function renderTabs() {
    tabStrip.innerHTML = "";
    for (const tab of tabs) {
      const node = document.createElement("div");
      node.className = "ed-tab" + (tab === active ? " active" : "");
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.textContent = tab.dirty ? "●" : "";
      const name = document.createElement("span");
      name.textContent = baseName(tab.path);
      const close = document.createElement("span");
      close.className = "x";
      close.textContent = "×";
      node.append(dot, name, close);
      node.addEventListener("click", () => setActive(tab));
      node.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); requestClose(tab); } });
      close.addEventListener("click", (e) => { e.stopPropagation(); requestClose(tab); });
      tabStrip.appendChild(node);
    }
    if (pendingClose) {
      const tab = pendingClose;
      const confirm = document.createElement("div");
      confirm.className = "ed-confirm";
      const label = document.createElement("span");
      label.textContent = "Unsaved:";
      confirm.append(
        label,
        mkButton("Save", async () => { await doSave(tab); if (!tab.dirty) closeTab(tab); }),
        mkButton("Discard", () => closeTab(tab)),
        mkButton("Cancel", () => { pendingClose = null; renderTabs(); }),
      );
      tabStrip.appendChild(confirm);
    }
  }

  function requestClose(tab) {
    if (tab.dirty) { pendingClose = tab; renderTabs(); }
    else closeTab(tab);
  }

  function closeTab(tab) {
    const i = tabs.indexOf(tab);
    if (i < 0) return;
    if (editor && editor.getModel() === tab.model) editor.setModel(null);
    tabs.splice(i, 1);
    if (tab.originalModel) tab.originalModel.dispose();
    tab.model.dispose();
    if (active === tab) active = tabs[Math.min(i, tabs.length - 1)] || null;
    pendingClose = null;
    renderTabs();
    renderCrumb();
    if (active) showTab(active);
    else hideEditors();
  }

  function refreshDirty(tab) {
    const dirty = tab.model.getValue() !== tab.savedText;
    if (dirty !== tab.dirty) { tab.dirty = dirty; renderTabs(); }
  }

  // ------------------------------------------------------------- view
  function setActive(tab) {
    if (active === tab) { showTab(tab); return; }
    if (active && active.mode === "file" && editor && editor.getModel() === active.model) {
      active.viewState = editor.saveViewState();
    }
    active = tab;
    pendingClose = null;
    renderTabs();
    renderCrumb();
    showTab(tab);
  }

  function showTab(tab) {
    if (tab.mode === "diff") {
      ensureDiffEditor();
      editorContainer.style.display = "none";
      diffContainer.style.display = "block";
      diffEditor.setModel({ original: tab.originalModel, modified: tab.model });
      diffEditor.updateOptions({ renderSideBySide: tab.sideBySide });
    } else {
      ensureEditor();
      diffContainer.style.display = "none";
      editorContainer.style.display = "block";
      if (editor.getModel() !== tab.model) {
        editor.setModel(tab.model);
        if (tab.viewState) editor.restoreViewState(tab.viewState);
      }
    }
    clearBanner();
    if (tab.note) showBanner("muted", tab.note);
    markActive(tab.path);
  }

  function hideEditors() {
    editorContainer.style.display = "none";
    diffContainer.style.display = "none";
    clearBanner();
    markActive(null);
  }

  function markActive(path) {
    for (const node of root.querySelectorAll(".ed-node")) {
      node.classList.toggle("active", node.dataset.path === path);
    }
  }

  function renderCrumb() {
    crumbs.innerHTML = "";
    if (!active) return;
    const parts = active.path.split("/");
    parts.forEach((part, i) => {
      if (i) {
        const sep = document.createElement("span");
        sep.className = "sep";
        sep.textContent = " › ";
        crumbs.appendChild(sep);
      }
      const seg = document.createElement("span");
      seg.textContent = part;
      crumbs.appendChild(seg);
    });
    if (active.mode === "diff") {
      const spacer = document.createElement("span");
      spacer.style.marginLeft = "auto";
      crumbs.appendChild(spacer);
      crumbs.append(
        mkButton(active.sideBySide ? "Side by side" : "Inline", () => {
          active.sideBySide = !active.sideBySide;
          if (diffEditor) diffEditor.updateOptions({ renderSideBySide: active.sideBySide });
          renderCrumb();
        }),
        mkButton("Back to file", () => {
          active.mode = "file";
          active.note = null;
          showTab(active);
          renderCrumb();
        }),
      );
    }
  }

  function revealLine(line) {
    const ed = active.mode === "diff" && diffEditor ? diffEditor.getModifiedEditor() : editor;
    if (!ed) return;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
  }

  // ------------------------------------------------------------- open / diff
  async function openFile(path, opts = {}) {
    if (!monaco) monaco = await loadMonaco();
    let tab = tabs.find((t) => t.path === path);
    if (!tab) {
      let file;
      try { file = await readRepoFile(computer, target, path); }
      catch (err) { showBanner("danger", err.message || "Could not open the file."); return; }
      const model = monaco.editor.createModel(file.text, languageFor(path));
      tab = {
        path, model, version: file.version, savedText: file.text, dirty: false,
        mode: "file", sideBySide: true, originalModel: null, viewState: null, note: null,
      };
      model.onDidChangeContent(() => refreshDirty(tab));
      tabs.push(tab);
      knownPaths.add(path);
    }
    setActive(tab);
    if (opts.diff) await openRepoDiff(tab);
    if (opts.line) revealLine(opts.line);
    return tab;
  }

  async function openRepoDiff(tab) {
    let file;
    try {
      const res = await hookPost(computer, "/v1/diff", { target, paths: [tab.path] });
      file = (res.files || []).find((f) => f.path === tab.path);
    } catch (err) { showBanner("danger", err.message || "Diff failed."); return; }
    const sections = ((file && file.sections) || []).filter((s) => s.patch && !s.binary);
    sections.sort((a, b) => (a.kind === "unstaged" ? 0 : 1) - (b.kind === "unstaged" ? 0 : 1));
    const patch = sections.map((s) => s.patch).join("\n");
    let original;
    if (file && file.status === "?") original = "";
    else if (patch) {
      try { original = reverseApply(tab.model.getValue(), patch); }
      catch { tab.mode = "file"; tab.note = "Diff unavailable for this file."; showTab(tab); renderCrumb(); renderTabs(); return; }
    } else original = tab.model.getValue();
    openDiff(tab, original);
  }

  function openDiff(tab, originalText) {
    if (tab.originalModel) tab.originalModel.dispose();
    tab.originalModel = monaco.editor.createModel(originalText, tab.model.getLanguageId());
    tab.mode = "diff";
    tab.sideBySide = true;
    tab.note = null;
    showTab(tab);
    renderCrumb();
    renderTabs();
  }

  // ------------------------------------------------------------- save
  async function doSave(tab) {
    if (!tab) return;
    try {
      const res = await hookPost(computer, "/v1/files/write", {
        target, path: tab.path, content: tab.model.getValue(), version: tab.version,
      });
      tab.version = res.version;
      tab.savedText = tab.model.getValue();
      tab.dirty = false;
      if (tab === active) clearBanner();
      renderTabs();
    } catch (err) {
      if (err.status === 409) showChanged(tab);
      else if (err.status === 404) showBanner("muted", `Update Phren on ${computer} to save files here.`);
      else showBanner("danger", err.message || "Save failed.");
    }
  }

  function showChanged(tab) {
    showBanner("waiting", `${baseName(tab.path)} changed on ${computer} since you opened it.`, [
      ["Reload", async () => {
        const { text, version } = await readRepoFile(computer, target, tab.path);
        tab.version = version;
        tab.savedText = text;
        tab.model.setValue(text);
        tab.dirty = false;
        if (tab.originalModel) { tab.originalModel.dispose(); tab.originalModel = null; }
        tab.mode = "file";
        clearBanner();
        showTab(tab);
        renderCrumb();
        renderTabs();
      }],
      ["Overwrite", async () => {
        const { version } = await readRepoFile(computer, target, tab.path);
        tab.version = version;
        await doSave(tab);
      }],
      ["Compare", async () => {
        const { text } = await readRepoFile(computer, target, tab.path);
        clearBanner();
        openDiff(tab, text);
      }],
    ]);
  }

  // ------------------------------------------------------------- tree
  async function loadDir(dirPath, container) {
    let entries;
    try { ({ entries } = await hookPost(computer, "/v1/git/tree", { target, path: dirPath })); }
    catch { return; }
    entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : (a.kind === "dir" ? -1 : 1));
    for (const entry of entries) {
      if (entry.kind === "dir") addDir(container, entry);
      else { knownPaths.add(entry.path); addFile(container, entry); }
    }
  }

  function addDir(container, entry) {
    const node = document.createElement("div");
    node.className = "ed-node";
    const disc = document.createElement("span");
    disc.className = "ed-disc";
    disc.textContent = "▸";
    const name = document.createElement("span");
    name.className = "ed-name";
    name.textContent = entry.name;
    const count = document.createElement("span");
    count.className = "ed-count";
    if (entry.fileCount != null) count.textContent = String(entry.fileCount);
    node.append(disc, name, count);
    const children = document.createElement("div");
    children.className = "ed-children";
    children.style.display = "none";
    const wrap = document.createElement("div");
    wrap.append(node, children);
    container.appendChild(wrap);
    let loaded = false;
    node.addEventListener("click", async () => {
      const open = children.style.display === "none";
      disc.textContent = open ? "▾" : "▸";
      children.style.display = open ? "block" : "none";
      if (open && !loaded) { loaded = true; await loadDir(entry.path, children); }
    });
  }

  function addFile(container, entry) {
    const node = document.createElement("div");
    node.className = "ed-node";
    node.dataset.path = entry.path;
    const disc = document.createElement("span");
    disc.className = "ed-disc";
    const name = document.createElement("span");
    name.className = "ed-name";
    name.textContent = entry.name;
    node.append(disc, name);
    node.addEventListener("click", () => { openFile(entry.path); });
    container.appendChild(node);
  }

  // ------------------------------------------------------------- quick open
  async function quickPaths() {
    const paths = new Set(knownPaths);
    try {
      const status = await hookPost(computer, "/v1/git/status", { target });
      for (const f of status.files || []) paths.add(f.path);
    } catch { /* the tree paths are still useful */ }
    return [...paths];
  }

  function openQuick() {
    quick.classList.add("open");
    quickInput.value = "";
    quickList.innerHTML = "";
    const all = [];
    let shown = [];
    let sel = 0;
    const render = () => {
      shown = all.filter((p) => fuzzy(quickInput.value.trim(), p)).slice(0, 200);
      if (sel >= shown.length) sel = 0;
      quickList.innerHTML = "";
      shown.forEach((p, i) => {
        const row = document.createElement("div");
        row.className = "ed-quick-item" + (i === sel ? " sel" : "");
        row.textContent = p;
        row.addEventListener("mousedown", (e) => { e.preventDefault(); openFromQuick(p); });
        quickList.appendChild(row);
      });
    };
    quickInput.oninput = render;
    quickInput.onkeydown = (e) => {
      if (e.key === "Escape") closeQuick();
      else if (e.key === "Enter") { if (shown[sel]) openFromQuick(shown[sel]); }
      else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    };
    quickInput.focus();
    quickPaths().then((paths) => { all.push(...paths); render(); });
  }

  function openFromQuick(path) {
    closeQuick();
    openFile(path);
  }

  function closeQuick() {
    quick.classList.remove("open");
    quickInput.blur();
  }

  // ------------------------------------------------------------- keys / teardown
  function ownsFocus() {
    const focused = document.activeElement;
    return hovered || (focused && el.contains(focused));
  }

  function onKey(e) {
    if (!ownsFocus() || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "p") { e.preventDefault(); openQuick(); }
    else if (key === "s") { e.preventDefault(); doSave(active); }
  }

  document.addEventListener("keydown", onKey);
  root.addEventListener("pointerenter", () => { hovered = true; });
  root.addEventListener("pointerleave", () => { hovered = false; });

  loadMonaco().catch(() => {});
  loadDir("", tree);

  function close() {
    document.removeEventListener("keydown", onKey);
    if (editor) { editor.setModel(null); editor.dispose(); editor = null; }
    if (diffEditor) { diffEditor.dispose(); diffEditor = null; }
    for (const tab of tabs) {
      if (tab.originalModel) tab.originalModel.dispose();
      tab.model.dispose();
    }
    tabs.length = 0;
    el.innerHTML = "";
  }

  return { openFile, close };
}
