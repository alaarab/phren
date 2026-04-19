/**
 * Unique colors and icons for spawned agents.
 *
 * Each agent gets a deterministic style based on its index (mod array length),
 * so the same slot always looks the same even across re-renders.
 */
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
// ── Color palette (8 distinct ANSI colors) ──────────────────────────────────
const AGENT_COLORS = [
    { name: "cyan", code: "36" },
    { name: "magenta", code: "35" },
    { name: "yellow", code: "33" },
    { name: "green", code: "32" },
    { name: "blue", code: "34" },
    { name: "red", code: "31" },
    { name: "white", code: "37" },
    { name: "bright-cyan", code: "96" },
];
// ── Icon palette (8 unicode icons) ──────────────────────────────────────────
const AGENT_ICONS = ["◆", "◇", "●", "○", "■", "□", "▲", "★"];
/** Get a deterministic style for agent at the given index. */
export function getAgentStyle(index) {
    const c = AGENT_COLORS[index % AGENT_COLORS.length];
    const icon = AGENT_ICONS[index % AGENT_ICONS.length];
    return {
        color: (text) => `${ESC}${c.code}m${text}${RESET}`,
        icon,
        colorName: c.name,
    };
}
/** Format an agent name with its icon and color: "◆ agent-name" */
export function formatAgentName(name, index) {
    const { color, icon } = getAgentStyle(index);
    return color(`${icon} ${name}`);
}
