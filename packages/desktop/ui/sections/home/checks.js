import { el } from "../../dom.js";
import { store } from "../../shell/store.js";
import { checksStrip, followChecks } from "../../shell/ci-watch.js";
import { checksWord } from "../../git-review.js";

export function createChecks({ block, openPrs }) {
  // The open requests the CI watch saw on working and recent sessions.
  let pulls = null;
  let stopChecks = null;
  function renderChecks() {
    const scope = block("checks");
    const list = checksStrip(pulls ?? []);
    scope.hidden = !list.length;
    scope.querySelector(".count").textContent = list.length ? String(list.length) : "";
    scope.querySelector(".home-checks").replaceChildren(...list.map((pull) => {
      const chip = el("button", `home-check ${pull.checks || "none"}`);
      chip.title = `${checksWord(pull.checks) || "No checks"} · ${pull.ref}${pull.number} ${pull.title} · ${pull.computer}`;
      chip.append(el("span", "home-check-dot"), el("span", "home-check-ref", `${pull.ref}${pull.number}`),
        el("span", "home-check-title", pull.title), el("span", "home-project", pull.project));
      chip.addEventListener("click", () => openPrs(pull.computer, store.find(pull.computer, pull.child.id)?.child ?? pull.child));
      return chip;
    }));
  }
  function followPulls() {
    stopChecks ??= followChecks((look) => { pulls = look; renderChecks(); });
  }
  function unfollowPulls() {
    stopChecks?.();
    stopChecks = null;
  }
  return { render: renderChecks, follow: followPulls, unfollow: unfollowPulls };
}
