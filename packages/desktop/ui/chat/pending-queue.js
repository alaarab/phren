import { el } from "../dom.js";
import { hookPost } from "../api.js";
import { store } from "../shell/store.js";

const TITLES = { queued: "Waiting for this turn to end", sending: "Sending", unknown: "May have been sent", failed: "Not sent" };
export function createPendingQueue({ computer, target, sendNow, editDraft, onItems = () => {} }) {
  const root = el("div", "pc-held-queue"); root.hidden = true;
  root.setAttribute("aria-label", "Pending messages");
  const error = el("div", "pc-queue-error"); error.setAttribute("role", "status");
  const list = el("div", "pc-held-list");
  root.append(list, error);
  let capabilities = {}, items = [], agentMessages = [], revision = 0, busy = false, destroyed = false, reading = false, timer;
  const withdrawn = new Set();
  // Keep the queue's controls in render order for focus restoration. Rebuilding
  // an empty strip needs neither DOM containment nor selector queries.
  let controls = [];
  const hasFocus = () => controls.includes(document.activeElement);
  const restoreFocus = () => controls.find(control => !control.disabled)?.focus();
  let editID = null, editText = "", signature = "";
  const capable = () => capabilities.afterTurnQueue === true;
  const agentCapable = () => (capabilities.queuedMessageActions || []).includes(target.source);
  const post = (action, fields = {}) => hookPost(computer, `/v1/prompt/after-turn${action ? `/${action}` : ""}`, { target, ...fields });
  async function refresh() {
    if (destroyed || !capable() || busy || reading) return;
    reading = true;
    const token = ++revision;
    try {
      const result = await post("list");
      if (destroyed || token !== revision) return;
      items = result.items || []; onItems(items); draw();
    } catch (err) { if (!destroyed && token === revision) { error.textContent = err.message; draw(); } }
    finally { reading = false; }
  }
  async function mutate(action) {
    if (busy || destroyed) return;
    const returnFocus = hasFocus();
    busy = true; ++revision; error.textContent = ""; draw();
    try { await action(); }
    catch (err) { if (!destroyed) error.textContent = err.message; }
    finally { busy = false; if (!destroyed) { signature = ""; draw(); if (returnFocus && document.activeElement === document.body) restoreFocus(); await refresh(); } }
  }
  function button(label, action) {
    const button = el("button", "pc-queue-action", label); button.type = "button"; button.disabled = busy;
    controls.push(button);
    button.addEventListener("click", () => void mutate(action)); return button;
  }
  function draw() {
    if (destroyed) return;
    const visible = items.filter(item => !["delivered", "cancelled"].includes(item.state));
    const next = JSON.stringify([visible, agentMessages, busy, editID]);
    root.hidden = !visible.length && !agentMessages.length && !error.textContent;
    if (next === signature) return;
    const hadFocus = hasFocus();
    signature = next; controls = []; list.replaceChildren();
    for (const item of visible) {
      const row = el("div", "pc-held-row");
      row.append(el("div", "pc-held-text", item.text), el("div", "pc-held-state", TITLES[item.state] || item.state));
      if (item.detail || item.reason) row.append(el("div", "pc-held-state", item.detail || item.reason));
      if (item.state === "unknown") row.append(el("div", "pc-held-state", "Check the conversation; it will not be sent again automatically."));
      if (item.state === "queued") {
        if (editID === item.id) {
          const input = el("textarea", "pc-queue-edit"); input.value = editText; input.setAttribute("aria-label", "Edit queued message");
          input.disabled = busy; controls.push(input);
          input.addEventListener("input", () => { editText = input.value; });
          row.append(input, button("Save", async () => { await post("edit", { id: item.id, text: editText }); editID = null; }), button("Keep original", async () => { editID = null; }));
        } else row.append(button("Send now", async () => {
          // Only a confirmed cancellation grants an ordinary send. An unknown
          // cancellation never risks delivering the same words twice.
          const reply = await post("cancel", { id: item.id });
          if (reply.item?.state !== "cancelled") throw new Error("The computer did not confirm cancellation. Check the queue before sending.");
          await sendNow(item.text);
        }), button("Edit", async () => { editID = item.id; editText = item.text; }), button("Cancel", () => post("cancel", { id: item.id })));
      }
      list.append(row);
    }
    if (agentMessages.length) {
      const row = el("div", "pc-held-row");
      row.append(el("div", "pc-held-text", agentMessages.map(m => m.text).join("\n\n")), el("div", "pc-held-state", "Queued in the agent"));
      if (agentCapable()) for (const action of ["Send now", "Edit", "Cancel"]) {
        const count = agentMessages.length;
        const label = count > 1 ? action === "Send now" ? `Send all ${count} now` : `${action} all ${count}` : action;
        row.append(button(label, async () => {
          const affected = agentMessages.slice();
          const reply = await hookPost(computer, "/v1/prompt/queue", { target, action: action === "Send now" ? "send-now" : "withdraw" });
          if (action === "Edit") editDraft((reply.messages || []).join("\n\n"));
          for (const message of affected) withdrawn.add(message.id);
          agentMessages = agentMessages.filter(message => !withdrawn.has(message.id));
        }));
      }
      list.append(row);
    }
    if (hadFocus) restoreFocus();
  }
  async function loadCapabilities() {
    capabilities = await store.capabilities(computer);
    if (destroyed) return;
    draw(); await refresh();
    if (!destroyed && !timer) timer = setInterval(() => { if (root.isConnected && root.parentElement?.getClientRects().length && !document.hidden) void refresh(); }, 3000);
  }
  void loadCapabilities();
  return {
    el: root, capable,
    async enqueue(id, text) {
      if (!capable()) throw new Error(`Needs a newer Phren on ${computer}`);
      const token = ++revision;
      try {
        const reply = await post("", { id, text });
        if (!destroyed && token === revision) { items = [...items.filter(item => item.id !== id), reply.item]; signature = ""; draw(); }
        return reply.item;
      } finally { void refresh(); }
    },
    reconcile(messages) { agentMessages = messages.filter(message => message.isQueued && message.role === "user" && !withdrawn.has(message.id)); draw(); },
    destroy() { destroyed = true; ++revision; clearInterval(timer); root.remove(); },
  };
}
