export const MAX_SCROLLBACK = 1000;

export interface Pane {
  agentId: string;
  name: string;
  /** Stable index for color/icon assignment. */
  index: number;
  lines: string[];
  /** Partial line accumulator for streaming text deltas */
  partial: string;
}

let nextPaneIndex = 0;

export function resetPaneIndex(): void {
  nextPaneIndex = 0;
}

export function createPane(agentId: string, name: string): Pane {
  return { agentId, name, index: nextPaneIndex++, lines: [], partial: "" };
}

export function appendToPane(pane: Pane, text: string): void {
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

export function flushPartial(pane: Pane): void {
  if (pane.partial) {
    pane.lines.push(pane.partial);
    pane.partial = "";
  }
}
