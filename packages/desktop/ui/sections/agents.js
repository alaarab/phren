// The Agents section: sessions on the left, open documents (chats now; files
// and diffs next) as centre tabs, the session's tools on the right
// (Changes · Files · Search), and a bottom terminal panel toggled with ⌘J.
// The right panel follows the active tab's session; the terminal attaches to
// that session's server.
import { renderSidebar } from "../sidebar.js";
import { openChat } from "../chat.js";
import { openTerminal } from "../terminal.js";
import { openChanges } from "../changes.js";
import { openFileTree, openEditorDoc } from "../editor.js";
import { openSearch } from "../search.js";
import { setActiveSession } from "../keys.js";
import { store, projectOf } from "../shell/store.js";
import { createTiles } from "../shell/tiles.js";

const PANES = [["changes", "Changes"], ["files", "Files"], ["search", "Search"]];

const SIDE_WIDTH_KEY = "phren.desktop.side-width";
const SIDE_DEFAULT = 360;
const SIDE_MIN = 300;
const TERM_HEIGHT_KEY = "phren.desktop.terminal-height";
const TERM_DEFAULT = 280;
const TERM_MIN = 120;
// Below this width the sidebar collapses to rings; below 1200 CSS overlays the
// right panel over the centre (see the media query in theme.css).
const SIDEBAR_COLLAPSE = 1440;

function readSize(key, fallback) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch { return fallback; }
}

function writeSize(key, value) {
  try { localStorage.setItem(key, String(Math.round(value))); } catch { /* storage unavailable */ }
}

export function mountAgents(root) {
  root.innerHTML = `
    <div class="columns">
      <aside id="sidebar" class="sidebar"></aside>
      <main id="main" class="main">
        <div class="layout-bar">
          <button class="doc-sidebar-toggle" type="button" aria-label="Collapse sidebar">\u25e7</button>
          <span class="spacer"></span>
          <button class="layout-btn" data-act="terminal" type="button" title="New terminal tile">Terminal</button>
          <button class="layout-btn" data-act="split-right" type="button" title="Split side by side (\u2318\\)">Split \u2192</button>
          <button class="layout-btn" data-act="split-down" type="button" title="Split top and bottom (\u2318\u21e7\\)">Split \u2193</button>
          <button class="layout-btn" data-act="zoom" type="button" title="Zoom the focused tile">Zoom</button>
        </div>
        <div class="tiles-root"></div>
        <section id="terminal-panel" class="terminal-panel" hidden>
          <div class="terminal-handle" title="Resize terminal"></div>
          <div class="terminal-bar">
            <span class="terminal-title">Terminal</span>
            <span class="spacer"></span>
            <button class="icon-button terminal-close" type="button" title="Close terminal" aria-label="Close terminal">\u00d7</button>
          </div>
          <div class="terminal-body"></div>
        </section>
      </main>
      <section id="side" class="side" hidden></section>
    </div>`;
  const sidebarEl = root.querySelector("#sidebar");
  const sideEl = root.querySelector("#side");
  const mainEl = root.querySelector("#main");
  const tilesRoot = root.querySelector(".tiles-root");
  const termPanel = root.querySelector("#terminal-panel");
  const termHandle = root.querySelector(".terminal-handle");
  const termTitle = root.querySelector(".terminal-title");
  const termBody = root.querySelector(".terminal-body");
  const sidebarToggle = root.querySelector(".doc-sidebar-toggle");

  let session = null; // { computer, child } of the active tab

  // ------------------------------------------------------------ sidebar
  // Auto-collapse below SIDEBAR_COLLAPSE; the toggle pins a choice either way.
  let sidebarPinned = false;
  let sidebarCompact = window.innerWidth < SIDEBAR_COLLAPSE;
  function renderSidebarState() {
    sidebarEl.classList.toggle("compact", sidebarCompact);
    const title = sidebarCompact ? "Expand sidebar" : "Collapse sidebar";
    sidebarToggle.title = title;
    sidebarToggle.setAttribute("aria-label", title);
  }
  sidebarToggle.addEventListener("click", () => {
    sidebarPinned = true;
    sidebarCompact = !sidebarCompact;
    renderSidebarState();
  });
  renderSidebarState();

  // ------------------------------------------------------------ right panel
  const bench = { pane: null, handles: {}, bodies: {}, sessionKey: null };
  const benchBar = document.createElement("div");
  benchBar.className = "bench-bar";
  const segments = document.createElement("div");
  segments.className = "segments";
  const segmentButtons = {};
  for (const [key, label] of PANES) {
    const b = document.createElement("button");
    b.className = "segment";
    b.textContent = label;
    b.addEventListener("click", () => showPane(key));
    segments.append(b);
    segmentButtons[key] = b;
  }
  const maxBtn = iconButton("⤢", "Cover the chat", () => document.body.classList.toggle("bench-max"));
  const closeBtn = iconButton("×", "Close the panel", () => closePanel());
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  benchBar.append(segments, spacer, maxBtn, closeBtn);
  const benchBody = document.createElement("div");
  benchBody.className = "bench-body";
  const handle = document.createElement("div");
  handle.className = "bench-handle";
  sideEl.append(handle, benchBar, benchBody);
  sideEl.style.width = `${readSize(SIDE_WIDTH_KEY, SIDE_DEFAULT)}px`;

  // Drag the left edge to resize: 300 px to 50 % of the window.
  handle.addEventListener("pointerdown", (down) => {
    handle.setPointerCapture(down.pointerId);
    const move = (ev) => {
      const max = window.innerWidth * 0.5;
      const width = Math.min(Math.max(window.innerWidth - ev.clientX, SIDE_MIN), max);
      sideEl.style.width = `${width}px`;
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      writeSize(SIDE_WIDTH_KEY, parseFloat(sideEl.style.width) || SIDE_DEFAULT);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });

  // Centre-tab file/diff documents, keyed by the tab id the editor handle owns.
  const fileHandles = new Map();

  function basename(p) { const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }

  function docSubtitle(path, child) {
    const i = path.lastIndexOf("/");
    const dir = i < 0 ? "" : path.slice(0, i);
    return [dir, projectOf(child)].filter(Boolean).join(" · ");
  }

  function fileDoc(id, computer, child, path, options = {}) {
    const diff = !!options.diff;
    const title = basename(path);
    const subtitle = docSubtitle(path, child);
    return {
      id,
      kind: diff ? "diff" : "file",
      computer,
      child,
      path,
      title,
      subtitle,
      persist: { computer, id: child.id, path, diff },
      mount: (el) => {
        const handle = openEditorDoc(el, {
          computer, child, path,
          line: options.line,
          diff,
          openFile: (p, o) => openFileDoc(computer, child, p, o),
          ask: (text) => askSession(computer, child, text),
          onDirty: (dirty) => tabs.setTitle(id, (dirty ? "\u25cf " : "") + title, subtitle),
          onCloseRequest: () => tabs.close(id),
        });
        fileHandles.set(id, handle);
        return handle;
      },
    };
  }

  /** Open or activate a file/diff as a centre-tab document; reveal `line`. */
  function openFileDoc(computer, child, path, options = {}) {
    const diff = !!options.diff;
    const id = `${diff ? "diff" : "file"}:${computer}/${child.id}/${path}`;
    const handle = tabs.open(fileDoc(id, computer, child, path, options));
    if (options.line != null) handle?.reveal?.(options.line);
    return handle;
  }

  /** Put review text in that session's chat, opening and focusing it. */
  function askSession(computer, child, text) {
    openSession(computer, child);
    tabs.activeHandle()?.insert?.(text);
  }

  function benchContext() {
    return {
      computer: session.computer,
      child: session.child,
      openFile(path, options = {}) { openFileDoc(session.computer, session.child, path, options); },
      showChanges() { showPane("changes"); },
      ask(text) { tabs.activeHandle()?.insert?.(text); },
    };
  }

  function resetBench() {
    for (const h of Object.values(bench.handles)) { try { h.close(); } catch { /* already closed */ } }
    bench.handles = {}; bench.bodies = {};
    benchBody.replaceChildren();
  }

  function body(key) {
    if (!bench.bodies[key]) {
      const div = document.createElement("div");
      div.className = `bench-pane bench-${key}`;
      benchBody.append(div);
      bench.bodies[key] = div;
    }
    return bench.bodies[key];
  }

  function showPane(key, terminalTarget) {
    // terminal is no longer a right-panel segment: it toggles the bottom panel.
    if (key === "terminal") return toggleTerminal(terminalTarget);
    sideEl.hidden = false;
    bench.pane = key;
    for (const [k] of PANES) segmentButtons[k].classList.toggle("selected", k === key);
    for (const [k, div] of Object.entries(bench.bodies)) div.hidden = k !== key;
    const el = body(key);
    el.hidden = false;
    if (!session?.child?.target) { el.textContent = "Open a session to see its changes and files."; return; }
    const open = { changes: openChanges, files: openFileTree, search: openSearch }[key];
    if (!bench.handles[key]) bench.handles[key] = open(el, benchContext());
    else if (key === "changes") bench.handles.changes.refresh?.();
    if (key === "search") bench.handles.search.focus?.();
  }

  function closePanel() {
    sideEl.hidden = true;
    document.body.classList.remove("bench-max");
  }

  // ------------------------------------------------------------ bottom terminal
  const terminal = { open: false, computer: null, server: null, handle: null };

  function openTerminalPanel(computer, server) {
    terminal.open = true;
    termPanel.hidden = false;
    if (!computer || !server) {
      termTitle.textContent = "Terminal";
      if (terminal.handle) { terminal.handle.close(); terminal.handle = null; }
      terminal.computer = null; terminal.server = null;
      if (!termBody.querySelector(".terminal-empty")) {
        termBody.replaceChildren();
        const note = document.createElement("div");
        note.className = "terminal-empty";
        note.textContent = "Open a session first.";
        termBody.append(note);
      }
      return;
    }
    if (terminal.handle && (terminal.computer !== computer || terminal.server !== server)) {
      terminal.handle.close(); terminal.handle = null;
    }
    terminal.computer = computer; terminal.server = server;
    termTitle.textContent = `Terminal · ${server} on ${computer}`;
    if (!terminal.handle) {
      terminal.handle = openTerminal(termBody, computer, server);
      termBody.querySelector(".xterm-helper-textarea")?.focus();
    }
  }

  function closeTerminal() {
    terminal.open = false;
    termPanel.hidden = true;
    if (terminal.handle) { terminal.handle.close(); terminal.handle = null; }
    terminal.computer = null; terminal.server = null;
  }

  /** The sidebar's >_ passes a target: open and attach. ⌘J passes none: toggle. */
  function toggleTerminal(target) {
    if (target?.computer && target?.server) return openTerminalPanel(target.computer, target.server);
    if (terminal.open) return closeTerminal();
    openTerminalPanel(session?.computer, session?.child?.target?.server);
  }

  /** Re-attach the open terminal when the active tab's server or computer moves. */
  function syncTerminal() {
    if (terminal.open) openTerminalPanel(session?.computer, session?.child?.target?.server);
  }

  termPanel.style.height = `${readSize(TERM_HEIGHT_KEY, TERM_DEFAULT)}px`;
  termHandle.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    termHandle.setPointerCapture(down.pointerId);
    const startY = down.clientY;
    const startHeight = termPanel.getBoundingClientRect().height;
    const move = (ev) => {
      const max = mainEl.clientHeight * 0.7;
      const height = Math.min(Math.max(startHeight + (startY - ev.clientY), TERM_MIN), max);
      termPanel.style.height = `${height}px`;
    };
    const up = () => {
      termHandle.removeEventListener("pointermove", move);
      termHandle.removeEventListener("pointerup", up);
      writeSize(TERM_HEIGHT_KEY, parseFloat(termPanel.style.height) || TERM_DEFAULT);
    };
    termHandle.addEventListener("pointermove", move);
    termHandle.addEventListener("pointerup", up);
  });
  root.querySelector(".terminal-close").addEventListener("click", closeTerminal);

  // ------------------------------------------------------------ documents
  const tabs = createTiles(tilesRoot, {
    emptyText: "Pick a session, or press \u2318K.",
    onActivate(doc) {
      if (!doc.child) return;
      const key = `${doc.computer}/${doc.child.id}`;
      session = { computer: doc.computer, child: doc.child };
      setActiveSession(doc.computer, doc.child);
      if (bench.sessionKey !== key) {
        bench.sessionKey = key;
        resetBench();
        showPane(bench.pane ?? "changes");
      }
      syncTerminal();
    },
    onEmpty() {
      session = null;
      bench.sessionKey = null;
      resetBench();
      closePanel();
      closeTerminal();
    },
  });

  root.querySelector(".layout-bar").addEventListener("click", (ev) => {
    const act = ev.target instanceof Element ? ev.target.closest(".layout-btn")?.dataset.act : null;
    if (act === "split-right") tabs.split("right");
    else if (act === "split-down") tabs.split("down");
    else if (act === "zoom") tabs.zoom();
    else if (act === "terminal") openTerminalDoc();
  });

  // A file/diff tab closes through its handle so a dirty doc can prompt first:
  // intercept the tab's close button and middle-click before createTabs closes it.
  const docBar = tilesRoot;
  const interceptClose = (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    const id = target?.closest(".doc-tab")?.dataset.doc;
    const handle = id && fileHandles.get(id);
    if (!handle?.tryClose) return;
    ev.preventDefault();
    ev.stopPropagation();
    handle.tryClose();
  };
  docBar.addEventListener("click", (ev) => {
    if (ev.target instanceof Element && ev.target.closest(".doc-tab-close")) interceptClose(ev);
  }, true);
  docBar.addEventListener("auxclick", (ev) => { if (ev.button === 1) interceptClose(ev); }, true);

  /** Close the active tab, prompting first when it is a dirty file. */
  function closeActiveTab() {
    const doc = tabs.active();
    const handle = doc && fileHandles.get(doc.id);
    if (handle?.tryClose) return handle.tryClose();
    tabs.close();
  }

  /** A session tile: its chat, or its agent pane's own terminal (the console). */
  function chatDoc(computer, child, mode = "chat") {
    const id = `chat:${computer}/${child.id}`;
    const doc = {
      id,
      kind: "chat",
      computer,
      child,
      title: child.title || child.label || projectOf(child),
      subtitle: `${projectOf(child)} \u00b7 ${computer}`,
      persist: { computer, id: child.id, mode },
      mount: (el) => mountSession(el, doc, mode),
    };
    return doc;
  }

  function mountSession(el, doc, initialMode) {
    const { computer, child } = doc;
    el.classList.add("session-doc");
    const bar = document.createElement("div");
    bar.className = "session-switch segments";
    const chatBtn = document.createElement("button");
    chatBtn.className = "segment"; chatBtn.textContent = "Chat";
    const consoleBtn = document.createElement("button");
    consoleBtn.className = "segment"; consoleBtn.textContent = "Console";
    bar.append(chatBtn, consoleBtn);
    const chatEl = document.createElement("div");
    chatEl.className = "session-pane";
    const consoleEl = document.createElement("div");
    consoleEl.className = "session-pane session-console";
    consoleEl.hidden = true;
    el.append(chatEl, consoleEl, bar);
    const chat = openChat(chatEl, computer, child, { onConsole: () => setMode("console") });
    let consoleHandle = null;
    let mode = "chat";

    function consoleAllowed() {
      if (computer === "This computer") return true;
      return store.can(computer, "paneTerminal") !== false;
    }

    function setMode(next) {
      if (next === mode) return;
      if (next === "console") {
        if (!child.target?.pane || !child.target?.server) return;
        if (!consoleAllowed()) {
          consoleEl.textContent = `The console needs a newer Phren on ${computer}.`;
        } else if (!consoleHandle) {
          consoleHandle = openTerminal(consoleEl, computer, child.target.server, { pane: child.target.pane });
        }
      } else if (consoleHandle) {
        // Detach the console when leaving it: it holds an SSH channel.
        consoleHandle.close();
        consoleHandle = null;
        consoleEl.replaceChildren();
      }
      mode = next;
      chatEl.hidden = mode !== "chat";
      consoleEl.hidden = mode !== "console";
      chatBtn.classList.toggle("selected", mode === "chat");
      consoleBtn.classList.toggle("selected", mode === "console");
      doc.persist = { ...doc.persist, mode };
      if (mode === "console") consoleHandle?.focus?.(); else chat.focus?.();
    }
    chatBtn.addEventListener("click", () => setMode("chat"));
    consoleBtn.addEventListener("click", () => setMode("console"));
    chatBtn.classList.add("selected");
    if (initialMode === "console") setMode("console");

    return {
      close() { chat.close(); consoleHandle?.close(); },
      focus() { if (mode === "console") consoleHandle?.focus?.(); else chat.focus?.(); },
      insert(text) { setMode("chat"); chat.insert?.(text); },
      toggleMode() { setMode(mode === "chat" ? "console" : "chat"); },
      setMode,
    };
  }

  /** A whole Herdr or tmux server as a terminal tile (the focused session's, by default). */
  function terminalDoc(computer, server) {
    return {
      id: `terminal:${computer}/${server}/${Date.now().toString(36)}`,
      kind: "terminal",
      title: `Terminal \u00b7 ${server}`,
      subtitle: computer,
      persist: { computer, server },
      mount: (el) => openTerminal(el, computer, server),
    };
  }

  function openTerminalDoc(computer = session?.computer, server = session?.child?.target?.server) {
    if (!computer || !server) return;
    tabs.open(terminalDoc(computer, server), { split: tabs.list().length ? "auto" : undefined });
  }

  function openSession(computer, child, options) {
    tabs.open(chatDoc(computer, child), options);
  }

  const handlers = {
    onOpenChat: (computer, child) => openSession(computer, child),
    onOpenTerminal: (computer, server) => showPane("terminal", { computer, server }),
  };

  // Rebuild last run's tiles once every computer they name has reported in.
  let pendingLayout = tabs.saved();
  function resolveSaved(item) {
    if (item.kind === "terminal") return item.computer && item.server ? terminalDoc(item.computer, item.server) : null;
    const row = store.find(item.computer, item.id);
    if (!row) return null;
    if (item.kind === "chat") return chatDoc(row.computer, row.child, item.mode === "console" ? "console" : "chat");
    if (item.kind === "file" || item.kind === "diff") {
      const diff = item.kind === "diff";
      return fileDoc(`${diff ? "diff" : "file"}:${row.computer}/${row.child.id}/${item.path}`, row.computer, row.child, item.path, { diff });
    }
    return null;
  }
  function savedComputers(node, out = new Set()) {
    if (!node) return out;
    if (node.a) { savedComputers(node.a, out); savedComputers(node.b, out); }
    for (const item of node.docs ?? []) if (item.computer) out.add(item.computer);
    return out;
  }
  store.subscribe((merged) => {
    renderSidebar(sidebarEl, merged, handlers);
    // Compact rows show only the ring, so carry the title onto the row for hover.
    for (const row of sidebarEl.querySelectorAll(".sb-row")) {
      row.title = row.querySelector(".sb-title")?.textContent || row.querySelector(".sb-project")?.textContent || "";
    }
    for (const row of sidebarEl.querySelectorAll(".sb-computer-row")) {
      row.title = row.querySelector(".sb-cname")?.textContent || "";
    }
    if (pendingLayout) {
      const states = new Map((merged.computers ?? []).map((c) => [c.computer, c.state]));
      const waiting = [...savedComputers(pendingLayout)].some((name) => states.has(name) && states.get(name) === "connecting");
      if (!waiting) { if (!tabs.list().length) tabs.restore(pendingLayout, resolveSaved); pendingLayout = null; }
    }
    if (session) setActiveSession(session.computer, session.child);
  });

  window.addEventListener("resize", () => {
    if (!sidebarPinned) {
      sidebarCompact = window.innerWidth < SIDEBAR_COLLAPSE;
      renderSidebarState();
    }
    const width = Math.min(parseFloat(sideEl.style.width) || SIDE_DEFAULT, window.innerWidth * 0.5);
    sideEl.style.width = `${Math.max(width, SIDE_MIN)}px`;
  });

  return {
    openSession,
    showPane,
    closePanel,
    closeTab: closeActiveTab,
    tiles: tabs,
    toggleConsole() { tabs.activeHandle()?.toggleMode?.(); },
    openTerminalDoc,
    nextTab: () => tabs.step(1),
    previousTab: () => tabs.step(-1),
    toggleZoom() { if (sideEl.hidden) showPane(bench.pane ?? "changes"); document.body.classList.toggle("bench-max"); },
    currentSession: () => session,
  };
}

function iconButton(text, title, onClick) {
  const b = document.createElement("button");
  b.className = "icon-button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}
