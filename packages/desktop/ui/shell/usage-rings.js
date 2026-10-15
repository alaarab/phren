// The titlebar usage rings. The daemon's /api/usage has already merged every
// computer's account reports; this draws one small ring per account (filled by
// its tightest window) and opens a popover listing every account and window,
// laid out like the phone's Account usage cards. The helper semantics mirror
// @phren/cli/client/account-usage, reimplemented here because the browser
// imports nothing from the CLI.

let openOverview = null;
/** Open the titlebar's shared overview, including when there are no rings. */
export function openUsage() { openOverview?.(); }

/** Exhausted accounts first, then the highest active window percent; unknown last. */
export function sortUsageAccounts(accounts) {
  const constraint = (row) => {
    const windows = (row.windows ?? []).filter((w) => !w.reset);
    const exhausted = row.exhausted || windows.some((w) => w.exhausted || w.limited || w.usedPercent >= 100 || w.leftPercent === 0);
    const used = windows.map((w) => typeof w.usedPercent === "number" ? w.usedPercent : typeof w.leftPercent === "number" ? 100 - w.leftPercent : -1);
    return [exhausted ? 1 : 0, Math.max(-1, ...used)];
  };
  return [...(accounts ?? [])].sort((a, b) => {
    const x = constraint(a), y = constraint(b);
    return y[0] - x[0] || y[1] - x[1];
  });
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

const resetsIn = (iso, now = Date.now()) => {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const minutes = Math.round(ms / 60_000);
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
/** "Oct 7": a credit's expiry in local time. */
const dayLocal = (iso) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : "";
};
const dollars = (value) => `$${value.toFixed(2)}`;
const isCredit = (w) => typeof w.id === "string" && w.id.startsWith("credit:");

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

/**
 * What one window says: the value on the right ("23%", "$3.10 of $10.00",
 * "reset") and the caption under its bar. An API credit's date is its expiry;
 * a 5-hour window with no reset time has not started.
 */
export function windowText(w, now = Date.now()) {
  const used = typeof w.usedPercent === "number" ? w.usedPercent : typeof w.leftPercent === "number" ? 100 - w.leftPercent : null;
  const credit = isCredit(w);
  const value = (credit || used === null) && w.usedUSD !== undefined
    ? `${dollars(w.usedUSD)}${w.limitUSD !== undefined ? ` of ${dollars(w.limitUSD)}` : ""}`
    : w.reset ? "reset" : used !== null ? `${Math.round(used * 10) / 10}%` : "unknown";
  let when = "";
  if (credit) {
    if (w.resetsAt && dayLocal(w.resetsAt)) when = `${Date.parse(w.resetsAt) > now ? "expires" : "expired"} ${dayLocal(w.resetsAt)}`;
  } else if (!w.reset) {
    const until = w.resetsIn || (w.resetsAt ? resetsIn(w.resetsAt, now) : "");
    when = until ? `resets in ${until}` : w.id === "five_hour" && !w.resetsAt ? "not started" : "";
  }
  const caption = [w.exhausted ? "Exhausted" : w.limited ? "Limit reached" : "", when || (!w.reset ? "reset time unknown" : "")].filter(Boolean).join(" · ");
  return { value, caption, used };
}

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

function windowConstraint(w) {
  if (w.reset) return [0, -1];
  const used = typeof w.usedPercent === "number" ? w.usedPercent : typeof w.leftPercent === "number" ? 100 - w.leftPercent : -1;
  return [w.exhausted || w.limited || used >= 100 ? 1 : 0, used];
}

function accountBlock(row, cardTitle, now) {
  const block = document.createElement("div");
  block.className = "usage-account";
  // Compact, as on the phone: the meta lines tight under the title, a small gap, then the bars.
  const head = document.createElement("div");
  head.className = "usage-account-head";
  head.append(line("usage-account-name", cardTitle));
  if (row.exhausted) head.append(line("usage-account-meta danger", "Exhausted"));
  const plan = subscriptionSummary(row.subscription, now);
  if (plan) head.append(line("usage-account-meta", plan));
  // A window that reset since its report already says so on its own line.
  if (row.stale && row.age && !(row.windows ?? []).some((w) => w.reset)) head.append(line("usage-account-meta warn", `snapshot from ${row.age} ago`));
  const meta = metaLine(row, now);
  if (meta) head.append(line("usage-account-meta", meta));
  block.append(head);
  const windows = [...(row.windows ?? [])].sort((a, b) => {
    const x = windowConstraint(a), y = windowConstraint(b);
    return y[0] - x[0] || y[1] - x[1];
  });
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

  const closePopover = () => {
    if (pop.hidden) return;
    pop.hidden = true;
    el.classList.remove("usage-open");
    if (returnFocus?.isConnected) returnFocus.focus();
    else row.querySelector("button")?.focus();
    returnFocus = null;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onOutside, true);
  };

  const onKey = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopImmediatePropagation(); closePopover(); } };
  const onOutside = (ev) => { if (!el.contains(ev.target)) closePopover(); };

  const openPopover = () => {
    if (!pop.hidden) { pop.focus(); return; }
    returnFocus = document.activeElement;
    renderPopover();
    el.classList.add("usage-open");
    pop.hidden = false;
    pop.focus();
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
      const tight = tightest(account);
      const used = tight ? tight.used : null;
      button.append(drawRing(used));
      if (account.stale) button.style.opacity = "0.4";
      const reset = tight?.resetsIn || (tight?.resetsAt ? resetsIn(tight.resetsAt) : "");
      button.title = `${titles.get(account.id) ?? title(account)} · ${used === null ? "no limit" : `${used}% used`}${reset ? `, resets in ${reset}` : ""}`;
      button.addEventListener("click", (ev) => { ev.stopPropagation(); if (pop.hidden) openPopover(); else closePopover(); });
      row.append(button);
    }
    if (!pop.hidden) renderPopover();
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
