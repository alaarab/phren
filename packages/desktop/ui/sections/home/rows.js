import { el } from "../../dom.js";
import { projectOf, sessions } from "../../shell/store.js";
import { decorateHomeHandoff } from "../../shell/handoff-view.js";
import { stalledMinutes, stallLabel } from "../../shell/stalls.js";

/** A short age: "now", "5m", "3h", "2d". */
export function age(iso) {
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

/** The shared row shape: a title/sub column on the left, caller-added meta right. */
export function rowShell({ tone, sub, selected: on }) {
  const button = el("button", `home-row${tone ? ` tone-${tone}` : ""}${on ? " selected" : ""}`);
  const main = el("div", "home-row-main");
  const title = el("span", "home-row-title");
  main.append(title);
  if (sub) main.append(sub);
  button.append(main);
  return { button, title };
}

/** What the agent said last before it stopped (Hook `lastReply`, 0.3.45+). */
export function replySub(child) {
  return child?.lastReply ? el("span", "home-row-sub reply", child.lastReply) : undefined;
}

export function homeRows({ state, open, block }) {
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
    return decorateHomeHandoff(shell.button, row.computer, child, sessions(state.merged, { includeOffline: true }));
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
  return { sessionRow, fill };
}
