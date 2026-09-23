import { readFile } from "node:fs/promises";
import path from "node:path";
import { bridgeRoot, object, serverName, sessionId, type Json } from "./protocol.js";

/** Small stores the agent callback socket keeps: the recorded pane binding
 * files, push-notification answer bindings, and overview watch leases. */

export const localSocket = () => path.join(bridgeRoot(), "agent.sock");
export const bindingPath = (server: string, pane: string) => path.join(bridgeRoot(), "bindings", encodeURIComponent(serverName.parse(server)), encodeURIComponent(pane) + ".json");
export async function recordedSession(server: string, pane: Json, pids: number[]): Promise<string | undefined> {
  try {
    const value = object(JSON.parse(await readFile(bindingPath(server, String(pane.pane_id)), "utf8")));
    if (value.terminal !== pane.terminal_id || value.source !== pane.agent || !Array.isArray(value.pids) || !value.pids.some(p => pids.includes(Number(p)))) return undefined;
    return sessionId.parse(value.session);
  } catch { return undefined; }
}

export interface PushBinding { action: string; expiresAt: number }
export class PushBindingStore {
  private values = new Map<string, PushBinding>();
  constructor(private now = Date.now, private limit = 128) {}
  add(binding: string, value: PushBinding) {
    for (const [key, item] of this.values) if (item.expiresAt <= this.now()) this.values.delete(key);
    while (this.values.size >= this.limit) this.values.delete(this.values.keys().next().value!);
    this.values.set(binding, value);
  }
  consume(binding: string): PushBinding | undefined {
    const value = this.values.get(binding); this.values.delete(binding);
    return value && value.expiresAt > this.now() ? value : undefined;
  }
  dropAction(action: string) { for (const [key, value] of this.values) if (value.action === action) this.values.delete(key); }
  clear() { this.values.clear(); }
  get size() { return this.values.size; }
}

/** An explicit foreground overview poll renews interest for a bounded interval.
 * A disconnected phone never leaves future terminal prompts waiting forever. */
export class ApprovalWatchLeases {
  private servers = new Map<string, number>();
  constructor(private now = Date.now) {}
  renew(server: string) {
    for (const [key, expiry] of this.servers) if (expiry <= this.now()) this.servers.delete(key);
    if (this.servers.has(server) || this.servers.size < 64) this.servers.set(server, this.now() + 25_000);
  }
  has(server: string) { return (this.servers.get(server) || 0) > this.now(); }
}
