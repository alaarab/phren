import { RESET, padToWidth, truncateLine, lineViewport, style } from "./shell-render.js";

export function formatSelectableLine(line: string, cols: number, selected: boolean): string {
  return selected
    ? `\x1b[7m${padToWidth(line, cols)}${RESET}`
    : truncateLine(line, cols);
}

export function viewportWithStatus(
  allLines: string[],
  cursorFirstLine: number,
  cursorLastLine: number,
  usableHeight: number,
  previousScroll: number,
  currentIndex: number,
  totalItems: number,
): { lines: string[]; scrollStart: number } {
  const vp = lineViewport(
    allLines,
    cursorFirstLine,
    cursorLastLine,
    Math.max(1, usableHeight),
    previousScroll,
  );

  if (allLines.length > usableHeight) {
    const pct = totalItems <= 1 ? 100 : Math.round((currentIndex / Math.max(totalItems - 1, 1)) * 100);
    vp.lines.push(style.dim(`  ━━━${currentIndex + 1}/${totalItems}  ${pct}%`));
  }

  return vp;
}
