/**
 * The live reply sidecar: `<event log>.preview.json` holds the assistant text
 * block the model is streaming right now, as `{turnStartedAt, text}` (the
 * shape OpenCode's plugin writes). The event log only gets whole messages;
 * Phren Hook reads this file to stream a reply to the phone while it is
 * still being written. Removed once the message lands in the log.
 */
import * as fs from "fs";
import { eventLogPath } from "./persist.js";

/** At most this often on disk; the Hook reads it twice a second. */
export const PREVIEW_WRITE_MS = 100;
const MAX_TEXT = 32_768;

export interface LivePreview {
  /** A new model response starts: forget the previous block's text. */
  start(turnStartedAt: string): void;
  append(text: string): void;
  /** The text block ended (tool call) or the message landed in the log. */
  clear(): void;
}

export function previewPath(phrenPath: string, sessionId: string): string {
  return `${eventLogPath(phrenPath, sessionId)}.preview.json`;
}

export function livePreview(file: string, now: () => number = Date.now): LivePreview {
  let turnStartedAt = "";
  let text = "";
  let writtenAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = undefined; } };
  const write = () => {
    cancel();
    if (!turnStartedAt || !text) return;
    writtenAt = now();
    const staging = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(staging, JSON.stringify({ turnStartedAt, text }), { mode: 0o600 });
      fs.renameSync(staging, file);
    } catch { try { fs.rmSync(staging, { force: true }); } catch { /* best effort */ } }
  };
  return {
    // A new response (or a retried one) shows its first words at once.
    start(at) { cancel(); turnStartedAt = at; text = ""; writtenAt = -Infinity; },
    append(delta) {
      if (!turnStartedAt || text.length >= MAX_TEXT) return;
      text = (text + delta).slice(0, MAX_TEXT);
      const wait = writtenAt + PREVIEW_WRITE_MS - now();
      if (wait <= 0) write();
      else if (!timer) timer = setTimeout(write, wait);
    },
    clear() {
      cancel();
      text = "";
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    },
  };
}
