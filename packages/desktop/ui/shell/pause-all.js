// "Pause all agents": interrupts the turn of every working agent on every
// computer with one Escape each, the same stop the chat's stop button sends.
// Agents stay open and keep their conversations. It only runs from the inline
// confirm below, never from a control alone, and it reports per-session
// success or failure. Ported from the phone's AgentFleetPause.
import { hookPost } from "../api.js";
import { registerCommand } from "./palette.js";
import { store } from "./store.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The working rows in a session list, as pause targets. */
export function workingSessions(rows) {
  return rows.filter(({ child }) => child.agentStatus === "working" && child.target);
}

/** What one row is called in the confirm and the result: "Fix login on Desk". */
export function sessionLabel(row) {
  const { child, computer } = row;
  const project = (child.cwd ?? "").split("/").filter(Boolean).pop();
  const name = child.title || child.label || project || "session";
  return `${name} on ${computer}`;
}

/** "Pause N agents on M computers?", the confirm's one line. */
export function pausePrompt(sessions) {
  if (!sessions.length) return "No agents are working.";
  const computers = new Set(sessions.map((s) => s.computer)).size;
  const agents = sessions.length === 1 ? "1 agent" : `${sessions.length} agents`;
  const machines = computers === 1 ? "1 computer" : `${computers} computers`;
  return `Pause ${agents} on ${machines}?`;
}

/** One line for the outcome, in the phone's wording. */
export function pauseSummary(outcome) {
  const agents = outcome.paused === 1 ? "1 agent" : `${outcome.paused} agents`;
  if (!outcome.failed.length) return outcome.paused === 0 ? "No agent was working." : `Paused ${agents}.`;
  const missed = outcome.failed.length === 1 ? "1 couldn't be reached" : `${outcome.failed.length} couldn't be reached`;
  return `Paused ${agents}; ${missed}: ${outcome.failed.join(", ")}.`;
}

/** The live stop: Escape into the session's own target. */
export async function liveStop(row) {
  await hookPost(row.computer, "/v1/keys", { target: row.child.target, keys: ["Escape"] });
}

/** Stop each session, keeping a per-session result. `stop` is injectable for tests. */
export async function pauseSessions(sessions, stop = liveStop) {
  const outcome = { paused: 0, failed: [], results: [] };
  for (const row of sessions) {
    const label = sessionLabel(row);
    try {
      await stop(row);
      outcome.paused += 1;
      outcome.results.push({ label, ok: true });
    } catch (error) {
      outcome.failed.push(label);
      outcome.results.push({ label, ok: false, error: error?.message || "could not be reached" });
    }
  }
  return outcome;
}

// ------------------------------------------------------------ dialog
let overlay = null;
let escHandler = null;

export function closePauseDialog() {
  if (escHandler) { window.removeEventListener("keydown", escHandler); escHandler = null; }
  overlay?.remove();
  overlay = null;
}

/** Open the confirm (or the result) for pausing every working agent. */
export function pauseAllAgents() {
  closePauseDialog();
  const sessions = workingSessions(store.sessions());

  const backdrop = el("div", "pause-backdrop");
  const dialog = el("div", "pause-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Pause all agents");
  const title = el("div", "pause-title");
  const body = el("div", "pause-body");
  const actions = el("div", "pause-actions");
  dialog.append(title, body, actions);
  backdrop.append(dialog);
  document.body.append(backdrop);
  overlay = backdrop;
  backdrop.addEventListener("mousedown", (ev) => { if (ev.target === backdrop) closePauseDialog(); });
  escHandler = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); closePauseDialog(); } };
  window.addEventListener("keydown", escHandler);

  const done = button("OK", "accent");
  done.addEventListener("click", closePauseDialog);

  if (!sessions.length) {
    title.textContent = "No agents are working";
    body.append(el("div", "pause-line", "Nothing to pause on your computers right now."));
    actions.append(done);
    return;
  }

  title.textContent = "Pause all agents?";
  body.append(el("div", "pause-line", pausePrompt(sessions)));
  const list = el("div", "pause-list");
  for (const row of sessions) list.append(el("div", "pause-item", sessionLabel(row)));
  body.append(list);

  const cancel = button("Cancel");
  cancel.addEventListener("click", closePauseDialog);
  const confirm = button(sessions.length === 1 ? "Pause 1 agent" : `Pause ${sessions.length} agents`, "danger");
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    cancel.disabled = true;
    confirm.textContent = "Pausing…";
    const outcome = await pauseSessions(sessions);
    title.textContent = "Pause all agents";
    body.replaceChildren(el("div", "pause-line", pauseSummary(outcome)));
    const results = el("div", "pause-list");
    for (const result of outcome.results) {
      const line = el("div", `pause-result ${result.ok ? "ok" : "fail"}`);
      line.append(el("span", "pause-result-mark", result.ok ? "✓" : "✗"));
      line.append(el("span", "pause-result-label", result.label));
      if (!result.ok && result.error) line.append(el("span", "pause-result-error", result.error));
      results.append(line);
    }
    body.append(results);
    actions.replaceChildren(done);
  });
  actions.append(cancel, confirm);
}

function button(label, kind) {
  const b = el("button", kind ? `pause-btn ${kind}` : "pause-btn", label);
  b.type = "button";
  return b;
}

// ------------------------------------------------------------ palette
let registered = false;

/** Register the "Pause all agents" palette command once. */
export function registerPauseCommand() {
  if (registered) return;
  registered = true;
  registerCommand({ id: "agents.pauseAll", title: "Pause all agents", group: "Commands", run: () => pauseAllAgents() });
}
