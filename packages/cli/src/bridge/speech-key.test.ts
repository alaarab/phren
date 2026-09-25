import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTestPhrenRoot } from "../test-helpers.js";
import { resolveSpeechKey, speechKeyFile } from "./speech-key.js";

const KEY = "sk_test_do_not_leak_0123456789";
const OTHER = "sk_test_env_do_not_leak_9876543210";

let home: string;
let file: string;
let legacy: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "phren-speech-key-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
  file = speechKeyFile();
  legacy = path.join(home, ".config", "mina-trailer.json");
  await mkdir(path.dirname(legacy), { recursive: true });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

async function store(value: unknown, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value), { mode });
  await chmod(file, mode);
}
const resolve = (env: NodeJS.ProcessEnv = {}) => resolveSpeechKey({ env: { HOME: home, ...env }, file, legacy });

describe("ElevenLabs key resolution", () => {
  it("prefers ELEVENLABS_API_KEY, then elevenlabs.json {apiKey} in the Hook's directory", async () => {
    expect(file).toBe(path.join(home, "bridge", "elevenlabs.json"));
    await store({ apiKey: ` ${KEY} ` });
    expect(await resolve()).toEqual({ key: KEY, source: "file" });
    expect(await resolve({ ELEVENLABS_API_KEY: "  " })).toEqual({ key: KEY, source: "file" });
    expect(await resolve({ ELEVENLABS_API_KEY: OTHER })).toEqual({ key: OTHER, source: "environment" });
  });

  it.skipIf(process.platform === "win32")("refuses a stored key other users can read, and doesn't migrate over it", async () => {
    await store({ apiKey: KEY }, 0o644);
    await writeFile(legacy, JSON.stringify({ elevenlabs_api_key: OTHER }));
    expect(await resolve()).toBeUndefined();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ apiKey: KEY });
  });

  it("copies the mina-trailer key once with mode 600, then reads only the new file and leaves the old one", async () => {
    expect(await resolve()).toBeUndefined();
    await expect(stat(file)).rejects.toThrow();

    const original = JSON.stringify({ gemini_api_key: "other", elevenlabs_api_key: ` ${KEY} ` });
    await writeFile(legacy, original);
    expect(await resolve()).toEqual({ key: KEY, source: "file" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ apiKey: KEY });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(legacy, "utf8")).toBe(original);

    await writeFile(legacy, JSON.stringify({ elevenlabs_api_key: OTHER }));
    expect(await resolve()).toEqual({ key: KEY, source: "file" });
  });
});

describe("doctor's speech-key check", () => {
  it("says per state whether a key is configured, fails only a file others can read, and never prints the key", async () => {
    const phren = path.join(home, ".phren");
    await mkdir(phren, { recursive: true });
    initTestPhrenRoot(phren);
    vi.stubEnv("HOME", home);
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const { runDoctor } = await import("../link/doctor.js");
    const check = async () => {
      const result = await runDoctor(phren);
      expect(JSON.stringify(result)).not.toContain(KEY);
      return result.checks.find(item => item.name === "speech-key");
    };

    expect(await check()).toMatchObject({ ok: true, detail: expect.stringMatching(/^not configured: .*phren bridge speech-key set/) });
    await writeFile(legacy, JSON.stringify({ elevenlabs_api_key: KEY }));
    expect(await check()).toMatchObject({ ok: true, detail: expect.stringMatching(/^configured: not stored yet; .*mina-trailer\.json/) });
    await expect(stat(file)).rejects.toThrow();
    await store({ apiKey: KEY });
    expect(await check()).toMatchObject({ ok: true, detail: `configured: stored in ${file}` });
    if (process.platform !== "win32") {
      await chmod(file, 0o644);
      expect(await check()).toMatchObject({ ok: false, detail: expect.stringMatching(/readable by other users/) });
    }
  });
});
