/** TTY spinner + formatting helpers for the agent REPL. */

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
    process.stderr.write(`\r\x1b[2K\x1b[90m${FRAMES[frame]} ${text}\x1b[0m`);
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
  return `\x1b[90m--- turn ${turn} (${toolCalls} tool call${toolCalls !== 1 ? "s" : ""}) ---\x1b[0m`;
}

/** Format a tool call for display: name + truncated input preview. */
export function formatToolCall(name: string, input: Record<string, unknown>): string {
  const raw = JSON.stringify(input);
  const preview = raw.length > 100 ? raw.slice(0, 100) + "..." : raw;
  return `\x1b[2m  ${name}(${preview})\x1b[0m`;
}
