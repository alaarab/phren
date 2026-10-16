import { el } from "../../dom.js";
import { needsYou, sessions, projectOf } from "../../shell/store.js";
import { snoozes, snoozable, snoozeChoices } from "../../shell/snooze.js";
import { approvals } from "../../shell/approvals.js";
import { sendReply } from "../../shell/needs-notify.js";
import { replySub } from "./rows.js";

/** "3:15 PM" today, "Fri 9:00 AM" later. */
export function wakeLabel(until, now = Date.now()) {
  const at = new Date(until);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return at.toDateString() === new Date(now).toDateString() ? time : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

export function createNeeds({ root, state, open, block, sessionRow, fill, isVisible }) {
  let selected = 0;
  function needsSub(row) {
    const info = approvals.approval(row.key);
    if (info?.summary) return el("span", "home-row-sub", info.summary);
    return replySub(row.child);
  }

  // Reply boxes under rows that simply wait: drafts survive re-renders, and the
  // block does not redraw while one is focused (it redraws on blur).
  const drafts = new Map(); // row key -> text
  const replyNotes = new Map(); // row key -> { text, error } after a send
  let needsDirty = false;
  function typingReply() {
    return document.activeElement instanceof HTMLElement && !!document.activeElement.closest('[data-block="needs"] .home-reply');
  }

  /** A small menu on a waiting row: 15 minutes, 1 hour, until tomorrow 9:00. */
  function snoozeMenu(row) {
    const wrap = el("span", "home-snooze");
    const trigger = el("button", "home-snooze-btn", "Snooze");
    trigger.type = "button";
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-label", `Snooze ${row.child.title || row.child.label || "this chat"}`);
    const menu = el("div", "home-snooze-menu");
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    const items = [];
    for (const choice of snoozeChoices()) {
      const item = el("button", "home-snooze-item", choice.label);
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.dataset.snooze = choice.id;
      // The wake time is taken when chosen, not when the row was drawn.
      item.addEventListener("click", () => {
        const picked = snoozeChoices().find((c) => c.id === choice.id);
        close(false);
        item.blur(); // a focused control inside the row would hold back the redraw
        snoozes.snooze(row, picked.until);
      });
      items.push(item);
    }
    menu.append(...items);
    function close(refocus = true) {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", outside, true);
      if (refocus) trigger.focus();
    }
    function outside(event) { if (!wrap.contains(event.target)) close(false); }
    function openMenu() {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", outside, true);
      items[0].focus();
    }
    trigger.addEventListener("click", () => (menu.hidden ? openMenu() : close()));
    wrap.addEventListener("keydown", (event) => {
      if (menu.hidden) {
        if (event.target === trigger && event.key === "ArrowDown") { openMenu(); event.stopPropagation(); event.preventDefault(); }
        return;
      }
      // While the menu is open its keys belong to it, not to Home's row shortcuts.
      event.stopPropagation();
      const at = items.indexOf(document.activeElement);
      if (event.key === "ArrowDown") items[(at + 1) % items.length].focus();
      else if (event.key === "ArrowUp") items[(at - 1 + items.length) % items.length].focus();
      else if (event.key === "Home") items[0].focus();
      else if (event.key === "End") items[items.length - 1].focus();
      else if (event.key === "Escape") close();
      else if (event.key === "Tab") { close(false); return; }
      else return;
      event.preventDefault();
    });
    wrap.append(trigger, menu);
    return wrap;
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
    if (snoozable(row.child)) form.append(snoozeMenu(row));
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

  /** "Snoozed (N)": collapsed under the list, each with when it wakes and Wake now. */
  function renderSnoozed() {
    const footer = block("needs").querySelector(".home-snoozed");
    if (!footer) return;
    const rows = snoozes.snoozed(sessions(state.merged).filter(({ child }) => snoozable(child)));
    footer.hidden = !rows.length;
    footer.querySelector(".home-snoozed-label").textContent = `Snoozed (${rows.length})`;
    footer.querySelector(".home-snoozed-list").replaceChildren(...rows.map((row) => {
      const line = el("div", "home-snoozed-row");
      const name = row.child.title || row.child.label || projectOf(row.child);
      const text = el("span", "home-snoozed-text");
      text.append(el("span", "home-snoozed-title", name), el("span", "home-snoozed-until", `${projectOf(row.child)} · until ${wakeLabel(row.until)}`));
      const wake = el("button", "home-snoozed-wake", "Wake now");
      wake.type = "button";
      wake.setAttribute("aria-label", `Wake ${name} now`);
      wake.addEventListener("click", () => snoozes.wake(row.key));
      line.append(text, wake);
      return line;
    }));
  }

  function renderNeeds() {
    const rows = needsYou(state.merged);
    if (typingReply()) { needsDirty = true; return; }
    needsDirty = false;
    if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
    fill("needs", rows.map(needsRow), "Nothing needs you.");
    renderSnoozed();
    block("needs").querySelector(".home-keys").hidden = !rows.length;
  }

  function onKeydown(event) {
    if (!isVisible() || document.querySelector('.launch-backdrop, [role="dialog"]:not([hidden]), dialog[open]')) return;
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
    const rows = needsYou(state.merged);
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
  return { render: renderNeeds, onKeydown };
}
