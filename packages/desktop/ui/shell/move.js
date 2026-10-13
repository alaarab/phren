// "Continue in…": move a live session to another harness or Claude account in
// the same pane (Hook `POST /v1/sessions/move`, session-move.ts). The agent
// writes a hand-off and exits; the chosen one starts in the same folder with
// the hand-off as its first prompt. Uncommitted work stays in the checkout.
// The sheet follows the move (`GET /v1/sessions/move?id=`) until it lands.
import { hookGet, hookPost } from "../api.js";
import { registerCommand } from "./palette.js";
import { sectionHandle } from "./sections.js";

const HARNESSES = [["claude", "Claude"], ["codex", "Codex"], ["opencode", "OpenCode"], ["copilot", "Copilot"]];
const STATE_WORDS = { "handing-off": "Writing a hand-off…", exiting: "Ending the old agent…", launching: "Starting the new agent…", moved: "Moved", failed: "The move failed" };
const POLL_MS = 2000;
const GIVE_UP_MS = 15 * 60_000;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Which harnesses can take the session: installed and usable on that
 * computer (when the Hook says), never the one it already runs. */
export function moveChoices(inventory, current) {
  const known = Array.isArray(inventory) ? new Map(inventory.map((h) => [h.source, h])) : null;
  return HARNESSES.filter(([source]) => source !== current).map(([source, label]) => {
    const entry = known?.get(source);
    const usable = !known || (entry?.installed && entry?.usable);
    return { source, label, usable: Boolean(usable), reason: usable ? "" : entry?.reason || "Not installed" };
  });
}

/** The Claude accounts a move can continue on (other than the default). */
export function moveAccounts(inventory) {
  const claude = Array.isArray(inventory) ? inventory.find((h) => h.source === "claude") : null;
  return (claude?.accounts ?? []).filter((a) => a.usable && a.id !== "default");
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

export async function openMoveSheet({ computer, child }) {
  openSheet?.close();
  installStyles();
  const current = child.target?.source ?? child.agent;
  const state = { harness: "", account: "", inventory: null, busy: false, timer: null };

  const backdrop = el("div", "launch-backdrop");
  const sheet = el("div", "launch-sheet move-sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "Continue in another agent");
  const head = el("div", "launch-head");
  const closeBtn = el("button", "launch-close", "×");
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.style.marginLeft = "auto";
  head.append(el("h2", "launch-title", "Continue in another agent"), closeBtn);
  const body = el("div", "launch-body");
  body.append(el("div", "launch-note", `${child.title || child.label || "This session"} on ${computer}. It writes a hand-off and exits; the new agent starts in the same folder with that hand-off. Uncommitted changes stay where they are.`));
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

  const close = () => { clearTimeout(state.timer); backdrop.remove(); if (openSheet?.backdrop === backdrop) openSheet = null; };
  openSheet = { close, backdrop };
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop && !state.busy) close(); });
  backdrop.addEventListener("keydown", (e) => { if (e.key === "Escape" && !state.busy) close(); });

  function render() {
    const choices = moveChoices(state.inventory, current);
    if (!state.harness || !choices.some((c) => c.source === state.harness && c.usable)) state.harness = choices.find((c) => c.usable)?.source ?? "";
    harnessRow.replaceChildren(...choices.map((c) => {
      const b = el("button", `launch-seg${c.source === state.harness ? " selected" : ""}`, c.label);
      b.type = "button";
      b.disabled = !c.usable || state.busy;
      if (c.reason) b.title = c.reason;
      b.addEventListener("click", () => { state.harness = c.source; render(); });
      return b;
    }));
    const accounts = state.harness === "claude" ? moveAccounts(state.inventory) : [];
    accountField.hidden = accounts.length === 0;
    accountSelect.replaceChildren(...[["", "Default"], ...accounts.map((a) => [a.id, a.label || a.id])].map(([v, l]) => { const o = el("option", null, l); o.value = v; return o; }));
    accountSelect.value = accounts.some((a) => a.id === state.account) ? state.account : "";
    accountSelect.disabled = state.busy;
    go.disabled = !state.harness || state.busy;
  }
  accountSelect.addEventListener("change", () => { state.account = accountSelect.value; });

  async function follow(id, started) {
    let move = null;
    try { move = (await hookGet(computer, "/v1/sessions/move", { id })).move; } catch { /* keep asking */ }
    if (move) status.textContent = moveStatus(move);
    if (move?.state === "moved") { state.busy = false; render(); setTimeout(close, 1500); return; }
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
      const res = await hookPost(computer, "/v1/sessions/move", { target: child.target, to, id });
      status.textContent = moveStatus(res.move) || "Moving…";
      void follow(res.move?.id ?? id, Date.now());
    } catch (err) {
      state.busy = false;
      status.classList.add("launch-error");
      status.textContent = err?.status === 404 || err?.status === 503 ? "This computer's Hook cannot move sessions; update it first." : err?.message || "The move did not start.";
      render();
    }
  });

  render();
  go.focus();
  try { state.inventory = (await hookGet(computer, "/v1/harnesses")).harnesses ?? null; } catch { /* offer every harness */ }
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
