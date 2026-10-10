// Phren desktop talk mode, dictation and read-aloud. Plain browser ES module,
// no framework. Mirrors the phone's talk slice (TalkTurnMachine, SpokenReply,
// ChatReadAloud) over the Hook's speech routes:
//   WS /v1/speech/transcribe   16 kHz mono PCM16 in, partial/committed out
//   POST /v1/speech            voices text; with timestamps answers word times
// The pure helpers at the top carry no DOM or network so they test in Node.

import { store } from "../shell/store.js";

// ---------------------------------------------------------------- pure helpers

/** How long a pause ends a spoken turn before it is sent (the phone's
 * TalkPause.normal), plus extra quiet when the words stop mid-thought. */
export const DEFAULT_SILENCE = 3;
export const MID_THOUGHT_EXTRA = 2;

/** Talk mode's states, ported from the phone's TalkTurnMachine.Phase. */
export const TALK_PHASES = { off: "off", listening: "listening", thinking: "thinking", speaking: "speaking" };

const MID_THOUGHT_WORDS = new Set(["and", "so", "but", "um", "uh", "like", "or", "because", "then"]);

/** Some letter or digit, not only punctuation and spaces. */
export function hasWords(text) {
  return /[\p{L}\p{N}]/u.test(String(text || ""));
}

export function wordCount(text) {
  const parts = String(text || "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return parts.length;
}

/** True when the words so far trail off: a comma or a filler word at the end. */
export function endsMidThought(text) {
  const trimmed = String(text || "").trim();
  if (trimmed.endsWith(",")) return true;
  const parts = trimmed.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  if (!parts.length) return false;
  return MID_THOUGHT_WORDS.has(parts[parts.length - 1].toLowerCase());
}

function silenceNeeded(state) {
  return (state.silence ?? DEFAULT_SILENCE) + (endsMidThought(state.utterance) ? MID_THOUGHT_EXTRA : 0);
}

/** A fresh turn state. `silence` is the pause that ends a turn, in seconds. */
export function createTurnState(silence = DEFAULT_SILENCE) {
  return { phase: TALK_PHASES.off, silence, utterance: "", lastSpeech: 0, playing: false, replyEnded: false };
}

/**
 * The turn-state reducer. Feed it an event, get back the next state and the
 * actions to run ({ type: "listen" | "stopListening" | "send" | "speak" |
 * "stopSpeaking", text? }). Pure and deterministic: `at` is seconds, supplied
 * by the caller. Events: start, stop, heard{text}, tick{voice}, send, reply
 * {text}, replyEnd, played, press.
 */
export function reduceTurn(state, event) {
  const next = { ...state };
  const actions = [];
  const now = typeof event.at === "number" ? event.at : 0;
  const send = () => {
    const words = next.utterance.trim();
    if (!hasWords(words)) { next.utterance = ""; actions.push({ type: "listen" }); return; }
    next.phase = TALK_PHASES.thinking;
    next.utterance = "";
    actions.push({ type: "send", text: words });
  };
  const endReply = () => { next.playing = false; next.replyEnded = false; };
  const listenAfterReply = () => { next.phase = TALK_PHASES.listening; next.utterance = ""; endReply(); actions.push({ type: "listen" }); };

  switch (event.type) {
    case "start":
      if (next.phase !== TALK_PHASES.off) break;
      next.phase = TALK_PHASES.listening; next.utterance = ""; next.lastSpeech = now;
      actions.push({ type: "listen" });
      break;
    case "stop":
      if (next.phase === TALK_PHASES.off) break;
      if (next.phase === TALK_PHASES.speaking) actions.push({ type: "stopSpeaking" });
      next.phase = TALK_PHASES.off; next.utterance = ""; endReply();
      actions.push({ type: "stopListening" });
      break;
    case "heard": {
      const text = String(event.text || "");
      if (next.phase === TALK_PHASES.listening) {
        if (text !== next.utterance) { next.utterance = text; next.lastSpeech = now; }
      } else if (next.phase === TALK_PHASES.speaking && wordCount(text) >= 2) {
        // A few recognised words while a reply plays are a barge-in: stop it
        // and take those words as the next turn.
        endReply();
        next.phase = TALK_PHASES.listening; next.utterance = text; next.lastSpeech = now;
        actions.push({ type: "stopSpeaking" }, { type: "listen" });
      }
      break;
    }
    case "tick":
      if (next.phase !== TALK_PHASES.listening && next.phase !== TALK_PHASES.thinking) break;
      if (event.voice && now > next.lastSpeech) next.lastSpeech = now;
      if (next.phase === TALK_PHASES.listening && hasWords(next.utterance) && now - next.lastSpeech >= silenceNeeded(next)) send();
      break;
    case "send":
      if (next.phase === TALK_PHASES.listening || next.phase === TALK_PHASES.thinking) send();
      break;
    case "reply":
      if (next.phase !== TALK_PHASES.thinking) break;
      if (hasWords(next.utterance)) { next.phase = TALK_PHASES.listening; break; }
      next.phase = TALK_PHASES.speaking; next.playing = true;
      actions.push({ type: "speak", text: String(event.text || "") });
      break;
    case "replyEnd":
      if (next.phase !== TALK_PHASES.speaking) break;
      next.replyEnded = true;
      if (!next.playing) listenAfterReply();
      break;
    case "played":
      if (next.phase !== TALK_PHASES.speaking) break;
      next.playing = false;
      if (next.replyEnded) listenAfterReply();
      break;
    case "press":
      if (next.phase === TALK_PHASES.speaking) {
        endReply();
        next.phase = TALK_PHASES.listening; next.utterance = "";
        actions.push({ type: "stopSpeaking" }, { type: "listen" });
      } else if (next.phase === TALK_PHASES.listening || next.phase === TALK_PHASES.thinking) {
        send();
      }
      break;
  }
  return { state: next, actions };
}

/** The phone's status wording, ported. */
export function stateLabel(phase) {
  if (phase === TALK_PHASES.listening) return "Listening";
  if (phase === TALK_PHASES.thinking) return "Working, listening";
  if (phase === TALK_PHASES.speaking) return "Replying. Press Stop to interrupt";
  return "Talk";
}

/** Joins a running transcript with new words, whether the harness sends each
 * piece alone or the whole transcript again. */
export function mergeTranscript(base, add) {
  const b = String(base || "").trim();
  const a = String(add || "").trim();
  if (!a) return b;
  if (!b) return a;
  if (a.startsWith(b)) return a;
  return `${b} ${a}`;
}

/**
 * A streaming 16 kHz PCM16 resampler from a browser AudioWorklet's rate.
 * Self-contained (only typed arrays and Math) so its source can be embedded
 * in the worklet module string. `push` takes one Float32 frame and returns the
 * Int16 samples ready so far; linear interpolation keeps block edges smooth.
 */
export function createPcmResampler(inputRate, outputRate = 16000) {
  const ratio = inputRate / outputRate;
  let buffer = new Float32Array(0);
  let position = 0;
  const toInt16 = (out) => {
    const pcm = new Int16Array(out.length);
    for (let i = 0; i < out.length; i++) pcm[i] = out[i] < 0 ? out[i] * 0x8000 : out[i] * 0x7fff;
    return pcm;
  };
  const resample = (input) => {
    if (input && input.length) {
      const merged = new Float32Array(buffer.length + input.length);
      merged.set(buffer); merged.set(input, buffer.length);
      buffer = merged;
    }
    if (buffer.length < 2) return new Int16Array(0);
    const out = [];
    while (position + 1 < buffer.length) {
      const i = Math.floor(position), frac = position - i;
      let sample = buffer[i] * (1 - frac) + buffer[i + 1] * frac;
      sample = sample > 1 ? 1 : sample < -1 ? -1 : sample;
      out.push(sample);
      position += ratio;
    }
    const consumed = Math.floor(position);
    if (consumed > 0) { buffer = buffer.slice(consumed); position -= consumed; }
    return toInt16(out);
  };
  return { push: resample, flush: () => resample(null) };
}

/** The alignment's character times grouped into words, in order. */
export function alignmentWords(alignment) {
  if (!alignment || !Array.isArray(alignment.characters)) return [];
  const { characters, starts, ends } = alignment;
  const words = [];
  let current = null;
  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    if (/[\p{L}\p{N}']/u.test(ch)) {
      if (current) { current.text += ch; current.end = ends[i]; }
      else current = { text: ch, start: starts[i], end: ends[i] };
    } else if (current) { words.push(current); current = null; }
  }
  if (current) words.push(current);
  return words.map((word, index) => ({ ...word, index }));
}

/** The word being read at `time` seconds into the audio, or -1 before the
 * first. Binary search over word start times. */
export function wordAt(words, time) {
  if (!Array.isArray(words) || words.length === 0) return -1;
  let lo = 0, hi = words.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= time) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** A base64 string as bytes. */
export function decodeBase64(base64) {
  const binary = atob(String(base64 || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------- audio plumbing

const host = (computer) => `/hosts/${encodeURIComponent(computer)}`;

function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById("pt-style")) return;
  const link = document.createElement("link");
  link.id = "pt-style";
  link.rel = "stylesheet";
  link.href = new URL("./talk.css", import.meta.url).href;
  document.head.appendChild(link);
}

/** A clear message per failure, so callers never surface a raw stack. */
function speechError(code, fallback) {
  const messages = {
    "speech-unconfigured": "Spoken replies are not set up on this computer. Add an ElevenLabs key.",
    "speech-rejected": "The ElevenLabs key on this computer was refused.",
    "speech-quota": "The ElevenLabs quota on this computer is used up.",
    "speech-busy": "ElevenLabs is busy. Try again shortly.",
    "speech-invalid": "There was nothing to say in this reply.",
    "speech-unreachable": "Could not reach ElevenLabs from this computer.",
    "transcribe-unconfigured": "Dictation is not set up on this computer. Add an ElevenLabs key.",
    "transcribe-rejected": "The ElevenLabs key on this computer was refused.",
    "transcribe-quota": "The ElevenLabs quota on this computer is used up.",
    "transcribe-busy": "ElevenLabs is busy. Try again shortly.",
    "transcribe-limit": "This dictation reached its time limit.",
    "transcribe-failed": "Could not reach ElevenLabs from this computer.",
  };
  const error = new Error(messages[code] || fallback || "Speech is unavailable right now.");
  error.code = code;
  return error;
}

function capabilityError(missing) {
  const error = new Error(missing === "transcribe"
    ? "Dictation needs a newer Phren on this computer."
    : "Spoken replies need a newer Phren on this computer.");
  error.code = "speech-unsupported";
  return error;
}

function micError(error) {
  const name = error && error.name;
  if (name === "NotAllowedError" || name === "SecurityError") return new Error("Microphone access was denied.");
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return new Error("No microphone was found.");
  if (name === "NotReadableError" || name === "TrackStartError") return new Error("The microphone is in use by another app.");
  return new Error((error && error.message) || "The microphone could not be opened.");
}

/** The AudioWorklet module: the resampler (embedded from its own source) and a
 * processor that posts 16 kHz PCM16 frames to the main thread. */
function workletSource() {
  return `const createPcmResampler = ${createPcmResampler.toString()};
class PhrenPcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.resampler = createPcmResampler(sampleRate, 16000); }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      const pcm = this.resampler.push(input);
      if (pcm.length) this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor("phren-pcm-capture", PhrenPcmCapture);`;
}

/** Open the microphone and an AudioWorklet that emits 16 kHz PCM16 frames.
 * Returns { context, node, stream }; `onFrame(ArrayBuffer)` is wired by the
 * caller. Throws a microphone Error when the device is denied or missing. */
async function openMicrophone(onFrame) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("This browser has no microphone support.");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (error) { throw micError(error); }
  const context = new (window.AudioContext || window.webkitAudioContext)();
  if (context.state === "suspended") { try { await context.resume(); } catch { /* stays suspended */ } }
  const url = URL.createObjectURL(new Blob([workletSource()], { type: "application/javascript" }));
  try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "phren-pcm-capture");
  const sink = context.createGain();
  sink.gain.value = 0;
  source.connect(node).connect(sink).connect(context.destination);
  node.port.onmessage = (event) => onFrame(event.data);
  return { context, node, stream, close() { try { node.port.onmessage = null; } catch { /* detached */ } try { stream.getTracks().forEach((t) => t.stop()); } catch { /* already stopped */ } try { context.close(); } catch { /* already closed */ } } };
}

/** A floating message for a failure or a status note; fades on its own. */
export function toast(message, { tone, ms = 4200 } = {}) {
  if (typeof document === "undefined") return () => {};
  ensureStyles();
  const el = document.createElement("div");
  el.className = `pt-toast${tone === "danger" ? " danger" : ""}`;
  el.textContent = String(message);
  el.setAttribute("role", "status");
  document.body.append(el);
  const remove = () => { el.classList.add("fade"); setTimeout(() => el.remove(), 200); };
  const timer = setTimeout(remove, ms);
  return () => { clearTimeout(timer); remove(); };
}

// ---------------------------------------------------------------- dictation

/**
 * Stream the microphone to the Hook's dictation relay. `onText(text, final)`
 * gets the running transcript (final true once committed, or when the session
 * ends). `onEnd(error)` fires once, on stop, silence or failure. Returns
 * { stop() }. With `silenceMs` (default 2000) an idle session ends itself
 * after that long; 0 never ends on silence (talk mode drives the turn).
 */
export function startDictation({ computer, onText, onEnd, silenceMs = 2000, language, keyterms } = {}) {
  let ended = false, ws = null, mic = null, silenceTimer = null, committed = "", spoke = false;
  const report = (text, final) => { try { onText && onText(text, final); } catch { /* a listener must not break dictation */ } };
  const cleanup = () => {
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    if (ws) { try { ws.close(); } catch { /* already closing */ } ws = null; }
    if (mic) { mic.close(); mic = null; }
  };
  const finish = (error) => {
    if (ended) return;
    ended = true;
    cleanup();
    try { onEnd && onEnd(error || null); } catch { /* a listener must not break dictation */ }
  };
  const armSilence = () => {
    if (!silenceMs) return;
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => finish(null), silenceMs);
  };

  const query = new URLSearchParams();
  if (language) query.set("language", language);
  for (const term of keyterms || []) query.append("keyterm", term);
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}${host(computer)}/v1/speech/transcribe${query.toString() ? `?${query}` : ""}`;

  (async () => {
    const caps = await store.capabilities(computer).catch(() => ({}));
    if (ended) return;
    if (!caps.transcribe) { finish(capabilityError("transcribe")); return; }
    try {
      mic = await openMicrophone((buffer) => { if (ws && ws.readyState === 1) ws.send(buffer); });
    } catch (error) { finish(error); return; }
    if (ended) { mic.close(); mic = null; return; }
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event) => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (frame.type === "partial") { report(mergeTranscript(committed, frame.text), false); if (hasWords(frame.text)) { spoke = true; armSilence(); } }
      else if (frame.type === "committed") { committed = mergeTranscript(committed, frame.text); if (hasWords(frame.text)) spoke = true; report(committed, true); armSilence(); }
      else if (frame.type === "error") { finish(speechError(frame.code, frame.error)); }
      else if (frame.type === "end") { report(committed, true); finish(null); }
    };
    ws.onerror = () => { if (ws.readyState !== 1) finish(speechError("transcribe-failed")); };
    ws.onclose = () => { if (!ended) { report(committed, true); finish(null); } };
  })().catch((error) => finish(error));

  return { stop() { finish(null); }, get transcript() { return committed; }, get heard() { return spoke; } };
}

// ---------------------------------------------------------------- speaking

/**
 * Voice `text` with the Hook and play it through WebAudio. `onWord(index)` is
 * called as each word of the alignment is read (index into alignmentWords),
 * and -1 at the end. Returns { stop(), done } where done settles when playback
 * finishes or the request fails.
 */
function speakSpeech({ computer, text, voice, formats, onWord }) {
  const controller = new AbortController();
  let context = null, source = null, stopped = false, frame = 0;
  const finishWord = () => { cancelAnimationFrame(frame); if (onWord) { try { onWord(-1); } catch { /* ignore */ } } };

  const done = (async () => {
    const caps = await store.capabilities(computer).catch(() => ({}));
    if (!caps.speech) throw capabilityError("speech");
    const response = await fetch(`${host(computer)}/v1/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Phren-Desktop": "1" },
      body: JSON.stringify({ text, timestamps: true, voice, formats: formats && formats.length ? formats : ["pcm_24000"] }),
      signal: controller.signal,
    });
    if (!response.ok) {
      let body = {};
      try { body = await response.json(); } catch { /* not JSON */ }
      throw speechError(body.code, body.error);
    }
    const body = await response.json();
    if (stopped) return;
    context = new (window.AudioContext || window.webkitAudioContext)();
    if (context.state === "suspended") { try { await context.resume(); } catch { /* stays suspended */ } }
    const bytes = decodeBase64(body.audio);
    let buffer;
    if (/^pcm/.test(String(body.format || ""))) {
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
      buffer = context.createBuffer(1, Math.max(1, pcm.length), body.sampleRate || 24000);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
    } else {
      buffer = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    if (stopped) { try { context.close(); } catch { /* ignore */ } return; }
    const words = alignmentWords(body.alignment);
    source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    let last = -1;
    const tick = () => {
      if (stopped) return;
      const index = wordAt(words, context.currentTime);
      if (index !== last && onWord) { last = index; try { onWord(index); } catch { /* ignore */ } }
      frame = requestAnimationFrame(tick);
    };
    await new Promise((resolve) => {
      source.onended = resolve;
      source.start();
      if (onWord) frame = requestAnimationFrame(tick);
    });
    finishWord();
    try { context.close(); } catch { /* ignore */ }
  })();
  done.catch(() => { /* the caller handles failures through its own await */ });

  const stop = () => {
    stopped = true;
    finishWord();
    try { source && source.stop(); } catch { /* not started */ }
    try { context && context.close(); } catch { /* ignore */ }
    controller.abort();
  };
  return { stop, done };
}

/**
 * Read a reply aloud with the Hook's voice and highlight its words. `onWord`
 * receives each word's index (into the reply's words) as it is read, and -1
 * when done. Returns { stop(), done }.
 */
export function readAloud({ computer, text, voice, onWord } = {}) {
  return speakSpeech({ computer, text, voice, onWord });
}

// ---------------------------------------------------------------- talk mode

const PROVIDERS = { claude: "Claude", codex: "Codex", copilot: "Copilot", phren: "Phren", opencode: "OpenCode" };
function providerName(source) { return PROVIDERS[String(source || "").toLowerCase()] || "Agent"; }

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function nowSeconds() { return (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000; }

/**
 * Talk mode: hold a voice conversation with one session. Speak; the pause
 * sends it; the agent's reply is spoken back; listening resumes. A floating
 * panel shows the state and the turn, with Stop. Returns { start(), stop(),
 * feedReply(text) }; the caller feeds the assistant reply to feedReply.
 */
export function createTalkMode({ computer, target, provider, send, onState } = {}) {
  ensureStyles();
  let phase = TALK_PHASES.off;
  let turn = createTurnState();
  let dictation = null, barge = null, playback = null, ticker = null, closed = true;
  let yourText = "", agentText = "", errorText = "";

  const panel = node("div", "pt-panel");
  panel.hidden = true;
  const dot = node("div", "pt-dot off");
  const stateEl = node("div", "pt-state", stateLabel(TALK_PHASES.off));
  const who = node("div", "pt-who", providerName(provider));
  const stopBtn = node("button", "pt-stop", "Stop");
  const head = node("div", "pt-head");
  head.append(dot, stateEl, who, stopBtn);
  const errorEl = node("div", "pt-error");
  const body = node("div", "pt-body");
  const youLabel = node("div", "pt-line-label", "You");
  const youTextEl = node("div", "pt-text");
  const youLine = node("div", "pt-line you"); youLine.append(youLabel, youTextEl);
  const themLabel = node("div", "pt-line-label", "Reply");
  const themTextEl = node("div", "pt-text");
  const themLine = node("div", "pt-line them"); themLine.append(themLabel, themTextEl);
  body.append(youLine, themLine);
  panel.append(head, errorEl, body);
  document.body.append(panel);
  stopBtn.addEventListener("click", () => stop());

  function render() {
    if (closed) return;
    dot.className = `pt-dot ${phase}`;
    stateEl.textContent = stateLabel(phase);
    errorEl.textContent = errorText;
    youTextEl.textContent = yourText || "Say something\u2026";
    youTextEl.classList.toggle("pt-empty", !yourText);
    themTextEl.textContent = agentText || (phase === TALK_PHASES.thinking ? "Waiting for the reply\u2026" : "\u2014");
    themTextEl.classList.toggle("pt-empty", !agentText);
    panel.hidden = false;
  }

  function emit() {
    render();
    try { onState && onState({ phase, transcript: yourText, reply: agentText, label: stateLabel(phase) }); } catch { /* a listener must not break talk mode */ }
  }

  function apply(event) {
    const result = reduceTurn(turn, event);
    turn = result.state;
    phase = turn.phase;
    for (const action of result.actions) runAction(action);
    emit();
  }

  function runAction(action) {
    if (action.type === "listen") listen();
    else if (action.type === "stopListening") stopListening();
    else if (action.type === "send") doSend(action.text);
    else if (action.type === "speak") doSpeak(action.text);
    else if (action.type === "stopSpeaking") stopSpeaking();
  }

  function listen() {
    stopListening();
    stopBarge();
    dictation = startDictation({
      computer, silenceMs: 0,
      onText: (text) => { yourText = text; apply({ type: "heard", text, at: nowSeconds() }); },
      onEnd: (error) => {
        dictation = null;
        if (error && !closed) { errorText = error.message; render(); }
      },
    });
  }

  function stopListening() {
    if (dictation) { const current = dictation; dictation = null; try { current.stop(); } catch { /* ignore */ } }
  }

  // While the reply plays, a second microphone watches for a few words: a
  // barge-in stops the voice and takes those words as the next turn.
  function stopBarge() {
    if (barge) { const current = barge; barge = null; try { current.stop(); } catch { /* ignore */ } }
  }
  function startBarge() {
    stopBarge();
    barge = startDictation({
      computer, silenceMs: 0,
      onText: (text) => {
        const words = String(text || "").trim();
        if (wordCount(words) < 2) return;
        stopBarge();
        apply({ type: "heard", text: words, at: nowSeconds() });
      },
      onEnd: () => { barge = null; },
    });
  }

  function doSend(text) {
    stopListening();
    agentText = ""; errorText = "";
    render();
    try {
      const result = send ? send(text) : null;
      if (result && typeof result.then === "function") result.catch((error) => fail(error));
    } catch (error) { fail(error); }
  }

  function doSpeak(text) {
    stopSpeaking();
    agentText = text;
    render();
    const player = speakSpeech({ computer, text });
    playback = player;
    startBarge();
    player.done.then(() => {
      if (playback !== player) return;
      playback = null;
      apply({ type: "played" });
    }).catch((error) => {
      if (playback !== player) return;
      playback = null;
      errorText = (error && error.message) || "Could not speak the reply.";
      turn = { ...turn, phase: TALK_PHASES.listening, utterance: "", playing: false, replyEnded: false };
      phase = turn.phase;
      listen();
      emit();
    });
  }

  function stopSpeaking() {
    stopBarge();
    if (playback) { const current = playback; playback = null; try { current.stop(); } catch { /* ignore */ } }
  }

  function fail(error) {
    errorText = (error && error.message) || "The message could not be sent.";
    turn = { ...turn, phase: TALK_PHASES.listening, utterance: "", playing: false, replyEnded: false };
    phase = turn.phase;
    listen();
    emit();
  }

  function tickerStart() {
    tickerStop();
    ticker = setInterval(() => { if (phase === TALK_PHASES.listening || phase === TALK_PHASES.thinking) apply({ type: "tick", at: nowSeconds(), voice: false }); }, 250);
  }
  function tickerStop() { if (ticker) { clearInterval(ticker); ticker = null; } }

  function start() {
    if (!closed) return;
    closed = false;
    errorText = ""; yourText = ""; agentText = "";
    apply({ type: "start", at: nowSeconds() });
    tickerStart();
  }

  function stop() {
    if (closed) return;
    apply({ type: "stop" });
    stopListening();
    stopSpeaking();
    tickerStop();
    closed = true;
    panel.hidden = true;
    try { onState && onState({ phase: TALK_PHASES.off, transcript: yourText, reply: agentText, label: stateLabel(TALK_PHASES.off) }); } catch { /* ignore */ }
  }

  function feedReply(text) {
    if (closed || phase !== TALK_PHASES.thinking || !hasWords(text)) return;
    agentText = mergeTranscript(agentText, text);
    apply({ type: "reply", text: String(text || ""), at: nowSeconds() });
  }

  return {
    start, stop, feedReply,
    /** The floating panel, so a caller can mount it elsewhere if it likes. */
    el: panel,
    get phase() { return phase; },
  };
}

// ---------------------------------------------------------------- push to talk

/**
 * Hold a key (default F5) anywhere in the app to dictate; release sends the
 * transcript to the conductor. `conductor()` returns { computer, target } or
 * null; `send(computer, target, text)` delivers it. Returns { uninstall() }.
 */
export function installPushToTalk({ key = "F5", conductor, send } = {}) {
  ensureStyles();
  let session = null, dest = null, transcript = "", indicator = null, label = null;

  const typing = (target) => target instanceof Element && !!target.closest("input, textarea, [contenteditable='true'], .xterm, .monaco-editor");
  const showIndicator = () => {
    indicator = node("div", "pt-recording");
    label = node("span", null, "Listening\u2026");
    indicator.append(node("span", "pt-recording-dot"), label);
    document.body.append(indicator);
  };
  const hideIndicator = () => { if (indicator) { indicator.remove(); indicator = null; label = null; } };

  const onDown = (event) => {
    if (event.key !== key || session || event.repeat) return;
    if (typing(event.target)) return;
    const where = conductor ? conductor() : null;
    if (!where) { toast("No conductor is running"); return; }
    event.preventDefault();
    dest = where; transcript = "";
    showIndicator();
    session = startDictation({
      computer: where.computer,
      onText: (text) => { transcript = text; if (label) label.textContent = text || "Listening\u2026"; },
      onEnd: (error) => { if (error) { session = null; hideIndicator(); toast(error.message, { tone: "danger" }); } },
    });
  };

  const onUp = (event) => {
    if (event.key !== key || !session) return;
    event.preventDefault();
    const current = session, where = dest, text = transcript.trim();
    session = null;
    try { current.stop(); } catch { /* ignore */ }
    hideIndicator();
    if (!text || !where || !send) return;
    try {
      const result = send(where.computer, where.target, text);
      if (result && typeof result.then === "function") result.catch((error) => toast((error && error.message) || "The message could not be sent.", { tone: "danger" }));
    } catch (error) { toast((error && error.message) || "The message could not be sent.", { tone: "danger" }); }
  };

  document.addEventListener("keydown", onDown, true);
  document.addEventListener("keyup", onUp, true);
  return {
    uninstall() {
      document.removeEventListener("keydown", onDown, true);
      document.removeEventListener("keyup", onUp, true);
      if (session) { try { session.stop(); } catch { /* ignore */ } session = null; }
      hideIndicator();
    },
  };
}

