// Passive sheet: no backdrop or focus grab, and never launches a move itself.
import { hookGet } from "../api.js";
import { store } from "./store.js";
import { onSectionChange } from "./sections.js";
import { followUsage, windowText } from "./usage-rings.js";
import { moveAccounts, moveChoices, openMoveSheet } from "./move.js";
import { quotaDestinations, quotaSessionKey, quotaWarnings, quotaWindows, sessionUsage } from "./quota-warn.js";
import { markQuotaSeen, quotaSeen, quotaSettings, quotaSuppressed, suppressQuotaChat } from "./quota-warn-prefs.js";

const node = (tag, cls, text) => {
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

export function watchQuotaWarnings(currentSession) {
  let usage = null;
  let open = null;
  let reading = false;
  function close() { open?.remove(); open = null; }
  async function check() {
    const session = currentSession();
    if (!session || !quotaSettings().on || quotaSuppressed().includes(quotaSessionKey(session))) { close(); return; }
    if (open && open.dataset.session !== quotaSessionKey(session)) close();
    if (!usage) return;
    const row = sessionUsage(session, usage.accounts);
    if (open) {
      const window = quotaWindows(row, Date.now()).find((w) => w.id === open.dataset.window && (w.resetsAt ?? "") === open.dataset.reset);
      if (!row || !window || window.used === null || window.used < quotaSettings().threshold || window.used >= 100 && open.dataset.stage !== "exhausted") close();
    }
    if (open || reading) return;
    const warning = quotaWarnings(session, row, { preferences: quotaSettings(), suppressed: quotaSuppressed(), seen: quotaSeen() })[0];
    if (!warning) return;
    reading = true;
    let inventory;
    try { inventory = (await hookGet(session.computer, "/v1/harnesses")).harnesses; }
    catch { /* the warning still explains the limit when inventory is unavailable */ }
    finally { reading = false; }
    const latest = currentSession();
    if (!latest || quotaSessionKey(latest) !== quotaSessionKey(session) || !quotaSettings().on || quotaSuppressed().includes(quotaSessionKey(session))) return;
    // Recheck after the asynchronous inventory read: the window may have reset.
    const freshRow = sessionUsage(latest, usage.accounts);
    const fresh = quotaWarnings(latest, freshRow, { preferences: quotaSettings(), suppressed: quotaSuppressed(), seen: quotaSeen() })[0];
    if (!fresh || fresh.token !== warning.token || document.querySelector(".launch-backdrop")) return;
    const destinations = quotaDestinations(latest, moveChoices(inventory ?? [], latest.child.target?.source ?? latest.child.agent), moveAccounts(inventory, { includeDefault: true }), usage.accounts);
    const best = destinations.find((d) => !d.exhausted);
    const sheet = node("aside", "launch-sheet quota-warning");
    sheet.dataset.session = quotaSessionKey(latest);
    sheet.dataset.window = fresh.id;
    sheet.dataset.reset = fresh.resetsAt ?? "";
    sheet.dataset.stage = fresh.stage;
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-labelledby", "quota-warning-title");
    const head = node("div", "launch-head");
    const title = node("h2", "launch-title", `${freshRow.name} is at ${Math.round(fresh.used)}% of its ${fresh.label} limit`);
    title.id = "quota-warning-title";
    head.append(title);
    const body = node("div", "launch-body");
    body.append(node("div", "launch-note", [freshRow.account, windowText(fresh).caption || "Reset time unknown"].filter(Boolean).join(" · ")));
    for (const dest of destinations) {
      const room = dest.exhausted ? `Exhausted${dest.row?.availableIn ? ` · back in ${dest.row.availableIn}` : ""}` : dest.left === null ? "Usage unknown" : `${Math.round(dest.left)}% remaining`;
      body.append(node("div", `launch-note${dest.exhausted ? " launch-error" : ""}`, `${dest.label} · ${room}`));
    }
    if (!destinations.length) body.append(node("div", "launch-note", "No other signed-in accounts or harnesses available on this computer."));
    const foot = node("div", "launch-foot");
    const button = (text, fn, accent = false) => {
      const b = node("button", `launch-btn${accent ? " accent" : ""}`, text);
      b.type = "button";
      b.addEventListener("click", fn);
      return b;
    };
    const change = button("Switch", () => { close(); void openMoveSheet({ ...latest, to: { harness: best.harness, ...(best.account ? { account: best.account } : {}) } }); }, true);
    change.disabled = !best;
    foot.append(change, button("Not now", close), button("Don't ask again for this chat", () => { suppressQuotaChat(quotaSessionKey(latest)); close(); }));
    sheet.append(head, body, foot);
    sheet.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
    if (!document.getElementById("launch-styles")) {
      const link = node("link", "");
      link.id = "launch-styles"; link.rel = "stylesheet"; link.href = new URL("launch.css", import.meta.url).href;
      document.head.append(link);
    }
    document.body.append(sheet);
    open = sheet;
    markQuotaSeen(fresh.token);
  }
  followUsage((snapshot) => { usage = snapshot; void check(); });
  store.subscribe(() => { void check(); });
  onSectionChange(() => { void check(); });
  return { check, close };
}
