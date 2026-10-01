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

/** Everything `speech.json` holds; a write keeps the keys it doesn't touch. */
async function readSettings(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/** Sets or removes one key of `speech.json`; the file goes when it is empty. */
async function updateSettings(file: string, key: string, value: string | undefined): Promise<void> {
  const settings = await readSettings(file);
  if (value === undefined) delete settings[key]; else settings[key] = value;
  if (!Object.keys(settings).length) { await rm(file, { force: true }); return; }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomic(file, JSON.stringify(settings) + "\n", 0o600);
}

export async function readStoredVoice(file = speechVoiceFile()): Promise<string | undefined> {
  const parsed = voiceId.safeParse((await readSettings(file)).voice);
  return parsed.success ? parsed.data : undefined;
}

export async function writeSpeechVoice(voice: string, file = speechVoiceFile()): Promise<string> {
  const value = voiceId.parse(voice);
  await updateSettings(file, "voice", value);
  return value;
}

export async function clearSpeechVoice(file = speechVoiceFile()): Promise<void> {
  await updateSettings(file, "voice", undefined);
}

/** The ElevenLabs model talk mode speaks with. It sits in the same
 * `speech.json` as the voice (`phren bridge speech-model set <id>`), so
 * install and update leave it alone too. Unset, it is v4 Turbo; speech.ts
 * drops to Flash v2.5 on its own while the chosen model fails or is slow. */
export const DEFAULT_SPEECH_MODEL = "eleven_v4_turbo";
/** ElevenLabs' lowest-latency model: the fallback. */
export const FALLBACK_SPEECH_MODEL = "eleven_flash_v2_5";

/** An ElevenLabs model id, e.g. eleven_v4_turbo or eleven_flash_v2_5. */
export const speechModelId = z.string().trim().regex(/^[a-z0-9][a-z0-9_]{2,63}$/, "An ElevenLabs model id is 3 to 64 lowercase letters, digits and underscores, e.g. eleven_v4_turbo.");

export async function readStoredModel(file = speechVoiceFile()): Promise<string | undefined> {
  const parsed = speechModelId.safeParse((await readSettings(file)).model);
  return parsed.success ? parsed.data : undefined;
}

export async function writeSpeechModel(model: string, file = speechVoiceFile()): Promise<string> {
  const value = speechModelId.parse(model);
  await updateSettings(file, "model", value);
  return value;
}

export async function clearSpeechModel(file = speechVoiceFile()): Promise<void> {
  await updateSettings(file, "model", undefined);
}

/** The stored model, else v4 Turbo. Read on every reply, so a change needs
 * no Hook restart. */
export async function resolveSpeechModel(file = speechVoiceFile()): Promise<{ model: string; source: "setting" | "default" }> {
  const stored = await readStoredModel(file);
  return stored ? { model: stored, source: "setting" } : { model: DEFAULT_SPEECH_MODEL, source: "default" };
}

/** Where this computer reaches ElevenLabs. `global` is api.elevenlabs.io,
 * which routes to the nearest region; `us` is ElevenLabs' US-only endpoint.
 * `phren bridge speech-region us|global` stores it in the same `speech.json`
 * as the voice and model; unset is global. Read on every reply. */
export const SPEECH_REGIONS = { global: "https://api.elevenlabs.io", us: "https://api.us.elevenlabs.io" } as const;
export type SpeechRegion = keyof typeof SPEECH_REGIONS;
export const DEFAULT_SPEECH_REGION: SpeechRegion = "global";
export const speechRegion = z.enum(Object.keys(SPEECH_REGIONS) as [SpeechRegion, ...SpeechRegion[]]);

export async function resolveSpeechRegion(file = speechVoiceFile()): Promise<{ region: SpeechRegion; origin: string; source: "setting" | "default" }> {
  const parsed = speechRegion.safeParse((await readSettings(file)).region);
  const region = parsed.success ? parsed.data : DEFAULT_SPEECH_REGION;
  return { region, origin: SPEECH_REGIONS[region], source: parsed.success ? "setting" : "default" };
}

/** Global is the default, so choosing it removes the key. */
export async function writeSpeechRegion(region: string, file = speechVoiceFile()): Promise<SpeechRegion> {
  const value = speechRegion.parse(region);
  await updateSettings(file, "region", value === DEFAULT_SPEECH_REGION ? undefined : value);
  return value;
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
export async function listSpeechVoices(key: string, fetcher: typeof fetch = fetch, signal?: AbortSignal, origin?: string): Promise<SpeechVoiceChoice[]> {
  let upstream: Response;
  try {
    upstream = await fetcher(`${origin ?? (await resolveSpeechRegion()).origin}/v1/voices`, { headers: { "xi-api-key": key }, signal });
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
