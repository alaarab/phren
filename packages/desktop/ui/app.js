import { renderSidebar } from "./sidebar.js";
import { openChat } from "./chat.js";
import { openTerminal } from "./terminal.js";

const sidebarEl = document.getElementById("sidebar");
const mainEl = document.getElementById("main");
const sideEl = document.getElementById("side");
const countEl = document.getElementById("conn-count");

let chat = null;
let terminal = null;

function setEmpty() {
  mainEl.innerHTML = '<div class="empty">Pick a session</div>';
}

function closeChat() {
  if (chat) {
    chat.close();
    chat = null;
  }
}

function closeTerminal() {
  if (terminal) {
    terminal.close();
    terminal = null;
  }
  sideEl.hidden = true;
}

const handlers = {
  onOpenChat(computer, child) {
    closeChat();
    chat = openChat(mainEl, computer, child);
  },
  onOpenTerminal(computer, server) {
    closeTerminal();
    sideEl.hidden = false;
    terminal = openTerminal(sideEl, computer, server);
  },
};

function updateCount(merged) {
  const computers = merged?.computers ?? [];
  const online = computers.filter((c) => c.state === "online").length;
  countEl.textContent = `${computers.length} computers \u00b7 ${online} online`;
}

// The Electron shell exposes window.phrenDesktop; in a browser it is absent.
const shell = window.phrenDesktop;
if (shell) document.documentElement.classList.add("electron", `platform-${shell.platform}`);

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

  ws.addEventListener("open", () => {
    retry = 1000;
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "overview") {
      renderSidebar(sidebarEl, msg.merged, handlers);
      updateCount(msg.merged);
      announce(msg.merged);
    }
  });
  ws.addEventListener("close", () => {
    // 1 s doubling to 10 s
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 10000);
  });
}

setEmpty();
connect();
