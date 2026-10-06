import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { targetTranscriptPath } from "./transcripts.js";
import { terminalProvider } from "./terminal.js";
import type { Json, Target } from "./protocol.js";
import { BACKGROUND_STALE_MS } from "./session-activity.js";

export interface Stall { stalled: true; stalledSince: string; stallFor: number }
export interface StallReaders {
  screen: (target: Target) => Promise<string>;
  transcript: (target: Target) => Promise<string>;
  now: () => number;
  threshold: () => number;
}
export function stallThreshold(): number {
  const value = Number(process.env.PHREN_STALL_MS ?? 300_000);
  return Number.isFinite(value) && value >= 0 ? value : 300_000;
}
async function transcriptStamp(target: Target): Promise<string> {
  const file = await open(await targetTranscriptPath(target), "r");
  try {
    const info = await file.stat(), start = Math.max(0, info.size - 8192), buffer = Buffer.alloc(info.size - start);
    await file.read(buffer, 0, buffer.length, start);
    return `${info.size}:${createHash("sha256").update(buffer).digest("hex")}`;
  } finally { await file.close(); }
}
/** Requires successful observations of both sources. Identity, terminal, work
 * status and either source changing all reset the clock. Missing data is unknown.
 * `live` reads the awaited work the pane's turn still waits on (`liveWork`:
 * awaited background shells and monitors, running children). A worker that
 * ended its turn on purpose while a build runs sits still on screen and in its
 * transcript, so once the clock runs out `live` is asked, and any live work
 * starts the clock over instead of reporting a stall, for at most
 * BACKGROUND_STALE_MS: work that never ends (a build deadlocked on a lock, a
 * child that died without its completion record) does not hide a stall forever. */
export class StallDetector {
  private entries = new Map<string, { signature: string; since: number; liveSince?: number }>();
  constructor(private readers: StallReaders = {
    screen: target => terminalProvider().readScreen(target.server, target.pane, { scope: "pane", source: "visible", lines: 120, stripAnsi: true, timeoutMs: 1000 }),
    transcript: transcriptStamp, now: Date.now, threshold: stallThreshold,
  }) {}
  async observe(target: Target, pane: Json, live?: () => Promise<number | undefined>): Promise<Stall | undefined> {
    const key = JSON.stringify([target.server, target.pane]);
    if (pane.agent_status !== "working" || this.readers.threshold() === 0) { this.entries.delete(key); return undefined; }
    let screen: string, transcript: string;
    try { [screen, transcript] = await Promise.all([this.readers.screen(target), this.readers.transcript(target)]); }
    catch { this.entries.delete(key); return undefined; }
    const signature = createHash("sha256").update(JSON.stringify([target, pane.terminal_id, screen, transcript])).digest("hex");
    const now = this.readers.now(), prior = this.entries.get(key);
    if (!prior || prior.signature !== signature) { this.entries.delete(key); this.entries.set(key, { signature, since: now }); }
    while (this.entries.size > 1024) this.entries.delete(this.entries.keys().next().value!);
    const entry = this.entries.get(key)!, since = entry.since;
    if (now - since < this.readers.threshold()) return undefined;
    const held = entry.liveSince === undefined || now - entry.liveSince < BACKGROUND_STALE_MS;
    if (live && held && await live().catch(() => undefined)) { entry.since = now; entry.liveSince ??= since; return undefined; }
    return { stalled: true, stalledSince: new Date(since).toISOString(), stallFor: Math.floor((now - since) / 1000) };
  }
}
export const sessionStalls = new StallDetector();
