/** TTY spinner + formatting helpers for the agent REPL. */

import { t, formatToolName, formatInlineCost, formatEffort } from "./theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL = 80;

export interface Spinner {
  start(text: string): void;
  update(text: string): void;
  stop(): void;
}

export function createSpinner(): Spinner {
  const isTTY = process.stderr.isTTY;
  let timer: ReturnType<typeof setInterval> | null = null;
  let frame = 0;
  let text = "";

  function render(): void {
    process.stderr.write(`\r\x1b[2K${t.brandDim(`${FRAMES[frame]} ${text}`)}`);
    frame = (frame + 1) % FRAMES.length;
  }

  return {
    start(t: string) {
      if (!isTTY) return;
      text = t;
      frame = 0;
      if (timer) clearInterval(timer);
      render();
      timer = setInterval(render, INTERVAL);
    },
    update(t: string) {
      text = t;
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (isTTY) process.stderr.write("\r\x1b[2K");
    },
  };
}

/** Format a turn header for REPL output. */
export function formatTurnHeader(turn: number, toolCalls: number): string {
  return t.muted(`── turn ${turn} (${toolCalls} tool call${toolCalls !== 1 ? "s" : ""}) ──`);
}

/** Format a tool call for display: name + truncated input preview. */
export function formatToolCall(name: string, input: Record<string, unknown>): string {
  const raw = JSON.stringify(input);
  const preview = raw.length > 100 ? raw.slice(0, 100) + "..." : raw;
  return `  ${formatToolName(name)}${t.muted(`(${preview})`)}`;
}

/** Format a turn cost badge (shown inline after each response). */
export function formatTurnCostBadge(turnCost: number): string {
  if (turnCost <= 0) return "";
  return `  ${formatInlineCost(turnCost)}`;
}

/** Format effort level badge for status display. */
export function formatEffortBadge(level: string): string {
  return formatEffort(level);
}
