import { el } from "../../dom.js";
import { needsYou } from "../../shell/store.js";
import { approvals } from "../../shell/approvals.js";
import { sendReply } from "../../shell/needs-notify.js";
import { replySub } from "./rows.js";

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
    const rows = needsYou(state.merged);
    if (typingReply()) { needsDirty = true; return; }
    needsDirty = false;
    if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
    fill("needs", rows.map(needsRow), "Nothing needs you.");
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
