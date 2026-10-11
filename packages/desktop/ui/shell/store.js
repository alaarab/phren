// The app's shared state: the merged overview of every computer, who needs
// the owner, and each computer's Hook capabilities. Fed by the daemon's one
// /api/overview WebSocket; every section subscribes here instead of opening
// its own.

const listeners = new Set();
let merged = null;
const capabilities = new Map(); // computer -> { at, caps } | { at, error }
const CAPS_TTL = 5 * 60_000;

export const store = {
  /** The latest merged overview, or null before the first frame. */
  get merged() { return merged; },

  /** Call `fn(merged)` now (when known) and on every change; returns an unsubscribe. */
  subscribe(fn) {
    listeners.add(fn);
    if (merged) fn(merged);
    return () => listeners.delete(fn);
  },

  /** Rows that need the owner: blocked or waiting agents and pending approvals. */
  needsYou() { return needsYou(merged); },

  /** Every agent row across computers, flattened. */
  sessions() { return sessions(merged); },

  /** Find a session row by computer and child id. */
  find(computer, id) { return sessions(merged).find((s) => s.computer === computer && s.child.id === id) ?? null; },

  /**
   * The Hook's declared capabilities for a computer (`/v1/health`), cached and
   * refreshed when the computer reconnects. Resolves to {} when unknown.
   */
  async capabilities(computer) {
    const hit = capabilities.get(computer);
    if (hit && Date.now() - hit.at < CAPS_TTL) return hit.caps ?? {};
    try {
      const res = await fetch(`/hosts/${encodeURIComponent(computer)}/v1/health`, { cache: "no-store" });
      const body = res.ok ? await res.json() : {};
      const caps = body.capabilities && typeof body.capabilities === "object" ? body.capabilities : {};
      capabilities.set(computer, { at: Date.now(), caps, version: body.version });
      return caps;
    } catch {
      capabilities.set(computer, { at: Date.now(), caps: {} });
      return {};
    }
  },

  /** Synchronous capability check from the cache: true, false, or undefined when not fetched yet. */
  can(computer, capability) {
    const hit = capabilities.get(computer);
    return hit ? Boolean(hit.caps?.[capability]) : undefined;
  },

  /** The Hook version a computer reported, when known. */
  version(computer) { return capabilities.get(computer)?.version; },
};

export function needsYou(m = merged) {
  return sessions(m).filter(({ child }) =>
    child.agentStatus === "blocked" || child.agentStatus === "waiting" || child.approvalPending);
}

export function sessions(m = merged) {
  const rows = [];
  for (const c of m?.computers ?? []) {
    for (const g of c.overview?.groups ?? []) {
      for (const child of g.children ?? []) {
        if (child.target) rows.push({ key: `${c.computer}/${child.id}`, computer: c.computer, group: g, child });
      }
    }
  }
  return rows;
}

let retry = 1000;
const states = new Map(); // computer -> state, to refresh capabilities on reconnect

/** Open the overview socket; reconnects with backoff. Call once. */
export function connectStore() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/overview`);
  ws.addEventListener("open", () => { retry = 1000; });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "overview") return;
    merged = msg.merged;
    for (const c of merged?.computers ?? []) {
      if (c.state === "online" && states.get(c.computer) !== "online") capabilities.delete(c.computer);
      states.set(c.computer, c.state);
    }
    for (const fn of listeners) {
      try { fn(merged); } catch (err) { console.error(err); }
    }
  });
  ws.addEventListener("close", () => {
    setTimeout(connectStore, retry);
    retry = Math.min(retry * 2, 10000);
  });
}

/** The project name a session row shows: the last folder of its working directory. */
export function projectOf(child) {
  return (child.cwd ?? "").split("/").filter(Boolean).pop() ?? child.label ?? "";
}
