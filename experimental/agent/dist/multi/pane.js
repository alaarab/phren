export const MAX_SCROLLBACK = 1000;
let nextPaneIndex = 0;
export function resetPaneIndex() {
    nextPaneIndex = 0;
}
export function createPane(agentId, name) {
    return { agentId, name, index: nextPaneIndex++, lines: [], partial: "" };
}
export function appendToPane(pane, text) {
    // Merge with partial line buffer
    const combined = pane.partial + text;
    const parts = combined.split("\n");
    // Everything except the last segment is a complete line
    for (let i = 0; i < parts.length - 1; i++) {
        pane.lines.push(parts[i]);
    }
    pane.partial = parts[parts.length - 1];
    // Enforce scrollback cap
    if (pane.lines.length > MAX_SCROLLBACK) {
        pane.lines.splice(0, pane.lines.length - MAX_SCROLLBACK);
    }
}
export function flushPartial(pane) {
    if (pane.partial) {
        pane.lines.push(pane.partial);
        pane.partial = "";
    }
}
