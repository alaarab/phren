import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { homeDir } from "../home-paths.js";
import { atomic, bridgeRoot } from "./protocol.js";

/** The ElevenLabs key for spoken replies and Scribe dictation. It is machine
 * config, like apns.json: it lives in the Hook's own directory, mode 600, and
 * never in the synced store. ELEVENLABS_API_KEY, ElevenLabs' own convention
 * that its SDKs and MCP server read, wins when set. The Hook runs as a service
 * that doesn't see shell env, so the file is the durable source. */

export const SPEECH_KEY_ENV = "ELEVENLABS_API_KEY";

export type SpeechKeySource = "environment" | "file";

export function speechKeyFile(): string {
  return path.join(bridgeRoot(), "elevenlabs.json");
}

/** Where the key lived before phren kept its own: the mina trailer config. It
 * is read once to migrate and never written or deleted. */
export function legacySpeechKeyFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(homeDir(env), ".config", "mina-trailer.json");
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

type Stored = { state: "missing" } | { state: "unsafe" | "invalid" } | { state: "ok"; key: string };

/** The stored key. A file other users can read is refused, as apns.json is. */
async function readStored(file: string): Promise<Stored> {
  let info;
  try { info = await stat(file); } catch { return { state: "missing" }; }
  if (!info.isFile()) return { state: "invalid" };
  if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))) return { state: "unsafe" };
  try {
    const key = clean((JSON.parse(await readFile(file, "utf8")) as { apiKey?: unknown }).apiKey);
    return key ? { state: "ok", key } : { state: "invalid" };
  } catch { return { state: "invalid" }; }
}

async function readLegacy(file: string): Promise<string | undefined> {
  try {
    return clean((JSON.parse(await readFile(file, "utf8")) as { elevenlabs_api_key?: unknown }).elevenlabs_api_key);
  } catch { return undefined; }
}

export async function writeSpeechKey(key: string, file = speechKeyFile()): Promise<void> {
  const value = clean(key);
  if (!value) throw new Error("The ElevenLabs key is empty.");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomic(file, JSON.stringify({ apiKey: value }) + "\n", 0o600);
}

export interface SpeechKeyPaths { env?: NodeJS.ProcessEnv; file?: string; legacy?: string }

/** ELEVENLABS_API_KEY, else the stored key. When nothing is stored yet and the
 * mina trailer config has a key, it is copied here once and read from here
 * after. */
export async function resolveSpeechKey(paths: SpeechKeyPaths = {}): Promise<{ key: string; source: SpeechKeySource } | undefined> {
  const env = paths.env ?? process.env;
  const fromEnv = clean(env[SPEECH_KEY_ENV]);
  if (fromEnv) return { key: fromEnv, source: "environment" };
  const file = paths.file ?? speechKeyFile();
  const stored = await readStored(file);
  if (stored.state === "ok") return { key: stored.key, source: "file" };
  if (stored.state !== "missing") return undefined;
  const legacy = await readLegacy(paths.legacy ?? legacySpeechKeyFile(env));
  if (!legacy) return undefined;
  try { await writeSpeechKey(legacy, file); } catch { /* use it this once; the next call tries again */ }
  return { key: legacy, source: "file" };
}

export async function readSpeechKey(): Promise<string | undefined> {
  return (await resolveSpeechKey())?.key;
}

export interface SpeechKeyStatus { configured: boolean; detail: string; problem?: boolean }

/** Whether this computer has a key, for doctor. Never the key itself, and it
 * doesn't migrate: a read-only check. */
export async function speechKeyStatus(paths: SpeechKeyPaths = {}): Promise<SpeechKeyStatus> {
  const env = paths.env ?? process.env;
  const file = paths.file ?? speechKeyFile();
  const stored = await readStored(file);
  const setup = "run `phren bridge speech-key set` and paste the key";
  if (clean(env[SPEECH_KEY_ENV])) {
    return stored.state === "ok"
      ? { configured: true, detail: `${SPEECH_KEY_ENV} is set and a key is stored in ${file}` }
      : { configured: true, detail: `${SPEECH_KEY_ENV} is set in this shell; the Hook service doesn't see shell env, so ${setup} to store it` };
  }
  switch (stored.state) {
    case "ok": return { configured: true, detail: `stored in ${file}` };
    case "unsafe": return { configured: false, problem: true, detail: `${file} is readable by other users; run chmod 600 on it` };
    case "invalid": return { configured: false, problem: true, detail: `${file} has no apiKey; ${setup}` };
  }
  const legacy = paths.legacy ?? legacySpeechKeyFile(env);
  if (await readLegacy(legacy)) {
    return { configured: true, detail: `not stored yet; the Hook copies it from ${legacy} on first use` };
  }
  return { configured: false, detail: `no ElevenLabs key, so spoken replies and Scribe dictation are off; ${setup}` };
}
