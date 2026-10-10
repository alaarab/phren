// Sessions sidebar for the Phren desktop spike. Plain browser ES module.
// See CONTRACT.md: export renderSidebar(el, merged, handlers).

const STYLE_ID = "sidebar-style";

// Provider glyph per Hook target source (contract.ts Target.source).
const PROVIDER = { claude: "C", codex: "X", opencode: "O", copilot: "G", phren: "P" };

const CSS = `
.sb-root { font-family: system-ui, -apple-system, sans-serif; color: var(--text); }
.sb-scroll { height: 100%; overflow-y: auto; }
.sb-section { margin: 0 0 8px; }
.sb-header {
  padding: 8px 12px 4px; color: var(--muted); font-size: 11px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase;
}
.sb-row {
  position: relative; display: flex; align-items: center; gap: 8px;
  width: 100%; min-height: 36px; max-height: 52px; box-sizing: border-box;
  padding: 6px 8px 6px 12px; margin: 0; border: none; border-radius: 10px;
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
  transition: background 0.18s ease;
}
.sb-row:hover { background: var(--surface); }
.sb-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.sb-bar { position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 999px; }
.sb-bar.working { background: var(--working); }
.sb-bar.needs { background: var(--waiting); }
.sb-ring {
  flex: none; width: 26px; height: 26px; box-sizing: border-box; border-radius: 50%;
  border: 2px solid var(--muted); display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 600;
}
.sb-ring.working { border-color: var(--working); color: var(--working); }
.sb-ring.needs { border-color: var(--waiting); color: var(--waiting); }
.sb-ring.idle { border-color: var(--muted); color: var(--muted); }
.sb-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sb-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.sb-project {
  color: var(--accent); font-size: 13px; max-width: 50%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sb-branch, .sb-computer { color: var(--muted); font-size: 12px; white-space: nowrap; }
.sb-branch {
  font-family: "JetBrains Mono", ui-monospace, Menlo, monospace;
  max-width: 40%; overflow: hidden; text-overflow: ellipsis;
}
.sb-age { margin-left: auto; color: var(--muted); font-size: 12px; white-space: nowrap; }
.sb-title {
  flex: 1; min-width: 0; color: var(--text-2); font-size: 12px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sb-term {
  flex: none; display: flex; align-items: center; justify-content: center;
  min-width: 22px; height: 18px; padding: 0 4px; border-radius: 6px;
  color: var(--muted); font-family: "JetBrains Mono", ui-monospace, Menlo, monospace;
  font-size: 12px; cursor: pointer;
}
.sb-term:hover { color: var(--text); background: var(--raised); }
.sb-term:focus-visible { outline: 2px solid var(--accent); }
.sb-computer-row {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 36px;
  box-sizing: border-box; padding: 6px 12px; border: none; border-radius: 10px;
  background: transparent; color: inherit; font: inherit; text-align: left;
}
button.sb-computer-row { cursor: pointer; transition: background 0.18s ease; }
button.sb-computer-row:hover { background: var(--surface); }
button.sb-computer-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.sb-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.sb-dot.online { background: var(--done); }
.sb-dot.connecting { background: var(--muted); }
.sb-dot.offline, .sb-dot.verify { background: var(--danger); }
.sb-cname { font-size: 13px; color: var(--text-2); white-space: nowrap; }
.sb-cstate {
  margin-left: auto; color: var(--muted); font-size: 12px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function kindOf(child) {
  const s = child.agentStatus;
  if (s === "blocked" || s === "waiting" || child.approvalPending === true) return "needs";
  if (s === "working") return "working";
  return "idle";
}

function providerLetter(source) {
  return PROVIDER[source] || (source ? source[0].toUpperCase() : "?");
}

function basename(p) {
  if (!p) return "";
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function timeOf(iso) {
  const t = Date.parse(iso || "");
  return Number.isNaN(t) ? 0 : t;
}

function formatAge(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const seconds = Math.max(0, (Date.now() - t) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h";
  return Math.floor(hours / 24) + "d";
}

function span(className, text) {
  const node = document.createElement("span");
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function collectRows(merged) {
  const rows = [];
  for (const co of merged.computers || []) {
    const overview = co.overview;
    if (!overview || !Array.isArray(overview.groups)) continue;
    for (const group of overview.groups) {
      for (const child of group.children || []) {
        if (!child || !child.target) continue;
        rows.push({ computer: co.computer, child });
      }
    }
  }
  return rows;
}

function sessionRow(row, handlers) {
  const { computer, child } = row;
  const kind = kindOf(child);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "sb-row";
  button.dataset.session = `${computer}/${child.id}`;
  if (kind === "needs" || kind === "working") button.appendChild(span("sb-bar " + kind));

  const ring = span("sb-ring " + kind, providerLetter(child.target.source));
  button.appendChild(ring);

  const main = span("sb-main");

  const line1 = span("sb-line");
  line1.appendChild(span("sb-project", basename(child.cwd) || child.label || ""));
  if (child.branch) line1.appendChild(span("sb-branch", child.branch));
  line1.appendChild(span("sb-computer", computer));
  line1.appendChild(span("sb-age", formatAge(child.lastChangedAt)));
  main.appendChild(line1);

  const line2 = span("sb-line");
  line2.appendChild(span("sb-title", child.title || ""));
  const term = span("sb-term", ">_");
  term.setAttribute("role", "button");
  term.setAttribute("tabindex", "0");
  term.title = "Open terminal";
  const openTerminal = (event) => {
    event.stopPropagation();
    handlers.onOpenTerminal?.(computer, child.target.server);
  };
  term.addEventListener("click", openTerminal);
  term.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openTerminal(event);
    }
  });
  line2.appendChild(term);
  main.appendChild(line2);
  button.appendChild(main);

  button.addEventListener("click", () => handlers.onOpenChat?.(computer, child));
  return button;
}

function section(label, rows, handlers) {
  const container = document.createElement("section");
  container.className = "sb-section";
  container.appendChild(span("sb-header", label + " \u00B7 " + rows.length));
  for (const row of rows) container.appendChild(sessionRow(row, handlers));
  return container;
}

function computerRow(co, handlers) {
  const mux = co.overview?.mux;
  const row = document.createElement(mux ? "button" : "div");
  row.className = "sb-computer-row";
  if (mux) {
    row.type = "button";
    row.addEventListener("click", () => handlers.onOpenTerminal?.(co.computer, mux.session));
  }
  row.appendChild(span("sb-dot " + co.state));
  row.appendChild(span("sb-cname", co.computer));
  row.appendChild(span("sb-cstate", co.error || co.state));
  return row;
}

export function renderSidebar(el, merged, handlers = {}) {
  ensureStyle();
  el.classList.add("sb-root");

  let scroller = el.querySelector(":scope > .sb-scroll");
  if (!scroller) {
    scroller = document.createElement("div");
    scroller.className = "sb-scroll";
    el.appendChild(scroller);
  }
  const previousScroll = scroller.scrollTop;

  const needs = [];
  const working = [];
  const idle = [];
  for (const row of collectRows(merged)) {
    const kind = kindOf(row.child);
    (kind === "needs" ? needs : kind === "working" ? working : idle).push(row);
  }
  const newestFirst = (a, b) => timeOf(b.child.lastChangedAt) - timeOf(a.child.lastChangedAt);
  needs.sort(newestFirst);
  working.sort(newestFirst);
  idle.sort(newestFirst);

  const fragment = document.createDocumentFragment();
  if (needs.length) fragment.appendChild(section("NEEDS YOU", needs, handlers));
  if (working.length) fragment.appendChild(section("WORKING", working, handlers));
  if (idle.length) fragment.appendChild(section("IDLE", idle, handlers));

  const computers = merged.computers || [];
  if (computers.length) {
    const container = document.createElement("section");
    container.className = "sb-section";
    container.appendChild(span("sb-header", "COMPUTERS"));
    for (const co of computers) container.appendChild(computerRow(co, handlers));
    fragment.appendChild(container);
  }

  scroller.replaceChildren(fragment);
  scroller.scrollTop = previousScroll;
}
