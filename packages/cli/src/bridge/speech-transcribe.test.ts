import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { relayTranscription, transcribeURL, type RelaySocket } from "./speech-transcribe.js";

class FakeSocket extends EventEmitter implements RelaySocket {
  readyState = 1;
  sent: string[] = [];
  closed?: { code?: number; reason?: string };
  send(data: string) { this.sent.push(data); }
  close(code?: number, reason?: string) { if (this.readyState !== 1) return; this.readyState = 3; this.closed = { code, reason }; this.emit("close"); }
}
const frames = (socket: FakeSocket) => socket.sent.map(frame => JSON.parse(frame));
const settle = () => new Promise(resolve => setImmediate(resolve));

describe("Scribe transcription relay", () => {
  it("builds the realtime URL with VAD, the language and the vocabulary as keyterms", () => {
    const url = new URL(transcribeURL(new URLSearchParams([["language", "en"], ["keyterm", "phren"], ["keyterm", "Herdr"], ["keyterm", "phren"], ["keyterm", "x".repeat(60)]])));
    expect(url.origin + url.pathname).toBe("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    expect(url.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(url.searchParams.get("audio_format")).toBe("pcm_16000");
    expect(url.searchParams.get("commit_strategy")).toBe("vad");
    expect(url.searchParams.get("language_code")).toBe("en");
    expect(url.searchParams.getAll("keyterms")).toEqual(["phren", "Herdr"]);
    expect(new URL(transcribeURL(new URLSearchParams([["language", "../x"]]))).searchParams.has("language_code")).toBe(false);
  });

  it("forwards audio (held until ElevenLabs answers), relays partial and committed text, and commits on the phone's stop", async () => {
    const client = new FakeSocket(), upstream = new FakeSocket();
    upstream.readyState = 0;
    let used = "";
    await relayTranscription(client, new URLSearchParams(), { key: async () => "sk-test", connect: (_url, key) => { used = key; return upstream; } });
    expect(used).toBe("sk-test");
    client.emit("message", Buffer.from([1, 2, 3, 4]), true);
    expect(upstream.sent).toEqual([]);
    upstream.readyState = 1; upstream.emit("open");
    client.emit("message", Buffer.from([5, 6]), true);
    expect(frames(upstream).map(frame => [frame.message_type, frame.audio_base_64, frame.commit])).toEqual([
      ["input_audio_chunk", Buffer.from([1, 2, 3, 4]).toString("base64"), false],
      ["input_audio_chunk", Buffer.from([5, 6]).toString("base64"), false],
    ]);
    upstream.emit("message", Buffer.from(JSON.stringify({ message_type: "partial_transcript", text: "rebase onto" })), false);
    upstream.emit("message", Buffer.from(JSON.stringify({ message_type: "committed_transcript", text: "Rebase onto main." })), false);
    expect(frames(client)).toEqual([{ type: "partial", text: "rebase onto" }, { type: "committed", text: "Rebase onto main." }]);
    client.emit("message", Buffer.from("{\"type\":\"commit\"}"), false);
    expect(frames(upstream).at(-1)).toMatchObject({ commit: true, audio_base_64: "" });
    client.close();
    await settle();
    expect(upstream.readyState).toBe(3);
  });

  it("never sends ElevenLabs' own error text, and says so when there is no key", async () => {
    const client = new FakeSocket(), upstream = new FakeSocket();
    await relayTranscription(client, new URLSearchParams(), { key: async () => "sk-test", connect: () => upstream });
    upstream.emit("message", Buffer.from(JSON.stringify({ message_type: "insufficient_audio_activity", error: "quiet" })), false);
    expect(client.sent).toEqual([]);
    upstream.emit("message", Buffer.from(JSON.stringify({ message_type: "auth_error", error: "key sk-test is invalid" })), false);
    expect(frames(client)).toEqual([{ type: "error", code: "transcribe-rejected", error: "ElevenLabs refused this computer's key." }]);
    expect(client.sent.join()).not.toContain("sk-test");
    expect(client.closed?.code).toBe(1011);

    const unkeyed = new FakeSocket();
    await relayTranscription(unkeyed, new URLSearchParams(), { key: async () => undefined, connect: () => { throw new Error("must not connect"); } });
    expect(frames(unkeyed)).toEqual([{ type: "error", code: "transcribe-unconfigured", error: "This computer has no ElevenLabs key." }]);
    expect(unkeyed.closed?.code).toBe(1008);
  });
});
