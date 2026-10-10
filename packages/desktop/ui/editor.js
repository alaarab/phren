// The editor, split in two: the right panel's file tree (openFileTree) and one
// centre-tab document per file or diff (openEditorDoc). Both share one Monaco /
// VS Code editor host (a page-wide singleton) and one workspace per session.
// Talks to a session's Hook through ./api.js; reverse-applies patches through
// ./patch.js.

import { hookPost, readRepoFile } from "./api.js";
import { reverseApply } from "./patch.js";
import { resolveProject, makeIndex } from "./codeindex.js";
import { store } from "./shell/store.js";

const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
const THEME = "phren";

let monacoPromise = null;

// Provider setup is process-wide. modelOwners lets a provider find the
// workspace (and its index) that owns the model it was invoked on.
let providersRegistered = false;
const modelOwners = new Map(); // model uri string -> { path, index, uriFor, pathFromUri }
let activeOpenFile = null; // the doc handling editor-opened files right now
let activeDoc = null; // the shown doc, for the save command and key handler

let usingHost = false;

function injectStyle() {
  if (document.getElementById("editor-style")) return;
  const style = document.createElement("style");
  style.id = "editor-style";
  style.textContent = `
.ed-tree-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--bg);color:var(--text-2);font-family:system-ui;}
.ed-tree-root *{box-sizing:border-box;}
.ed-files-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 6px;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim);}
.ed-qp{border:1px solid var(--border);background:var(--surface);color:var(--muted);border-radius:6px;font-family:${MONO};font-size:11px;padding:1px 6px;cursor:pointer;}
.ed-qp:hover{color:var(--text);border-color:var(--border-strong);}
.ed-tree{flex:1;min-height:0;overflow:auto;padding-bottom:8px;}
.ed-children{margin-left:14px;}
.ed-node{display:flex;align-items:center;gap:4px;height:24px;padding:0 10px;font-family:${MONO};font-size:12.5px;color:var(--muted);white-space:nowrap;cursor:pointer;}
.ed-node:hover{background:var(--surface);}
.ed-disc{width:12px;flex:none;color:var(--dim);}
.ed-name{overflow:hidden;text-overflow:ellipsis;}
.ed-count{margin-left:auto;color:var(--dim);font-size:11px;}
.ed-quick{position:absolute;inset:0;z-index:30;display:none;align-items:flex-start;justify-content:center;background:rgba(0,0,0,.35);}
.ed-quick.open{display:flex;}
.ed-quick-box{margin-top:72px;width:min(620px,80%);background:var(--raised);border:1px solid var(--border-strong);border-radius:12px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.4);}
.ed-quick-input{width:100%;border:0;border-bottom:1px solid var(--border);background:var(--sunken);color:var(--text);font-family:${MONO};font-size:13px;padding:10px 12px;outline:none;}
.ed-quick-list{max-height:320px;overflow:auto;}
.ed-quick-item{padding:7px 12px;font-family:${MONO};font-size:12.5px;color:var(--muted);cursor:pointer;}
.ed-quick-item.sel{background:var(--card);color:var(--text);}
.ed-doc{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--bg);color:var(--text-2);font-family:system-ui;}
.ed-doc *{box-sizing:border-box;}
.ed-crumbs{flex:none;display:flex;align-items:center;gap:2px;height:28px;padding:0 12px;font-family:${MONO};font-size:12px;color:var(--muted);border-bottom:1px solid var(--border);overflow:hidden;white-space:nowrap;}
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
.ed-close-ask{position:absolute;inset:0;z-index:40;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.4);}
.ed-close-ask.open{display:flex;}
.ed-close-card{background:var(--raised);border:1px solid var(--border-strong);border-radius:12px;padding:16px 18px;min-width:280px;max-width:380px;box-shadow:0 16px 40px rgba(0,0,0,.5);}
.ed-close-msg{color:var(--text);font-size:13px;margin-bottom:14px;}
.ed-close-actions{display:flex;gap:8px;justify-content:flex-end;}
.ed-close-actions .ed-save{border-color:var(--accent-solid);background:var(--accent-solid);color:var(--text);}
`;
  document.head.appendChild(style);
}

/** The editor: VS Code's own (monaco-vscode-api, ui/editor-host/) with its
 * themes, grammars and extensions when that bundle is built, else Monaco's
 * standalone AMD build with the Phren theme defined here. */
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
 * real file into it. The owning workspace's uriFor chooses the URI. */
function location(monaco, owner, file, line) {
  const uri = owner.uriFor(file);
  if (uri.scheme === "phren") window.PhrenEditorHost?.registerPhrenFile?.(uri.path.replace(/^\//, ""));
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
 * the owning workspace through modelOwners, so they keep working across docs. */
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

// ------------------------------------------------------------- workspaces
// One workspace per session, resolved once and shared by every file/diff doc
// and the tree. It owns the URI mapping, the code index and the capabilities.

const workspaces = new Map(); // session key -> Promise<workspace>
let wsSeq = 0;
let saveOverrideInstalled = false;

function workspaceFor(computer, child) {
  const key = `${computer}/${child?.id ?? ""}`;
  let ws = workspaces.get(key);
  // Each session gets its own phren: root token, so two sessions' files at the
  // same relative path stay distinct models.
  if (!ws) { ws = createWorkspace(computer, child, `w${++wsSeq}`); workspaces.set(key, ws); }
  return ws;
}

// The Hook's phren: reader is process-wide; route each virtual path back to the
// session that owns it, so several sessions' files stay distinct.
const phrenRoots = new Map(); // root token -> { computer, target }
let phrenReaderInstalled = false;
function installPhrenReader() {
  if (phrenReaderInstalled) return;
  phrenReaderInstalled = true;
  window.PhrenEditorHost?.setPhrenReader?.((virtualPath) => {
    const cut = virtualPath.indexOf("/");
    const root = cut < 0 ? virtualPath : virtualPath.slice(0, cut);
    const path = cut < 0 ? "" : virtualPath.slice(cut + 1);
    const owner = phrenRoots.get(root);
    if (!owner) throw new Error("No session is open for this file.");
    return readRepoFile(owner.computer, owner.target, path).then((file) => file.text);
  });
}

async function createWorkspace(computer, child, root) {
  const target = child && child.target;
  const monaco = await loadMonaco();
  installPhrenReader();
  phrenRoots.set(root, { computer, target });

  // The Hook's own flags decide save and quick-open, not a 404.
  const caps = await store.capabilities(computer);
  const canWrite = caps.fileWrite === true;
  const canList = caps.fileSearch === true;

  // One save path: with the VS Code host up, its own save command would write
  // vscode-remote files through the REH filesystem, bypassing the Hook's
  // compare-and-swap. Override it once to call the active doc's save.
  if (usingHost && !saveOverrideInstalled) {
    saveOverrideInstalled = true;
    try { window.PhrenEditorHost?.vscode?.commands?.registerCommand?.("workbench.action.files.save", () => activeDoc?.save?.()); }
    catch { /* the document key handler still saves */ }
  }

  // repoRoot is resolved once; a computer without a repository keeps phren:.
  let repoRoot = null;
  try {
    const status = await hookPost(computer, "/v1/git/status", { target });
    repoRoot = status.repository || null;
  } catch { /* no repository */ }
  const useRemote = !!(window.PhrenEditorHost?.remote) && computer === "This computer" && !!repoRoot;

  function uriFor(path) {
    if (useRemote) {
      const remote = window.PhrenEditorHost.remoteUri(repoRoot + "/" + path);
      if (remote) return monaco.Uri.parse(remote);
    }
    return monaco.Uri.parse(`phren:/${root}/${path}`);
  }

  function pathFromUri(uri) {
    if (uri.scheme === "phren") {
      const prefix = root + "/";
      const path = uri.path.replace(/^\//, "");
      return path.startsWith(prefix) ? path.slice(prefix.length) : null;
    }
    if (uri.scheme === "vscode-remote" && repoRoot && uri.path.startsWith(repoRoot + "/")) {
      return uri.path.slice(repoRoot.length + 1);
    }
    return null;
  }

  const resolved = await resolveProject(computer, target);
  const index = resolved.available && resolved.project ? makeIndex(computer, resolved.project) : null;
  if (index) ensureProviders(monaco);

  return {
    computer, child, target, monaco, canWrite, canList, repoRoot, useRemote,
    uriFor, pathFromUri, index, project: resolved.project, indexAvailable: resolved.available,
  };
}

function ownerFor(ws, path) {
  return { path, index: ws.index, uriFor: ws.uriFor, pathFromUri: ws.pathFromUri };
}

// One model per workspace+path, reference-counted so a file tab and its diff
// tab share edits and neither disposes the other's model.
const models = new Map(); // uri string -> { model, refs }

function acquireModel(ws, path, text, language) {
  const uri = ws.uriFor(path);
  if (uri.scheme === "phren") window.PhrenEditorHost?.registerPhrenFile?.(uri.path.replace(/^\//, ""));
  const key = uri.toString();
  let entry = models.get(key);
  if (!entry) {
    let model = ws.monaco.editor.getModel(uri);
    if (model) {
      ws.monaco.editor.setModelLanguage(model, language);
      if (!model.getValue() && text) model.setValue(text);
    } else {
      model = ws.monaco.editor.createModel(text, language, uri);
    }
    entry = { model, refs: 0 };
    models.set(key, entry);
  }
  entry.refs++;
  modelOwners.set(key, ownerFor(ws, path));
  return entry.model;
}

function releaseModel(model) {
  const key = model.uri.toString();
  const entry = models.get(key);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) { models.delete(key); modelOwners.delete(key); model.dispose(); }
}

// ------------------------------------------------------------- file tree
/** The right panel's Files segment: a lazy tree and ⌘P quick open. Choosing a
 * path opens it as a centre-tab document through ctx.openFile. */
export function openFileTree(el, ctx) {
  injectStyle();

  const computer = ctx.computer;
  const child = ctx.child;
  const target = child && child.target;
  const knownPaths = new Set();
  let canList = true;
  store.capabilities(computer).then((caps) => { canList = caps.fileSearch === true; }).catch(() => {});

  const root = document.createElement("div");
  root.className = "ed-tree-root";
  const header = document.createElement("div");
  header.className = "ed-files-header";
  const title = document.createElement("span");
  title.textContent = "Files";
  const quickButton = document.createElement("button");
  quickButton.className = "ed-qp";
  quickButton.textContent = "⌘P";
  quickButton.addEventListener("click", () => openQuick());
  header.append(title, quickButton);
  const tree = document.createElement("div");
  tree.className = "ed-tree";
  root.append(header, tree);

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

  const openFile = (path, options) => ctx.openFile(path, options);

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
    node.addEventListener("click", () => openFile(entry.path));
    container.appendChild(node);
  }

  // ------------------------------------------------------------- quick open
  let listed = null; // { at, files } from /v1/files/list, reused for 30 s
  async function quickPaths() {
    const paths = new Set(knownPaths);
    // /v1/files/list needs fileSearch like any search; without it the tree and
    // changed paths already loaded are all we can offer.
    if (canList) try {
      if (!listed || Date.now() - listed.at > 30_000) {
        const reply = await hookPost(computer, "/v1/files/list", { target });
        listed = { at: Date.now(), files: reply.files || [] };
      }
      for (const f of listed.files) paths.add(f);
    } catch { /* a failed list still leaves the tree and changed paths */ }
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
    let items = [];
    let pool = [];
    let sel = 0;

    const activate = (path) => { closeQuick(); openFile(path); };

    const render = () => {
      quickList.innerHTML = "";
      items.forEach((path, i) => {
        const row = document.createElement("div");
        row.className = "ed-quick-item" + (i === sel ? " sel" : "");
        row.textContent = path;
        row.addEventListener("mousedown", (e) => { e.preventDefault(); activate(path); });
        quickList.appendChild(row);
      });
    };

    const filterFiles = () => {
      items = rankPaths(quickInput.value.trim(), pool).slice(0, 200);
      if (sel >= items.length) sel = 0;
      render();
    };

    quickInput.oninput = filterFiles;
    quickInput.onkeydown = (e) => {
      if (e.key === "Escape") closeQuick();
      else if (e.key === "Enter") { if (items[sel]) activate(items[sel]); }
      else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    };
    quickInput.focus();
    quickPaths().then((paths) => { pool = paths; filterFiles(); });
  }

  function closeQuick() {
    quick.classList.remove("open");
    quickInput.blur();
  }

  loadDir("", tree);

  return { close() { el.replaceChildren(); } };
}

// ------------------------------------------------------------- editor document
/** One centre-tab document: a Monaco / VS Code editor for one file or diff.
 * Returns { close, focus, show, hide, reveal(line), isDirty, tryClose, save }. */
export function openEditorDoc(el, opts) {
  injectStyle();

  const computer = opts.computer;
  const child = opts.child;
  const target = child && child.target;
  const isDiff = !!opts.diff;

  let ws = null;
  let monaco = null;
  let editor = null;
  let diffEditor = null;
  let originalModel = null;
  let model = null;
  let changeSub = null;
  let version = null;
  let savedText = "";
  let dirty = false;
  let binary = false;
  let bom = false;
  let saving = false;
  let ready = false;
  let sideBySide = true;
  let pendingLine = opts.line != null ? opts.line : null;

  // ------------------------------------------------------------- DOM
  const root = document.createElement("div");
  root.className = "ed-doc";
  const crumbs = document.createElement("div");
  crumbs.className = "ed-crumbs";
  const banner = document.createElement("div");
  banner.className = "ed-banner";
  const editors = document.createElement("div");
  editors.className = "ed-editors";
  const editorHost = document.createElement("div");
  const diffHost = document.createElement("div");
  diffHost.style.display = "none";
  editors.append(editorHost, diffHost);
  root.append(crumbs, banner, editors);

  const closeAsk = document.createElement("div");
  closeAsk.className = "ed-close-ask";
  const closeCard = document.createElement("div");
  closeCard.className = "ed-close-card";
  const closeMsg = document.createElement("div");
  closeMsg.className = "ed-close-msg";
  const closeActions = document.createElement("div");
  closeActions.className = "ed-close-actions";
  const saveBtn = mkButton("Save", () => {});
  saveBtn.classList.add("ed-save");
  closeActions.append(
    saveBtn,
    mkButton("Don't save", () => { hideCloseAsk(); opts.onCloseRequest?.(); }),
    mkButton("Cancel", () => hideCloseAsk()),
  );
  closeCard.append(closeMsg, closeActions);
  closeAsk.appendChild(closeCard);
  root.appendChild(closeAsk);
  el.appendChild(root);

  // ------------------------------------------------------------- helpers
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

  function askAction(ed) {
    return {
      id: "phren.ask",
      label: "Ask the agent about this",
      contextMenuGroupId: "9_cutcopypaste",
      contextMenuOrder: 1,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyA],
      run: () => {
        const m = ed.getModel();
        const sel = ed.getSelection();
        if (!m || !sel) return;
        const text = m.getValueInRange(sel);
        opts.ask?.(`${opts.path}:${sel.startLineNumber}-${sel.endLineNumber}\n\`\`\`\n${text}\n\`\`\`\n`);
      },
    };
  }

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
  function showGate() {
    if (!needsNewer(banner, computer, "fileWrite")) return;
    banner.className = "ed-banner waiting";
    banner.style.display = "flex";
  }

  function renderCrumb() {
    crumbs.innerHTML = "";
    const parts = opts.path.split("/");
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
    if (isDiff) {
      const spacer = document.createElement("span");
      spacer.style.marginLeft = "auto";
      crumbs.appendChild(spacer);
      crumbs.append(mkButton("Side by side", () => {
        if (!diffEditor) return;
        sideBySide = !sideBySide;
        diffEditor.updateOptions({ renderSideBySide: sideBySide });
      }));
    }
    if (ws && !ws.indexAvailable && ws.project) {
      const note = document.createElement("span");
      note.className = "ed-crumb-note";
      note.textContent = `No code index for ${ws.project}`;
      crumbs.appendChild(note);
    }
  }

  function applyPendingLine() {
    if (pendingLine == null) return;
    const ed = isDiff && diffEditor ? diffEditor.getModifiedEditor() : editor;
    if (!ed) return;
    ed.revealLineInCenter(pendingLine);
    ed.setPosition({ lineNumber: pendingLine, column: 1 });
    pendingLine = null;
  }

  // ------------------------------------------------------------- load
  function onModelChange() {
    if (!model) return;
    const nowDirty = model.getValue() !== savedText;
    if (nowDirty !== dirty) { dirty = nowDirty; opts.onDirty?.(dirty); }
  }

  async function load() {
    let file;
    try { file = await readRepoFile(computer, target, opts.path); }
    catch (err) { ready = true; showBanner("danger", err.message || "Could not open the file."); return; }
    binary = file.binary;
    bom = file.bom;
    version = file.version;
    const text = file.binary ? "" : file.text;
    savedText = text;
    model = acquireModel(ws, opts.path, text, languageFor(monaco, opts.path));
    if (isDiff) await setUpDiff();
    else setUpEditor();
    ready = true;
    renderCrumb();
    applyPendingLine();
  }

  function setUpEditor() {
    editorHost.style.display = "block";
    diffHost.style.display = "none";
    editor = monaco.editor.create(editorHost, options());
    editor.addAction(askAction(editor));
    editor.updateOptions({ readOnly: binary || !ws.canWrite });
    editor.setModel(model);
    changeSub = model.onDidChangeContent(onModelChange);
    if (binary) showBanner("waiting", "This file is not UTF-8 text, so it opens read-only.");
    else if (!ws.canWrite) showGate();
  }

  async function setUpDiff() {
    editorHost.style.display = "none";
    diffHost.style.display = "block";
    let file;
    try {
      const res = await hookPost(computer, "/v1/diff", { target, paths: [opts.path] });
      file = (res.files || []).find((f) => f.path === opts.path);
    } catch (err) { showBanner("danger", err.message || "Diff failed."); return; }
    const sections = ((file && file.sections) || []).filter((s) => s.patch && !s.binary);
    sections.sort((a, b) => (a.kind === "unstaged" ? 0 : 1) - (b.kind === "unstaged" ? 0 : 1));
    const patch = sections.map((s) => s.patch).join("\n");
    let originalText;
    if (file && file.status === "?") originalText = "";
    else if (patch) {
      try { originalText = reverseApply(model.getValue(), patch); }
      catch { originalText = model.getValue(); showBanner("muted", "Diff unavailable for this file."); }
    } else originalText = model.getValue();
    originalModel = monaco.editor.createModel(originalText, model.getLanguageId());
    diffEditor = monaco.editor.createDiffEditor(diffHost, { ...options(), renderSideBySide: sideBySide, originalEditable: false });
    diffEditor.setModel({ original: originalModel, modified: model });
    // Review only: the modified side stays read-only so a diff never owns edits.
    const modified = diffEditor.getModifiedEditor();
    modified.updateOptions({ readOnly: true });
    modified.addAction(askAction(modified));
  }

  workspaceFor(computer, child)
    .then((w) => { ws = w; monaco = w.monaco; return load(); })
    .catch(() => { ready = true; showBanner("danger", "Could not open the editor."); });

  // ------------------------------------------------------------- save
  async function save() {
    if (!model || binary || saving) return;
    if (!ws?.canWrite) { showGate(); return; }
    saving = true;
    const path = ws.pathFromUri(model.uri) || opts.path;
    const content = (bom ? "\uFEFF" : "") + model.getValue();
    try {
      const res = await hookPost(computer, "/v1/files/write", { target, path, content, version });
      version = res.version;
      savedText = model.getValue();
      if (dirty) { dirty = false; opts.onDirty?.(false); }
      if (ws.index) ws.index.invalidate(path);
      clearBanner();
    } catch (err) {
      if (err.status === 409) showChanged();
      else showBanner("danger", err.message || "Save failed.");
    } finally {
      saving = false;
    }
  }

  function showChanged() {
    showBanner("waiting", `${baseName(opts.path)} changed on ${computer} since you opened it.`, [
      ["Reload", async () => {
        const file = await readRepoFile(computer, target, opts.path);
        const text = file.binary ? "" : file.text;
        version = file.version; bom = file.bom; binary = file.binary; savedText = text;
        model.setValue(text);
        if (dirty) { dirty = false; opts.onDirty?.(false); }
        clearBanner();
      }],
      ["Overwrite", async () => {
        const { version: current } = await readRepoFile(computer, target, opts.path);
        version = current;
        await save();
      }],
      ["Open diff", () => opts.openFile?.(opts.path, { diff: true })],
    ]);
  }

  // ------------------------------------------------------------- close prompt
  function showCloseAsk() {
    closeMsg.textContent = `Save changes to ${baseName(opts.path)}?`;
    closeAsk.classList.add("open");
  }
  function hideCloseAsk() { closeAsk.classList.remove("open"); }
  saveBtn.addEventListener("click", async () => {
    await save();
    hideCloseAsk();
    if (!dirty) opts.onCloseRequest?.();
  });

  function tryClose() {
    if (dirty) { showCloseAsk(); return; }
    opts.onCloseRequest?.();
  }

  // Capture phase so the VS Code host never writes a vscode-remote file to disk
  // behind the Hook's compare-and-swap.
  function onKey(e) {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    if (e.key.toLowerCase() !== "s") return;
    e.preventDefault();
    e.stopPropagation();
    save();
  }
  el.addEventListener("keydown", onKey, true);

  // ------------------------------------------------------------- handle
  const pane = {
    openFile: (path, o) => opts.openFile?.(path, o),
    pathFromUri: (uri) => (ws ? ws.pathFromUri(uri) : null),
  };

  const handle = {
    save,
    isDirty: () => dirty,
    tryClose,
    reveal(line) {
      if (line != null) pendingLine = line;
      if (ready) applyPendingLine();
    },
    focus() {
      const active = isDiff && diffEditor ? diffEditor.getModifiedEditor() : editor;
      active?.focus();
    },
    show() {
      activeDoc = handle;
      activeOpenFile = pane;
      if (editor) editor.layout();
      if (diffEditor) diffEditor.layout();
    },
    hide() { hideCloseAsk(); },
    close() {
      el.removeEventListener("keydown", onKey, true);
      if (changeSub) { changeSub.dispose(); changeSub = null; }
      if (editor) { editor.dispose(); editor = null; }
      if (diffEditor) { diffEditor.dispose(); diffEditor = null; }
      if (originalModel) { originalModel.dispose(); originalModel = null; }
      if (model) { releaseModel(model); model = null; }
      if (activeDoc === handle) activeDoc = null;
      if (activeOpenFile === pane) activeOpenFile = null;
      el.replaceChildren();
    },
  };
  return handle;
}

// ------------------------------------------------------------- capability gate
const GATE_LABEL = { fileWrite: "Saving", fileSearch: "Find in files", code: "The code index" };

/** The reason a control needs a newer Hook. The version clause is dropped when
 * the computer has not reported one. */
export function newerMessage(computer, feature) {
  const version = store.version(computer);
  return `${GATE_LABEL[feature] || "This feature"} needs a newer Phren on ${computer}${version ? ` (it runs ${version})` : ""}.`;
}

/**
 * Whether `computer`'s Hook is missing `feature`. When missing, renders the
 * shared reason into `el` and returns true; false when the Hook declares it
 * (and before the first capabilities read, so a control gates only once the
 * Hook has answered).
 */
export function needsNewer(el, computer, feature) {
  if (store.can(computer, feature)) return false;
  const note = document.createElement("div");
  note.className = "gate-note";
  note.textContent = newerMessage(computer, feature);
  el.replaceChildren(note);
  return true;
}
