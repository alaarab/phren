import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSpeechVoice, DEFAULT_SPEECH_VOICE, listSpeechVoices, readStoredVoice, resolveSpeechVoice, writeSpeechVoice } from "./speech-voice.js";

describe("the talk-mode voice setting", () => {
  let root: string, file: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-voice-")); file = path.join(root, "speech.json"); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("uses the default on a new computer, and a stored voice once set", async () => {
    expect(await resolveSpeechVoice(undefined, { env: {}, file })).toEqual({ voice: DEFAULT_SPEECH_VOICE, source: "default" });
    await writeSpeechVoice(" S9EGwlCtMF7VXtENq79v ", file);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await resolveSpeechVoice(undefined, { env: {}, file })).toEqual({ voice: "S9EGwlCtMF7VXtENq79v", source: "setting" });
    expect(await resolveSpeechVoice("UgBBYS2sOqTuMpoF3BR0", { env: {}, file })).toEqual({ voice: "UgBBYS2sOqTuMpoF3BR0", source: "request" });
    await clearSpeechVoice(file);
    expect(await readStoredVoice(file)).toBeUndefined();
  });

  // 2026-09-28: the owner's voice lived only in PHREN_SPEECH_VOICE in the
  // service environment, and an update that rewrote the plist dropped it.
  it("moves the old environment override into the setting, which then wins", async () => {
    const env = { PHREN_SPEECH_VOICE: "S9EGwlCtMF7VXtENq79v" };
    expect(await resolveSpeechVoice(undefined, { env, file })).toEqual({ voice: "S9EGwlCtMF7VXtENq79v", source: "environment" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ voice: "S9EGwlCtMF7VXtENq79v" });
    expect(await resolveSpeechVoice(undefined, { env: {}, file })).toEqual({ voice: "S9EGwlCtMF7VXtENq79v", source: "setting" });
    expect(await resolveSpeechVoice(undefined, { env: { PHREN_SPEECH_VOICE: "UgBBYS2sOqTuMpoF3BR0" }, file })).toMatchObject({ source: "setting" });
  });

  it("refuses anything that is not an ElevenLabs voice id", async () => {
    for (const bad of ["", "short", "../../v1/user", "S9EGwlCtMF7VXtENq79v?x=1"]) {
      await expect(writeSpeechVoice(bad, file)).rejects.toThrow();
      await expect(resolveSpeechVoice(bad || "x", { env: {}, file })).rejects.toThrow();
    }
    expect(await resolveSpeechVoice(undefined, { env: { PHREN_SPEECH_VOICE: "not a voice" }, file })).toMatchObject({ source: "default" });
  });

  it("lists the account's voices by name with only id, name, category and description", async () => {
    const fetcher = (async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.elevenlabs.io/v1/voices");
      expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("sk_test");
      return Response.json({ voices: [
        { voice_id: "UgBBYS2sOqTuMpoF3BR0", name: "Mark", category: "professional", description: "Natural conversations", samples: [{ secret: 1 }] },
        { voice_id: "S9EGwlCtMF7VXtENq79v", name: "Emma Taylor", category: "generated", labels: { accent: "british" } },
        { voice_id: "../bad", name: "Nope" }, { voice_id: "SAz9YHcvj6GT2YYXdXww" },
      ] });
    }) as typeof fetch;
    expect(await listSpeechVoices("sk_test", fetcher)).toEqual([
      { id: "S9EGwlCtMF7VXtENq79v", name: "Emma Taylor", category: "generated" },
      { id: "UgBBYS2sOqTuMpoF3BR0", name: "Mark", category: "professional", description: "Natural conversations" },
    ]);
    await expect(listSpeechVoices("sk_test", (async () => new Response("", { status: 401 })) as typeof fetch)).rejects.toThrow("refused this computer's key");
  });
});
