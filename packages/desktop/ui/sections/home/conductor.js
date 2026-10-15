import { el } from "../../dom.js";
import { sessions } from "../../shell/store.js";
import { hookPost } from "../../api.js";
import { RETURN_STATE } from "./finished.js";

export function createConductor({ root, state, receipts, open }) {
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
    const found = sessions(state.merged).find((row) => row.child.role === "conductor");
    const online = (state.merged?.computers ?? []).map((c) => c.computer).join(",");
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
    const computers = state.merged?.computers ?? [];
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
  return renderConductor;
}
