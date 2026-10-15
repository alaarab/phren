import { windowText } from "./usage-windows.js";
import { movePlan } from "./handoff.js";
// Passive sheet: no backdrop or focus grab, and never launches a move itself.
import { hookGet } from "../api.js";
import { store } from "./store.js";
import { onSectionChange } from "./sections.js";
import { followUsage } from "./usage-rings.js";
import { moveAccounts, moveChoices, openMoveSheet } from "./move.js";
import { quotaDestinations, quotaDestinationText, quotaSessionKey, quotaWarnings, sessionUsage } from "./quota-warn.js";
import { loadQuotaState, unmarkQuotaSeen, markQuotaSeen, quotaSeen, quotaSettings, quotaSuppressed, suppressQuotaChat } from "./quota-warn-prefs.js";

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
  const reportFailure = (error) => console.warn("Quota warning preferences:", error);
  const blocked = (session) => session?.interactionsPending || session?.child.approvalPending;
  const destinationsFor = (session, inventory) => quotaDestinations(session,
    moveChoices(inventory ?? [], session.child.target?.source ?? session.child.agent),
    moveAccounts(inventory, { includeDefault: true }), usage?.accounts ?? []);
  function pending(session, row) {
    return quotaWarnings(session, row, { preferences: quotaSettings(), suppressed: quotaSuppressed(), seen: quotaSeen().filter((token) => token !== open?.dataset.token) })[0];
  }
  async function check() {
    let session = currentSession();
    if (blocked(session)) {
      // An interruption is not a dismissal: make the shown crossing eligible again.
      const token = open?.dataset.token;
      close();
      if (token) await unmarkQuotaSeen(token).catch(reportFailure);
      return;
    }
    if (!session?.quotaHost) { close(); return; }
    try { await loadQuotaState(); } catch (error) { reportFailure(error); return; }
    session = currentSession();
    if (!session || blocked(session) || !quotaSettings().on || quotaSuppressed().includes(quotaSessionKey(session))) { close(); return; }
    if (open && open.dataset.session !== quotaSessionKey(session)) close();
    if (!usage) return;
    const row = sessionUsage(session, usage.accounts);
    const warning = pending(session, row);
    if (open) {
      if (warning?.token === open.dataset.token) { open.refreshUsage(row, warning); return; }
      close();
    }
    if (reading || !warning) return;
    reading = true;
    let inventory;
    try {
      const [profile] = await Promise.all([hookGet(session.computer, "/v1/harnesses"), store.capabilities(session.computer)]);
      inventory = profile.harnesses;
    }
    catch { /* the warning still explains the limit when inventory is unavailable */ }
    finally { reading = false; }
    const latest = currentSession();
    if (!latest || blocked(latest) || quotaSessionKey(latest) !== quotaSessionKey(session) || !quotaSettings().on || quotaSuppressed().includes(quotaSessionKey(session))) return;
    // Re-evaluate every window after the read; exhaustion always takes priority.
    const freshRow = sessionUsage(latest, usage.accounts);
    const fresh = pending(latest, freshRow);
    if (!fresh || open || document.querySelector(".launch-backdrop")) return;
    if (!latest.quotaHost) return;
    const sheet = node("aside", "launch-sheet quota-warning");
    sheet.dataset.session = quotaSessionKey(latest);
    sheet.dataset.window = fresh.id;
    sheet.dataset.reset = fresh.resetsAt ?? "";
    sheet.dataset.stage = fresh.stage;
    sheet.dataset.token = fresh.token;
    sheet.setAttribute("role", "region");
    sheet.setAttribute("aria-labelledby", "quota-warning-title");
    const head = node("div", "launch-head");
    const title = node("h2", "launch-title", `${freshRow.name} is at ${Math.round(fresh.used)}% of its ${fresh.label} limit`);
    title.id = "quota-warning-title";
    head.append(title);
    const body = node("div", "launch-body");
    const caption = node("div", "launch-note", [freshRow.account, windowText(fresh).caption || "Reset time unknown"].filter(Boolean).join(" · "));
    body.append(caption);
    const alternatives = node("div", "quota-alternatives");
    body.append(alternatives);
    const switchNote = node("div", "launch-hint");
    sheet.refreshDestinations = () => {
      alternatives.replaceChildren();
      const destinations = destinationsFor(currentSession() ?? latest, inventory);
      for (const dest of destinations) {
        alternatives.append(node("div", `launch-note${dest.exhausted ? " launch-error" : ""}`, quotaDestinationText(dest)));
      }
      const best = destinations.find((d) => !d.exhausted && d.left > 0);
      switchNote.textContent = best ? `${best.label} · ${movePlan(latest.child.target?.source ?? latest.child.agent, best, store.can(latest.computer, "moveNewChat")).label}` : "";
      if (!best) alternatives.append(node("div", "launch-note", "No other account or harness has known room. Choose where to continue."));
    };
    sheet.refreshUsage = (row, warning) => {
      title.textContent = `${row.name} is at ${Math.round(warning.used)}% of its ${warning.label} limit`;
      caption.textContent = [row.account, windowText(warning).caption || "Reset time unknown"].filter(Boolean).join(" · ");
      sheet.refreshDestinations();
    };
    sheet.refreshDestinations();
    const foot = node("div", "launch-foot");
    const button = (text, fn, accent = false) => {
      const b = node("button", `launch-btn${accent ? " accent" : ""}`, text);
      b.type = "button";
      b.addEventListener("click", fn);
      return b;
    };
    const change = button("Switch", () => {
      const session = currentSession();
      if (!session || blocked(session) || quotaSessionKey(session) !== quotaSessionKey(latest)) { void check(); return; }
      // A destination can run out while the notice is open. Never reuse its old rank.
      const best = destinationsFor(session, inventory).find((d) => !d.exhausted && d.left > 0);
      close();
      void openMoveSheet({ ...session,
        to: best ? { harness: best.harness, ...(best.account ? { account: best.account } : {}) } : undefined,
        ...(!best ? { selectDefault: false, notice: "No other account or harness has known room. Choose where to continue." } : {}),
      });
    }, true);
    foot.append(change, button("Not now", close), button("Don't ask again for this chat", () => { void suppressQuotaChat(quotaSessionKey(latest)).catch(reportFailure); close(); }));
    body.append(switchNote);
    sheet.append(head, body, foot);
    sheet.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
    if (!document.getElementById("launch-styles")) {
      const link = node("link", "");
      link.id = "launch-styles"; link.rel = "stylesheet"; link.href = new URL("launch.css", import.meta.url).href;
      document.head.append(link);
    }
    latest.quotaHost.append(sheet);
    open = sheet;
    void markQuotaSeen(fresh.token).catch(reportFailure);
  }
  followUsage((snapshot) => { usage = snapshot; void check(); });
  store.subscribe(() => { void check(); });
  onSectionChange(() => { void check(); });
  return { check, close };
}
