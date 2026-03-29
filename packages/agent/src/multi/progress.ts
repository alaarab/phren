/**
 * Progress indicators for terminal output.
 */

const FILLED = "█";
const EMPTY = "░";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Render a progress bar: `[████░░░░] 50%` */
export function renderProgressBar(current: number, total: number, width = 20): string {
  if (total <= 0) return `[${"░".repeat(width)}] 0%`;
  const pct = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const percent = Math.round(pct * 100);
  return `[${FILLED.repeat(filled)}${EMPTY.repeat(empty)}] ${percent}%`;
}

/** Get a braille spinner frame by index (wraps automatically). */
export function renderSpinnerFrame(frame: number): string {
  return SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
}

/** Format elapsed time from a start timestamp: `2.1s` or `1m 30s`. */
export function renderElapsed(startMs: number): string {
  const elapsed = Date.now() - startMs;
  if (elapsed < 1000) return `${elapsed}ms`;
  const secs = elapsed / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = Math.round(secs % 60);
  return `${mins}m ${remSecs}s`;
}
