import { RESET, padToWidth, truncateLine, lineViewport, style } from "./shell-render.js";
export function formatSelectableLine(line, cols, selected) {
    return selected
        ? `\x1b[7m${padToWidth(line, cols)}${RESET}`
        : truncateLine(line, cols);
}
export function viewportWithStatus(allLines, cursorFirstLine, cursorLastLine, usableHeight, previousScroll, currentIndex, totalItems) {
    const vp = lineViewport(allLines, cursorFirstLine, cursorLastLine, Math.max(1, usableHeight), previousScroll);
    if (allLines.length > usableHeight) {
        const pct = totalItems <= 1 ? 100 : Math.round((currentIndex / Math.max(totalItems - 1, 1)) * 100);
        vp.lines.push(style.dim(`  ━━━${currentIndex + 1}/${totalItems}  ${pct}%`));
    }
    return vp;
}
