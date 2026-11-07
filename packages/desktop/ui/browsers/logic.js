// Geometry is shared by click and wheel: CSS object-fit: contain, including its gutters.
export function fittedFrame(box, width, height) {
  if (!(width > 0 && height > 0 && box.width > 0 && box.height > 0)) return null;
  const scale = Math.min(box.width / width, box.height / height);
  const w = width * scale, h = height * scale;
  return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, width: w, height: h };
}

export function normalizedPoint(box, width, height, x, y) {
  const fit = fittedFrame(box, width, height);
  if (!fit || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const nx = (x - fit.left) / fit.width, ny = (y - fit.top) / fit.height;
  return nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1 ? { x: nx, y: ny } : null;
}

// Trailing batches preserve deltas and the newest pointer; cancel on loss of control.
export function wheelCoalescer(send) {
  let pending = null, timer = null;
  const flush = () => {
    timer = null;
    const event = pending; pending = null;
    if (event) send({ ...event, dx: Math.max(-5, Math.min(5, event.dx)), dy: Math.max(-5, Math.min(5, event.dy)) });
  };
  return {
    add(event) {
      pending = { ...event, dx: (pending?.dx ?? 0) + event.dx, dy: (pending?.dy ?? 0) + event.dy };
      if (timer === null) timer = setTimeout(flush, 34);
    },
    cancel() { clearTimeout(timer); timer = null; pending = null; },
  };
}

export function controlState(state, message) {
  if (message.type === "connected") return { ...state, connected: true, error: "" };
  if (message.type === "closed") return { ...state, connected: false, holder: null };
  if (message.type === "released") return { ...state, holder: null };
  if (message.type === "control" && state.connected) return { ...state, holder: ["you", "other"].includes(message.holder) ? message.holder : null, help: message.help ?? null };
  if (message.type === "error") return { ...state, error: message.message };
  return state;
}

export function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function frameAtTime(frames, t) {
  // Markers may lie between frames or after the final frame.
  let lo = 0, hi = frames.length - 1, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (frames[mid].t <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}
