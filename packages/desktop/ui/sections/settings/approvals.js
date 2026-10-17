// Settings › Approvals: each online computer's standing approval rules, read-only.
// Adding, switching off and revoking rules needs a paired-key signature, so it happens on the phone.
import { store } from "../../shell/store.js";
import { hookGet } from "../../api.js";
import { button, el, heading } from "./ui.js";
import { ruleDates, ruleScope, ruleSentence, ruleStatus } from "./approval-rule-text.js";

export function buildApprovals(page) {
  const [head, count] = heading("Approvals");
  const intro = el("div", "settings-note", "Standing rules that make an agent ask, or stop it, before it runs a command. Adding or revoking a rule happens from the phone, because each change needs a signature from a paired key.");
  const toolbar = el("div", "settings-toolbar");
  const refreshBtn = button("Refresh");
  toolbar.append(el("div", "settings-note", "Read from each online computer when this page opens."), refreshBtn);
  const list = el("div", "approval-computers");
  page.append(head, intro, toolbar, list);

  let controller = null;
  let closed = false;

  function section(name) {
    const box = el("section", "approval-computer");
    box.dataset.computer = name;
    const body = el("div", "approval-body");
    box.append(el("div", "comp-section-label", name), body);
    return { box, body };
  }

  function renderRules(body, name, rules) {
    if (!rules.length) { body.replaceChildren(el("div", "settings-empty approval-empty", `No standing approval rules on ${name}.`)); return; }
    body.replaceChildren(...rules.map((rule) => {
      const row = el("div", "settings-row approval-rule");
      const main = el("div", "settings-row-main");
      main.append(el("div", "settings-row-title approval-sentence", ruleSentence(rule)),
        el("div", "approval-meta approval-scope", ruleScope(rule)),
        el("div", "approval-meta approval-dates", ruleDates(rule)));
      const status = ruleStatus(rule);
      row.append(main, el("span", `approval-status approval-${status.toLowerCase()}`, status));
      return row;
    }));
  }

  async function load() {
    if (closed) return;
    controller?.abort();
    const mine = (controller = new AbortController());
    const computers = store.merged?.computers ?? [];
    const online = computers.filter((c) => c.state === "online");
    count.textContent = "";
    if (!online.length) {
      list.replaceChildren(el("div", "settings-empty", computers.length ? "No computers are online." : "No computers linked."));
      refreshBtn.disabled = false;
      return;
    }
    refreshBtn.disabled = true;
    const sections = online.map((c) => ({ c, ...section(c.computer) }));
    for (const s of sections) s.body.append(el("div", "settings-inline-note", "Loading…"));
    list.replaceChildren(...sections.map((s) => s.box));
    let total = 0;
    await Promise.all(sections.map(async ({ c, body }) => {
      try {
        const result = await hookGet(c.computer, "/v1/approval-rules", {}, { signal: mine.signal });
        if (mine.signal.aborted) return;
        const rules = Array.isArray(result?.rules) ? result.rules : [];
        total += rules.length;
        renderRules(body, c.computer, rules);
      } catch (err) {
        if (mine.signal.aborted) return;
        body.replaceChildren(el("div", "settings-error approval-error", err.status === 404
          ? `Needs a newer Phren on ${c.computer}.` : `Could not read approval rules on ${c.computer}: ${err.message}`));
      }
    }));
    if (mine.signal.aborted || closed) return;
    refreshBtn.disabled = false;
    count.textContent = total ? String(total) : "";
  }

  refreshBtn.addEventListener("click", load);
  // Built on first show, which is the first read; showing the page again reads again. No timer.
  const refresh = () => { load(); };
  refresh.hide = () => { controller?.abort(); refreshBtn.disabled = false; };
  refresh.close = () => { closed = true; controller?.abort(); };
  load();
  return refresh;
}
