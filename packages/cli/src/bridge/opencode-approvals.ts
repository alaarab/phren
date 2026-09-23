import { lstatSync, readFileSync } from "node:fs";
import { lstat, opendir, readFile } from "node:fs/promises";
import path from "node:path";
import { object, type Json } from "./protocol.js";
import { phrenStoreRoot } from "./transcripts.js";

/** The request and answer files the opencode plugin and the Hook exchange for
 * an opencode permission ask, under the store's `.runtime/approvals`. */

const opencodeSession = /^ses_[0-9A-Za-z]{1,64}$/;
export function opencodeApprovalFile(session: string, kind: "request" | "answer"): string | undefined {
  if (!opencodeSession.test(session)) return undefined;
  return path.join(phrenStoreRoot(), ".runtime", "approvals", `opencode-${session}.${kind}.json`);
}
export async function* directoryNames(directory: string, limit: number): AsyncGenerator<string> {
  const entries = await opendir(directory).catch(() => undefined);
  if (!entries) return;
  let count = 0;
  for await (const entry of entries) {
    if (count++ >= limit) break;
    yield entry.name;
  }
}

function validRequest(value: Json, session: string): Json | undefined {
  if (typeof value.id !== "string" || !value.id || value.sessionID !== session) return undefined;
  if (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) return undefined;
  return value;
}

export function opencodeRequest(session: string): Json | undefined {
  const file = opencodeApprovalFile(session, "request");
  if (!file) return undefined;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 65_536) return undefined;
    return validRequest(object(JSON.parse(readFileSync(file, "utf8"))), session);
  } catch { return undefined; }
}

/** `opencodeRequest` without blocking the event loop, for the background sweep. */
export async function readOpencodeRequest(session: string): Promise<Json | undefined> {
  const file = opencodeApprovalFile(session, "request");
  if (!file) return undefined;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 65_536) return undefined;
    return validRequest(object(JSON.parse(await readFile(file, "utf8"))), session);
  } catch { return undefined; }
}
