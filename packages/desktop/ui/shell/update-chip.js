import { el } from "../dom.js";
// The titlebar's update chip: when the shell finds a newer Phren desktop it
// shows "Phren <version>"; clicking opens What's new (the release notes, from
// packages/desktop/CHANGELOG.md) with Restart to update (a downloaded update)
// or Download (a build that cannot update itself). Later hides it until the
// next version. Absent in a browser.

const SKIP_KEY = "phren.desktop.update-skipped";

/** What the popover says for an offer from the shell. */
export function updateView(state) {
  const restart = state.action === "restart";
  return {
    chip: restart ? `Restart for ${state.version}` : `Phren ${state.version}`,
    title: `What's new in ${state.version}`,
    sub: restart ? `Downloaded. You have ${state.current}.` : `You have ${state.current}. This build can't update itself.`,
    button: restart ? "Restart to update" : "Download",
    notes: Array.isArray(state.notes) ? state.notes.map((line) => String(line).replace(/^-\s*/, "")).filter(Boolean) : [],
  };
}

export function startUpdateChip(shell, before) {
  if (!shell?.onUpdate || !shell.updateAction) return;
  let chip = null;
  let pop = null;
  const close = () => { pop?.remove(); pop = null; };

  shell.onUpdate((state) => {
    try { if (localStorage.getItem(SKIP_KEY) === state.version) return; } catch { /* show it */ }
    const view = updateView(state);
    chip?.parentElement?.remove();
    close();
    const wrap = el("span", "update-wrap");
    chip = el("button", "update-chip", view.chip);
    wrap.append(chip);
    chip.type = "button";
    chip.setAttribute("aria-haspopup", "dialog");
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      if (pop) { close(); return; }
      pop = el("div", "update-pop");
      pop.setAttribute("role", "dialog");
      pop.setAttribute("aria-label", view.title);
      pop.append(el("div", "update-title", view.title), el("div", "update-sub", view.sub));
      if (view.notes.length) {
        const list = el("ul", "update-notes");
        for (const line of view.notes) list.append(el("li", "", line));
        pop.append(list);
      }
      const actions = el("div", "update-actions");
      const later = el("button", "update-later", "Later");
      later.type = "button";
      later.addEventListener("click", () => {
        try { localStorage.setItem(SKIP_KEY, state.version); } catch { /* this session only */ }
        close();
        wrap.remove();
        chip = null;
      });
      const go = el("button", "update-go", view.button);
      go.type = "button";
      go.addEventListener("click", () => { shell.updateAction(state.action); close(); });
      actions.append(later, go);
      pop.append(actions);
      pop.addEventListener("click", (e) => e.stopPropagation());
      wrap.append(pop);
      document.addEventListener("click", close, { once: true });
    });
    before.before(wrap);
  });
}
