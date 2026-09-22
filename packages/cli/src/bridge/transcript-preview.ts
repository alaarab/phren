import { readFile } from "node:fs/promises";
import { codexThreadPreview } from "./codex-threads.js";
import { rpc } from "./herdr.js";
import { object, objects, type Json, type Target } from "./protocol.js";
import { withTranscriptIndex } from "./transcript-index.js";
import type { Entry } from "./transcripts.js";

export interface TranscriptPreview { turnStartedAt: string; text: string }
export const PREVIEW_INTERVAL_MS = 500;
const MAX_TEXT = 32_768;

/** Only the last Claude reply after the current prompt is eligible. A missing
 * prompt anchor is deliberately silent: scrollback could belong to an old turn. */
export function claudePanePreview(rendered: string, prompt: string, previous = ""): string {
  const raw = rendered.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").split(/\r?\n/);
  // The rule above the input box can carry the session title
  // ("───── Claude sesh ─"); it ends the reply, it is never part of it.
  const lines = raw.map(line => /[─━═]{3,}/.test(line) && !/^\s*[│┃║]/.test(line) ? "❯" : line.replace(/[\u2500-\u257f]/g, "").trimEnd());
  const firstPrompt = prompt.trim().split(/\r?\n/)[0]?.trim();
  if (!firstPrompt) return "";
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*[❯>]\s*\S/.test(lines[i])) continue;
    const shown = lines[i].replace(/^\s*[❯>]\s*/, "").trim();
    if (shown === firstPrompt || (shown.length >= 12 && firstPrompt.startsWith(shown))) start = i + 1;
  }
  // Once anchored, a reply can scroll its prompt off screen. Extend only
  // through a matching text overlap; unrelated terminal lines cannot replace it.
  const scrolled = start < 0;
  if (scrolled && !previous) return "";
  const reply: string[] = [];
  let writing = scrolled;
  const body = lines.slice(Math.max(0, start));
  // A "⏺" block whose next line is a "⎿" result is a tool call, collapsed
  // ("⏺ Running 1 shell command…") or not; it lands as its own entry.
  const toolBlock = (index: number) => {
    for (let next = index + 1; next < body.length; next++) {
      if (!body[next].trim()) continue;
      return /^\s*⎿/.test(body[next]);
    }
    return false;
  };
  for (const [index, line] of body.entries()) {
    if (/^\s*[❯>]/.test(line) || /esc(?:ape)? to interrupt/i.test(line)) break;
    if (/^\s*[✻✽✶✢✳·⠁-⣿]/u.test(line)) continue;
    // A tool call ("⏺ Bash(ls)", "⏺ phren - search (MCP)(…)") is not reply
    // text; it lands as its own entry a moment later.
    if (/^\s*[⏺●]\s*[\w.:-]+(?: - [\w.:-]+)?(?: \(MCP\))?\(/.test(line) || (/^\s*[⏺●]/.test(line) && toolBlock(index))) { writing = false; continue; }
    if (/^\s*[⏺●]/.test(line)) { reply.length = 0; writing = true; }
    if (!writing) continue;
    const clean = line.replace(/^\s*[⏺●]\s?/, "").replace(/[⠁-⣿✻✽✶✢✳]/gu, "");
    if (/^\s*(?:↳|⎿|ctrl\+|shift\+|\? for shortcuts)/i.test(clean)) continue;
    reply.push(clean.replace(/^ {2}/, ""));
  }
  const text = reply.join("\n").trim().slice(0, MAX_TEXT);
  if (!scrolled) return text;
  if (text.startsWith(previous)) return text;
  const overlap = previous.lastIndexOf(text.split("\n", 1)[0].slice(0, 80));
  return overlap >= 0 && text.startsWith(previous.slice(overlap))
    ? (previous.slice(0, overlap) + text).slice(0, MAX_TEXT) : previous;
}

/** The word Claude's own spinner shows ("✻ Pondering… (12s · esc to interrupt)"). */
export function claudeSpinnerVerb(rendered: string): string | undefined {
  const lines = rendered.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^\s*[✻✽✶✢✳✦·*⠁-⣿]\s+([A-Z][\p{L}'-]{1,30})(?:…|\.\.\.)\s*\((?:\d|.*esc to interrupt)/u.exec(lines[i]);
    if (match) return match[1];
  }
  return undefined;
}

export async function readPreviewPane(target: Target): Promise<string> {
  try {
    const result = object(await rpc(target.server, "agent.read",
      { target: target.pane, source: "visible", lines: 80, strip_ansi: true }, undefined, 2_000));
    const read = object(result.read ?? result);
    return typeof read.text === "string" ? read.text : "";
  } catch { return ""; }
}

/** Older Codex rollouts may carry public text deltas between response items.
 * Keep a bounded raw cursor, since history intentionally filters these out. */
export class CodexRolloutPreview {
  private revision?: string;
  private cursor = 0;
  private startedAt?: string;
  private text = "";
  async read(file: string): Promise<TranscriptPreview | null> {
    return withTranscriptIndex(file, async (handle, index) => {
      if (this.revision !== index.revision) { this.cursor = Math.max(0, index.lines - 2_000); this.startedAt = undefined; this.text = ""; }
      const rows: Json[] = [];
      for await (const row of index.rows(handle, index.lines, Math.max(this.cursor, index.lines - 2_000))) {
        if (!row.bytes) continue;
        try { rows.push(object(JSON.parse(row.bytes.toString()))); } catch { /* Incomplete or malformed event. */ }
      }
      for (const raw of rows.reverse()) {
        const payload = object(raw.payload), params = object(raw.params);
        if (raw.type === "event_msg" && payload.type === "task_started") {
          const time = payload.started_at;
          this.startedAt = typeof raw.timestamp === "string" ? raw.timestamp
            : typeof time === "number" ? new Date(time > 1e12 ? time : time * 1000).toISOString() : undefined;
          this.text = "";
        } else if (raw.type === "event_msg" && ["task_complete", "task_completed", "turn_aborted", "task_aborted", "error"].includes(String(payload.type))) {
          this.startedAt = undefined; this.text = "";
        } else if (raw.type === "response_item" && payload.type === "message" && payload.role === "assistant") this.text = "";
        else if (this.startedAt && ((raw.type === "event_msg" && payload.type === "agent_message_delta" && payload.channel !== "analysis")
          || (raw.method === "item/agentMessage/delta" && params.threadId !== undefined))) {
          const delta = raw.method ? params.delta : payload.delta;
          if (typeof delta === "string") this.text = (this.text + delta).slice(0, MAX_TEXT);
        }
      }
      this.cursor = index.lines; this.revision = index.revision;
      return this.startedAt && Number.isFinite(Date.parse(this.startedAt)) && this.text ? { turnStartedAt: this.startedAt, text: this.text } : null;
    });
  }
}

export async function readDeltaPreview(target: Target, file?: string, rollout?: CodexRolloutPreview): Promise<TranscriptPreview | null> {
  if (target.source === "codex") return await codexThreadPreview(target.session)
    ?? (file && rollout ? await rollout.read(file).catch(() => null) : null);
  if (target.source !== "opencode" || !file) return null;
  try {
    const value = object(JSON.parse(await readFile(file + ".preview.json", "utf8")));
    if (typeof value.turnStartedAt !== "string" || !Number.isFinite(Date.parse(value.turnStartedAt))
        || typeof value.text !== "string" || !value.text || value.text.length > MAX_TEXT) return null;
    return { turnStartedAt: value.turnStartedAt, text: value.text };
  } catch { return null; }
}

/** Socket-local, ephemeral state. It never writes transcript rows or advances
 * the history cursor. Final rows bypass the text throttle and clear atomically. */
export class TranscriptPreviewStream {
  private startedAt?: string;
  private prompt = "";
  private landed = false;
  private ended = false;
  /** Claude's own spinner word for the running turn, sent beside frames as
   * `activityVerb`; older phones ignore the field. */
  verb: string | undefined;
  private lastRead = -Infinity;
  private lastSent = -Infinity;
  private current: TranscriptPreview | null = null;
  private observedLine = -1;
  private wasWorking = false;
  private readonly rollout = new CodexRolloutPreview();
  constructor(private readonly target: Target,
    private readonly pane: () => Promise<string> = () => readPreviewPane(target),
    private readonly delta: (file?: string) => Promise<TranscriptPreview | null> = file => readDeltaPreview(target, file, this.rollout)) {}

  observe(entries: Entry[], reset = false): void {
    if (reset) { this.observedLine = -1; this.startedAt = undefined; this.landed = false; this.ended = false; this.wasWorking = false; }
    for (const { raw, line } of entries) {
      if (line <= this.observedLine) continue;
      this.observedLine = line;
      if (this.target.source !== "claude") continue;
      const message = object(raw.message), blocks = objects(message.content);
      if (raw.type === "user" && !raw.phrenQueued && !raw.isMeta && !blocks.some(b => b.type === "tool_result")) {
        const prompt = typeof message.content === "string" ? message.content : blocks.filter(b => b.type === "text").map(b => String(b.text ?? "")).join("\n");
        if (prompt.trim() && typeof raw.timestamp === "string" && Number.isFinite(Date.parse(raw.timestamp))) {
          this.startedAt = raw.timestamp; this.prompt = prompt; this.landed = false; this.ended = false; this.wasWorking = false; this.verb = undefined;
        }
      } else if (this.startedAt && (raw.type === "assistant" || blocks.some(b => b.type === "tool_result"))) this.landed = true;
    }
  }

  async update(status: unknown, file?: string, now?: number): Promise<{ preview: TranscriptPreview | null } | undefined> {
    const readAt = now ?? Date.now();
    let next: TranscriptPreview | null = null;
    if (status === "working") {
      this.wasWorking = true;
      if (this.target.source === "codex" || this.target.source === "opencode") {
        // These harnesses own a delta source. Never scrape their pane, even
        // when the source is temporarily empty or unavailable.
        next = await this.delta(file);
      } else if (this.target.source === "claude" && this.startedAt && !this.ended) {
        if (readAt - this.lastRead < PREVIEW_INTERVAL_MS) return undefined;
        this.lastRead = readAt;
        // The reply text stops once a real entry lands; Claude's spinner
        // verb keeps naming the work until the turn ends.
        const pane = await this.pane();
        const text = this.landed ? "" : claudePanePreview(pane, this.prompt,
          this.current?.turnStartedAt === this.startedAt ? this.current.text : "");
        this.verb = claudeSpinnerVerb(pane) ?? this.verb;
        if (text) next = { turnStartedAt: this.startedAt, text };
      }
    } else if (this.target.source === "claude" && this.wasWorking) { this.landed = true; this.ended = true; this.verb = undefined; }
    const sentAt = now ?? Date.now();
    if (next?.text === this.current?.text && next?.turnStartedAt === this.current?.turnStartedAt) return undefined;
    if (next && sentAt - this.lastSent < PREVIEW_INTERVAL_MS) return undefined;
    this.current = next;
    if (next) this.lastSent = sentAt;
    return { preview: next };
  }
}
