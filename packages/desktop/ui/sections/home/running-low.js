import { el } from "../../dom.js";
import { projectOf, store } from "../../shell/store.js";
import { hookGet } from "../../api.js";
import { runningLow } from "../../shell/home-usage.js";
import { quotaSettings } from "../../shell/quota-warn-prefs.js";
import { openQuotaSwitch } from "../../shell/quota-warn-sheet.js";
import { quotaSessionKey } from "../../shell/quota-warn.js";

export function createRunningLow({ root, state, open, block, fill }) {
  let usage = null;
  let quotaReady = false;
  function renderLow() {
    const scope = block("low");
    const rows = quotaReady ? runningLow(state.merged, usage, quotaSettings()) : [];
    const focused = scope.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.dataset.key;
    const focusAction = focused?.dataset.action;
    scope.hidden = !rows.length;
    fill("low", rows.map((row) => {
      const wrap = el("div", "home-row home-low");
      const chat = el("button", "home-low-chat home-row-main");
      chat.type = "button";
      chat.dataset.key = row.key;
      chat.dataset.action = "open";
      chat.append(el("span", "home-row-title", row.child.title || row.child.label || projectOf(row.child)),
        el("span", "home-row-sub", [row.account.name || row.account.harness, row.child.account?.label || row.account.account || row.child.account?.id, row.computer].filter(Boolean).join(" · ")),
        el("span", "home-low-usage", row.text));
      chat.addEventListener("click", () => open(row.computer, row.child));
      const change = el("button", "home-btn ghost", "Switch");
      change.type = "button";
      change.dataset.key = row.key;
      change.dataset.action = "switch";
      change.setAttribute("aria-label", `Switch ${row.child.title || row.child.label || "chat"}`);
      change.addEventListener("click", async () => {
        change.disabled = true;
        try {
          let inventory;
          try { inventory = (await hookGet(row.computer, "/v1/harnesses")).harnesses; } catch { /* allow choosing manually */ }
          const live = store.find(row.computer, row.child.id);
          if (!live || quotaSessionKey(live) !== quotaSessionKey(row) || !(state.merged?.computers ?? []).some((c) => c.computer === row.computer && c.state === "online")) return;
          change.disabled = false;
          await openQuotaSwitch(live, inventory, usage?.accounts, { returnFocus: () => {
            // Overview updates can replace the invoking row while the sheet is open.
            [...scope.querySelectorAll("button")].find((button) => button.dataset.key === row.key && button.dataset.action === "switch")?.focus();
          } });
        } catch (error) {
          wrap.append(el("span", "home-row-sub", `Could not switch: ${error?.message || error}`));
        } finally { change.disabled = false; }
      });
      wrap.append(chat, change);
      return wrap;
    }), "");
    if (focusKey) {
      const next = [...scope.querySelectorAll("button")].find((button) => button.dataset.key === focusKey && button.dataset.action === focusAction);
      (next ?? root.querySelector("button"))?.focus();
    }
  }
  return { render: renderLow, update(snapshot) { usage = snapshot; renderLow(); }, ready() { quotaReady = true; } };
}
