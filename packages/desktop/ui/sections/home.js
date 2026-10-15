// Home: the cockpit. Top to bottom, the conductor card, who needs you (with
// keyboard answers), the turns that ended since you left, what is working (with each agent's activity line), the
// checks on those sessions' pull requests, recent returns from dispatched
// workers, and how every computer is doing.
import { hookGet, hookPost } from "../api.js";
import { needsYou, projectOf, sessions, store } from "../shell/store.js";
import { showSection } from "../shell/sections.js";
import { checksStrip, followChecks } from "../shell/ci-watch.js";
import { checksWord } from "../git-review.js";
import { approvals } from "../shell/approvals.js";
import { away } from "../shell/away.js";
import { hookDrift, hookVersion, updateCommand } from "../shell/hook-drift.js";
import { backgroundLabel, stallLabel, stalledMinutes } from "../shell/stalls.js";
import { runningLow } from "../shell/home-usage.js";
import { followUsage } from "../shell/usage-rings.js";
import { loadQuotaState, quotaSettings } from "../shell/quota-warn-prefs.js";
import { openQuotaSwitch } from "../shell/quota-warn-sheet.js";
import { quotaSessionKey } from "../shell/quota-warn.js";
import { sendReply } from "../shell/needs-notify.js";

// Receipts drive both the conductor's latest line and the recent-returns list.
const RETURN_POLL_MS = 30_000;
const MAX_RETURNS = 5;
const SEEN_KEY = "phren.desktop.home.seen";
const RUN_STATE = { finished: "done", "needs-you": "needs you", failed: "failed", blocked: "blocked", skipped: "skipped" };

// Returns and scheduled runs stay unread (an accent dot) until opened here.
function loadSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]")); } catch { return new Set(); }
}
function saveSeen(seen) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-1000))); } catch { /* private window */ }
}
const RETURN_STATE = { "done": "done", "needs-you": "needs you", "failed": "failed", "blocked": "blocked", "gone": "gone", "stalled": "stalled" };

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A short age: "now", "5m", "3h", "2d". */
function age(iso) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Elapsed since a row last changed, from its `lastChangedAt`. */
function elapsed(child) {
  const iso = child && child.lastChangedAt;
  return iso ? age(iso) : "";
}

function gb(bytes) {
  return `${(Number(bytes) / 1_073_741_824).toFixed(1)} GB`;
}

export function mountHome(root, { openSession, openPulls } = {}) {
  const open = typeof openSession === "function" ? openSession : () => {};
  const openPrs = typeof openPulls === "function" ? openPulls : open;
  root.innerHTML = `
    <div class="home">
      <section class="home-block" data-block="conductor">
        <div class="home-list" data-conductor></div>
      </section>
      <section class="home-block" data-block="needs">
        <h2 class="section-label">Needs you <span class="count"></span></h2>
        <p class="home-keys">Up/Down select &middot; <kbd>Enter</kbd> approve &middot; <kbd>P</kbd> allow for this project &middot; <kbd>D</kbd> deny &middot; <kbd>O</kbd> open</p>
        <div class="home-list"></div>
      </section>
      <section class="home-block" data-block="finished">
        <h2 class="section-label">Finished <span class="count"></span><span class="home-away-for"></span></h2>
        <button class="home-away-dismiss" type="button" hidden>Dismiss</button>
        <div class="home-list"></div>
      </section>
      <section class="home-block" data-block="low" hidden>
        <h2 class="section-label">Running low <span class="count"></span></h2>
        <div class="home-list"></div>
      </section>
      <section class="home-block" data-block="working">
        <h2 class="section-label">Working <span class="count"></span></h2>
        <div class="home-list"></div>
      </section>
      <section class="home-block" data-block="checks" hidden>
        <h2 class="section-label">Checks <span class="count"></span></h2>
        <div class="home-checks"></div>
      </section>
      <section class="home-block" data-block="computers">
        <h2 class="section-label">Computers <span class="count"></span></h2>
        <div class="home-list"></div>
      </section>
    </div>`;
  const block = (name) => root.querySelector(`[data-block="${name}"]`);

  let merged = null;
  let visible = false;
  let selected = 0;
  let pollTimer = null;
  const receipts = new Map(); // computer -> [{ receipt, computer }]
  const runs = new Map(); // computer -> finished scheduled runs
  const seen = loadSeen();
  // On the first launch everything already there counts as read.
  let seedSeen = (() => { try { return localStorage.getItem(SEEN_KEY) === null; } catch { return false; } })();

  /** The shared row shape: a title/sub column on the left, caller-added meta right. */
  function rowShell({ tone, sub, selected: on }) {
    const button = el("button", `home-row${tone ? ` tone-${tone}` : ""}${on ? " selected" : ""}`);
    const main = el("div", "home-row-main");
    const title = el("span", "home-row-title");
    main.append(title);
    if (sub) main.append(sub);
    button.append(main);
    return { button, title };
  }

  /** What the agent said last before it stopped (Hook `lastReply`, 0.3.45+). */
  function replySub(child) {
    return child?.lastReply ? el("span", "home-row-sub reply", child.lastReply) : undefined;
  }

  function needsSub(row) {
    const info = approvals.approval(row.key);
    if (info?.summary) return el("span", "home-row-sub", info.summary);
    return replySub(row.child);
  }

  function sessionRow(row, { tone, selected: on, sub }) {
    const shell = rowShell({ tone, sub, selected: on });
    const child = row.child;
    shell.title.textContent = child.title || child.label || projectOf(child);
    const metaEl = el("span", "home-row-meta");
    metaEl.append(el("span", "home-project", projectOf(child)), el("span", "home-host", row.computer));
    if (child.approvalPending || child.agentStatus === "blocked") metaEl.append(el("span", "home-why", child.approvalPending ? "Approval" : "Blocked"));
    const stalled = stalledMinutes(child);
    if (stalled !== null) metaEl.append(el("span", "home-stalled", stallLabel(stalled)));
    const age = elapsed(child);
    if (age) metaEl.append(el("span", "home-age", age));
    shell.button.append(metaEl);
    shell.button.addEventListener("click", () => open(row.computer, child));
    return shell.button;
  }

  function fill(name, rows, empty) {
    const scope = block(name);
    if (!scope) return;
    const count = scope.querySelector(".count");
    if (count) count.textContent = rows.length ? String(rows.length) : "";
    const list = scope.querySelector(".home-list");
    list.replaceChildren(...rows);
    if (!rows.length) list.append(el("div", "home-empty", empty));
  }

  // Reply boxes under rows that simply wait: drafts survive re-renders, and the
  // block does not redraw while one is focused (it redraws on blur).
  const drafts = new Map(); // row key -> text
  const replyNotes = new Map(); // row key -> { text, error } after a send
  let needsDirty = false;
  function typingReply() {
    return document.activeElement instanceof HTMLElement && !!document.activeElement.closest('[data-block="needs"] .home-reply');
  }

  function replyBox(row) {
    const form = el("form", "home-reply");
    const input = el("input", "home-reply-input");
    input.type = "text";
    input.placeholder = `Reply to ${row.child.title || row.child.label || "the agent"}…`;
    input.setAttribute("aria-label", `Reply to ${row.child.title || row.child.label || "the agent"}`);
    input.value = drafts.get(row.key) ?? "";
    input.addEventListener("input", () => { drafts.set(row.key, input.value); replyNotes.delete(row.key); });
    input.addEventListener("blur", () => { if (needsDirty) setTimeout(() => { if (!typingReply()) renderNeeds(); }, 0); });
    const shown = replyNotes.get(row.key);
    const note = el("span", `home-reply-note${shown?.error ? " error" : ""}`, shown?.text ?? "");
    form.append(input, note);
    const say = (text, error = false) => {
      replyNotes.set(row.key, { text, error });
      note.textContent = text;
      note.classList.toggle("error", error);
    };
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.readOnly = true;
      say("Sending…");
      const error = await sendReply(row.key, text);
      input.readOnly = false;
      if (error) { say(error, true); return; }
      drafts.delete(row.key);
      input.value = "";
      say("Sent");
    });
    return form;
  }

  function needsRow(row, index) {
    const button = sessionRow(row, { tone: "waiting", selected: index === selected, sub: needsSub(row) });
    const waiting = row.child.agentStatus === "waiting" && !row.child.approvalPending && row.child.target;
    if (!waiting) return button;
    const wrap = el("div", "home-reply-row");
    wrap.append(button, replyBox(row));
    return wrap;
  }

  function renderNeeds() {
    const rows = needsYou(merged);
    if (typingReply()) { needsDirty = true; return; }
    needsDirty = false;
    if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
    fill("needs", rows.map(needsRow), "Nothing needs you.");
    block("needs").querySelector(".home-keys").hidden = !rows.length;
  }

  let usage = null;
  let stopUsage = null;
  let quotaReady = false;
  function renderLow() {
    const scope = block("low");
    const rows = quotaReady ? runningLow(merged, usage, quotaSettings()) : [];
    const focused = scope.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.dataset.key;
    const focusAction = focused?.dataset.action;
    scope.hidden = !rows.length;
    fill("low", rows.map((row) => {
      const wrap = el("div", "home-row home-low");
      const chat = el("button", "home-low-chat home-row-main");
      chat.type = "button";
      chat.dataset.key = row.key;
      chat.dataset.action = "open";
      chat.append(el("span", "home-row-title", row.child.title || row.child.label || projectOf(row.child)),
        el("span", "home-row-sub", [row.account.name || row.account.harness, row.child.account?.label || row.account.account || row.child.account?.id, row.computer].filter(Boolean).join(" · ")),
        el("span", "home-low-usage", row.text));
      chat.addEventListener("click", () => open(row.computer, row.child));
      const change = el("button", "home-btn ghost", "Switch");
      change.type = "button";
      change.dataset.key = row.key;
      change.dataset.action = "switch";
      change.setAttribute("aria-label", `Switch ${row.child.title || row.child.label || "chat"}`);
      change.addEventListener("click", async () => {
        change.disabled = true;
        try {
          let inventory;
          try { inventory = (await hookGet(row.computer, "/v1/harnesses")).harnesses; } catch { /* allow choosing manually */ }
          const live = store.find(row.computer, row.child.id);
          if (!live || quotaSessionKey(live) !== quotaSessionKey(row) || !(merged?.computers ?? []).some((c) => c.computer === row.computer && c.state === "online")) return;
          change.disabled = false;
          await openQuotaSwitch(live, inventory, usage?.accounts, { returnFocus: () => {
            // Overview updates can replace the invoking row while the sheet is open.
            [...scope.querySelectorAll("button")].find((button) => button.dataset.key === row.key && button.dataset.action === "switch")?.focus();
          } });
        } catch (error) {
          wrap.append(el("span", "home-row-sub", `Could not switch: ${error?.message || error}`));
        } finally { change.disabled = false; }
      });
      wrap.append(chat, change);
      return wrap;
    }), "");
    if (focusKey) {
      const next = [...scope.querySelectorAll("button")].find((button) => button.dataset.key === focusKey && button.dataset.action === focusAction);
      (next ?? root.querySelector("button"))?.focus();
    }
  }

  function renderWorking() {
    const needKeys = new Set(needsYou(merged).map((r) => r.key));
    const rows = sessions(merged).filter((r) => r.child.agentStatus === "working" && !needKeys.has(r.key));
    fill("working", rows.map((row) => {
      // The overview's current step is the agent's activity verb ("Editing server.ts").
      // A turn that ended with work still running says so instead.
      const activity = row.child.currentStep || row.child.activity || row.child.activityVerb || backgroundLabel(row.child);
      const sub = activity ? el("span", "home-row-sub activity", String(activity)) : undefined;
      return sessionRow(row, { tone: stalledMinutes(row.child) !== null ? "stalled" : "working", sub });
    }), "No agent is working.");
  }

  // ---- since you left -------------------------------------------------

  const NOW_WORD = { working: "working again", waiting: "waiting", blocked: "blocked" };
  // One "Finished" block (pitch): what ended while you were away first (turns
  // and checks, until dismissed), then worker returns and scheduled runs.
  let awayRows = [];
  let returnRows = [];
  let returnTotal = 0;
  function renderFinished() {
    const scope = block("finished");
    const summary = away.current();
    scope.querySelector(".home-away-for").textContent = summary ? ` · away ${age(new Date(summary.since).toISOString())}` : "";
    scope.querySelector(".home-away-dismiss").hidden = !summary;
    fill("finished", [...awayRows, ...returnRows], "Nothing finished yet.");
    scope.querySelector(".count").textContent = awayRows.length + returnTotal ? String(awayRows.length + returnTotal) : "";
    if (returnTotal > MAX_RETURNS) {
      const more = el("button", "home-more", `All ${returnTotal} returns in Review`);
      more.addEventListener("click", () => showSection("review"));
      scope.querySelector(".home-list").append(more);
    }
  }

  function renderAway() {
    const summary = away.current();
    if (!summary) { awayRows = []; renderFinished(); return; }
    const checkRows = (summary.checks ?? []).map((pull) => {
      const failed = pull.checks === "failing";
      const shell = rowShell({ tone: failed ? "failed" : "done" });
      shell.title.textContent = `${pull.ref}${pull.number} ${pull.title}`;
      const meta = el("span", "home-row-meta");
      meta.append(el("span", "home-project", pull.project), el("span", "home-host", pull.computer),
        el("span", failed ? "home-failed" : "home-passed", failed ? "checks failed" : "checks passed"),
        el("span", "home-age", age(new Date(pull.at).toISOString())));
      shell.button.append(meta);
      shell.button.addEventListener("click", () => openPrs(pull.computer, store.find(pull.computer, pull.child.id)?.child ?? pull.child));
      return shell.button;
    });
    awayRows = [...checkRows, ...summary.rows.map((entry) => {
      // The row as it is now, when the session is still there.
      const live = store.find(entry.computer, entry.child.id);
      const child = live?.child ?? entry.child;
      const shell = rowShell({ tone: "done", sub: replySub(child) });
      shell.title.textContent = child.title || child.label || projectOf(child);
      const meta = el("span", "home-row-meta");
      meta.append(el("span", "home-project", projectOf(child)), el("span", "home-host", entry.computer));
      const now = !live ? "closed" : child.approvalPending ? "approval" : NOW_WORD[child.agentStatus];
      if (now) meta.append(el("span", "home-why", now));
      meta.append(el("span", "home-age", `done ${age(new Date(entry.at).toISOString())}`));
      shell.button.append(meta);
      shell.button.disabled = !live;
      shell.button.addEventListener("click", () => { if (live) open(entry.computer, live.child); });
      return shell.button;
    })];
    renderFinished();
  }
  block("finished").querySelector(".home-away-dismiss").addEventListener("click", () => away.dismiss());
  const unsubscribeAway = away.subscribe(renderAway);

  // ---- recent returns -------------------------------------------------

  // The open requests the CI watch saw on working and recent sessions.
  let pulls = null;
  let stopChecks = null;
  function renderChecks() {
    const scope = block("checks");
    const list = checksStrip(pulls ?? []);
    scope.hidden = !list.length;
    scope.querySelector(".count").textContent = list.length ? String(list.length) : "";
    scope.querySelector(".home-checks").replaceChildren(...list.map((pull) => {
      const chip = el("button", `home-check ${pull.checks || "none"}`);
      chip.title = `${checksWord(pull.checks) || "No checks"} · ${pull.ref}${pull.number} ${pull.title} · ${pull.computer}`;
      chip.append(el("span", "home-check-dot"), el("span", "home-check-ref", `${pull.ref}${pull.number}`),
        el("span", "home-check-title", pull.title), el("span", "home-project", pull.project));
      chip.addEventListener("click", () => openPrs(pull.computer, store.find(pull.computer, pull.child.id)?.child ?? pull.child));
      return chip;
    }));
  }
  function followPulls() {
    stopChecks ??= followChecks((look) => { pulls = look; renderChecks(); });
  }
  function unfollowPulls() {
    stopChecks?.();
    stopChecks = null;
  }

  function overviewChild(target) {
    if (!target) return null;
    for (const row of sessions(merged, { includeOffline: true })) {
      const t = row.child.target;
      if (t && t.server === target.server && t.workspace === target.workspace && t.tab === target.tab
        && t.pane === target.pane && t.source === target.source && t.session === target.session) return row;
    }
    return null;
  }

  /** A finished scheduled run: an inbox line like a worker's return. */
  function runRow(entry) {
    const { run, schedule } = entry;
    const state = String(run.status);
    const chip = state === "failed" ? "failed" : state === "finished" ? "done" : state === "skipped" ? "gone" : "needs";
    const shell = rowShell({ tone: chip === "needs" ? "waiting" : undefined, sub: run.reason ? el("span", "home-row-sub", String(run.reason).slice(0, 160)) : undefined });
    shell.title.textContent = schedule.name || "Scheduled prompt";
    const meta = el("span", "home-row-meta");
    if (!seen.has(entry.id)) meta.append(el("span", "home-unread"));
    meta.append(el("span", "home-tag", "Scheduled"));
    meta.append(el("span", `home-chip ${chip}`, RUN_STATE[state] ?? state));
    if (run.project) meta.append(el("span", "home-project", run.project));
    meta.append(el("span", "home-host", entry.computer));
    meta.append(el("span", "home-age", age(entry.at)));
    shell.button.append(meta);
    const launch = run.launch ?? {};
    const match = sessions(merged, { includeOffline: true }).find((row) => row.computer === entry.computer && launch.paneId
      && row.child.target?.pane === launch.paneId && (!launch.server || row.child.target?.server === launch.server));
    shell.button.addEventListener("click", () => {
      markSeen(entry.id);
      if (match) open(match.computer, match.child); else showSection("schedules");
    });
    return shell.button;
  }

  function markSeen(id) {
    if (seen.has(id)) return;
    seen.add(id);
    saveSeen(seen);
    renderReturns();
  }

  function returnRow(entry) {
    const r = entry.receipt;
    const state = String(r.returned.state);
    const chip = state === "failed" ? "failed" : state === "done" ? "done" : state === "gone" ? "gone" : "needs";
    const tone = chip === "needs" ? "waiting" : undefined;
    const excerpt = (r.returned.reply || r.returned.question || r.returned.error || "").split("\n").find((line) => line.trim());
    const sub = excerpt ? el("span", "home-row-sub", excerpt.trim().slice(0, 160)) : undefined;
    const shell = rowShell({ tone, sub });
    shell.title.textContent = r.label || r.project || "Worker";
    const meta = el("span", "home-row-meta");
    const id = `return:${r.id}:${r.returned.at}`;
    if (!seen.has(id)) meta.append(el("span", "home-unread"));
    meta.append(el("span", `home-chip ${chip}`, RETURN_STATE[state] ?? state));
    if (r.project) meta.append(el("span", "home-project", r.project));
    meta.append(el("span", "home-host", entry.computer));
    meta.append(el("span", "home-age", age(r.returned.at)));
    shell.button.append(meta);
    const match = overviewChild(r.target);
    // A return whose session has closed opens in Review, which keeps its report.
    shell.button.addEventListener("click", () => {
      markSeen(id);
      if (match) open(match.computer, match.child); else showSection("review");
    });
    return shell.button;
  }

  function renderReturns() {
    const rows = [];
    for (const list of receipts.values()) for (const entry of list) if (entry.receipt?.returned) rows.push({ kind: "return", at: String(entry.receipt.returned.at), entry });
    for (const list of runs.values()) for (const entry of list) rows.push({ kind: "run", at: entry.at, entry });
    rows.sort((a, b) => b.at.localeCompare(a.at));
    returnRows = rows.slice(0, MAX_RETURNS).map((row) => row.kind === "run" ? runRow(row.entry) : returnRow(row.entry));
    returnTotal = rows.length;
    renderFinished();
  }

  // ---- computers ------------------------------------------------------

  /** The Hook's version, and when it is older than the newest seen, a chip that copies its update command. */
  function hookMeta(c, drift) {
    const version = hookVersion(c);
    if (!version) return [];
    const behind = drift.behind.has(c.computer);
    const label = el("span", `home-hook${behind ? " behind" : ""}`, `Hook ${version}`);
    if (!behind) return [label];
    const command = updateCommand(drift.newest);
    const chip = el("button", "home-hook-update", `update to ${drift.newest}`);
    chip.type = "button";
    chip.title = `Copy: ${command}`;
    chip.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(command); chip.textContent = "command copied"; }
      catch { chip.textContent = command; }
    });
    return [label, chip];
  }

  function computerRow(c, drift) {
    const row = el("div", `home-row home-computer state-${c.state}`);
    row.append(el("span", "home-computer-name", c.computer));
    const meta = el("span", "home-computer-meta");
    meta.append(...hookMeta(c, drift));
    const r = c.resources && typeof c.resources === "object" ? c.resources : null;
    if (c.state === "online") meta.append(el("span", null, "Online"));
    else {
      meta.append(el("span", "home-error", c.error ? `${c.state}: ${c.error}` : c.state));
    }
    if (r) {
      const jobs = Array.isArray(r.heavy) ? r.heavy.length : 0;
      meta.append(el("span", "home-age", jobs ? `${jobs} heavy` : "no heavy jobs"));
      if (r.disk) meta.append(el("span", "home-age", `${gb(r.disk.freeBytes)} free`));
    } else if (c.state === "online") meta.append(el("span", "home-age", "no resources"));
    row.append(meta);
    const load = el("div", "home-load");
    const bar = el("div", "home-load-bar");
    const fillEl = el("span", "home-load-fill");
    const cores = r?.cpu?.cores ? Number(r.cpu.cores) : 0;
    const load1 = r?.cpu?.load1 !== undefined ? Number(r.cpu.load1) : 0;
    const fraction = cores > 0 ? Math.min(1, Math.max(0, load1 / cores)) : 0;
    fillEl.style.width = `${Math.round(fraction * 100)}%`;
    if (r?.level === "stressed") fillEl.classList.add("stressed");
    else if (r?.level === "busy") fillEl.classList.add("busy");
    bar.append(fillEl);
    load.append(bar);
    if (r && cores > 0) load.append(el("span", "home-load-text", `load ${load1.toFixed(1)} / ${cores} cores`));
    row.append(load);
    return row;
  }

  function renderComputers() {
    const computers = merged?.computers ?? [];
    const drift = hookDrift(computers);
    fill("computers", computers.map((c) => computerRow(c, drift)), "No computers linked.");
  }

  // ---- conductor ------------------------------------------------------

  function latestLine(computer) {
    const list = receipts.get(computer) ?? [];
    let best = null;
    for (const entry of list) {
      const r = entry.receipt;
      const at = r.returned?.at || r.updatedAt || r.createdAt;
      if (!at) continue;
      if (!best || at > best.at) best = { at, receipt: r };
    }
    if (!best) return "";
    const r = best.receipt;
    if (r.returned) return `Returned: ${r.label} ${RETURN_STATE[r.returned.state] ?? r.returned.state}`;
    if (r.worker?.state) return `${r.label}: ${r.worker.state}`;
    return `Dispatched ${r.label}`;
  }

  let conductorSig = "";

  function renderConductor() {
    const found = sessions(merged).find((row) => row.child.role === "conductor");
    const online = (merged?.computers ?? []).map((c) => c.computer).join(",");
    const sig = found
      ? `run:${found.computer}:${found.child.id}:${found.child.agentStatus}:${latestLine(found.computer)}`
      : `none:${online}`;
    if (sig === conductorSig) return;
    conductorSig = sig;
    const host = root.querySelector("[data-conductor]");

    if (found) {
      const card = el("div", "home-conductor");
      const head = el("div", "home-conductor-head");
      head.append(el("span", "home-conductor-title", "Conductor"));
      // The session's own title ("Agent status") is the harness's, not the role.
      const named = found.child.title || found.child.label;
      if (named && named !== "Conductor") head.append(el("span", "home-conductor-session", named));
      const meta = el("span", "home-conductor-meta");
      const live = found.child.agentStatus === "working" ? "working" : found.child.agentStatus === "blocked" || found.child.approvalPending ? "waiting" : found.child.agentStatus || "idle";
      meta.append(el("span", "home-host", found.computer), el("span", `home-conductor-state ${live === "waiting" ? "waiting" : ""}`, live));
      head.append(meta);
      card.append(head);
      const line = latestLine(found.computer);
      card.append(el("div", `home-conductor-line${line ? "" : " muted"}`, line || "No dispatches yet."));
      const actions = el("div", "home-conductor-actions");
      const openBtn = el("button", "home-btn ghost", "Open");
      openBtn.addEventListener("click", () => open(found.computer, found.child));
      actions.append(openBtn);
      card.append(actions);
      host.replaceChildren(card);
      return;
    }

    const card = el("div", "home-conductor");
    const head = el("div", "home-conductor-head");
    head.append(el("span", "home-conductor-title", "Start a conductor"));
    card.append(head);
    const computers = merged?.computers ?? [];
    const field = el("div", "home-field");
    field.append(el("span", "home-field-label", "On"));
    const select = el("select", "home-select");
    for (const c of computers) {
      const option = el("option", null, c.state === "online" ? c.computer : `${c.computer} (${c.state})`);
      option.value = c.computer;
      option.disabled = c.state !== "online";
      select.append(option);
    }
    const onlineFirst = computers.find((c) => c.state === "online");
    if (onlineFirst) select.value = onlineFirst.computer;
    const start = el("button", "home-btn", "Start");
    start.disabled = !onlineFirst;
    const note = el("span", "home-start-note");
    start.addEventListener("click", () => { void startConductor(select.value, start, note); });
    field.append(select, start, note);
    card.append(field);
    host.replaceChildren(card);
  }

  async function startConductor(computer, button, note) {
    if (!computer) return;
    button.disabled = true;
    note.textContent = `Starting on ${computer}\u2026`;
    try {
      await hookPost(computer, "/v1/workspaces/launch", { role: "conductor", kind: "codex", label: "Conductor" });
      note.textContent = `Conductor starting on ${computer}.`;
    } catch (err) {
      note.textContent = err?.status === 409 ? "A conductor is already running." : `Could not start: ${err?.message || err}`;
    } finally {
      button.disabled = false;
    }
  }

  // ---- receipts polling ----------------------------------------------

  async function pollReceipts() {
    const online = (merged?.computers ?? []).filter((c) => c.state === "online");
    const answers = await Promise.all(online.map(async (c) => {
      try {
        const body = await hookGet(c.computer, "/v1/dispatch");
        const list = Array.isArray(body.dispatches) ? body.dispatches : [];
        return [c.computer, list.map((receipt) => ({ receipt, computer: receipt.computer || c.computer }))];
      } catch {
        return [c.computer, []];
      }
    }));
    receipts.clear();
    for (const [computer, list] of answers) receipts.set(computer, list);
    if (!visible) return;
    // Finished runs of the schedules each computer owns.
    const scheduled = await Promise.all(online.map(async (c) => {
      try {
        const body = await hookPost(c.computer, "/v1/schedules", {});
        const out = [];
        for (const schedule of Array.isArray(body.schedules) ? body.schedules : []) {
          if (schedule.owned === false) continue;
          for (const run of Array.isArray(schedule.lastRuns) ? schedule.lastRuns : []) {
            if (run.status === "launched" || run.status === "running") continue;
            out.push({ id: `run:${run.id}`, at: String(run.finishedAt ?? run.startedAt ?? ""), run, schedule, computer: c.computer });
          }
        }
        return [c.computer, out];
      } catch {
        return [c.computer, []];
      }
    }));
    runs.clear();
    for (const [computer, list] of scheduled) runs.set(computer, list);
    if (seedSeen && online.length) {
      seedSeen = false;
      for (const list of receipts.values()) for (const e of list) if (e.receipt?.returned) seen.add(`return:${e.receipt.id}:${e.receipt.returned.at}`);
      for (const list of runs.values()) for (const e of list) seen.add(e.id);
      saveSeen(seen);
    }
    renderReturns();
    renderConductor();
  }

  function startPolling() {
    if (pollTimer !== null) return;
    polledFor = (merged?.computers ?? []).filter((c) => c.state === "online").map((c) => c.computer).sort().join("\n");
    void pollReceipts();
    pollTimer = setInterval(() => { void pollReceipts(); }, RETURN_POLL_MS);
  }

  function stopPolling() {
    if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ---- render and keys -----------------------------------------------

  function render() {
    renderConductor();
    renderNeeds();
    renderAway();
    renderLow();
    renderWorking();
    renderChecks();
    renderReturns();
    renderComputers();
  }

  function onKeydown(event) {
    if (!visible || document.querySelector('.launch-backdrop, [role="dialog"]:not([hidden]), dialog[open]')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // Only when nothing else has focus, or focus is inside Home: Enter on another
    // control (a section pill, a sidebar row) must do that control's job, never approve.
    const active = document.activeElement;
    const free = !active || active === document.body || active === document.documentElement;
    if (!free && !root.contains(active)) return;
    const tag = (active?.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || active?.isContentEditable) return;
    // A focused button or link inside Home keeps Enter for itself.
    if (event.key === "Enter" && !free && (tag === "BUTTON" || tag === "A")) return;
    const rows = needsYou(merged);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!rows.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      selected = Math.max(0, Math.min(rows.length - 1, selected + step));
      renderNeeds();
      event.preventDefault();
      return;
    }
    const row = rows[selected];
    if (!row) return;
    const has = !!approvals.approval(row.key);
    if (event.key === "Enter" && has) { void approvals.answerKey(row.key, "approve"); event.preventDefault(); }
    else if (event.key.toLowerCase() === "p" && has) { void approvals.answerKey(row.key, "approve", "project"); event.preventDefault(); }
    else if (event.key.toLowerCase() === "d" && has) { void approvals.answerKey(row.key, "deny"); event.preventDefault(); }
    else if (event.key.toLowerCase() === "o") { open(row.computer, row.child); event.preventDefault(); }
  }

  // Poll when online computers change while visible; show() reads on every visit.
  let polledFor = "";
  const unsubscribe = store.subscribe((value) => {
    merged = value;
    render();
    const online = (value?.computers ?? []).filter((c) => c.state === "online").map((c) => c.computer).sort().join("\n");
    if (visible && online && online !== polledFor) { polledFor = online; void pollReceipts(); }
  });
  const unsubscribeApprovals = approvals.subscribe(renderNeeds);

  return {
    show() {
      if (visible) return;
      visible = true;
      startPolling();
      followPulls();
      stopUsage = followUsage((snapshot) => { usage = snapshot; renderLow(); });
      void loadQuotaState().then(() => { quotaReady = true; if (visible) renderLow(); }).catch((error) => console.warn("Home usage preferences:", error));
      document.addEventListener("keydown", onKeydown);
    },
    hide() {
      visible = false;
      stopPolling();
      unfollowPulls();
      stopUsage?.();
      stopUsage = null;
      document.removeEventListener("keydown", onKeydown);
    },
    destroy() {
      visible = false;
      stopPolling();
      unfollowPulls();
      stopUsage?.();
      stopUsage = null;
      unsubscribe();
      unsubscribeAway();
      unsubscribeApprovals();
      document.removeEventListener("keydown", onKeydown);
    },
  };
}

