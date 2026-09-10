import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

export const PROTOCOL = 1;
export const MAX_FRAME = 8 * 1024 * 1024;
export const id = z.string().regex(/^[A-Za-z0-9_%:.-]{1,200}$/);
export const serverName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
export const provider = z.enum(["codex", "claude", "copilot"]);
export type Provider = z.infer<typeof provider>;
export const targetSchema = z.object({
  server: serverName,
  workspace: id,
  tab: id,
  pane: id,
  source: provider,
  session: z.string().uuid(),
});
export type Target = z.infer<typeof targetSchema>;
export type Json = Record<string, unknown>;
export function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}
export function objects(value: unknown): Json[] { return Array.isArray(value) ? value.map(object) : []; }
export function bridgeRoot(): string { return process.env.PHREN_BRIDGE_HOME || path.join(homedir(), ".local/share/phren/bridge"); }
export function socketPath(): string { return path.join(bridgeRoot(), "hook.sock"); }
export class BridgeError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const requestID = () => randomUUID();

export function targetFromURL(url: URL): Target {
  return targetSchema.parse(Object.fromEntries(["server", "workspace", "tab", "pane", "source", "session"].map(k => [k, url.searchParams.get(k)])));
}
