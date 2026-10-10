// The Agents section: sessions on the left, open documents (chats now; files
// and diffs next) as centre tabs, and the session's tools on the right
// (Changes · Files · Search · Terminal · Extensions). The right panel follows
// the active tab's session.
import { renderSidebar } from "../sidebar.js";
import { openChat } from "../chat.js";
import { openTerminal } from "../terminal.js";
import { openChanges } from "../changes.js";
import { openFiles } from "../editor.js";
import { openSearch } from "../search.js";
import { openExtensions } from "../extensions.js";
import { setActiveSession } from "../keys.js";
import { store, projectOf } from "../shell/store.js";
import { createTabs } from "../shell/tabs.js";

const PANES = [["changes", "Changes"], ["files", "Files"], ["search", "Search"], ["terminal", "Terminal"], ["extensions", "Extensions"]];

export function mountAgents(root) {
  root.innerHTML = `
    <div class="columns">
      <aside id="sidebar" class="sidebar"></aside>
      <main id="main" class="main">
        <div class="doc-bar"></div>
        <div class="doc-body"><div class="empty">Pick a session</div></div>
      </main>
      <section id="side" class="side" hidden></section>
    </div>`;
  const sidebarEl = root.querySelector("#sidebar");
  const sideEl = root.querySelector("#side");
  const docBody = root.querySelector(".doc-body");
  const emptyEl = docBody.querySelector(".empty");

  let session = null; // { computer, child } of the active tab

  // ------------------------------------------------------------ right panel
  const bench = { pane: null, handles: {}, bodies: {}, terminalServer: null, terminalComputer: null, sessionKey: null };
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

  // Drag the left edge to resize: 280 px to 75 % of the window.
  handle.addEventListener("pointerdown", (down) => {
    handle.setPointerCapture(down.pointerId);
    const move = (ev) => {
      const width = Math.min(Math.max(window.innerWidth - ev.clientX, 280), window.innerWidth * 0.75);
      sideEl.style.width = `${width}px`;
    };
    const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });

  function benchContext() {
    return {
      computer: session.computer,
      child: session.child,
      openFile(path, options = {}) { showPane("files"); bench.handles.files?.openFile(path, options); },
      showChanges() { showPane("changes"); },
      ask(text) { tabs.activeHandle()?.insert?.(text); },
    };
  }

  function resetBench() {
    for (const h of Object.values(bench.handles)) { try { h.close(); } catch { /* already closed */ } }
    bench.handles = {}; bench.bodies = {}; bench.terminalServer = null; bench.terminalComputer = null;
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
    sideEl.hidden = false;
    bench.pane = key;
    for (const [k] of PANES) segmentButtons[k].classList.toggle("selected", k === key);
    for (const [k, div] of Object.entries(bench.bodies)) div.hidden = k !== key;
    const el = body(key);
    el.hidden = false;
    if (key === "terminal") {
      const computer = terminalTarget?.computer ?? session?.computer;
      const server = terminalTarget?.server ?? session?.child?.target?.server;
      if (!computer || !server) { el.textContent = "Open a session first."; return; }
      if (bench.handles.terminal && (bench.terminalServer !== server || bench.terminalComputer !== computer)) {
        bench.handles.terminal.close(); delete bench.handles.terminal;
      }
      if (!bench.handles.terminal) {
        bench.terminalServer = server; bench.terminalComputer = computer;
        bench.handles.terminal = openTerminal(el, computer, server);
        el.hidden = false;
      }
      return;
    }
    if (key !== "extensions" && !session?.child?.target) { el.textContent = "Open a session to see its changes and files."; return; }
    const open = { changes: openChanges, files: openFiles, search: openSearch, extensions: openExtensions }[key];
    if (!bench.handles[key]) bench.handles[key] = open(el, benchContext());
    else if (key === "changes") bench.handles.changes.refresh?.();
    if (key === "search") bench.handles.search.focus?.();
  }

  function closePanel() {
    sideEl.hidden = true;
    document.body.classList.remove("bench-max");
  }

  // ------------------------------------------------------------ documents
  const tabs = createTabs(root.querySelector(".doc-bar"), docBody, {
    onActivate(doc) {
      emptyEl.hidden = true;
      if (doc.kind !== "chat") return;
      const key = `${doc.computer}/${doc.child.id}`;
      session = { computer: doc.computer, child: doc.child };
      setActiveSession(doc.computer, doc.child);
      if (bench.sessionKey !== key) {
        bench.sessionKey = key;
        resetBench();
        showPane(bench.pane && bench.pane !== "extensions" ? bench.pane : "changes");
      }
    },
    onEmpty() {
      session = null;
      bench.sessionKey = null;
      resetBench();
      closePanel();
      emptyEl.hidden = false;
    },
  });

  function chatDoc(computer, child) {
    return {
      id: `chat:${computer}/${child.id}`,
      kind: "chat",
      computer,
      child,
      title: child.title || child.label || projectOf(child),
      subtitle: `${projectOf(child)} · ${computer}`,
      persist: { computer, id: child.id },
      mount: (el) => openChat(el, computer, child, {}),
    };
  }

  function openSession(computer, child, options) {
    tabs.open(chatDoc(computer, child), options);
  }

  const handlers = {
    onOpenChat: (computer, child) => openSession(computer, child),
    onOpenTerminal: (computer, server) => showPane("terminal", { computer, server }),
  };

  // Reopen last run's chat tabs once their sessions show up in the overview.
  let restore = tabs.saved();
  store.subscribe((merged) => {
    renderSidebar(sidebarEl, merged, handlers);
    if (session) setActiveSession(session.computer, session.child);
    if (restore) {
      const pending = [];
      for (const item of restore.list) {
        const row = item.kind === "chat" ? store.find(item.computer, item.id) : null;
        if (row) openSession(row.computer, row.child, { background: true });
        else if (item.kind === "chat" && !merged.computers?.some((c) => c.computer === item.computer && c.state === "online")) pending.push(item);
      }
      const activeId = restore.active;
      if (activeId && tabs.has(activeId)) tabs.activate(activeId);
      else if (!tabs.active() && tabs.list().length) tabs.activate(`chat:${tabs.list()[0].computer}/${tabs.list()[0].child.id}`);
      // Computers still connecting get another chance on later frames.
      restore = pending.length ? { list: pending, active: activeId } : null;
    }
  });

  return {
    openSession,
    showPane,
    closePanel,
    closeTab: () => tabs.close(),
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
