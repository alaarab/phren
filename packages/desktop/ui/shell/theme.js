// Phren desktop themes: the phone's five token sets (tokens.json) mapped onto
// the CSS variables theme.css declares. app.js calls initTheme() at startup;
// Settings lists themes() and switches with applyTheme(id). The ids are the
// phone's own appearance raw values, so a saved choice reads the same on both.
//
// tokens.json is the source of colour values; theme.css keeps Charcoal in
// `:root` so the first paint is right before this module's fetch resolves.

const STORAGE_KEY = "phren.desktop.theme";
const DEFAULT_THEME = "midnight"; // Charcoal

// Order and display names, stable before tokens.json has loaded (the picker and
// currentTheme() must answer synchronously).
const BUILT_IN = [
  { id: "midnight", name: "Charcoal" },
  { id: "amethyst", name: "Amethyst" },
  { id: "graphite", name: "Graphite" },
  { id: "slate", name: "Slate" },
  { id: "devs-choice", name: "Dev's Choice" },
];

// tokens.json palette field -> the CSS variable theme.css uses.
const VARS = {
  background: "--bg",
  sunken: "--sunken",
  surface: "--surface",
  card: "--card",
  raised: "--raised",
  toolPanel: "--tool",
  text: "--text",
  secondary: "--text-2",
  muted: "--muted",
  dim: "--dim",
  accent: "--accent",
  hover: "--accent-hover",
  solid: "--accent-solid",
  link: "--link",
  stateWorking: "--working",
  stateWaiting: "--waiting",
  stateDone: "--done",
  danger: "--danger",
};

// The phone's adaptive chat colours: a light canvas takes the darker value.
const PATH_DARK = "#7FB6F0", PATH_LIGHT = "#1C62A8";
const BRANCH_DARK = "#F0A06E", BRANCH_LIGHT = "#A4501C";

let tokens = null;
let current = DEFAULT_THEME;

async function loadTokens() {
  if (tokens) return tokens;
  const res = await fetch(new URL("../tokens.json", import.meta.url));
  if (!res.ok) throw new Error(`themes: tokens.json ${res.status}`);
  tokens = await res.json();
  return tokens;
}

// PhrenTheme.isLight: weighted luminance above 0.55.
function isLight(hex) {
  const n = parseInt(String(hex).replace("#", ""), 16);
  const value = (((n >> 16) & 255) * 0.2126 + ((n >> 8) & 255) * 0.7152 + (n & 255) * 0.0722) / 255;
  return value > 0.55;
}

function readSaved() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function save(id) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* storage unavailable */ }
}

/** The built-in themes in display order: `{ id, name }`. */
export function themes() { return BUILT_IN.map((t) => ({ ...t })); }

/** The id currently applied to the document. */
export function currentTheme() { return current; }

/** Apply a theme by id: colours, adaptive chat colours, borders, color-scheme. */
export async function applyTheme(id) {
  const data = await loadTokens();
  const theme = data.themes?.[id];
  if (!theme) return current;
  const root = document.documentElement;
  for (const [field, cssVar] of Object.entries(VARS)) {
    if (theme[field]) root.style.setProperty(cssVar, theme[field]);
  }
  const light = isLight(theme.chatCanvas);
  root.style.setProperty("--path", light ? PATH_LIGHT : theme.path ?? PATH_DARK);
  root.style.setProperty("--branch", light ? BRANCH_LIGHT : theme.branch ?? BRANCH_DARK);
  root.style.setProperty("--border", light ? "rgba(0, 0, 0, 0.08)" : "rgba(255, 255, 255, 0.07)");
  root.style.setProperty("--border-strong", light ? "rgba(0, 0, 0, 0.16)" : "rgba(255, 255, 255, 0.14)");
  if (data.density) {
    for (const [name, value] of Object.entries(data.density)) root.style.setProperty(`--${name}`, value);
  }
  root.style.colorScheme = light ? "light" : "dark";
  current = id;
  save(id);
  return current;
}

/** Apply the saved theme (else Charcoal) at startup. Never throws. */
export async function initTheme() {
  const saved = readSaved();
  const id = BUILT_IN.some((t) => t.id === saved) ? saved : DEFAULT_THEME;
  try {
    return await applyTheme(id);
  } catch {
    current = DEFAULT_THEME; // tokens.json unreachable: :root's Charcoal stands.
    return current;
  }
}
