import { el } from "../dom.js";
import { movePlan } from "./handoff.js";
import { openHandoffChat } from "./handoff-view.js";
import { store } from "./store.js";
// "Continue in…": move a live session to another harness or Claude account in
// a pane or a new chat (Hook `POST /v1/sessions/move`, session-move.ts). The agent
// writes a hand-off; the chosen one starts in the same folder with
// the hand-off as its first prompt. Uncommitted work stays in the checkout.
// The sheet follows the move (`GET /v1/sessions/move?id=`) until it lands.
import { hookGet, hookPost } from "../api.js";
import { registerCommand } from "./palette.js";
import { sectionHandle } from "./sections.js";

const HARNESSES = [["claude", "Claude"], ["codex", "Codex"], ["opencode", "OpenCode"], ["copilot", "Copilot"]];
const STATE_WORDS = { "handing-off": "Writing a hand-off…", exiting: "Ending the old agent…", launching: "Starting the new agent…", moved: "Moved", failed: "The move failed" };
const POLL_MS = 2000;
const GIVE_UP_MS = 15 * 60_000;

/** Which harnesses can take the session: installed and usable on that
 * computer (when the Hook says), including Claude on another account. */
export function moveChoices(inventory, current, currentAccount) {
  const known = Array.isArray(inventory) ? new Map(inventory.map((h) => [h.source, h])) : null;
  return HARNESSES.filter(([source]) => (source !== current || source === "claude" && currentAccount && moveAccounts(inventory, { includeDefault: true }).some((a) => a.id !== currentAccount))).map(([source, label]) => {
    const entry = known?.get(source);
    const usable = !known || (entry?.installed && entry?.usable);
    return { source, label, usable: Boolean(usable), reason: usable ? "" : entry?.reason || "Not installed" };
  });
}

/** Usable Claude accounts; includeDefault enables returning to the default home. */
export function moveAccounts(inventory, { includeDefault = false } = {}) {
  const claude = Array.isArray(inventory) ? inventory.find((h) => h.source === "claude") : null;
  return (claude?.accounts ?? []).filter((a) => a.usable && (includeDefault || a.id !== "default"));
}

/** What the sheet says for a move record. */
export function moveStatus(move) {
  if (!move) return "";
  if (move.state === "failed") return move.error ? `The move failed: ${move.error}` : STATE_WORDS.failed;
  if (move.state === "moved" && move.handoff?.source === "fallback") return "Moved (Phren wrote the hand-off from the transcript)";
  return STATE_WORDS[move.state] ?? move.state;
}

let openSheet = null;

/** The sheet borrows the launch sheet's styles (launch.css, added once by either). */
function installStyles() {
  if (document.getElementById("launch-styles")) return;
  const link = document.createElement("link");
  link.id = "launch-styles";
  link.rel = "stylesheet";
  link.href = new URL("launch.css", import.meta.url).href;
  document.head.append(link);
}

export async function openMoveSheet({ computer, child, to = {}, notice = "", selectDefault = true, returnFocus }) {
  openSheet?.close();
  returnFocus ??= document.activeElement;
  installStyles();
  const current = child.target?.source ?? child.agent;
  const state = { harness: to.harness ?? "", account: to.account ?? "", inventory: null, moveNewChat: false, mode: undefined, busy: false, timer: null };

  const backdrop = el("div", "launch-backdrop");
  const sheet = el("div", "launch-sheet move-sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.tabIndex = -1;
  sheet.setAttribute("aria-label", "Continue in another agent");
  const head = el("div", "launch-head");
  const closeBtn = el("button", "launch-close", "×");
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.style.marginLeft = "auto";
  head.append(el("h2", "launch-title", "Continue in another agent"), closeBtn);
  const body = el("div", "launch-body");
  body.append(el("div", "launch-note", `${child.title || child.label || "This session"} on ${computer}. The agent writes a hand-off; work continues in the same folder. Uncommitted changes stay where they are.`));
  const outcome = el("div", "launch-hint");
  body.append(outcome);
  if (notice) body.append(el("div", "launch-note", notice));
  const harnessRow = el("div", "launch-segments");
  const harnessField = el("div", "launch-field");
  harnessField.append(el("span", "launch-label", "Continue in"), harnessRow);
  const accountSelect = el("select", "launch-select");
  accountSelect.setAttribute("aria-label", "Claude account");
  const accountField = el("div", "launch-field");
  accountField.append(el("span", "launch-label", "Account"), accountSelect);
  accountField.hidden = true;
  const status = el("div", "launch-status");
  status.setAttribute("role", "status");
  const go = el("button", "launch-btn accent", "Continue");
  go.type = "button";
  body.append(harnessField, accountField, status);
  const foot = el("div", "launch-foot");
  foot.append(go);
  sheet.append(head, body, foot);
  backdrop.append(sheet);
  document.body.append(backdrop);

  const controls = () => [...sheet.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    .filter((control) => !control.closest("[hidden], [inert]"));
  const focusFirst = () => (controls()[0] ?? sheet).focus();
  const keepFocus = () => { if (!sheet.contains(document.activeElement)) focusFirst(); };
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      const list = controls();
      const index = list.indexOf(document.activeElement);
      if (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === list.length - 1) {
        event.preventDefault();
        (event.shiftKey ? list.at(-1) ?? sheet : list[0] ?? sheet).focus();
      }
    }
  };
  const close = () => {
    if (openSheet?.backdrop !== backdrop) return;
    clearTimeout(state.timer);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("focusin", keepFocus);
    backdrop.remove();
    openSheet = null;
    if (typeof returnFocus === "function") returnFocus();
    else if (returnFocus?.isConnected) returnFocus.focus();
  };
  openSheet = { close, backdrop };
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop && !state.busy) close(); });
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("focusin", keepFocus);

  function render() {
    const hadFocus = sheet.contains(document.activeElement);
    const choices = moveChoices(state.inventory, current, child.account?.id);
    if (!choices.some((c) => c.source === state.harness && c.usable)) state.harness = selectDefault ? choices.find((c) => c.usable)?.source ?? "" : "";
    harnessRow.replaceChildren(...choices.map((c) => {
      const b = el("button", `launch-seg${c.source === state.harness ? " selected" : ""}`, c.label);
      b.type = "button";
      b.disabled = !c.usable || state.busy;
      if (c.reason) b.title = c.reason;
      b.addEventListener("click", () => { state.harness = c.source; render(); });
      return b;
    }));
    const accounts = state.harness === "claude" ? moveAccounts(state.inventory, { includeDefault: true }).filter((a) => current !== "claude" || a.id !== child.account?.id) : [];
    accountField.hidden = accounts.length === 0;
    const accountOptions = accounts.length ? accounts.map((a) => [a.id, a.label || a.id]) : [["", "Default"]];
    accountSelect.replaceChildren(...accountOptions.map(([v, l]) => { const o = el("option", null, l); o.value = v; return o; }));
    if (state.harness === "claude" && !accounts.some((a) => a.id === state.account)) state.account = accounts.find((a) => a.id === "default")?.id ?? accounts[0]?.id ?? "";
    accountSelect.value = accounts.some((a) => a.id === state.account) ? state.account : "";
    accountSelect.disabled = state.busy;
    const accountLabel = accounts.find((a) => a.id === state.account)?.label;
    outcome.textContent = movePlan(current, { harness: state.harness, account: state.account, accountLabel }, state.moveNewChat).label;
    go.disabled = !state.harness || state.busy;
    if (hadFocus && (!sheet.contains(document.activeElement) || document.activeElement.disabled || document.activeElement.closest("[hidden], [inert]"))) focusFirst();
  }
  accountSelect.addEventListener("change", () => { state.account = accountSelect.value; render(); });

  async function follow(id, started) {
    if (openSheet?.backdrop !== backdrop) return;
    let move = null;
    try { move = (await hookGet(computer, "/v1/sessions/move", { id })).move; } catch { /* keep asking */ }
    if (openSheet?.backdrop !== backdrop) return;
    if (move) status.textContent = moveStatus(move);
    if (move?.state === "moved") {
      if (state.mode !== "new-chat" || move.target && openHandoffChat(computer, move.target)) {
        state.busy = false; render(); setTimeout(close, 1500); return;
      }
      status.textContent = "Hand-off ready; waiting for the new chat to appear…";
    }
    if (move?.state === "failed") { status.classList.add("launch-error"); state.busy = false; render(); return; }
    if (Date.now() - started > GIVE_UP_MS) { status.textContent = "Still moving; check the session in a moment."; state.busy = false; render(); return; }
    state.timer = setTimeout(() => void follow(id, started), POLL_MS);
  }

  go.addEventListener("click", async () => {
    if (!state.harness || state.busy) return;
    state.busy = true;
    status.className = "launch-status";
    status.textContent = "Asking the agent for a hand-off…";
    render();
    const id = crypto.randomUUID();
    const to = { harness: state.harness, ...(state.harness === "claude" && state.account ? { account: state.account } : {}) };
    try {
      const caps = await store.capabilities(computer);
      state.mode = movePlan(current, to, caps.moveNewChat).mode;
      const res = await hookPost(computer, "/v1/sessions/move", { target: child.target, to, id, ...(state.mode ? { mode: state.mode } : {}) });
      status.textContent = moveStatus(res.move) || "Moving…";
      void follow(res.move?.id ?? id, Date.now());
    } catch (err) {
      state.busy = false;
      status.classList.add("launch-error");
      status.textContent = err?.status === 404 || err?.status === 503 ? "This computer's Hook cannot move sessions; update it first." : err?.message || "The move did not start.";
      render();
    }
  });

  go.disabled = true;
  focusFirst();
  const [inventory, caps] = await Promise.all([
    hookGet(computer, "/v1/harnesses").catch(() => null),
    store.capabilities(computer),
  ]);
  state.inventory = inventory?.harnesses ?? null;
  state.moveNewChat = caps.moveNewChat === true;
  if (openSheet?.backdrop === backdrop) render();
}

// ⌘K: the same sheet for the session open in Agents.
const openSession = () => {
  const session = sectionHandle("agents")?.currentSession?.();
  return session?.child?.target ? session : null;
};
registerCommand({
  id: "continue-in",
  title: "Continue this session in\u2026",
  meta: () => openSession()?.child.title || "Another harness or account",
  when: () => !!openSession(),
  run: () => { const session = openSession(); if (session) void openMoveSheet({ computer: session.computer, child: session.child }); },
});
