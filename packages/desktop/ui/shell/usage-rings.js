import { compareUsage, exhausted, limitingWindow, resetLabel, usedPercent, windowText } from "./usage-windows.js";
// The titlebar usage rings. The daemon's /api/usage has already merged every
// computer's account reports; this draws one small ring per account (filled by
// its tightest window) and opens a popover listing every account and window,
// laid out like the phone's Account usage cards.

let openOverview = null;
/** Open the titlebar's shared overview, including when there are no rings. */
export function openUsage() { openOverview?.(); }

/** Exhausted accounts first, then the highest active window percent; unknown last. */
export function sortUsageAccounts(accounts) {
  return [...(accounts ?? [])].sort(compareUsage);
}

const usageListeners = new Set();
let latestUsage = null;
export function followUsage(fn) { usageListeners.add(fn); fn(latestUsage); return () => usageListeners.delete(fn); }

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

const title = (row) => (row.account ? `${row.name} · ${row.account}` : row.name);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Oct 7": a subscription date in UTC, as the phone writes it. */
const dayUTC = (iso) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` : "";
};
/**
 * Card titles by account id, as the phone names them: the provider, then the
 * email or label. One email on two plans (a personal plan and a Team seat)
 * adds the plan, and two or more unnamed accounts of one provider become
 * "Account 2" by their place, so two cards never read the same.
 */
export function accountTitles(accounts) {
  const titles = new Map();
  const bySource = new Map();
  for (const row of accounts ?? []) bySource.set(row.harness, [...(bySource.get(row.harness) ?? []), row]);
  for (const group of bySource.values()) {
    const unnamed = group.filter((row) => !row.account).length;
    group.forEach((row, index) => {
      let label = row.account;
      const plan = row.subscription?.plan;
      if (label && plan && group.some((other) => other !== row && other.account === label)) label = `${label} · ${plan}`;
      if (!label && unnamed > 1) label = `Account ${index + 1}`;
      titles.set(row.id, label ? `${row.name} · ${label}` : row.name);
    });
  }
  return titles;
}

/** "Max 20x · since Jul 13 · renews about Oct 13", dates in UTC. A renewal
 * already past is left out: the plan renewed or lapsed, the report cannot say. */
export function subscriptionSummary(sub, now = Date.now()) {
  if (!sub?.plan) return "";
  const parts = [sub.plan];
  if (sub.startedAt && dayUTC(sub.startedAt)) parts.push(`since ${dayUTC(sub.startedAt)}`);
  if (sub.renewsAt && dayUTC(sub.renewsAt) && Date.parse(sub.renewsAt) > now) parts.push(`renews ${sub.renewsEstimated ? "about " : ""}${dayUTC(sub.renewsAt)}`);
  return parts.join(" · ");
}

/** "Mini, Workstation · updated 1m ago": where the card came from and how old it is, on one line. */
export function metaLine(row, now = Date.now()) {
  const parts = [];
  const names = [...new Set((row.computers ?? []).map((c) => c.name))];
  if (names.length) parts.push(names.join(", "));
  const updated = Date.parse(row.updatedAt ?? "");
  if (Number.isFinite(updated)) parts.push(`updated ${ageText(now - updated)} ago`);
  return parts.join(" · ");
}

/** "1,250.5 credits", "Unlimited", or "" when the account has no Codex credits. */
export function creditsValue(credits) {
  if (!credits?.hasCredits) return "";
  if (credits.unlimited) return "Unlimited";
  return typeof credits.balance === "number" ? credits.balance.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "Available";
}

/** The one-line answer the tooltip and popover header show. */
function usageSummary(view) {
  const accounts = view?.accounts ?? [];
  const computers = view?.computers ?? [];
  const parts = [`${accounts.length} account${accounts.length === 1 ? "" : "s"} across ${computers.length} computer${computers.length === 1 ? "" : "s"}.`];
  const out = accounts.filter(exhausted);
  if (out.length) parts.push(`Out of quota: ${out.map(title).join("; ")}.`);
  const stale = accounts.filter((row) => row.stale);
  if (stale.length) parts.push(`Stale: ${stale.map(title).join("; ")}.`);
  if (view?.unreachable?.length) parts.push(`Unreachable: ${view.unreachable.map((u) => u.computer).join(", ")}.`);
  return parts.join(" ");
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
  const text = windowText(w, now);
  const row = document.createElement("div");
  row.className = "usage-window";
  const label = document.createElement("span");
  label.className = "usage-window-name";
  label.textContent = w.name;
  const value = document.createElement("span");
  value.className = "usage-window-value";
  if (w.reset) value.classList.add("muted");
  if (w.limited || w.exhausted) value.classList.add("danger");
  value.textContent = text.value;
  const bar = document.createElement("span");
  bar.className = "usage-bar";
  const fill = document.createElement("span");
  fill.className = "usage-bar-fill";
  fill.style.width = `${text.used === null ? 0 : Math.max(0, Math.min(100, text.used))}%`;
  fill.style.background = w.limited || w.exhausted ? "var(--danger)" : tone(text.used);
  bar.append(fill);
  row.append(label, value, bar);
  if (text.caption) {
    const caption = document.createElement("span");
    caption.className = "usage-window-reset";
    if (w.limited || w.exhausted) caption.classList.add("danger");
    caption.textContent = text.caption;
    row.append(caption);
  }
  return row;
}

/** Codex credits: a line like a window's, without a bar, since a balance has no limit. */
function creditsLine(credits) {
  const row = document.createElement("div");
  row.className = "usage-window usage-credits";
  const label = document.createElement("span");
  label.className = "usage-window-name";
  label.textContent = "Credits";
  const value = document.createElement("span");
  value.className = "usage-window-value";
  value.textContent = creditsValue(credits);
  row.append(label, value);
  if (credits.inUse) {
    const caption = document.createElement("span");
    caption.className = "usage-window-reset";
    caption.textContent = "in use: a plan limit is spent";
    row.append(caption);
  }
  return row;
}

function line(className, text) {
  const node = document.createElement("div");
  node.className = className;
  node.textContent = text;
  return node;
}

function accountBlock(row, cardTitle, now) {
  const block = document.createElement("div");
  block.className = "usage-account";
  // Compact, as on the phone: the meta lines tight under the title, a small gap, then the bars.
  const head = document.createElement("div");
  head.className = "usage-account-head";
  head.append(line("usage-account-name", cardTitle));
  if (exhausted(row)) head.append(line("usage-account-meta danger", "Exhausted"));
  const plan = subscriptionSummary(row.subscription, now);
  if (plan) head.append(line("usage-account-meta", plan));
  // A window that reset since its report already says so on its own line.
  if (row.stale && row.age && !(row.windows ?? []).some((w) => w.reset)) head.append(line("usage-account-meta warn", `snapshot from ${row.age} ago`));
  const meta = metaLine(row, now);
  if (meta) head.append(line("usage-account-meta", meta));
  block.append(head);
  const windows = [...(row.windows ?? [])].sort(compareUsage);
  const showCredits = Boolean(creditsValue(row.credits));
  if (windows.length || showCredits) {
    const list = document.createElement("div");
    list.className = "usage-windows";
    for (const w of windows) list.append(windowLine(w, now));
    if (showCredits) list.append(creditsLine(row.credits));
    block.append(list);
  }
  if (row.spend) block.append(line("usage-account-note", `$${row.spend.amountUSD.toFixed(2)} ${row.spend.period.replace(/_/g, " ")}`));
  if (row.message) block.append(line("usage-account-note", row.message));
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
  pop.tabIndex = -1;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Account usage");
  el.append(pop);

  let snapshot = null;
  let timer = null;
  let returnFocus = null;
  let anchored = false;

  const closePopover = () => {
    if (pop.hidden) return;
    pop.hidden = true;
    el.classList.remove("usage-open");
    if (returnFocus?.isConnected) returnFocus.focus();
    else row.querySelector("button")?.focus();
    returnFocus = null;
    window.removeEventListener("resize", positionPopover);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onOutside, true);
  };

  const onKey = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopImmediatePropagation(); closePopover(); } };
  const onOutside = (ev) => { if (!el.contains(ev.target)) closePopover(); };

  function positionPopover() {
    const gutter = 16;
    const width = pop.getBoundingClientRect().width;
    const anchor = el.getBoundingClientRect();
    const titlebar = document.querySelector(".titlebar")?.getBoundingClientRect();
    const desired = anchored ? anchor.right - width : (window.innerWidth - width) / 2;
    pop.style.left = `${Math.max(gutter, Math.min(desired, window.innerWidth - width - gutter))}px`;
    const top = (anchored ? anchor.bottom : titlebar?.bottom ?? anchor.bottom) + 10;
    pop.style.top = `${top}px`;
    pop.style.setProperty("--usage-top", `${top}px`);
  }

  const openPopover = (anchor = null) => {
    anchored = Boolean(anchor);
    if (!pop.hidden) { positionPopover(); pop.focus(); return; }
    returnFocus = document.activeElement;
    renderPopover();
    el.classList.add("usage-open");
    pop.hidden = false;
    positionPopover();
    pop.focus();
    window.addEventListener("resize", positionPopover);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onOutside, true);
  };

  openOverview = openPopover;

  function renderPopover() {
    pop.replaceChildren();
    const header = document.createElement("div");
    header.className = "usage-pop-summary";
    header.textContent = usageSummary(snapshot);
    pop.append(header);
    const titles = accountTitles(snapshot?.accounts);
    if (!snapshot) pop.append(line("usage-pop-nodata", "Loading account usage…"));
    for (const account of sortUsageAccounts(snapshot?.accounts)) pop.append(accountBlock(account, titles.get(account.id) ?? title(account), Date.now()));
    for (const item of snapshot?.unreachable ?? []) pop.append(line("usage-pop-nodata", `${item.computer}: unreachable`));
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
    const titles = accountTitles(accounts);
    for (const account of accounts) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "usage-ring";
      const tight = limitingWindow(account);
      const used = usedPercent(tight);
      button.append(drawRing(used));
      if (account.stale) button.style.opacity = "0.4";
      const reset = tight?.resetsIn || Date.parse(tight?.resetsAt) > Date.now() ? resetLabel(tight) : "";
      button.title = `${titles.get(account.id) ?? title(account)} · ${used === null ? "no limit" : `${used}% used`}${reset ? `, ${reset}` : ""}`;
      button.addEventListener("click", (ev) => { ev.stopPropagation(); if (pop.hidden) openPopover(button); else closePopover(); });
      row.append(button);
    }
    if (!pop.hidden) { renderPopover(); positionPopover(); }
  }

  async function load() {
    try {
      const res = await fetch("/api/usage", { cache: "no-store" });
      if (res.ok) {
        snapshot = await res.json();
        latestUsage = snapshot;
        for (const fn of usageListeners) fn(snapshot);
      }
    } catch {
      // Keep the last drawing; the next poll retries.
    }
    render();
  }

  render();
  void load();
  timer = setInterval(load, POLL_MS);

  return { close() { if (openOverview === openPopover) openOverview = null; if (timer) clearInterval(timer); closePopover(); } };
}
