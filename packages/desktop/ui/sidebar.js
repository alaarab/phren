// Sessions sidebar: the phone's Live sessions list at desktop density.
// See CONTRACT.md: export renderSidebar(el, merged, handlers). The row keeps
// the `.sb-row` / data-session="<computer>/<childId>" shape keys.js relies on.
import { showSection } from "./shell/sections.js";
import { hookPost, targetQuery } from "./api.js";
import { store } from "./shell/store.js";

// answerApproval is written in a parallel change under ui/chat/. Import it
// lazily so a missing module never takes the whole sidebar down; the fallback
// posts the same answer the contract documents.
let answerApproval;
import("./chat/answers.js").then((m) => { answerApproval = m.answerApproval; }).catch(() => {});

const GROUP_KEY = "phren.desktop.sidebar.group";
const PULL_TTL_MS = 60_000;

// Provider glyphs (inline SVG), one per Hook target source.
const GLYPHS = {
  claude: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 3.5v6.5M12 14v6.5M5 7.8l5.6 3.2M13.4 13l5.6 3.2M5 16.2l5.6-3.2M13.4 11l5.6-3.2"/></svg>',
  codex: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"/><path d="M12 3v8.5l7.8 4.5M12 11.5L4.2 16"/></svg>',
  opencode: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9.5l3 3-3 3M12.5 15.5h4"/></svg>',
  copilot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="8" cy="12" r="3.4"/><circle cx="16" cy="12" r="3.4"/><path d="M2.5 11h2.1M19.4 11h2.1" stroke-linecap="round"/></svg>',
  phren: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="5" r="2.1"/><circle cx="5" cy="17.5" r="2.1"/><circle cx="19" cy="17.5" r="2.1"/><path d="M10.7 6.9L6.3 15.5M13.3 6.9l4.4 8.6M7.1 17.5h9.8"/></svg>',
};
const BADGE = { needs: "!", working: "\u25CF", done: "\u2713", idle: "\u00B7" };

// Six Phren-palette hues for the stable per-computer colour.
// Not the accent purple (projects) or the status colours; by link order, so
// the first few computers never share a colour.
const HOST_HUES = ["#7FB6F0", "#F0A06E", "#6FD0D8", "#E79BD0", "#C8C27A", "#A5B4FC"];

// The phone's OfflineReason wording (docs/phren-hook.md "Offline reasons").
const OFFLINE_LABELS = {
  "herdr-not-running": "Herdr not running", "herdr-stale-socket": "Herdr stopped", "herdr-permission": "Herdr socket blocked",
  "herdr-unreachable": "Herdr unreachable", "herdr-timeout": "Herdr not answering", "ssh-unavailable": "SSH unavailable",
  "dispatch-key-missing": "Not enrolled", "peer-offline": "Peer offline", "peer-timeout": "Peer not answering",
  "peer-key-not-enrolled": "Key not enrolled", "peer-host-key-mismatch": "Host key changed",
};

// ---------------------------------------------------------------- helpers
function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function glyph(source) {
  const wrap = el("span", "sb-glyph");
  wrap.innerHTML = GLYPHS[source] || GLYPHS.phren;
  return wrap;
}
function el(tag, className, text) { return h(tag, className, text); }

function basename(p) {
  const parts = String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || String(p || "");
}

function kindOf(child) {
  const s = child.agentStatus;
  if (s === "blocked" || s === "waiting" || child.approvalPending === true) return "needs";
  if (s === "working") return "working";
  if (s === "done") return "done";
  return "idle";
}

function hostColor(name) {
  const index = (store.merged?.computers ?? []).findIndex((c) => c.computer === name);
  if (index >= 0) return HOST_HUES[index % HOST_HUES.length];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return HOST_HUES[hash % HOST_HUES.length];
}

function relativeAge(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const seconds = Math.max(0, (Date.now() - t) / 1000);
  if (!Number.isFinite(seconds) || seconds < 10) return "now";
  if (seconds < 60) return Math.floor(seconds) + "s ago";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
  return Math.floor(seconds / 86400) + "d ago";
}

function offlineReason(co) {
  const raw = String(co.error || "").trim();
  if (OFFLINE_LABELS[raw]) return OFFLINE_LABELS[raw];
  if (/host key|REMOTE HOST IDENTIFICATION/i.test(raw)) return "Host key changed";
  if (/timed out|timeout/i.test(raw)) return "Not answering";
  if (/refused|ECONNREFUSED/i.test(raw)) return "Connection refused";
  if (/ENOENT|no such file|not found/i.test(raw)) return "Not found";
  return raw || "Offline";
}

function keyOf(computer, child) { return `${computer}/${child.id}`; }
function rowId(computer, child) { return `r:${keyOf(computer, child)}`; }

function sessionRows(merged) {
  const rows = [];
  for (const co of merged?.computers || []) {
    for (const group of co.overview?.groups || []) {
      for (const child of group.children || []) {
        if (child && child.target) rows.push({ computer: co.computer, group, child });
      }
    }
  }
  return rows;
}

const newestFirst = (a, b) => (Date.parse(b.child.lastChangedAt) || 0) - (Date.parse(a.child.lastChangedAt) || 0);

function readMode() {
  try { return localStorage.getItem(GROUP_KEY) === "computer" ? "computer" : "status"; } catch { return "status"; }
}
function writeMode(mode) { try { localStorage.setItem(GROUP_KEY, mode); } catch { /* storage unavailable */ } }

function stateOf(el) {
  if (!el.__sb) {
    el.__sb = {
      el, mode: readMode(), merged: null, handlers: {},
      nodes: new Map(), prCache: new Map(), prInflight: new Set(),
      approvals: new Map(), approvalSockets: new Map(),
    };
  }
  return el.__sb;
}

function requestRender(sb) { if (sb.merged) renderSidebar(sb.el, sb.merged, sb.handlers); }

function pullNumber(sb, row) {
  const cached = sb.prCache.get(row.computer);
  const branch = row.child.branch;
  if (!cached || !branch) return null;
  const pull = (cached.pulls || []).find((p) => p.head === branch && String(p.state || "").toLowerCase() === "open");
  return pull ? pull.number : null;
}

// ---------------------------------------------------------------- model
function header(id, text, count) { return { id: `h:${id}`, kind: "header", text, count }; }
function subhead(id, text) { return { id: `sub:${id}`, kind: "subhead", text }; }
function rowDesc(sb, row) {
  return { id: rowId(row.computer, row.child), kind: "row", computer: row.computer, child: row.child, pr: pullNumber(sb, row) };
}
function computerDesc(co, sessions) { return { id: `c:${co.computer}`, kind: "computer", co, sessions }; }

function buildModel(sb) {
  const merged = sb.merged || {};
  const rows = sessionRows(merged);
  const computers = merged.computers || [];
  const desired = [];

  if (sb.mode === "computer") {
    for (const co of computers) {
      const mine = rows.filter((r) => r.computer === co.computer).sort(newestFirst);
      desired.push(header(`co:${co.computer}`, co.computer, mine.length));
      if (co.state !== "online") desired.push(computerDesc(co, mine));
      let groupId = null;
      for (const row of mine) {
        if (row.group.id !== groupId) {
          groupId = row.group.id;
          desired.push(subhead(`${co.computer}:${groupId}`, row.group.label || ""));
        }
        desired.push(rowDesc(sb, row));
      }
    }
    desired.push({ id: "add", kind: "add" });
    return desired;
  }

  const groups = { needs: [], working: [], idle: [], done: [] };
  for (const row of rows) groups[kindOf(row.child)].push(row);
  for (const list of Object.values(groups)) list.sort(newestFirst);
  const titles = { needs: "Needs you", working: "Working", idle: "Idle", done: "Done" };
  for (const kind of ["needs", "working", "idle", "done"]) {
    if (!groups[kind].length) continue;
    desired.push(header(kind, titles[kind], groups[kind].length));
    for (const row of groups[kind]) desired.push(rowDesc(sb, row));
  }

  if (computers.length) {
    desired.push(header("computers", "Computers"));
    for (const co of computers) desired.push(computerDesc(co, rows.filter((r) => r.computer === co.computer)));
    desired.push({ id: "add", kind: "add" });
  }
  return desired;
}

// ---------------------------------------------------------------- reconcile
function nodeFor(sb, desc) {
  const hit = sb.nodes.get(desc.id);
  if (hit) return hit;
  const node = makeNode(sb, desc);
  node.__id = desc.id;
  sb.nodes.set(desc.id, node);
  return node;
}

function reconcile(sb, container, desired) {
  for (let i = 0; i < desired.length; i++) {
    const desc = desired[i];
    const node = nodeFor(sb, desc);
    updateNode(sb, node, desc);
    const at = container.children[i];
    if (at !== node) container.insertBefore(node, at || null);
  }
  while (container.children.length > desired.length) container.lastChild.remove();
  const keep = new Set(desired.map((d) => d.id));
  for (const [id, node] of sb.nodes) {
    if (keep.has(id)) continue;
    node.remove();
    sb.nodes.delete(id);
  }
}

function makeNode(sb, desc) {
  if (desc.kind === "header") {
    const node = el("div", "sb-header");
    node.append(el("span", "sb-header-text"), el("span", "sb-count"));
    return node;
  }
  if (desc.kind === "subhead") return el("div", "sb-subhead");
  if (desc.kind === "add") {
    const node = el("div", "sb-computer-row sb-add");
    node.setAttribute("role", "button");
    node.tabIndex = 0;
    node.append(el("span", "sb-dot"), el("span", "sb-cname", "Add computer"));
    const open = () => {
      showSection("settings");
      document.querySelector('.settings-tab[data-page="computers"]')?.click();
    };
    node.addEventListener("click", open);
    node.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    return node;
  }
  if (desc.kind === "computer") {
    const node = el("div", "sb-computer-row");
    node.append(el("span", "sb-dot"), el("span", "sb-cname"), el("span", "sb-cstate"));
    node.addEventListener("click", () => {
      const mux = node.__co?.overview?.mux;
      if (mux) sb.handlers.onOpenTerminal?.(node.__co.computer, mux.session);
    });
    return node;
  }
  return makeRow(sb, desc);
}

function updateNode(sb, node, desc) {
  if (desc.kind === "header") {
    const sig = desc.text + "|" + (desc.count ?? "");
    if (node.__sig === sig) return;
    node.__sig = sig;
    node.firstChild.textContent = desc.text;
    const count = node.lastChild;
    count.textContent = desc.count ?? "";
    count.hidden = desc.count == null;
    return;
  }
  if (desc.kind === "subhead") {
    if (node.__sig !== desc.text) { node.__sig = desc.text; node.textContent = desc.text; }
    return;
  }
  if (desc.kind === "computer") { updateComputer(node, desc); return; }
  if (desc.kind === "add") return;
  updateRow(sb, node, desc);
}

function updateComputer(node, desc) {
  const co = desc.co;
  const mux = co.overview?.mux;
  node.__co = co;
  node.tabIndex = mux ? 0 : -1;
  node.setAttribute("role", mux ? "button" : "listitem");
  const count = desc.sessions.length;
  let state = count ? `${count} session${count === 1 ? "" : "s"}` : "No sessions";
  if (co.state === "connecting") state = "Connecting\u2026";
  else if (co.state === "offline" || co.state === "verify") {
    const seen = relativeAge(co.updatedAt);
    state = offlineReason(co) + (seen ? ` \u00B7 ${seen}` : "");
  }
  const sig = [co.computer, co.state, state].join("|");
  if (node.__sig === sig) return;
  node.__sig = sig;
  node.children[0].className = "sb-dot " + co.state;
  const name = node.children[1];
  name.textContent = co.computer;
  name.style.setProperty("--host-color", hostColor(co.computer));
  const meta = node.children[2];
  meta.className = "sb-cstate " + co.state;
  meta.textContent = state;
}

// ---------------------------------------------------------------- rows
function makeRow(sb, desc) {
  const node = el("div", "sb-row");
  node.setAttribute("role", "button");
  node.tabIndex = 0;
  node.addEventListener("click", () => {
    const row = node.__row;
    if (row) sb.handlers.onOpenChat?.(row.computer, row.child);
  });
  node.addEventListener("keydown", (event) => {
    if (event.target !== node) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const row = node.__row;
      if (row) sb.handlers.onOpenChat?.(row.computer, row.child);
    }
  });
  node.addEventListener("contextmenu", (event) => { event.preventDefault(); showMenu(node); });
  return node;
}

function rowSig(sb, desc) {
  const c = desc.child;
  const approval = sb.approvals.get(keyOf(desc.computer, c));
  return [desc.computer, c.id, kindOf(c), c.title, c.cwd, c.branch, c.lastChangedAt,
    c.approvalPending === true, desc.pr, approval?.actionId || ""].join("|");
}

function updateRow(sb, node, desc) {
  node.dataset.session = keyOf(desc.computer, desc.child);
  node.__row = { computer: desc.computer, child: desc.child };
  const sig = rowSig(sb, desc);
  if (node.__sig === sig && node.firstChild) return;
  node.__sig = sig;
  node.replaceChildren(...rowContent(sb, node, desc));
}

function rowContent(sb, node, desc) {
  const { computer, child } = desc;
  const kind = kindOf(child);
  const out = [];
  if (kind === "needs" || kind === "working") out.push(el("span", "sb-bar " + kind));

  const ring = el("span", "sb-ring " + kind);
  ring.append(glyph(child.target.source), el("span", "sb-badge " + kind, BADGE[kind] || ""));
  out.push(ring);

  const main = el("span", "sb-main");
  const top = el("span", "sb-line");
  top.append(el("span", "sb-project", basename(child.cwd) || child.label || ""));
  const chip = el("span", "sb-computer", computer);
  chip.style.setProperty("--host-color", hostColor(computer));
  top.append(chip, el("span", "sb-age", relativeAge(child.lastChangedAt)));
  main.append(top);

  const bottom = el("span", "sb-line");
  bottom.append(el("span", "sb-title", child.title || ""));
  if (child.branch) bottom.append(el("span", "sb-branch", child.branch));
  if (desc.pr != null) bottom.append(el("span", "sb-pr", "#" + desc.pr));
  main.append(bottom);
  out.push(main);

  // Hidden terminal trigger: keys.js's 't' clicks `.sb-term`.
  const term = el("span", "sb-term");
  term.setAttribute("role", "button");
  term.tabIndex = 0;
  const openTerm = (event) => { event.stopPropagation(); sb.handlers.onOpenTerminal?.(computer, child.target.server); };
  term.addEventListener("click", openTerm);
  term.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openTerm(event); } });
  out.push(term);

  out.push(rowActions(sb, node, desc), rowMenu(sb, desc));
  return out;
}

function rowActions(sb, node, desc) {
  const actions = el("span", "sb-actions");
  const key = keyOf(desc.computer, desc.child);
  if (kindOf(desc.child) === "needs" && desc.child.approvalPending === true && sb.approvals.get(key)?.actionId) {
    const approve = el("button", "sb-act approve", "Approve");
    const deny = el("button", "sb-act deny", "Deny");
    approve.type = deny.type = "button";
    approve.addEventListener("click", (event) => { event.stopPropagation(); decide(sb, desc, "approve"); });
    deny.addEventListener("click", (event) => { event.stopPropagation(); decide(sb, desc, "deny"); });
    actions.append(approve, deny);
  }
  const more = el("button", "sb-act sb-more", "\u22EF");
  more.type = "button";
  more.title = "Session actions";
  more.setAttribute("aria-label", "Session actions");
  more.addEventListener("click", (event) => { event.stopPropagation(); showMenu(node); });
  actions.append(more);
  return actions;
}

function rowMenu(sb, desc) {
  const menu = el("div", "sb-menu");
  const openTerminal = el("button", null, "Open terminal");
  openTerminal.type = "button";
  openTerminal.addEventListener("click", (event) => {
    event.stopPropagation();
    hideMenus();
    sb.handlers.onOpenTerminal?.(desc.computer, desc.child.target.server);
  });
  const rename = el("button", null, "Rename");
  rename.type = "button";
  const input = el("input", "sb-rename");
  input.type = "text";
  input.placeholder = "Session name";
  input.hidden = true;
  input.setAttribute("aria-label", "Session name");
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") submitRename(sb, desc, input.value);
    else if (event.key === "Escape") { input.hidden = true; input.blur(); }
  });
  rename.addEventListener("click", (event) => {
    event.stopPropagation();
    input.hidden = false;
    input.value = desc.child.title || "";
    input.focus();
    input.select();
  });
  menu.append(openTerminal, rename, input);
  return menu;
}

function hideMenus() { for (const menu of document.querySelectorAll(".sb-menu.on")) menu.classList.remove("on"); }
function showMenu(node) {
  const menu = node.querySelector(".sb-menu");
  const wasOpen = Boolean(menu?.classList.contains("on"));
  hideMenus();
  if (menu && !wasOpen) menu.classList.add("on");
}
document.addEventListener("click", () => hideMenus());

async function decide(sb, desc, decision) {
  const key = keyOf(desc.computer, desc.child);
  const info = sb.approvals.get(key);
  if (!info?.actionId) return;
  try {
    if (answerApproval) await answerApproval(desc.computer, desc.child.target, { actionId: info.actionId, decision, scope: "once" });
    else await hookPost(desc.computer, "/v1/approvals/answer", { target: desc.child.target, actionId: info.actionId, decision });
  } catch { /* the next overview frame settles it */ }
  sb.approvals.delete(key);
  requestRender(sb);
}

async function submitRename(sb, desc, title) {
  hideMenus();
  const value = String(title || "").trim();
  if (!value) return;
  const target = desc.child.target || {};
  try {
    // The Hook reads workspaceId/tabId/paneId/label (session-rename.ts).
    await hookPost(desc.computer, "/v1/sessions/rename", {
      workspaceId: target.workspace, tabId: target.tab, paneId: target.pane, label: value,
    });
  } catch { /* reported by the next overview frame */ }
}

// ---------------------------------------------------------------- live bits
function statusUrl(computer, target) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/hosts/${encodeURIComponent(computer)}/v1/status?${targetQuery(target)}`;
}

function syncApprovals(sb, merged) {
  const pending = new Map();
  for (const row of sessionRows(merged)) {
    if (row.child.approvalPending === true) pending.set(keyOf(row.computer, row.child), row);
  }
  for (const [key, socket] of sb.approvalSockets) {
    if (pending.has(key)) continue;
    try { socket.close(); } catch { /* already closing */ }
    sb.approvalSockets.delete(key);
    sb.approvals.delete(key);
  }
  for (const [key, row] of pending) {
    if (sb.approvalSockets.has(key)) continue;
    const socket = new WebSocket(statusUrl(row.computer, row.child.target));
    socket.addEventListener("message", (event) => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (!frame || frame.type !== "agentStatus") return;
      const before = sb.approvals.get(key)?.actionId || null;
      const approval = frame.pendingApproval;
      if (approval && approval.actionId) sb.approvals.set(key, approval);
      else sb.approvals.delete(key);
      if ((sb.approvals.get(key)?.actionId || null) !== before) requestRender(sb);
    });
    sb.approvalSockets.set(key, socket);
  }
}

function syncPulls(sb, merged) {
  const rows = sessionRows(merged);
  for (const co of merged?.computers || []) {
    if (co.state !== "online" || sb.prInflight.has(co.computer)) continue;
    const cached = sb.prCache.get(co.computer);
    if (cached && Date.now() - cached.at < PULL_TTL_MS) continue;
    const row = rows.find((r) => r.computer === co.computer);
    if (!row) continue;
    sb.prInflight.add(co.computer);
    hookPost(co.computer, "/v1/git/pulls", { target: row.child.target })
      .then((res) => { sb.prCache.set(co.computer, { at: Date.now(), pulls: res && Array.isArray(res.pulls) ? res.pulls : [] }); requestRender(sb); })
      .catch(() => { sb.prCache.set(co.computer, { at: Date.now(), pulls: [] }); })
      .finally(() => sb.prInflight.delete(co.computer));
  }
}

// ---------------------------------------------------------------- public
export function renderSidebar(element, merged, handlers = {}) {
  const sb = stateOf(element);
  sb.merged = merged;
  sb.handlers = handlers;
  element.classList.add("sb-root");

  let mode = element.querySelector(":scope > .sb-mode");
  if (!mode) {
    mode = el("div", "sb-mode");
    for (const id of ["status", "computer"]) {
      const b = el("button", null, id === "status" ? "Status" : "Computer");
      b.type = "button";
      b.dataset.group = id;
      b.addEventListener("click", () => { sb.mode = id; writeMode(id); requestRender(sb); });
      mode.append(b);
    }
    element.append(mode);
  }
  for (const b of mode.children) b.classList.toggle("on", b.dataset.group === sb.mode);

  let scroller = element.querySelector(":scope > .sb-scroll");
  if (!scroller) { scroller = el("div", "sb-scroll"); element.append(scroller); }

  const previousScroll = scroller.scrollTop;
  reconcile(sb, scroller, buildModel(sb));
  scroller.scrollTop = previousScroll;

  syncApprovals(sb, merged);
  syncPulls(sb, merged);
}


