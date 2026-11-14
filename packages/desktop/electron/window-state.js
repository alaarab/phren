// Where the window was last time: its size, its position and whether it filled
// the screen. Read when the window is made, written a moment after it moves.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// This much of the window must still land on a display for its saved position to be used.
const VISIBLE_WIDTH = 120;
const VISIBLE_HEIGHT = 60;

const whole = (value) => (Number.isFinite(value) ? Math.round(value) : null);

/** The saved state, or null when the file is missing or does not hold one. */
export function readWindowState(file) {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const width = whole(saved?.width);
    const height = whole(saved?.height);
    if (width === null || height === null || width <= 0 || height <= 0) return null;
    return { x: whole(saved.x), y: whole(saved.y), width, height, maximized: saved.maximized === true };
  } catch {
    return null;
  }
}

/**
 * What a window opens with, given what was saved and the work areas of the
 * displays connected now. The size is kept, never larger than a display and
 * never smaller than the minimum. The position is kept only while enough of
 * the window lands on a display with its title bar in reach, so a window last
 * left on a monitor that has since been unplugged opens centred, not off screen.
 * Returns `{ bounds, maximized }`; `bounds` has no `x`/`y` when the window
 * should be centred.
 */
export function restoredBounds(saved, workAreas, { width, height, minWidth, minHeight }) {
  if (!saved) return { bounds: { width, height }, maximized: false };
  const home = saved.x === null || saved.y === null ? null : workAreas.find((area) => {
    const across = Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x);
    const titleBarReachable = saved.y >= area.y - 1 && saved.y <= area.y + area.height - VISIBLE_HEIGHT;
    return across >= Math.min(VISIBLE_WIDTH, saved.width) && titleBarReachable;
  });
  const limit = home ?? workAreas[0] ?? { width: saved.width, height: saved.height };
  const bounds = {
    width: Math.max(minWidth, Math.min(saved.width, limit.width)),
    height: Math.max(minHeight, Math.min(saved.height, limit.height)),
  };
  if (home) { bounds.x = saved.x; bounds.y = Math.max(saved.y, home.y); }
  return { bounds, maximized: saved.maximized };
}

/** Keep `file` in step with `win`: saved shortly after a move or resize, and when it closes. */
export function trackWindowState(win, file) {
  let timer = null;
  const save = () => {
    if (win.isDestroyed()) return;
    // The size to come back to, even while maximized, minimized or full screen.
    const state = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(state));
      renameSync(`${file}.tmp`, file);
    } catch {
      // A window that cannot remember its place still works.
    }
  };
  const soon = () => { clearTimeout(timer); timer = setTimeout(save, 400); };
  for (const event of ["resize", "move", "maximize", "unmaximize"]) win.on(event, soon);
  win.on("close", () => { clearTimeout(timer); save(); });
}
