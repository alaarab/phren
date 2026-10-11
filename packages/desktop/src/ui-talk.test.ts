import { describe, expect, it } from "vitest";
import {
  DEFAULT_SILENCE,
  TALK_PHASES,
  alignmentWords,
  createPcmResampler,
  createTurnState,
  decodeBase64,
  endsMidThought,
  hasWords,
  mergeTranscript,
  reduceTurn,
  stateLabel,
  wordAt,
  wordCount,
} from "../ui/chat/talk.js";

describe("downsampling to 16 kHz PCM16", () => {
  it("resamples a whole second of 48 kHz audio to about 16000 samples", () => {
    const resampler = createPcmResampler(48000);
    const out = resampler.push(new Float32Array(48000));
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(2);
    expect(out).toBeInstanceOf(Int16Array);
  });

  it("scales a constant signal to the same PCM16 level", () => {
    const resampler = createPcmResampler(32000);
    const out = resampler.push(new Float32Array(3200).fill(0.5));
    expect(out.length).toBeGreaterThan(1500);
    for (const sample of out) expect(Math.abs(sample - 16384)).toBeLessThanOrEqual(1);
  });

  it("clamps out-of-range samples", () => {
    const out = createPcmResampler(16000).push(Float32Array.from([2, -2, 0]));
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32768);
  });

  it("gives the same output whether fed in one frame or many", () => {
    const chunk = new Float32Array(4800);
    for (let i = 0; i < chunk.length; i++) chunk[i] = Math.sin(i / 40);
    const whole = createPcmResampler(48000).push(chunk);
    const streamed = createPcmResampler(48000);
    const pieces = [];
    for (let at = 0; at < chunk.length; at += 480) pieces.push(streamed.push(chunk.slice(at, at + 480)));
    const joined = Int16Array.from(pieces.flatMap((piece) => Array.from(piece)));
    expect(joined.length).toBe(whole.length);
    for (let i = 0; i < joined.length; i++) expect(joined[i]).toBe(whole[i]);
  });

  it("decimates a ramp by the ratio", () => {
    const out = createPcmResampler(32000).push(Float32Array.from([0, 0.25, 0.5, 0.75]));
    expect(Array.from(out)).toEqual([0, 16383]);
  });
});

describe("turn-state reducer", () => {
  it("starts listening from off", () => {
    const { state, actions } = reduceTurn(createTurnState(), { type: "start", at: 0 });
    expect(state.phase).toBe(TALK_PHASES.listening);
    expect(actions).toEqual([{ type: "listen" }]);
  });

  it("sends the utterance once the pause has run", () => {
    let result = reduceTurn(createTurnState(), { type: "start", at: 0 });
    result = reduceTurn(result.state, { type: "heard", text: "hello world", at: 0 });
    result = reduceTurn(result.state, { type: "tick", at: DEFAULT_SILENCE - 0.5, voice: false });
    expect(result.actions).toEqual([]);
    result = reduceTurn(result.state, { type: "tick", at: DEFAULT_SILENCE + 0.5, voice: false });
    expect(result.state.phase).toBe(TALK_PHASES.thinking);
    expect(result.actions).toEqual([{ type: "send", text: "hello world" }]);
  });

  it("waits longer when the words trail off", () => {
    let result = reduceTurn(createTurnState(), { type: "start", at: 0 });
    result = reduceTurn(result.state, { type: "heard", text: "one more and", at: 0 });
    result = reduceTurn(result.state, { type: "tick", at: DEFAULT_SILENCE + 0.5, voice: false });
    expect(result.actions).toEqual([]);
    result = reduceTurn(result.state, { type: "tick", at: DEFAULT_SILENCE + 2.5, voice: false });
    expect(result.actions).toEqual([{ type: "send", text: "one more and" }]);
  });

  it("speaks a reply while thinking", () => {
    const state = { ...createTurnState(), phase: TALK_PHASES.thinking, lastSpeech: 0 };
    const { state: next, actions } = reduceTurn(state, { type: "reply", text: "Here it is.", at: 1 });
    expect(next.phase).toBe(TALK_PHASES.speaking);
    expect(actions).toEqual([{ type: "speak", text: "Here it is." }]);
  });

  it("listens again once the reply has finished playing", () => {
    let result = reduceTurn({ ...createTurnState(), phase: TALK_PHASES.speaking, playing: true }, { type: "replyEnd" });
    expect(result.actions).toEqual([]);
    result = reduceTurn(result.state, { type: "played" });
    expect(result.state.phase).toBe(TALK_PHASES.listening);
    expect(result.actions).toEqual([{ type: "listen" }]);
  });

  it("treats a couple of words while playing as a barge-in", () => {
    const { state, actions } = reduceTurn({ ...createTurnState(), phase: TALK_PHASES.speaking, playing: true }, { type: "heard", text: "stop now", at: 2 });
    expect(state.phase).toBe(TALK_PHASES.listening);
    expect(actions).toEqual([{ type: "stopSpeaking" }, { type: "listen" }]);
  });

  it("ignores a single word while playing (the reply's own echo)", () => {
    const { state, actions } = reduceTurn({ ...createTurnState(), phase: TALK_PHASES.speaking, playing: true }, { type: "heard", text: "echo", at: 2 });
    expect(state.phase).toBe(TALK_PHASES.speaking);
    expect(actions).toEqual([]);
  });

  it("stops speaking and listening on stop", () => {
    const { state, actions } = reduceTurn({ ...createTurnState(), phase: TALK_PHASES.speaking, playing: true }, { type: "stop" });
    expect(state.phase).toBe(TALK_PHASES.off);
    expect(actions).toEqual([{ type: "stopSpeaking" }, { type: "stopListening" }]);
  });

  it("sends on demand while listening", () => {
    const { actions } = reduceTurn({ ...createTurnState(), phase: TALK_PHASES.listening, utterance: "go" }, { type: "press" });
    expect(actions).toEqual([{ type: "send", text: "go" }]);
  });
});

describe("talk wording and text helpers", () => {
  it("uses the phone's status wording", () => {
    expect(stateLabel(TALK_PHASES.listening)).toBe("Listening");
    expect(stateLabel(TALK_PHASES.thinking)).toBe("Working, listening");
    expect(stateLabel(TALK_PHASES.speaking)).toBe("Replying. Press Stop to interrupt");
    expect(stateLabel(TALK_PHASES.off)).toBe("Talk");
  });

  it("merges running transcripts whether incremental or cumulative", () => {
    expect(mergeTranscript("", "hello")).toBe("hello");
    expect(mergeTranscript("hello", "")).toBe("hello");
    expect(mergeTranscript("hello", "there")).toBe("hello there");
    expect(mergeTranscript("hello", "hello there")).toBe("hello there");
  });

  it("recognizes words and trailing thoughts", () => {
    expect(hasWords("...")).toBe(false);
    expect(hasWords("hi")).toBe(true);
    expect(wordCount("one two three")).toBe(3);
    expect(wordCount("...")).toBe(0);
    expect(endsMidThought("hello and")).toBe(true);
    expect(endsMidThought("hello,")).toBe(true);
    expect(endsMidThought("hello.")).toBe(false);
    expect(endsMidThought("")).toBe(false);
  });
});

describe("word alignment", () => {
  const alignment = {
    characters: ["H", "i", " ", "t", "h", "e", "r", "e", "!"],
    starts: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
    ends: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
  };

  it("groups characters into words with their times", () => {
    const words = alignmentWords(alignment);
    expect(words).toHaveLength(2);
    expect(words[0]).toMatchObject({ text: "Hi", start: 0, end: 0.2, index: 0 });
    expect(words[1]).toMatchObject({ text: "there", start: 0.3, end: 0.8, index: 1 });
    expect(alignmentWords(null)).toEqual([]);
  });

  it("finds the word being read at a time", () => {
    const words = alignmentWords(alignment);
    expect(wordAt(words, -1)).toBe(-1);
    expect(wordAt(words, 0.05)).toBe(0);
    expect(wordAt(words, 0.5)).toBe(1);
    expect(wordAt(words, 99)).toBe(1);
    expect(wordAt([], 1)).toBe(-1);
  });
});

describe("decode base64", () => {
  it("decodes to the original bytes", () => {
    const bytes = decodeBase64(Buffer.from([1, 2, 250, 255]).toString("base64"));
    expect(Array.from(bytes)).toEqual([1, 2, 250, 255]);
  });
});
