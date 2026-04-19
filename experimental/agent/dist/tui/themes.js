/**
 * Theme system — semantic color keys for every TUI element.
 *
 * Ink components use Ink color strings (e.g., "magenta", "#7C3AED").
 * Raw ANSI renderers (markdown, syntax, diff) use ANSI escape sequences.
 */
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
// ── Theme presets ───────────────────────────────────────────────────────────
export const DARK_THEME = {
    name: "dark",
    user: { label: "\u276f", color: "white", bold: true },
    agent: { label: "\u25c6", color: "magenta" },
    system: { color: "gray" },
    tool: {
        success: "green",
        error: "red",
        name: "cyan",
        preview: "gray",
        duration: "gray",
        output: "gray",
        border: "gray",
    },
    thinking: {
        primary: [155, 140, 250],
        secondary: [40, 211, 242],
        verb: "magenta",
        elapsed: "gray",
    },
    input: {
        separator: "gray",
        prompt: "cyan",
        bashPrompt: "yellow",
        placeholder: "gray",
    },
    statusBar: {
        background: "gray",
        text: "white",
        accent: "cyan",
        separator: "gray",
    },
    permission: {
        suggest: "cyan",
        auto: "blue",
        plan: "magenta",
        fullAuto: "green",
    },
    markdown: {
        heading: `${ESC}1m${ESC}36m`, // bold cyan
        bold: `${ESC}1m`, // bold
        italic: `${ESC}3m`, // italic
        code: `${ESC}36m${ESC}7m`, // cyan inverse
        codeBlockBorder: `${ESC}2m`, // dim
        codeBlockLabel: `${ESC}2m${ESC}33m`, // dim yellow
        bullet: `${ESC}33m`, // yellow
        link: `${ESC}4m${ESC}36m`, // underline cyan
        reset: RESET,
    },
    syntax: {
        keyword: `${ESC}35m`, // magenta
        string: `${ESC}32m`, // green
        number: `${ESC}33m`, // yellow
        comment: `${ESC}90m`, // gray
        type: `${ESC}36m`, // cyan
        variable: `${ESC}33m`, // yellow
        operator: `${ESC}36m`, // cyan
        reset: RESET,
    },
    diff: {
        added: `${ESC}32m`, // green
        removed: `${ESC}31m`, // red
        context: `${ESC}2m`, // dim
        lineNumber: `${ESC}90m`, // gray
        header: `${ESC}36m`, // cyan
        separator: `${ESC}2m`, // dim
        reset: RESET,
    },
    agentTab: {
        active: "magentaBright",
        inactive: "gray",
        running: "cyan",
        idle: "gray",
        done: "green",
        error: "red",
    },
    text: "white",
    dim: "gray",
    accent: "cyan",
    warning: "yellow",
    error: "red",
    success: "green",
    info: "blue",
    banner: {
        logo: "magenta",
        version: "gray",
        cwd: "cyan",
    },
    steer: { color: "yellow", icon: "↳" },
    search: { prompt: "cyan", match: "yellow", noMatch: "red" },
    separator: "gray",
};
export const LIGHT_THEME = {
    name: "light",
    user: { label: "\u276f", color: "black", bold: true },
    agent: { label: "\u25c6", color: "#7C3AED" },
    system: { color: "gray" },
    tool: {
        success: "#16a34a",
        error: "#dc2626",
        name: "#0891b2",
        preview: "gray",
        duration: "gray",
        output: "gray",
        border: "gray",
    },
    thinking: {
        primary: [120, 58, 237],
        secondary: [6, 182, 212],
        verb: "#7C3AED",
        elapsed: "gray",
    },
    input: {
        separator: "gray",
        prompt: "#0891b2",
        bashPrompt: "#ca8a04",
        placeholder: "gray",
    },
    statusBar: {
        background: "gray",
        text: "black",
        accent: "#0891b2",
        separator: "gray",
    },
    permission: {
        suggest: "#0891b2",
        auto: "#16a34a",
        plan: "#7C3AED",
        fullAuto: "#ca8a04",
    },
    markdown: {
        heading: `${ESC}1m${ESC}34m`, // bold blue
        bold: `${ESC}1m`,
        italic: `${ESC}3m`,
        code: `${ESC}34m${ESC}7m`, // blue inverse
        codeBlockBorder: `${ESC}2m`,
        codeBlockLabel: `${ESC}2m${ESC}34m`,
        bullet: `${ESC}34m`, // blue
        link: `${ESC}4m${ESC}34m`, // underline blue
        reset: RESET,
    },
    syntax: {
        keyword: `${ESC}34m`, // blue
        string: `${ESC}32m`, // green
        number: `${ESC}35m`, // magenta
        comment: `${ESC}90m`, // gray
        type: `${ESC}34m`, // blue
        variable: `${ESC}33m`, // yellow
        operator: `${ESC}36m`, // cyan
        reset: RESET,
    },
    diff: {
        added: `${ESC}32m`,
        removed: `${ESC}31m`,
        context: `${ESC}2m`,
        lineNumber: `${ESC}90m`,
        header: `${ESC}34m`,
        separator: `${ESC}2m`,
        reset: RESET,
    },
    agentTab: {
        active: "#7C3AED",
        inactive: "gray",
        running: "#0891b2",
        idle: "gray",
        done: "#16a34a",
        error: "#dc2626",
    },
    text: "black",
    dim: "gray",
    accent: "#0891b2",
    warning: "#ca8a04",
    error: "#dc2626",
    success: "#16a34a",
    info: "#2563eb",
    banner: {
        logo: "#7C3AED",
        version: "gray",
        cwd: "#0891b2",
    },
    steer: { color: "#ca8a04", icon: "↳" },
    search: { prompt: "#0891b2", match: "#ca8a04", noMatch: "#dc2626" },
    separator: "gray",
};
export const SOLARIZED_THEME = {
    name: "solarized",
    user: { label: "\u276f", color: "#839496", bold: true },
    agent: { label: "\u25c6", color: "#b58900" },
    system: { color: "#586e75" },
    tool: {
        success: "#859900",
        error: "#dc322f",
        name: "#268bd2",
        preview: "#586e75",
        duration: "#586e75",
        output: "#586e75",
        border: "#586e75",
    },
    thinking: {
        primary: [181, 137, 0],
        secondary: [38, 139, 210],
        verb: "#b58900",
        elapsed: "#586e75",
    },
    input: {
        separator: "#586e75",
        prompt: "#268bd2",
        bashPrompt: "#b58900",
        placeholder: "#586e75",
    },
    statusBar: {
        background: "#073642",
        text: "#839496",
        accent: "#268bd2",
        separator: "#586e75",
    },
    permission: {
        suggest: "#2aa198",
        auto: "#859900",
        plan: "#6c71c4",
        fullAuto: "#b58900",
    },
    markdown: {
        heading: `${ESC}1m${ESC}33m`,
        bold: `${ESC}1m`,
        italic: `${ESC}3m`,
        code: `${ESC}36m${ESC}7m`,
        codeBlockBorder: `${ESC}2m`,
        codeBlockLabel: `${ESC}2m${ESC}33m`,
        bullet: `${ESC}33m`,
        link: `${ESC}4m${ESC}36m`,
        reset: RESET,
    },
    syntax: {
        keyword: `${ESC}32m`, // solarized green
        string: `${ESC}36m`, // cyan
        number: `${ESC}35m`, // magenta
        comment: `${ESC}90m`, // base01
        type: `${ESC}33m`, // yellow
        variable: `${ESC}34m`, // blue
        operator: `${ESC}32m`, // green
        reset: RESET,
    },
    diff: {
        added: `${ESC}32m`,
        removed: `${ESC}31m`,
        context: `${ESC}2m`,
        lineNumber: `${ESC}90m`,
        header: `${ESC}33m`,
        separator: `${ESC}2m`,
        reset: RESET,
    },
    agentTab: {
        active: "#b58900",
        inactive: "#586e75",
        running: "#268bd2",
        idle: "#586e75",
        done: "#859900",
        error: "#dc322f",
    },
    text: "#839496",
    dim: "#586e75",
    accent: "#268bd2",
    warning: "#b58900",
    error: "#dc322f",
    success: "#859900",
    info: "#268bd2",
    banner: {
        logo: "#b58900",
        version: "#586e75",
        cwd: "#268bd2",
    },
    steer: { color: "#b58900", icon: "↳" },
    search: { prompt: "#268bd2", match: "#b58900", noMatch: "#dc322f" },
    separator: "#586e75",
};
export const MONO_THEME = {
    name: "mono",
    user: { label: "\u276f", color: "white", bold: true },
    agent: { label: "\u25c6", color: "white" },
    system: { color: "gray" },
    tool: {
        success: "white",
        error: "white",
        name: "white",
        preview: "gray",
        duration: "gray",
        output: "gray",
        border: "gray",
    },
    thinking: {
        primary: [200, 200, 200],
        secondary: [120, 120, 120],
        verb: "white",
        elapsed: "gray",
    },
    input: {
        separator: "gray",
        prompt: "white",
        bashPrompt: "white",
        placeholder: "gray",
    },
    statusBar: {
        background: "gray",
        text: "white",
        accent: "white",
        separator: "gray",
    },
    permission: {
        suggest: "white",
        auto: "white",
        plan: "white",
        fullAuto: "white",
    },
    markdown: {
        heading: `${ESC}1m`,
        bold: `${ESC}1m`,
        italic: `${ESC}3m`,
        code: `${ESC}7m`,
        codeBlockBorder: `${ESC}2m`,
        codeBlockLabel: `${ESC}2m`,
        bullet: `${ESC}1m`,
        link: `${ESC}4m`,
        reset: RESET,
    },
    syntax: {
        keyword: `${ESC}1m`, // bold
        string: `${ESC}2m`, // dim
        number: `${ESC}0m`, // normal
        comment: `${ESC}2m`, // dim
        type: `${ESC}1m`, // bold
        variable: `${ESC}0m`, // normal
        operator: `${ESC}0m`, // normal
        reset: RESET,
    },
    diff: {
        added: `${ESC}1m`, // bold
        removed: `${ESC}9m`, // strikethrough
        context: `${ESC}2m`, // dim
        lineNumber: `${ESC}2m`, // dim
        header: `${ESC}1m`, // bold
        separator: `${ESC}2m`, // dim
        reset: RESET,
    },
    agentTab: {
        active: "white",
        inactive: "gray",
        running: "white",
        idle: "gray",
        done: "white",
        error: "white",
    },
    text: "white",
    dim: "gray",
    accent: "white",
    warning: "white",
    error: "white",
    success: "white",
    info: "white",
    banner: {
        logo: "white",
        version: "gray",
        cwd: "white",
    },
    steer: { color: "white", icon: "↳" },
    search: { prompt: "white", match: "white", noMatch: "gray" },
    separator: "gray",
};
// ── Theme registry ──────────────────────────────────────────────────────────
const THEMES = {
    dark: DARK_THEME,
    light: LIGHT_THEME,
    solarized: SOLARIZED_THEME,
    mono: MONO_THEME,
};
export const THEME_NAMES = Object.keys(THEMES);
export function getTheme(name) {
    if (name && THEMES[name])
        return THEMES[name];
    // Auto-detect: check COLORFGBG env for light/dark terminal background
    const bg = process.env.COLORFGBG;
    if (bg) {
        const parts = bg.split(";");
        const bgColor = parseInt(parts[parts.length - 1] ?? "0", 10);
        if (bgColor > 8)
            return LIGHT_THEME;
    }
    return DARK_THEME;
}
