import { el } from "../../dom.js";
import { needsYou, projectOf, sessions } from "../../shell/store.js";
import { backgroundLabel, stalledMinutes } from "../../shell/stalls.js";
import { liveStop } from "../../shell/pause-all.js";

export function createWorking({ state, block, sessionRow }) {
  let keyed = new Map();

  function render() {
    const scope = block("working");
    const list = scope.querySelector(".home-list");
    const needKeys = new Set(needsYou(state.merged).map((r) => r.key));
    const live = sessions(state.merged);
    const rows = live.filter((r) => r.child.agentStatus === "working" && !needKeys.has(r.key));
    scope.querySelector(".count").textContent = rows.length ? String(rows.length) : "";
    const next = new Map();
    const nodes = rows.map((row) => {
      let entry = keyed.get(row.key);
      if (!entry) {
        const wrap = el("div", "home-working");
        const content = el("div", "home-working-content");
        const stop = el("button", "home-working-stop", "■");
        stop.type = "button";
        const error = el("span", "home-working-error");
        error.setAttribute("role", "status");
        error.hidden = true;
        wrap.append(content, stop, error);
        entry = { wrap, content, stop, error, row, timer: null, busyTimer: null, busy: false, disposed: false };
        const current = entry;
        current.releaseStop = () => {
          clearTimeout(current.busyTimer);
          current.busy = false;
          stop.setAttribute("aria-busy", "false");
          stop.setAttribute("aria-disabled", "false");
          stop.textContent = "■";
        };
        stop.addEventListener("click", async (event) => {
          event.stopPropagation();
          if (current.busy || current.disposed) return;
          clearTimeout(current.timer);
          error.hidden = true;
          error.textContent = "";
          current.busy = true;
          stop.setAttribute("aria-busy", "true");
          stop.setAttribute("aria-disabled", "true");
          stop.textContent = "…";
          // A fast keys response does not mean the harness has stopped yet.
          // Retain the guard through overview polls, with a bounded retry wait.
          current.busyTimer = setTimeout(current.releaseStop, 5000);
          try {
            await liveStop(current.row);
          } catch (failure) {
            if (current.disposed) return;
            error.textContent = failure?.message || "Could not stop this session.";
            error.hidden = false;
            current.timer = setTimeout(() => { error.hidden = true; error.textContent = ""; }, 4000);
          }
        });
      }
      entry.row = row;
      const title = row.child.title || row.child.label || projectOf(row.child) || "session";
      entry.stop.title = `Stop ${title}`;
      entry.stop.setAttribute("aria-label", `Stop ${title}`);
      // Stop stays mounted when activity or hand-off metadata changes.
      const sig = JSON.stringify([row.child, row.computer, live]);
      if (entry.sig !== sig) {
        const active = document.activeElement;
        const controls = [...entry.content.querySelectorAll("button")];
        const focusIndex = controls.indexOf(active);
        const activity = row.child.currentStep || row.child.activity || row.child.activityVerb || backgroundLabel(row.child);
        const sub = String(activity || "").trim() ? el("span", "home-row-sub activity", String(activity)) : undefined;
        entry.content.replaceChildren(sessionRow(row, { tone: stalledMinutes(row.child) !== null ? "stalled" : "working", sub }));
        if (focusIndex >= 0) entry.content.querySelectorAll("button")[focusIndex]?.focus();
        entry.sig = sig;
      }
      next.set(row.key, entry);
      return entry.wrap;
    });
    for (const [key, entry] of keyed) if (!next.has(key)) { entry.disposed = true; entry.releaseStop(); clearTimeout(entry.timer); }
    keyed = next;
    const active = document.activeElement;
    const keepFocus = nodes.some((node) => node.contains(active));
    const children = [...list.children];
    if (children.length !== nodes.length || nodes.some((node, i) => node !== children[i])) {
      list.replaceChildren(...nodes);
      if (keepFocus) active.focus();
    }
    if (!rows.length) list.replaceChildren(el("div", "home-empty", "No agent is working."));
  }

  return { render, destroy() { for (const entry of keyed.values()) { entry.disposed = true; entry.releaseStop(); clearTimeout(entry.timer); } keyed.clear(); } };
}
