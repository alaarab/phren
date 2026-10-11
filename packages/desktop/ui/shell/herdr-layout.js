// Turn a Herdr tab's pane rectangles into the tiles' split tree (shell/tiles.js
// `restore` format): find a vertical cut no pane crosses (side by side), else a
// horizontal one (stacked), and recurse. Rects Herdr cannot express as clean
// cuts fall back to tabs in one tile.

/** panes: [{ pane_id, rect: { x, y, width, height }, focused? }] -> node */
export function layoutTree(panes, leafFor) {
  if (!panes.length) return null;
  if (panes.length === 1) return leafFor([panes[0]]);
  for (const dir of ["row", "col"]) {
    const start = (p) => (dir === "row" ? p.rect.x : p.rect.y);
    const end = (p) => start(p) + (dir === "row" ? p.rect.width : p.rect.height);
    const min = Math.min(...panes.map(start));
    const max = Math.max(...panes.map(end));
    const cuts = [...new Set(panes.map(end))].filter((c) => c > min && c < max).sort((a, b) => a - b);
    for (const cut of cuts) {
      const a = panes.filter((p) => end(p) <= cut);
      const b = panes.filter((p) => start(p) >= cut);
      if (a.length && b.length && a.length + b.length === panes.length) {
        const ratio = Math.round(((cut - min) / (max - min)) * 1000) / 1000;
        return { dir, ratio, a: layoutTree(a, leafFor), b: layoutTree(b, leafFor) };
      }
    }
  }
  return leafFor(panes);
}
