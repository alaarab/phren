// Settings › Appearance: theme, transcript size and sidebar rows.
import { applyTheme, currentTheme, themes as themeList } from "../../shell/theme.js";
import { el, heading, toggleRow } from "./ui.js";
import { SIDEBAR_ROWS_KEY, SIZES, TITLE_CHAT_KEY, titleChatEnabled, writeFlag, TRANSCRIPT_KEY, applyTranscriptSize, readSidebarRows, readTranscriptSize } from "./prefs.js";

// ------------------------------------------------------------ page: Appearance
export function buildAppearance(page) {
  const [head] = heading("Appearance");
  page.append(head);
  page.append(el("div", "settings-group-label", "THEMES"));
  const themes = el("div", "settings-themes");
  themes.id = "appearance-themes";
  themes.setAttribute("role", "radiogroup");
  themes.setAttribute("aria-label", "Theme");
  const paint = () => {
    for (const b of themes.children) {
      const on = b.dataset.theme === currentTheme();
      b.classList.toggle("selected", on);
      b.setAttribute("aria-checked", String(on));
    }
  };
  for (const t of themeList()) {
    const b = el("button", "settings-theme", t.name);
    b.dataset.theme = t.id;
    b.setAttribute("role", "radio");
    b.addEventListener("click", async () => { await applyTheme(t.id); paint(); });
    themes.append(b);
  }
  paint();
  page.append(themes);
  page.append(el("div", "settings-group-label", "TRANSCRIPT TEXT"));
  const field = el("div", "settings-field");
  field.append(el("label", "settings-field-label", "Font size"));
  const select = document.createElement("select");
  select.className = "settings-select";
  select.setAttribute("aria-label", "Transcript font size");
  for (const px of SIZES) {
    const option = document.createElement("option");
    option.value = String(px);
    option.textContent = `${px} px`;
    select.append(option);
  }
  select.value = String(readTranscriptSize());
  select.addEventListener("change", () => {
    const px = Number(select.value);
    applyTranscriptSize(px);
    try { localStorage.setItem(TRANSCRIPT_KEY, String(px)); } catch { /* private window: this session only */ }
  });
  field.append(select);
  page.append(field);
  page.append(el("div", "settings-group-label", "SIDEBAR ROWS"));
  const rowField = el("div", "settings-field");
  rowField.append(el("label", "settings-field-label", "Row style"));
  const segs = el("div", "segments");
  segs.setAttribute("role", "tablist");
  segs.setAttribute("aria-label", "Sidebar row style");
  for (const id of ["detailed", "compact"]) {
    const on = readSidebarRows() === id;
    const b = el("button", on ? "segment selected" : "segment", id === "detailed" ? "Detailed" : "Compact");
    b.type = "button";
    b.dataset.rows = id;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(on));
    b.addEventListener("click", () => {
      try { localStorage.setItem(SIDEBAR_ROWS_KEY, id); } catch { /* private window: this session only */ }
      for (const other of segs.children) {
        const selected = other.dataset.rows === id;
        other.classList.toggle("selected", selected);
        other.setAttribute("aria-selected", String(selected));
      }
      document.dispatchEvent(new CustomEvent("phren:sidebar-rows"));
    });
    segs.append(b);
  }
  rowField.append(segs);
  page.append(rowField);

  page.append(el("div", "settings-group-label", "WINDOW"));
  page.append(toggleRow("Show the chat's title in the window title", titleChatEnabled(), (on) => {
    writeFlag(TITLE_CHAT_KEY, on);
    document.dispatchEvent(new Event("phren:tabs-changed")); // the window title re-reads it
  }));
  return null;
}
