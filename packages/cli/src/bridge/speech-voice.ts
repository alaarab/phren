import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomic, BridgeError, bridgeRoot } from "./protocol.js";

/** The ElevenLabs voice talk mode speaks with. A new computer uses the
 * built-in default; `phren bridge speech-voice set <id>` stores another in
 * the Hook's own directory, next to the speech key, where install and update
 * leave it alone. The phone may name a voice per request, which wins. */

/** River: relaxed, neutral and informative, ElevenLabs' premade voice. */
export const DEFAULT_SPEECH_VOICE = "SAz9YHcvj6GT2YYXdXww";
/** The environment override from before the setting existed. It is read only
 * when nothing is stored, and copied into the setting then. */
export const SPEECH_VOICE_ENV = "PHREN_SPEECH_VOICE";

/** An ElevenLabs voice id: letters and digits (20 today). */
export const voiceId = z.string().trim().regex(/^[A-Za-z0-9]{10,40}$/, "An ElevenLabs voice id is 10 to 40 letters and digits.");

export function speechVoiceFile(): string {
  return path.join(bridgeRoot(), "speech.json");
}

export async function readStoredVoice(file = speechVoiceFile()): Promise<string | undefined> {
  try {
    const parsed = voiceId.safeParse((JSON.parse(await readFile(file, "utf8")) as { voice?: unknown }).voice);
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

export async function writeSpeechVoice(voice: string, file = speechVoiceFile()): Promise<string> {
  const value = voiceId.parse(voice);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomic(file, JSON.stringify({ voice: value }) + "\n", 0o600);
  return value;
}

export async function clearSpeechVoice(file = speechVoiceFile()): Promise<void> {
  await rm(file, { force: true });
}

export type SpeechVoiceSource = "request" | "setting" | "environment" | "default";

/** The voice to speak with: the request's own, the stored setting, the old
 * environment override (copied into the setting on first use), else the
 * default. */
export async function resolveSpeechVoice(requested?: string, paths: { env?: NodeJS.ProcessEnv; file?: string } = {}): Promise<{ voice: string; source: SpeechVoiceSource }> {
  if (requested) return { voice: voiceId.parse(requested), source: "request" };
  const file = paths.file ?? speechVoiceFile();
  const stored = await readStoredVoice(file);
  if (stored) return { voice: stored, source: "setting" };
  const legacy = voiceId.safeParse((paths.env ?? process.env)[SPEECH_VOICE_ENV]);
  if (legacy.success) {
    await writeSpeechVoice(legacy.data, file).catch(() => { /* used this once; the next call tries again */ });
    return { voice: legacy.data, source: "environment" };
  }
  return { voice: DEFAULT_SPEECH_VOICE, source: "default" };
}

export interface SpeechVoiceChoice { id: string; name: string; category?: string; description?: string }

/** The voices this computer's ElevenLabs account can speak with, for the
 * phone's picker: id, name and a short description, never the account's
 * other details. */
export async function listSpeechVoices(key: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<SpeechVoiceChoice[]> {
  let upstream: Response;
  try {
    upstream = await fetcher("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key }, signal });
  } catch {
    throw new BridgeError(502, "Couldn't reach ElevenLabs from this computer.", { code: "speech-unreachable" });
  }
  if (upstream.status === 401 || upstream.status === 403) throw new BridgeError(502, "ElevenLabs refused this computer's key.", { code: "speech-rejected" });
  if (!upstream.ok) throw new BridgeError(502, `ElevenLabs failed (HTTP ${upstream.status}).`, { code: "speech-failed" });
  let body: { voices?: unknown };
  try { body = (await upstream.json()) as { voices?: unknown }; } catch {
    throw new BridgeError(502, "ElevenLabs sent an unreadable reply.", { code: "speech-failed" });
  }
  const text = (value: unknown, max: number) => typeof value === "string" && value.trim() ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max) : undefined;
  const voices: SpeechVoiceChoice[] = [];
  for (const raw of Array.isArray(body.voices) ? body.voices.slice(0, 500) : []) {
    const item = raw as Record<string, unknown>;
    const id = voiceId.safeParse(item.voice_id), name = text(item.name, 120);
    if (!id.success || !name) continue;
    const category = text(item.category, 40), description = text(item.description, 240);
    voices.push({ id: id.data, name, ...(category ? { category } : {}), ...(description ? { description } : {}) });
  }
  return voices.sort((a, b) => a.name.localeCompare(b.name));
}
