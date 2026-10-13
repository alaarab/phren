// Settings › Keys: the shortcut bindings and the summon hotkey.
import { DEFAULT_SUMMON, acceleratorFromEvent, formatAccelerator, setSummonKey, summonAvailable, summonKey } from "../../shell/summon.js";
import { api, button, el, heading, noticeLine, showNotice } from "./ui.js";

// ------------------------------------------------------------ page: Keys
export function buildKeys(page) {
  const [head, count] = heading("Keys");
  const reload = button("Reload");
  const toolbar = el("div", "settings-toolbar");
  toolbar.append(el("div", "settings-note", "Shortcut bindings the desktop reads at startup."), reload);
  const notice = noticeLine();
  const content = el("div", "settings-keys");
  page.append(head, toolbar, notice);
  if (summonAvailable()) page.append(summonRow());
  page.append(content);

  function fileLine(label, path) {
    const line = el("div", "settings-note");
    line.append(document.createTextNode(`${label}: `));
    line.append(el("span", "settings-config-path", path || "unknown"));
    return line;
  }

  function bindingTable(definitions, bindings, app) {
    const table = el("div", "settings-keytable");
    const groups = new Map();
    for (const def of definitions.values()) {
      if (Boolean(def.app) !== app) continue;
      if (!groups.has(def.group)) groups.set(def.group, []);
      groups.get(def.group).push(def);
    }
    for (const [group, list] of groups) {
      table.append(el("div", "settings-subgroup-label", group));
      for (const def of list) {
        const row = el("div", "settings-keyrow");
        row.append(el("span", "settings-keylabel", def.label));
        const caps = el("span", "settings-caps");
        const keys = (bindings ?? {})[def.action] ?? [];
        if (!keys.length) caps.append(el("span", "settings-unbound", "unbound"));
        else for (const key of keys) caps.append(el("kbd", "settings-kbd", key));
        row.append(caps);
        table.append(row);
      }
    }
    if (!table.childNodes.length) table.append(el("div", "settings-note", "No shortcuts."));
    return table;
  }

  function render(config) {
    const definitions = new Map((config.actions ?? []).map((a) => [a.action, a]));
    count.textContent = config.actions?.length ? String(config.actions.length) : "";
    const frag = document.createDocumentFragment();
    const files = el("div", "settings-files");
    files.append(fileLine("Desktop config", config.files?.desktop));
    files.append(fileLine("Herdr config", config.files?.herdr));
    frag.append(files);
    const prefix = (config.bindings?.prefix ?? []).join("  ");
    if (prefix) {
      const p = el("div", "settings-prefix");
      p.append(el("span", "settings-keylabel", "Prefix"));
      p.append(el("kbd", "settings-kbd", prefix));
      frag.append(p);
    }
    frag.append(el("div", "settings-group-label", "PREFIX SHORTCUTS"));
    frag.append(bindingTable(definitions, config.bindings, false));
    frag.append(el("div", "settings-group-label", "APP SHORTCUTS"));
    frag.append(bindingTable(definitions, config.appBindings, true));
    for (const error of config.errors ?? []) frag.append(el("div", "settings-error", error));
    content.replaceChildren(frag);
  }

  async function load() {
    content.replaceChildren(el("div", "settings-note", "Loading…"));
    try {
      render(await api("/api/keys"));
    } catch (err) {
      content.replaceChildren(el("div", "settings-error", err.message));
    }
  }

  reload.addEventListener("click", async () => {
    await load();
    showNotice(notice, "Reloaded from disk. Restart the app to apply changes to the keys.", false);
  });

  load();
  return load;
}

/** Settings › Keys: the system-wide key that brings Phren forward with ⌘K open.
 * Click the key to record a new one; Esc cancels. */
function summonRow() {
  const platform = window.phrenDesktop?.platform;
  const wrap = el("div", "settings-summon");
  const row = el("div", "settings-keyrow");
  const text = el("span", "settings-keylabel");
  text.append(el("span", "", "Summon Phren from any app"), el("span", "settings-summon-sub", "Brings the window forward with ⌘K open"));
  const caps = el("span", "settings-caps");
  const key = button("");
  key.className = "settings-kbd settings-summon-key";
  const off = button("Turn off");
  const reset = button("Reset");
  caps.append(key, off, reset);
  row.append(text, caps);
  const note = noticeLine();
  wrap.append(row, note);

  let recording = false;
  function paint() {
    const accel = summonKey();
    key.textContent = recording ? "Press a shortcut…" : formatAccelerator(accel, platform);
    key.classList.toggle("recording", recording);
    key.setAttribute("aria-label", recording ? "Press the new shortcut, Esc to cancel" : `Summon shortcut: ${formatAccelerator(accel, platform)}. Click to change.`);
    off.hidden = !accel;
    reset.hidden = accel === DEFAULT_SUMMON;
  }
  async function save(accel) {
    recording = false;
    const ok = await setSummonKey(accel);
    paint();
    showNotice(note, ok ? "" : `${formatAccelerator(accel, platform)} is taken by another app or the system. Pick another.`, !ok);
  }
  key.addEventListener("click", () => { recording = !recording; paint(); });
  key.addEventListener("blur", () => { if (recording) { recording = false; paint(); } });
  key.addEventListener("keydown", (ev) => {
    if (!recording) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.key === "Escape") { recording = false; paint(); return; }
    const accel = acceleratorFromEvent(ev, platform);
    if (accel) void save(accel);
    else if (!["Shift", "Control", "Alt", "Meta"].includes(ev.key)) showNotice(note, "Use ⌘ or Ctrl (or ⌥/Alt) with a letter, number, Space or F-key.", true);
  });
  off.addEventListener("click", () => void save(""));
  reset.addEventListener("click", () => void save(DEFAULT_SUMMON));
  paint();
  return wrap;
}
