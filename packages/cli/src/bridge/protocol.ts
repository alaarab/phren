import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { isRecord } from "../phren-core.js";

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
/** `value` when it is a plain object, else an empty one. */
export function object(value: unknown): Json { return isRecord(value) ? value : {}; }
export function objects(value: unknown): Json[] { return Array.isArray(value) ? value.map(object) : []; }
export function bridgeRoot(): string { return process.env.PHREN_BRIDGE_HOME || path.join(homedir(), ".local/share/phren/bridge"); }
export function socketPath(): string { return path.join(bridgeRoot(), "hook.sock"); }
export class BridgeError extends Error {
  constructor(public status: number, message: string, public details?: Json) { super(message); }
}

/**
 * Why a computer's Herdr or a linked peer could not be reached, as a stable
 * `code` beside the human `error` text, so a client can explain the offline
 * state without matching sentences. See docs/phren-hook.md#offline-reasons.
 */
export type OfflineCode =
  | "herdr-not-running" | "herdr-stale-socket" | "herdr-permission" | "herdr-unreachable" | "herdr-timeout"
  | "ssh-unavailable" | "dispatch-key-missing" | "peer-offline" | "peer-timeout" | "peer-key-not-enrolled" | "peer-host-key-mismatch";

const ERROR_CODE = /^[a-z][a-z0-9-]{0,39}$/;

/** The machine-readable `code` an error carries, if any. */
export function errorCode(error: unknown): string | undefined {
  const code = error instanceof BridgeError ? error.details?.code : undefined;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : undefined;
}

/** A BridgeError that keeps `error`'s status and text and adds `code` when it has none yet. */
export function withErrorCode(error: BridgeError, code: OfflineCode): BridgeError {
  return errorCode(error) ? error : new BridgeError(error.status, error.message, { ...(error.details ?? {}), code });
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
    await renameOver(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/**
 * Windows refuses to replace a file another handle holds open (a concurrent
 * reader, or another writer's rename landing at the same moment) with EPERM,
 * EACCES or EBUSY, where POSIX replaces it atomically. Those holds last
 * milliseconds, so retry briefly before giving up.
 */
async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 5 * (attempt + 1)));
    }
  }
}

/** {@link atomic}, first creating the file's directory (0700 where it is new). */
export async function atomicInPrivateDir(file: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomic(file, value, mode);
}

export function targetFromURL(url: URL): Target {
  return targetSchema.parse(Object.fromEntries(["server", "workspace", "tab", "pane", "source", "session"].map(k => [k, url.searchParams.get(k)])));
}
