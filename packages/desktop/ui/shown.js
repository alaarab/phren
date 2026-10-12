// Whether a pane is on screen. A hidden section, a background tab or a closed
// side pane has no layout boxes, and its polls only cost Hook requests.
export function isShown(el) {
  return el.isConnected && el.getClientRects().length > 0;
}

/** Calls `onShown` each time `el` comes back on screen. Returns a stop function. */
export function watchShown(el, onShown) {
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) onShown();
  });
  observer.observe(el);
  return () => observer.disconnect();
}
