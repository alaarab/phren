import { renderSidebar } from "./sidebar.js";
import { openChat } from "./chat.js";
import { openTerminal } from "./terminal.js";
import { openChanges } from "./changes.js";
import { openFiles } from "./editor.js";
import { openSearch } from "./search.js";

const sidebarEl = document.getElementById("sidebar");
const mainEl = document.getElementById("main");
const sideEl = document.getElementById("side");
const countEl = document.getElementById("conn-count");

// The Electron shell exposes window.phrenDesktop; in a browser it is absent.
const shell = window.phrenDesktop;
if (shell) document.documentElement.classList.add("electron", `platform-${shell.platform}`);

let chat = null;
let session = null; // { computer, child } the chat and workbench are scoped to

// ---------------------------------------------------------------- workbench
// The right panel: Changes · Files · Terminal for the open session. Panes stay
// mounted while the session is open so tabs, scroll and drafts survive switching.
const PANES = [["changes", "Changes"], ["files", "Files"], ["search", "Search"], ["terminal", "Terminal"]];
const bench = { pane: null, handles: {}, bodies: {}, terminalServer: null, terminalComputer: null };

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
const maxBtn = document.createElement("button");
maxBtn.className = "icon-button";
maxBtn.title = "Cover the chat";
maxBtn.textContent = "⤢";
maxBtn.addEventListener("click", () => document.body.classList.toggle("bench-max"));
const closeBtn = document.createElement("button");
closeBtn.className = "icon-button";
closeBtn.title = "Close the panel";
closeBtn.textContent = "×";
closeBtn.addEventListener("click", () => { sideEl.hidden = true; document.body.classList.remove("bench-max"); });
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
    ask(text) { chat?.insert(text); },
  };
}

function resetBench() {
  for (const h of Object.values(bench.handles)) { try { h.close(); } catch { /* already closed */ } }
  bench.handles = {}; bench.bodies = {}; bench.pane = null; bench.terminalServer = null;
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
  if (!session?.child?.target) { el.textContent = "Open a session to see its changes and files."; return; }
  const open = { changes: openChanges, files: openFiles, search: openSearch }[key];
  if (!bench.handles[key]) bench.handles[key] = open(el, benchContext());
  else if (key === "changes") bench.handles.changes.refresh?.();
  if (key === "search") bench.handles.search.focus?.();
}

// ---------------------------------------------------------------- sessions
function setEmpty() {
  mainEl.innerHTML = '<div class="empty">Pick a session</div>';
}

const handlers = {
  onOpenChat(computer, child) {
    chat?.close();
    resetBench();
    session = { computer, child };
    chat = openChat(mainEl, computer, child, {
      onChanges: () => showPane("changes"),
      onFiles: () => showPane("files"),
      onSearch: () => showPane("search"),
      onTerminal: () => showPane("terminal"),
    });
    if (!sideEl.hidden) showPane("changes");
  },
  onOpenTerminal(computer, server) {
    showPane("terminal", { computer, server });
  },
};

function updateCount(merged) {
  const computers = merged?.computers ?? [];
  const online = computers.filter((c) => c.state === "online").length;
  countEl.textContent = `${computers.length} computers · ${online} online`;
}

/** Rows that need the owner: blocked or waiting agents and pending approvals. */
function needsYou(merged) {
  const rows = [];
  for (const c of merged?.computers ?? []) {
    for (const g of c.overview?.groups ?? []) {
      for (const child of g.children ?? []) {
        if (child.target && (child.agentStatus === "blocked" || child.agentStatus === "waiting" || child.approvalPending)) {
          rows.push({ key: `${c.computer}/${child.id}`, computer: c.computer, child });
        }
      }
    }
  }
  return rows;
}

let notified = null; // keys already announced; null until the first frame
function announce(merged) {
  const rows = needsYou(merged);
  shell?.setBadge(rows.length);
  document.title = rows.length ? `(${rows.length}) Phren` : "Phren";
  const keys = new Set(rows.map((r) => r.key));
  if (notified && shell) {
    for (const r of rows) {
      if (!notified.has(r.key)) {
        const project = (r.child.cwd ?? r.child.label ?? "").split("/").filter(Boolean).pop() ?? r.child.label;
        shell.notify(`${project} needs you`, `${r.child.title ?? r.child.label} · ${r.computer}`);
      }
    }
  }
  notified = keys;
}

let retry = 1000;
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/overview`);
  ws.addEventListener("open", () => { retry = 1000; });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "overview") {
      renderSidebar(sidebarEl, msg.merged, handlers);
      updateCount(msg.merged);
      announce(msg.merged);
    }
  });
  ws.addEventListener("close", () => {
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 10000);
  });
}

setEmpty();
connect();

// ⇧⌘F opens Search for the open session, as in VS Code.
window.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && ev.key.toLowerCase() === "f" && session) {
    ev.preventDefault();
    showPane("search");
  }
});
