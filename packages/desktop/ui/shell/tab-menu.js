// The tab right-click menu: the chat header's menu look (`.chat-menu`), placed at
// the pointer or under a keyboard-focused tab. Focus moves into it and is trapped
// (Tab cycles), arrows / Home / End move. Esc, an outside press or focus moving
// elsewhere (another overlay opened) closes it; after Esc focus goes back to the
// tab that opened it.
//
// openTabMenu({ items: [{ label, run, enabled?, id? }], x, y, label, returnTo? }) -> { close() }

let current = null;

function ensureStyle() {
  if (document.getElementById("chat-style")) return; // the chat header's sheet, shared
  const link = document.createElement("link");
  link.id = "chat-style";
  link.rel = "stylesheet";
  link.href = new URL("../chat/chat.css", import.meta.url).href;
  document.head.appendChild(link);
}

export function openTabMenu({ items, x = 0, y = 0, label = "Tab menu", returnTo = null }) {
  current?.close(false);
  ensureStyle();
  const menu = document.createElement("div");
  menu.className = "chat-menu tab-menu";
  menu.setAttribute("role", "menu");
  menu.addEventListener("contextmenu", (ev) => ev.preventDefault()); // no browser menu on top of ours
  menu.setAttribute("aria-label", label);
  const buttons = [];
  let done = false;

  function close(restore = true) {
    if (done) return;
    done = true;
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("focusin", onFocusIn, true);
    window.removeEventListener("blur", onAway);
    window.removeEventListener("resize", onAway);
    menu.remove();
    if (current === api) current = null;
    if (restore && returnTo?.isConnected) returnTo.focus();
  }
  const api = { close, el: menu };

  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = item.label;
    if (item.id) button.dataset.action = item.id;
    const enabled = item.enabled !== false;
    if (!enabled) button.setAttribute("aria-disabled", "true");
    button.addEventListener("click", () => {
      if (!enabled) return;
      close(false);
      item.run();
    });
    buttons.push(button);
    menu.append(button);
  }

  function move(delta) {
    const at = buttons.indexOf(document.activeElement);
    const next = delta === "first" ? 0 : delta === "last" ? buttons.length - 1 : (at + delta + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
  function onKey(ev) {
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); return; }
    if (!menu.contains(document.activeElement) && ev.key !== "Tab") return;
    const step = { ArrowDown: 1, ArrowUp: -1, Home: "first", End: "last" }[ev.key];
    if (step !== undefined) { ev.preventDefault(); ev.stopPropagation(); move(step); return; }
    if (ev.key === "Tab") { ev.preventDefault(); ev.stopPropagation(); move(ev.shiftKey ? -1 : 1); } // the menu is the focus trap
  }
  function onOutside(ev) { if (!menu.contains(ev.target)) close(false); }
  function onAway() { close(false); }
  // Another overlay (the command palette, a dialog) took focus: it owns the keys now.
  function onFocusIn(ev) { if (!menu.contains(ev.target)) close(false); }

  menu.style.position = "fixed";
  menu.style.left = "0px";
  menu.style.top = "0px";
  document.body.append(menu);
  // Keep it on screen: flip left / up when it would run off the window.
  const rect = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, document.documentElement.clientWidth - rect.width - 4));
  const top = Math.max(4, Math.min(y, document.documentElement.clientHeight - rect.height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onAway);
  window.addEventListener("resize", onAway);
  current = api;
  buttons[0]?.focus();
  document.addEventListener("focusin", onFocusIn, true); // after the first focus, which is inside

  return api;
}
