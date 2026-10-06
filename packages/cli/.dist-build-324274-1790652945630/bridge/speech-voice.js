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
export function speechVoiceFile() {
    return path.join(bridgeRoot(), "speech.json");
}
/** Everything `speech.json` holds; a write keeps the keys it doesn't touch. */
async function readSettings(file) {
    try {
        const parsed = JSON.parse(await readFile(file, "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
/** Sets or removes one key of `speech.json`; the file goes when it is empty. */
async function updateSettings(file, key, value) {
    const settings = await readSettings(file);
    if (value === undefined)
        delete settings[key];
    else
        settings[key] = value;
    if (!Object.keys(settings).length) {
        await rm(file, { force: true });
        return;
    }
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await atomic(file, JSON.stringify(settings) + "\n", 0o600);
}
export async function readStoredVoice(file = speechVoiceFile()) {
    const parsed = voiceId.safeParse((await readSettings(file)).voice);
    return parsed.success ? parsed.data : undefined;
}
export async function writeSpeechVoice(voice, file = speechVoiceFile()) {
    const value = voiceId.parse(voice);
    await updateSettings(file, "voice", value);
    return value;
}
export async function clearSpeechVoice(file = speechVoiceFile()) {
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
export async function readStoredModel(file = speechVoiceFile()) {
    const parsed = speechModelId.safeParse((await readSettings(file)).model);
    return parsed.success ? parsed.data : undefined;
}
export async function writeSpeechModel(model, file = speechVoiceFile()) {
    const value = speechModelId.parse(model);
    await updateSettings(file, "model", value);
    return value;
}
export async function clearSpeechModel(file = speechVoiceFile()) {
    await updateSettings(file, "model", undefined);
}
/** The stored model, else v4 Turbo. Read on every reply, so a change needs
 * no Hook restart. */
export async function resolveSpeechModel(file = speechVoiceFile()) {
    const stored = await readStoredModel(file);
    return stored ? { model: stored, source: "setting" } : { model: DEFAULT_SPEECH_MODEL, source: "default" };
}
/** The voice to speak with: the request's own, the stored setting, the old
 * environment override (copied into the setting on first use), else the
 * default. */
export async function resolveSpeechVoice(requested, paths = {}) {
    if (requested)
        return { voice: voiceId.parse(requested), source: "request" };
    const file = paths.file ?? speechVoiceFile();
    const stored = await readStoredVoice(file);
    if (stored)
        return { voice: stored, source: "setting" };
    const legacy = voiceId.safeParse((paths.env ?? process.env)[SPEECH_VOICE_ENV]);
    if (legacy.success) {
        await writeSpeechVoice(legacy.data, file).catch(() => { });
        return { voice: legacy.data, source: "environment" };
    }
    return { voice: DEFAULT_SPEECH_VOICE, source: "default" };
}
/** The voices this computer's ElevenLabs account can speak with, for the
 * phone's picker: id, name and a short description, never the account's
 * other details. */
export async function listSpeechVoices(key, fetcher = fetch, signal) {
    let upstream;
    try {
        upstream = await fetcher("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key }, signal });
    }
    catch {
        throw new BridgeError(502, "Couldn't reach ElevenLabs from this computer.", { code: "speech-unreachable" });
    }
    if (upstream.status === 401 || upstream.status === 403)
        throw new BridgeError(502, "ElevenLabs refused this computer's key.", { code: "speech-rejected" });
    if (!upstream.ok)
        throw new BridgeError(502, `ElevenLabs failed (HTTP ${upstream.status}).`, { code: "speech-failed" });
    let body;
    try {
        body = (await upstream.json());
    }
    catch {
        throw new BridgeError(502, "ElevenLabs sent an unreadable reply.", { code: "speech-failed" });
    }
    const text = (value, max) => typeof value === "string" && value.trim() ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max) : undefined;
    const voices = [];
    for (const raw of Array.isArray(body.voices) ? body.voices.slice(0, 500) : []) {
        const item = raw;
        const id = voiceId.safeParse(item.voice_id), name = text(item.name, 120);
        if (!id.success || !name)
            continue;
        const category = text(item.category, 40), description = text(item.description, 240);
        voices.push({ id: id.data, name, ...(category ? { category } : {}), ...(description ? { description } : {}) });
    }
    return voices.sort((a, b) => a.name.localeCompare(b.name));
}
