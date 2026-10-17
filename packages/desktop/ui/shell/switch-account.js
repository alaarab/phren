import { el } from "../dom.js";
import { hookGet, hookPost } from "../api.js";
import { activeWindow, exhausted, leftPercent, limitingWindow, resetLabel, windowNames } from "./usage-windows.js";
import { followUsage } from "./usage-rings.js";
import { openMoveSheet } from "./move.js";
import { registerCommand } from "./palette.js";
import { sectionHandle } from "./sections.js";
import { store } from "./store.js";
// "Switch account": the same Claude conversation under another Claude account
// on its own computer (Hook `POST /v1/sessions/move` with `continuation:
// "resume"`, capabilities.moveResume). Nothing is asked of the current agent,
// so it works when that account is out of usage. Other harnesses and other
// computers stay behind "Continue in…" (shell/move.js), linked from the sheet.

const POLL_MS = 2000;
const GIVE_UP_MS = 5 * 60_000;
const STATE_WORDS = { exiting: "Ending the current agent…", launching: "Resuming under the new account…", moved: "Switched", failed: "The switch failed" };

/** The usage row for one Claude account on this computer, as quota-warn.js matches it. */
function accountUsage(computer, account, accounts) {
  const matches = (accounts ?? []).filter((row) => row.harness === "claude" && row.computers?.some((c) => c.name === computer && (c.account ?? "default") === account));
  return matches.length === 1 && !matches[0].stale ? matches[0] : null;
}

/** The command that signs a Claude account slot in on its computer. */
export function loginCommand(account) {
  return account === "default" ? "claude /login" : `CLAUDE_CONFIG_DIR=~/.claude-${account} claude /login`;
}

/**
 * One row per Claude account on the chat's computer (`GET /v1/harnesses`),
 * the chat's own first: signed-in accounts with room can be picked, exhausted
 * ones are disabled with their reset time, and a slot that is not signed in
 * offers the /login step instead.
 */
export function switchAccountRows(session, inventory, usage, now = Date.now()) {
  const claude = Array.isArray(inventory) ? inventory.find((h) => h.source === "claude") : null;
  const current = session.child.account?.id ?? "default";
  return (claude?.accounts ?? []).map((account) => {
    const row = accountUsage(session.computer, account.id, usage);
    const limiting = limitingWindow(row, now);
    const left = leftPercent(limiting);
    const out = exhausted(row && { ...row, windows: row.windows?.filter((w) => activeWindow(w, now)) });
    const isCurrent = account.id === current;
    const reason = isCurrent ? "This chat's account"
      : !account.signedIn ? "Not signed in"
      : out ? "Out of usage"
      : !account.usable ? account.reason || "Not available" : "";
    const room = out ? "Out of usage" : left === null ? "Usage unknown" : `${Math.round(left)}% left${limiting ? ` of ${windowNames[limiting.id] || limiting.name || "limit"}` : ""}`;
    const reset = out ? (Date.parse(limiting?.resetsAt) > now ? resetLabel(limiting, now, { clock: true }) : row?.availableIn ? `back in ${row.availableIn}` : "") : "";
    const detail = !account.signedIn ? "Not signed in" : [room, reset].filter(Boolean).join(" · ");
    return { id: account.id, label: account.label || account.id, current: isCurrent, signedIn: account.signedIn === true, exhausted: out, left, reason, detail,
      login: account.signedIn ? "" : loginCommand(account.id) };
  }).sort((a, b) => Number(b.current) - Number(a.current) || Number(Boolean(a.reason)) - Number(Boolean(b.reason)) || (b.left ?? -1) - (a.left ?? -1) || a.label.localeCompare(b.label));
}

/** What the sheet says for a move record. */
export function switchStatus(move) {
  if (!move) return "";
  if (move.state === "failed") return move.error ? `The switch failed: ${move.error}` : STATE_WORDS.failed;
  return STATE_WORDS[move.state] ?? move.state;
}

let openSheet = null;

function installStyles() {
  if (document.getElementById("launch-styles")) return;
  const link = document.createElement("link");
  link.id = "launch-styles";
  link.rel = "stylesheet";
  link.href = new URL("launch.css", import.meta.url).href;
  document.head.append(link);
}

/** The sheet for a Claude chat; any other chat goes straight to "Continue in…". */
export async function openSwitchAccountSheet({ computer, child, returnFocus }) {
  const source = child.target?.source ?? child.agent;
  if (source !== "claude") return openMoveSheet({ computer, child, returnFocus });
  openSheet?.close();
  if (openSheet) return;
  returnFocus ??= document.activeElement;
  installStyles();
  const state = { busy: false, timer: null, rows: [], inventory: null, usage: null, resume: false };

  const backdrop = el("div", "launch-backdrop");
  const sheet = el("div", "launch-sheet switch-account-sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "Switch account");
  sheet.tabIndex = -1;
  const head = el("div", "launch-head");
  const closeBtn = el("button", "launch-close", "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.style.marginLeft = "auto";
  head.append(el("h2", "launch-title", "Switch account"), closeBtn);
  const body = el("div", "launch-body");
  body.append(el("div", "launch-note", `${child.title || child.label || "This chat"} on ${computer}. The same conversation continues under the account you pick. Nothing is asked of the current one, so this works when it is out of usage.`));
  const rows = el("div", "launch-computers");
  rows.append(el("div", "launch-note", "Loading accounts…"));
  const status = el("div", "launch-status");
  status.setAttribute("role", "status");
  const other = el("button", "launch-btn switch-account-other", "Other agents and computers…");
  other.type = "button";
  body.append(rows, status);
  const foot = el("div", "launch-foot");
  foot.append(other);
  sheet.append(head, body, foot);
  backdrop.append(sheet);
  document.body.append(backdrop);

  const controls = () => [...sheet.querySelectorAll("button:not(:disabled)")].filter((c) => !c.closest("[hidden]"));
  const focusFirst = () => (controls()[0] ?? sheet).focus();
  const keepFocus = () => { if (!sheet.contains(document.activeElement)) focusFirst(); };
  const onKey = (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (!["ArrowDown", "ArrowUp", "Tab"].includes(event.key)) return;
    const list = controls();
    const index = list.indexOf(document.activeElement);
    if (event.key === "Tab" && !(index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === list.length - 1)) return;
    event.preventDefault();
    const step = event.key === "ArrowUp" || event.key === "Tab" && event.shiftKey ? -1 : 1;
    list[(index + step + list.length) % list.length]?.focus();
  };
  let stopUsage = () => {};
  function close() {
    if (openSheet?.backdrop !== backdrop) return;
    clearTimeout(state.timer);
    stopUsage();
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("focusin", keepFocus);
    backdrop.remove();
    openSheet = null;
    if (returnFocus?.isConnected) returnFocus.focus();
  }
  openSheet = { close, backdrop };
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop && !state.busy) close(); });
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("focusin", keepFocus);
  other.addEventListener("click", () => { if (state.busy) return; close(); void openMoveSheet({ computer, child, returnFocus }); });

  function render() {
    if (!state.inventory) return;
    const hadFocus = sheet.contains(document.activeElement);
    state.rows = switchAccountRows({ computer, child }, state.inventory, state.usage?.accounts);
    if (!state.rows.length) { rows.replaceChildren(el("div", "launch-note", `No Claude accounts on ${computer}.`)); return; }
    rows.replaceChildren(...state.rows.map((row) => {
      const label = row.current ? `${row.label} · current` : row.label;
      const button = el("button", `launch-computer switch-account-row${row.current ? " selected" : ""}`);
      button.type = "button";
      const main = el("span", "launch-computer-main");
      main.append(el("span", "launch-computer-name", label), el("span", "launch-computer-sub", row.detail));
      button.append(main);
      button.setAttribute("aria-label", `${label} · ${row.detail}`);
      button.title = row.reason && !row.current ? `${row.reason}${row.login ? `: run ${row.login} on ${computer}` : ""}` : `${label} · ${row.detail}`;
      button.disabled = state.busy || !!row.reason;
      button.dataset.account = row.id;
      button.addEventListener("click", () => void switchTo(row));
      if (!row.login) return button;
      // A slot that is not signed in: the /login step, one click to copy.
      const wrap = el("div", "switch-account-login");
      const copy = el("button", "move-copy-command", row.login);
      copy.type = "button";
      copy.title = "Copy command";
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(row.login); copy.title = "Copied"; } catch { copy.title = "Select the command to copy it"; }
      });
      const hint = el("div", "switch-account-hint", `Sign it in on ${computer}, then switch: `);
      hint.append(copy);
      wrap.append(button, hint);
      return wrap;
    }));
    other.disabled = state.busy;
    if (hadFocus && (!sheet.contains(document.activeElement) || document.activeElement.disabled)) focusFirst();
  }

  async function follow(id, started) {
    if (openSheet?.backdrop !== backdrop) return;
    let move;
    try { move = (await hookGet(computer, "/v1/sessions/move", { id })).move; } catch { /* keep asking */ }
    if (openSheet?.backdrop !== backdrop) return;
    if (move) status.textContent = switchStatus(move);
    if (move?.state === "moved") { state.busy = false; render(); setTimeout(close, 1500); return; }
    if (move?.state === "failed") { status.classList.add("launch-error"); state.busy = false; render(); return; }
    if (Date.now() - started > GIVE_UP_MS) { status.textContent = "Still switching; check the chat in a moment."; state.busy = false; render(); return; }
    state.timer = setTimeout(() => void follow(id, started), POLL_MS);
  }

  async function switchTo(row) {
    if (state.busy || row.reason || !state.resume) return;
    state.busy = true;
    status.className = "launch-status";
    status.textContent = "Ending the current agent…";
    render();
    const id = crypto.randomUUID();
    try {
      const res = await hookPost(computer, "/v1/sessions/move", { target: child.target, to: { harness: "claude", account: row.id }, continuation: "resume", id });
      status.textContent = switchStatus(res.move) || "Switching…";
      void follow(res.move?.id ?? id, Date.now());
    } catch (err) {
      state.busy = false;
      status.classList.add("launch-error");
      status.textContent = err?.message || "The switch did not start.";
      render();
    }
  }

  focusFirst();
  const [inventory, caps] = await Promise.all([hookGet(computer, "/v1/harnesses").catch(() => null), store.capabilities(computer).catch(() => ({}))]);
  if (openSheet?.backdrop !== backdrop) return;
  state.resume = caps.moveResume === true;
  if (!state.resume) {
    rows.replaceChildren(el("div", "launch-note", `${computer}'s Hook can't switch accounts without a hand-off yet. Update it, or continue in another agent with a hand-off.`));
    focusFirst();
    return;
  }
  if (!inventory?.harnesses) { rows.replaceChildren(el("div", "launch-error", "Could not read this computer's accounts.")); return; }
  state.inventory = inventory.harnesses;
  stopUsage = followUsage((usage) => { state.usage = usage; render(); });
  render();
  focusFirst();
}

// ⌘K: the same sheet for the Claude chat open in Agents.
const openClaudeSession = () => {
  const session = sectionHandle("agents")?.currentSession?.();
  return session?.child?.target?.source === "claude" ? session : null;
};
registerCommand({
  id: "switch-account",
  title: "Switch account…",
  meta: () => openClaudeSession()?.child.title || "This Claude chat on another Claude account",
  when: () => !!openClaudeSession(),
  run: () => { const session = openClaudeSession(); if (session) void openSwitchAccountSheet({ computer: session.computer, child: session.child }); },
});
