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
