// The titlebar usage rings. The daemon's /api/usage has already merged every
// computer's account reports; this draws one small ring per account (filled by
// its tightest window) and opens a popover listing every account and window.
// The helper semantics mirror @phren/cli/client/account-usage, reimplemented
// here because the browser imports nothing from the CLI.

const POLL_MS = 60_000;
const SIZE = 18;
const RADIUS = 7;
const STROKE = 2.5;
const CIRC = 2 * Math.PI * RADIUS;
const SVG_NS = "http://www.w3.org/2000/svg";

const ageText = (ms) => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};

const roomLeft = (windows) => {
  const known = (windows ?? []).map((w) => w.leftPercent).filter((v) => v !== undefined);
  return known.length ? Math.min(...known) : undefined;
};

const resetsIn = (iso, now = Date.now()) => {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const minutes = Math.round(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};

const title = (row) => (row.account ? `${row.name} · ${row.account}` : row.name);

/** The one-line answer the tooltip and popover header show. */
function usageSummary(view) {
  const accounts = view?.accounts ?? [];
  const computers = view?.computers ?? [];
  const parts = [`${accounts.length} account${accounts.length === 1 ? "" : "s"} across ${computers.length} computer${computers.length === 1 ? "" : "s"}.`];
  const out = accounts.filter((row) => row.exhausted);
  if (out.length) parts.push(`Out of quota: ${out.map(title).join("; ")}.`);
  const stale = accounts.filter((row) => row.stale);
  if (stale.length) parts.push(`Stale: ${stale.map(title).join("; ")}.`);
  if (view?.unreachable?.length) parts.push(`Unreachable: ${view.unreachable.map((u) => u.computer).join(", ")}.`);
  return parts.join(" ");
}

/** Used percent and colour of an account's tightest window (least room left). */
function tightest(row) {
  const known = (row.windows ?? []).filter((w) => typeof w.usedPercent === "number");
  if (!known.length) return null;
  const window = known.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
  return { used: window.usedPercent, resetsIn: window.resetsIn, resetsAt: window.resetsAt };
}

function tone(used) {
  if (used === null || used === undefined) return "var(--muted)";
  if (used > 90) return "var(--danger)";
  if (used >= 70) return "var(--waiting)";
  return "var(--accent)";
}

function svgEl(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function drawRing(used) {
  const svg = svgEl("svg", { width: SIZE, height: SIZE, viewBox: `0 0 ${SIZE} ${SIZE}`, "aria-hidden": "true" });
  const track = svgEl("circle", { cx: 9, cy: 9, r: RADIUS, fill: "none", "stroke-width": STROKE });
  track.style.stroke = "var(--border-strong)";
  svg.append(track);
  const fraction = used === null ? 0 : Math.max(0, Math.min(1, used / 100));
  const arc = svgEl("circle", { cx: 9, cy: 9, r: RADIUS, fill: "none", "stroke-width": STROKE, "stroke-linecap": "round", transform: "rotate(-90 9 9)" });
  arc.style.stroke = tone(used);
  arc.style.strokeDasharray = `${CIRC}`;
  arc.style.strokeDashoffset = `${CIRC * (1 - fraction)}`;
  svg.append(arc);
  return svg;
}

function windowLine(w, now) {
  const row = document.createElement("div");
  row.className = "usage-window";
  const label = document.createElement("span");
  label.className = "usage-window-name";
  label.textContent = w.name;
  const value = document.createElement("span");
  value.className = "usage-window-value";
  const used = typeof w.usedPercent === "number" ? w.usedPercent : null;
  value.textContent = w.reset ? "reset" : used !== null ? `${used}%` : w.usedUSD !== undefined ? `$${w.usedUSD.toFixed(2)}` : "";
  const bar = document.createElement("span");
  bar.className = "usage-bar";
  const fill = document.createElement("span");
  fill.className = "usage-bar-fill";
  fill.style.width = `${used === null ? 0 : Math.max(0, Math.min(100, used))}%`;
  fill.style.background = tone(used);
  bar.append(fill);
  const reset = document.createElement("span");
  reset.className = "usage-window-reset";
  const until = w.resetsIn || (w.resetsAt ? resetsIn(w.resetsAt, now) : "");
  reset.textContent = until ? `resets in ${until}` : "";
  row.append(label, value, bar, reset);
  return row;
}

function accountBlock(row, now) {
  const block = document.createElement("div");
  block.className = "usage-account";
  const head = document.createElement("div");
  head.className = "usage-account-head";
  const name = document.createElement("span");
  name.className = "usage-account-name";
  name.textContent = title(row);
  const meta = document.createElement("span");
  meta.className = "usage-account-meta";
  const age = row.updatedAt ? `reported ${ageText(now - Date.parse(row.updatedAt))} ago` : "";
  const left = roomLeft(row.windows);
  meta.textContent = [row.harness, left !== undefined ? `${left}% left` : "", age].filter(Boolean).join(" · ");
  head.append(name, meta);
  block.append(head);
  for (const w of row.windows ?? []) block.append(windowLine(w, now));
  if (row.spend) {
    const spend = document.createElement("div");
    spend.className = "usage-account-note";
    spend.textContent = `$${row.spend.amountUSD.toFixed(2)} ${row.spend.period.replace(/_/g, " ")}`;
    block.append(spend);
  }
  if (row.message) {
    const note = document.createElement("div");
    note.className = "usage-account-note";
    note.textContent = row.message;
    block.append(note);
  }
  return block;
}

export function mountUsageRings(el) {
  el.classList.add("usage-rings");
  el.setAttribute("aria-label", "Account usage");

  const row = document.createElement("div");
  row.className = "usage-rings-row";
  el.append(row);

  const pop = document.createElement("div");
  pop.className = "usage-pop";
  pop.hidden = true;
  el.append(pop);

  let snapshot = null;
  let timer = null;

  const closePopover = () => {
    pop.hidden = true;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onOutside, true);
  };

  const onKey = (ev) => { if (ev.key === "Escape") closePopover(); };
  const onOutside = (ev) => { if (!el.contains(ev.target)) closePopover(); };

  const openPopover = () => {
    renderPopover();
    pop.hidden = false;
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onOutside, true);
  };

  function renderPopover() {
    pop.replaceChildren();
    const header = document.createElement("div");
    header.className = "usage-pop-summary";
    header.textContent = usageSummary(snapshot);
    pop.append(header);
    for (const account of snapshot?.accounts ?? []) pop.append(accountBlock(account, Date.now()));
    for (const item of snapshot?.noData ?? []) {
      const note = document.createElement("div");
      note.className = "usage-pop-nodata";
      note.textContent = `${item.name}: no numbers from ${item.computers.join(", ")}`;
      pop.append(note);
    }
  }

  function render() {
    row.replaceChildren();
    const accounts = snapshot?.accounts ?? [];
    el.classList.toggle("empty", accounts.length === 0);
    for (const account of accounts) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "usage-ring";
      const tight = tightest(account);
      const used = tight ? tight.used : null;
      button.append(drawRing(used));
      if (account.stale) button.style.opacity = "0.4";
      const reset = tight?.resetsIn || (tight?.resetsAt ? resetsIn(tight.resetsAt) : "");
      button.title = `${title(account)} · ${used === null ? "no limit" : `${used}% used`}${reset ? `, resets in ${reset}` : ""}`;
      button.addEventListener("click", (ev) => { ev.stopPropagation(); if (pop.hidden) openPopover(); else closePopover(); });
      row.append(button);
    }
    if (!pop.hidden) renderPopover();
  }

  async function load() {
    try {
      const res = await fetch("/api/usage", { cache: "no-store" });
      if (res.ok) snapshot = await res.json();
    } catch {
      // Keep the last drawing; the next poll retries.
    }
    render();
  }

  render();
  void load();
  timer = setInterval(load, POLL_MS);

  return { close() { if (timer) clearInterval(timer); closePopover(); } };
}
