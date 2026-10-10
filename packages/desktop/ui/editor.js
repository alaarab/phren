// Files workbench: lazy tree, quick open, editor tabs, save and diff for the
// desktop spike. Talks to a session's Hook through ./api.js; reverse-applies
// patches through ./patch.js.

import { hookPost, readRepoFile } from "./api.js";
import { reverseApply } from "./patch.js";
import { resolveProject, makeIndex } from "./codeindex.js";

const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
const THEME = "phren";

let monacoPromise = null;

// Provider setup is process-wide. modelOwners lets a provider find the pane
// (and its index) that owns the model it was invoked on.
let providersRegistered = false;
const modelOwners = new Map(); // model uri string -> { path, index, uriFor, pathFromUri }
let activeOpenFile = null; // { openFile, pathFromUri } of the pane handling opens right now

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
.ed-crumb-note{margin-left:auto;color:var(--dim);}
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

/** The editor: VS Code's own (monaco-vscode-api, ui/editor-host/) with its
 * themes, grammars and extensions when that bundle is built, else Monaco's
 * standalone AMD build with the Phren theme defined here. */
let usingHost = false;
function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = import("/editor-host/editor-host.js")
    .then(async () => {
      const host = window.PhrenEditorHost;
      await host.ready;
      usingHost = true;
      return host.monaco;
    })
    .catch((error) => {
      console.warn("VS Code editor host unavailable; using standalone Monaco.", error);
      return loadStandaloneMonaco();
    });
  return monacoPromise;
}

function loadStandaloneMonaco() {
  return new Promise((resolve, reject) => {
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
      // Phren's code index answers definitions, references and outlines for the
      // whole project; the one-file worker would add a second, local answer and
      // turn every F12 into a peek list. Keep its completions and hovers.
      defaults?.setModeConfiguration?.({
        completionItems: true, hovers: true, signatureHelp: true, documentHighlights: true,
        definitions: false, references: false, documentSymbols: false, rename: false,
        diagnostics: true, documentRangeFormattingEdits: true, onTypeFormattingEdits: true,
        codeActions: false, inlayHints: false,
      });
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

/** Rank quick-open matches: exact file name, then name prefix, then name
 * contains, then a match only in the folder; shorter paths first within each. */
function rankPaths(query, paths) {
  const q = query.toLowerCase();
  const tier = (p) => {
    const name = baseName(p).toLowerCase();
    if (!q) return 3;
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.includes(q)) return 2;
    return fuzzy(q, name) ? 3 : 4;
  };
  return paths.filter((p) => fuzzy(q, p))
    .map((p) => [tier(p), p])
    .sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]))
    .map(([, p]) => p);
}

function mkButton(label, onClick) {
  const b = document.createElement("button");
  b.className = "ed-btn";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function languageFor(monaco, path) {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  const ext = name.slice(dot).toLowerCase();
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.extensions && lang.extensions.some((e) => e.toLowerCase() === ext)) return lang.id;
  }
  return "plaintext";
}

/** A Monaco location in another file. Monaco only navigates to a URI that has
 * a model, so leave an empty placeholder; the editor opener then loads the
 * real file into it (openFile fills a placeholder in place). The owning pane's
 * uriFor chooses the URI scheme for this computer. */
function location(monaco, owner, file, line) {
  const uri = owner.uriFor(file);
  if (uri.scheme === "phren") window.PhrenEditorHost?.registerPhrenFile?.(file);
  if (!monaco.editor.getModel(uri)) monaco.editor.createModel("", languageFor(monaco, file), uri);
  return { uri, range: new monaco.Range(line, 1, line, 1) };
}

function findingText(f) {
  if (typeof f === "string") return f;
  return (f && (f.text || f.finding || f.summary)) || "";
}

const KIND_WORDS = {
  function: "Function", method: "Method", class: "Class", interface: "Interface",
  type: "Struct", enum: "Enum", variable: "Variable", struct: "Struct",
};

function toSymbol(monaco, entry) {
  const line = entry.line || 1;
  const end = entry.endLine || line;
  return {
    name: entry.name,
    detail: entry.signature || "",
    kind: monaco.languages.SymbolKind[KIND_WORDS[String(entry.kind || "").toLowerCase()] || "Object"],
    range: new monaco.Range(line, 1, end, 1),
    selectionRange: new monaco.Range(line, 1, line, 1),
    children: (entry.children || []).map((child) => toSymbol(monaco, child)),
  };
}

/** Register the phren: / vscode-remote language providers once; they resolve
 * the owning pane through modelOwners, so they keep working across panes. */
function ensureProviders(monaco) {
  if (providersRegistered) return;
  providersRegistered = true;

  const PHREN_SELECTOR = [{ scheme: "phren" }, { scheme: "vscode-remote" }];

  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      const pane = activeOpenFile;
      if (!pane) return false;
      const path = pane.pathFromUri(resource);
      if (path == null) return false;
      const line = selectionOrPosition && (selectionOrPosition.startLineNumber || selectionOrPosition.lineNumber);
      pane.openFile(path, { line });
      return true;
    },
  });

  monaco.languages.registerDefinitionProvider(PHREN_SELECTOR, {
    async provideDefinition(model, position) {
      const owner = modelOwners.get(model.uri.toString());
      const word = model.getWordAtPosition(position);
      if (!owner || !word) return null;
      try {
        const refs = await owner.index.fileReferences(owner.path);
        const row = (refs.references || []).find((r) => r.line === position.lineNumber && r.name === word.word);
        let target = row ? { file: row.file, line: row.targetLine } : null;
        if (!target) {
          const def = await owner.index.definition(word.word);
          const sym = def.definition && def.definition.symbol;
          if (sym) target = { file: sym.file, line: sym.line };
        }
        return target && target.file ? location(monaco, owner, target.file, target.line) : null;
      } catch { return null; }
    },
  });

  monaco.languages.registerReferenceProvider(PHREN_SELECTOR, {
    async provideReferences(model, position) {
      const owner = modelOwners.get(model.uri.toString());
      const word = model.getWordAtPosition(position);
      if (!owner || !word) return null;
      try {
        const refs = await owner.index.fileReferences(owner.path);
        const row = (refs.references || []).find((r) => r.line === position.lineNumber && r.name === word.word);
        const data = await owner.index.references(row && row.symbol ? row.symbol : word.word);
        const locations = [];
        for (const group of (data.references && data.references.groups) || []) {
          const uri = owner.uriFor(group.file);
          // Empty model gives the peek list a label without loading the file.
          if (!monaco.editor.getModel(uri)) monaco.editor.createModel("", languageFor(monaco, group.file), uri);
          for (const ref of group.references || []) {
            locations.push({ uri, range: new monaco.Range(ref.line, 1, ref.line, 1) });
          }
        }
        return locations;
      } catch { return null; }
    },
  });

  monaco.languages.registerHoverProvider(PHREN_SELECTOR, {
    async provideHover(model, position) {
      const owner = modelOwners.get(model.uri.toString());
      const word = model.getWordAtPosition(position);
      if (!owner || !word) return null;
      try {
        const refs = await owner.index.fileReferences(owner.path);
        const row = (refs.references || []).find((r) => r.line === position.lineNumber && r.name === word.word);
        const def = await owner.index.definition(row && row.symbol ? row.symbol : word.word);
        const symbol = def.definition && def.definition.symbol;
        if (!symbol) return null;
        const md = [];
        if (symbol.signature) md.push("```" + languageFor(monaco, symbol.file || owner.path) + "\n" + symbol.signature + "\n```");
        if (symbol.doc) md.push(symbol.doc);
        md.push(`**${symbol.kind}** · used in ${symbol.uses || 0} places`);
        const findings = (def.definition && def.definition.findings) || [];
        if (findings.length) {
          md.push("**What Phren knows**");
          for (const f of findings.slice(0, 3)) md.push("- " + findingText(f).slice(0, 200));
        }
        return {
          contents: [{ value: md.join("\n\n") }],
          range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        };
      } catch { return null; }
    },
  });

  monaco.languages.registerDocumentSymbolProvider(PHREN_SELECTOR, {
    async provideDocumentSymbols(model) {
      const owner = modelOwners.get(model.uri.toString());
      if (!owner) return [];
      try {
        const data = await owner.index.outline(owner.path);
        return (data.entries || []).map((entry) => toSymbol(monaco, entry));
      } catch { return []; }
    },
  });
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

  let index = null;
  let project = null;
  let indexAvailable = false;

  // ------------------------------------------------------- remote file URIs
  // When this computer runs a Node extension host, its languages servers only
  // read real paths, so files open under vscode-remote; other computers stay
  // on the phren: scheme. repoRoot is resolved once from the Changes status.
  let repoRoot = null;
  let useRemote = false;
  let contextReady = null;

  function uriFor(path) {
    return useRemote
      ? monaco.Uri.parse(window.PhrenEditorHost.remoteUri(repoRoot + "/" + path))
      : monaco.Uri.parse("phren:/" + path);
  }

  function pathFromUri(uri) {
    if (uri.scheme === "phren") return uri.path.replace(/^\//, "");
    if (uri.scheme === "vscode-remote" && repoRoot && uri.path.startsWith(repoRoot + "/")) {
      return uri.path.slice(repoRoot.length + 1);
    }
    return null;
  }

  function ownerFor(tab) {
    return { path: tab.path, index, uriFor, pathFromUri };
  }

  const pane = { openFile, uriFor, pathFromUri };

  // Runs once: loads Monaco, resolves the repo root, wires the shared providers.
  function ensureContext() {
    if (contextReady) return contextReady;
    contextReady = loadMonaco()
      .then(async (m) => {
        monaco = m;
        window.PhrenEditorHost?.setPhrenReader?.((path) => readRepoFile(computer, target, path).then((file) => file.text));
        try {
          const status = await hookPost(computer, "/v1/git/status", { target });
          repoRoot = status.repository || null;
        } catch { /* no repository: keep the phren: scheme */ }
        useRemote = !!(window.PhrenEditorHost?.remote) && computer === "This computer" && !!repoRoot;
        const resolved = await resolveProject(computer, target);
        project = resolved.project;
        indexAvailable = resolved.available;
        if (indexAvailable) {
          index = makeIndex(computer, project);
          ensureProviders(m);
          activeOpenFile = pane;
          for (const tab of tabs) modelOwners.set(tab.model.uri.toString(), ownerFor(tab));
        }
        renderCrumb();
      })
      .catch(() => {});
    return contextReady;
  }

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
  quickButton.addEventListener("click", () => openQuick("file"));
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
    ...(usingHost ? {} : { theme: THEME }),
    fontFamily: MONO,
    fontSize: 13,
    minimap: { enabled: false },
    automaticLayout: true,
    scrollBeyondLastLine: false,
    renderLineHighlight: "line",
    breadcrumbs: { enabled: true },
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
    modelOwners.delete(tab.model.uri.toString());
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
    if (active) {
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
    if (!indexAvailable && project) {
      const note = document.createElement("span");
      note.className = "ed-crumb-note";
      note.textContent = `No code index for ${project}`;
      crumbs.appendChild(note);
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
    await ensureContext();
    if (!monaco) monaco = await loadMonaco();
    let tab = tabs.find((t) => t.path === path);
    if (!tab) {
      let file;
      try { file = await readRepoFile(computer, target, path); }
      catch (err) { showBanner("danger", err.message || "Could not open the file."); return; }
      const uri = uriFor(path);
      if (uri.scheme === "phren") window.PhrenEditorHost?.registerPhrenFile?.(path);
      // A peek list may have left an empty placeholder under this URI.
      let model = monaco.editor.getModel(uri);
      if (model) {
        monaco.editor.setModelLanguage(model, languageFor(monaco, path));
        if (model.getValue() !== file.text) model.setValue(file.text);
      } else {
        model = monaco.editor.createModel(file.text, languageFor(monaco, path), uri);
      }
      tab = {
        path, model, version: file.version, savedText: file.text, dirty: false,
        mode: "file", sideBySide: true, originalModel: null, viewState: null, note: null,
      };
      model.onDidChangeContent(() => refreshDirty(tab));
      tabs.push(tab);
      knownPaths.add(path);
    }
    if (index) modelOwners.set(tab.model.uri.toString(), ownerFor(tab));
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
      if (index) index.invalidate(tab.path);
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
  let listed = null; // { at, files } from /v1/files/list, reused for 30 s
  async function quickPaths() {
    const paths = new Set(knownPaths);
    try {
      if (!listed || Date.now() - listed.at > 30_000) {
        const reply = await hookPost(computer, "/v1/files/list", { target });
        listed = { at: Date.now(), files: reply.files || [] };
      }
      for (const f of listed.files) paths.add(f);
    } catch { /* an older Hook has no file list: tree and changed paths still work */ }
    try {
      const status = await hookPost(computer, "/v1/git/status", { target });
      for (const f of status.files || []) paths.add(f.path);
    } catch { /* the tree paths are still useful */ }
    return [...paths];
  }

  function openQuick(mode = "file") {
    if (mode === "search" && !index) return;
    quick.classList.add("open");
    quickInput.value = "";
    quickInput.placeholder = mode === "search" ? "Go to function or type…" : "Search files by name";
    quickList.innerHTML = "";
    let items = [];
    let pool = [];
    let sel = 0;
    let timer = null;

    const label = (item) => typeof item === "string"
      ? item
      : `${item.name}  ${item.kind} · ${item.file}:${item.line}`;

    const activate = (item) => {
      closeQuick();
      if (typeof item === "string") openFile(item);
      else openFile(item.file, { line: item.line });
    };

    const render = () => {
      quickList.innerHTML = "";
      items.forEach((item, i) => {
        const row = document.createElement("div");
        row.className = "ed-quick-item" + (i === sel ? " sel" : "");
        row.textContent = label(item);
        row.addEventListener("mousedown", (e) => { e.preventDefault(); activate(item); });
        quickList.appendChild(row);
      });
    };

    const filterFiles = () => {
      items = rankPaths(quickInput.value.trim(), pool).slice(0, 200);
      if (sel >= items.length) sel = 0;
      render();
    };

    const runSearch = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try { items = (await index.search(quickInput.value.trim())).symbols || []; }
        catch { items = []; }
        if (sel >= items.length) sel = 0;
        render();
      }, 150);
    };

    quickInput.oninput = mode === "search" ? runSearch : filterFiles;
    quickInput.onkeydown = (e) => {
      if (e.key === "Escape") closeQuick();
      else if (e.key === "Enter") { if (items[sel]) activate(items[sel]); }
      else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    };
    quickInput.focus();
    if (mode === "search") runSearch();
    else quickPaths().then((paths) => { pool = paths; filterFiles(); });
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
    if (key === "p") { e.preventDefault(); openQuick("file"); }
    else if (key === "s") { e.preventDefault(); doSave(active); }
    else if (key === "t") { e.preventDefault(); openQuick("search"); }
  }

  document.addEventListener("keydown", onKey);
  root.addEventListener("pointerenter", () => { hovered = true; });
  root.addEventListener("pointerleave", () => { hovered = false; });

  ensureContext();
  loadDir("", tree);

  function close() {
    document.removeEventListener("keydown", onKey);
    if (editor) { editor.setModel(null); editor.dispose(); editor = null; }
    if (diffEditor) { diffEditor.dispose(); diffEditor = null; }
    for (const tab of tabs) {
      modelOwners.delete(tab.model.uri.toString());
      if (tab.originalModel) tab.originalModel.dispose();
      tab.model.dispose();
    }
    tabs.length = 0;
    if (activeOpenFile === pane) activeOpenFile = null;
    el.innerHTML = "";
  }

  return { openFile, close };
}
