import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

export const PROTOCOL = 1;
export const MAX_FRAME = 8 * 1024 * 1024;
export const id = z.string().regex(/^[A-Za-z0-9_%:.-]{1,200}$/);
export const serverName = z.string().regex(/^(?!\.\.?$)[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/);
export const computerName = serverName.refine(name => name !== "anywhere", "anywhere is reserved for scheduling");
export const provider = z.enum(["codex", "claude", "copilot", "phren", "opencode"]);
export type Provider = z.infer<typeof provider>;
export const sessionId = z.union([
  z.string().uuid(),
  z.string().regex(/^ses_[0-9A-Za-z]{1,64}$/),
]);
export const targetSchema = z.object({
  server: serverName,
  workspace: id,
  tab: id,
  pane: id,
  source: provider,
  session: sessionId,
});
export type Target = z.infer<typeof targetSchema>;
// Only /v1/prompt accepts a transcript-less target. All transcript, image,
// approval and diff routes retain the session-bound schema above.
export const startingTargetSchema = targetSchema.omit({ session: true }).extend({
  starting: z.literal(true), startingToken: z.string().regex(/^[a-f0-9]{64}$/),
});
export type StartingTarget = z.infer<typeof startingTargetSchema>;
export type Json = Record<string, unknown>;
export function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}
export function objects(value: unknown): Json[] { return Array.isArray(value) ? value.map(object) : []; }
export function bridgeRoot(): string { return process.env.PHREN_BRIDGE_HOME || path.join(homedir(), ".local/share/phren/bridge"); }
export function socketPath(): string { return path.join(bridgeRoot(), "hook.sock"); }
export class BridgeError extends Error {
  constructor(public status: number, message: string, public details?: Json) { super(message); }
}
export const requestID = () => randomUUID();

/**
 * Write a file atomically: serialize to a fresh temp name, then rename it over
 * the target so a reader never observes a partial file. `value` may be
 * pre-serialized text or any JSON-serializable value. The default mode is 0600
 * because every caller writes per-user state.
 */
export async function atomic(file: string, value: unknown, mode = 0o600): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  await writeFile(temporary, text, { mode, flag: "wx" });
  try {
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export function targetFromURL(url: URL): Target {
  return targetSchema.parse(Object.fromEntries(["server", "workspace", "tab", "pane", "source", "session"].map(k => [k, url.searchParams.get(k)])));
}
