import { readFile } from "node:fs/promises";
import type { BrowserWatch, Json } from "./protocol.js";

interface Entry { at: number; value: BrowserWatch }
const cache = new Map<number, Entry>();
const launched = new Map<number, number>();
interface Launch { terminal: unknown; source: unknown; pid: number; session?: string }
const panes = new Map<string, Launch>();
const paneKey = (server: string, pane: unknown) => JSON.stringify([server, pane]);
const TTL = 30_000;

/** Successful Hook launches provide evidence without inspecting an environment. */
export function noteBrowserLaunch(pids: readonly number[], env: Record<string, string> | undefined, place?: { server: string; pane: Json }): void {
  if (!env?.PHREN_BROWSER_SOCKET || env.PHREN_BROWSER_WATCH === "0" || !env.PHREN_BROWSER_SESSION || !env.NODE_OPTIONS?.includes("--require=")) return;
  if (place && pids[0] && place.pane.terminal_id) {
    if (panes.size >= 512) panes.delete(panes.keys().next().value!);
    panes.set(paneKey(place.server, place.pane.pane_id), { terminal: place.pane.terminal_id, source: place.pane.agent, pid: pids[0] });
  }
  for (const pid of pids) {
    if (launched.size >= 512) launched.delete(launched.keys().next().value!);
    launched.set(pid, Date.now());
  }
}

/** Never await process inspection on a session-list path. Only inspect the
 * agent PID the caller already resolved; no ps subprocesses on macOS. */
export function browserWatch(pid: number | undefined): BrowserWatch {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  const now = Date.now();
  const launch = launched.get(pid);
  // Bare PID evidence expires to bound PID reuse; pane-bound evidence below
  // also checks the terminal, harness and conversation.
  if (launch !== undefined && now - launch < TTL) {
    try { process.kill(pid, 0); return "on"; } catch { launched.delete(pid); }
  }
  launched.delete(pid);
  const entry = cache.get(pid);
  if (entry && now - entry.at < TTL) return entry.value;
  if (process.platform !== "linux") return "unknown";
  if (cache.size >= 512) cache.delete(cache.keys().next().value!);
  const next: Entry = { at: now, value: "unknown" };
  cache.set(pid, next);
  void readFile(`/proc/${pid}/environ`, "utf8").then(text => {
    const env = Object.fromEntries(text.split("\0").filter(Boolean).map(line => {
      const eq = line.indexOf("="); return [line.slice(0, eq), line.slice(eq + 1)];
    }));
    next.value = env.PHREN_BROWSER_SOCKET && env.PHREN_BROWSER_SESSION
      && env.NODE_OPTIONS?.includes("--require=") && env.PHREN_BROWSER_WATCH !== "0" ? "on" : "off";
  }, () => { /* Permission denied or exited: unknown, never off. */ });
  return next.value;
}

/** A reported conversation can skip PID lookup. Reuse only this launch's
 * terminal, harness and conversation; a replacement retires the evidence. */
export function paneBrowserWatch(server: string, pane: Json, session: string | undefined, pid?: number): BrowserWatch {
  const key = paneKey(server, pane.pane_id), launch = panes.get(key);
  if (launch) {
    if (launch.terminal !== pane.terminal_id || launch.source !== pane.agent
      || (pid !== undefined && pid !== launch.pid) || (launch.session && session && launch.session !== session)) {
      panes.delete(key);
      launched.delete(launch.pid);
    } else {
      launch.session ??= session;
      try { process.kill(launch.pid, 0); return "on"; }
      catch { panes.delete(key); launched.delete(launch.pid); }
    }
  }
  return browserWatch(pid);
}
